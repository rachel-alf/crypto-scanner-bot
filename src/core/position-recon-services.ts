// services/PositionReconciliationService.ts

import type { BotInstance, Position } from '@lib/type.js';
import { Exchange } from 'ccxt';

import { log } from './candles.js';

interface BinancePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  positionSide: string; // BOTH, LONG, SHORT
}

export class PositionReconciliationService {
  private binance: Exchange;

  constructor(binance: Exchange) {
    this.binance = binance;
  }

  /**
   * Fetch all active positions from Binance
   */
  async fetchBinancePositions(): Promise<BinancePosition[]> {
    try {
      const positions = await (
        this.binance as any
      ).fapiPrivateV2GetPositionRisk();

      // Filter only positions with non-zero amount
      return positions.filter((pos: BinancePosition) => {
        const amount = parseFloat(pos.positionAmt);
        return amount !== 0;
      });
    } catch (error: any) {
      log(`❌ Failed to fetch Binance positions: ${error.message}`, 'error');
      return [];
    }
  }

  /**
   * Fetch open orders for a symbol (SL/TP orders)
   */
  async fetchOpenOrders(symbol: string): Promise<any[]> {
    try {
      const orders = await this.binance.fetchOpenOrders(symbol);
      return orders;
    } catch (error: any) {
      log(`❌ Failed to fetch orders for ${symbol}: ${error.message}`, 'error');
      return [];
    }
  }

  /**
   * Convert Binance position to app Position format
   */
  async convertBinancePositionToAppPosition(
    binancePos: BinancePosition
  ): Promise<Position | null> {
    try {
      const positionAmt = parseFloat(binancePos.positionAmt);
      const entryPrice = parseFloat(binancePos.entryPrice);
      const markPrice = parseFloat(binancePos.markPrice);
      const leverage = parseInt(binancePos.leverage);
      const unrealizedPnl = parseFloat(binancePos.unRealizedProfit);

      // Determine side
      const side = positionAmt > 0 ? 'LONG' : 'SHORT';
      const amount = Math.abs(positionAmt);

      // Fetch open orders to get SL/TP
      const openOrders = await this.fetchOpenOrders(binancePos.symbol);

      let stopLossOrderId: string | undefined;
      let takeProfitOrderId: string | undefined;
      let stopLoss: number | undefined;
      let takeProfit: number | undefined;

      for (const order of openOrders) {
        // Stop-loss order
        if (
          order.type === 'STOP_MARKET' ||
          order.type === 'STOP' ||
          order.info?.type === 'STOP_MARKET'
        ) {
          // For LONG: SL is a SELL order below entry
          // For SHORT: SL is a BUY order above entry
          const isSellOrder = order.side === 'SELL';
          if (
            (side === 'LONG' && isSellOrder) ||
            (side === 'SHORT' && !isSellOrder)
          ) {
            stopLossOrderId = order.id;
            stopLoss = order.stopPrice || order.price;
          }
        }

        // Take-profit order
        if (
          order.type === 'TAKE_PROFIT_MARKET' ||
          order.type === 'TAKE_PROFIT' ||
          order.info?.type === 'TAKE_PROFIT_MARKET'
        ) {
          // For LONG: TP is a SELL order above entry
          // For SHORT: TP is a BUY order below entry
          const isSellOrder = order.side === 'SELL';
          if (
            (side === 'LONG' && isSellOrder) ||
            (side === 'SHORT' && !isSellOrder)
          ) {
            takeProfitOrderId = order.id;
            takeProfit = order.stopPrice || order.price;
          }
        }
      }

      const notionalValue = amount * entryPrice;
      const marginUsed = notionalValue / leverage;
      const pnlPct = (unrealizedPnl / marginUsed) * 100;

      const position: Position = {
        positionId: `binance-${binancePos.symbol}-${Date.now()}`,
        symbol: binancePos.symbol,
        side: side as 'LONG' | 'SHORT',
        entryPrice: entryPrice,
        currentPrice: markPrice,
        amount: amount,
        remainingAmount: amount,
        stopLoss: stopLoss as number,
        takeProfit: takeProfit as number,
        pnlUsd: unrealizedPnl,
        pnlPct: pnlPct,
        leverage: leverage,
        marginUsed: marginUsed,
        notionalValue: notionalValue,
        entryTime: new Date(), // We don't have exact entry time from Binance
        strategy: 'UNKNOWN' as any, // Mark as unknown strategy
        partialsSold: 0,
        stopLossOrderId: stopLossOrderId as string,
        takeProfitOrderId: takeProfitOrderId as string,
      };

      return position;
    } catch (error: any) {
      log(
        `❌ Failed to convert position for ${binancePos.symbol}: ${error.message}`,
        'error'
      );
      return null;
    }
  }

  /**
   * Reconcile app bots with Binance positions
   */
  async reconcileBots(bots: Map<string, BotInstance>): Promise<{
    synced: number;
    newPositions: number;
    orphanedPositions: string[];
  }> {
    console.log('\n🔄 Starting position reconciliation with Binance...');

    const binancePositions = await this.fetchBinancePositions();

    console.log(
      `📊 Found ${binancePositions.length} active positions on Binance`
    );

    let synced = 0;
    let newPositions = 0;
    const orphanedPositions: string[] = [];

    // Track which symbols have positions on Binance
    const binanceSymbols = new Set(binancePositions.map((p) => p.symbol));

    // 1. Check app bots against Binance
    for (const [symbol, bot] of bots.entries()) {
      if (bot.position) {
        // Bot thinks it has a position
        if (!binanceSymbols.has(symbol)) {
          log(
            `⚠️ ${symbol}: App has position but Binance doesn't - marking as orphaned`,
            'warning'
          );
          orphanedPositions.push(symbol);
          // Clear the position from app
          bot.position = null;
          bot.status = 'idle';
        } else {
          log(`✅ ${symbol}: Position exists in both app and Binance`, 'info');
          synced++;
        }
      }
    }

    // 2. Check Binance positions against app
    for (const binancePos of binancePositions) {
      const symbol = binancePos.symbol;
      const bot = bots.get(symbol);

      if (!bot) {
        log(
          `⚠️ ${symbol}: Position exists on Binance but no bot in app - skipping`,
          'warning'
        );
        continue;
      }

      if (!bot.position) {
        // Binance has position but app doesn't
        log(
          `🔍 ${symbol}: Found position on Binance, importing to app...`,
          'info'
        );

        const position =
          await this.convertBinancePositionToAppPosition(binancePos);

        if (position) {
          bot.position = position;
          bot.status = 'running';
          newPositions++;

          log(`✅ ${symbol}: Imported position from Binance`, 'success');
          log(`   Side: ${position.side}`, 'info');
          log(`   Entry: $${position.entryPrice.toFixed(6)}`, 'info');
          log(`   Amount: ${position.amount}`, 'info');
          log(
            `   PnL: $${position.pnlUsd.toFixed(2)} (${position.pnlPct.toFixed(2)}%)`,
            'info'
          );
          if (position.stopLoss) {
            log(`   SL: $${position.stopLoss.toFixed(6)}`, 'info');
          }
          if (position.takeProfit) {
            log(`   TP: $${position.takeProfit.toFixed(6)}`, 'info');
          }
        }
      } else if (bot.position.marginUsed) {
        // Both have position - verify they match
        const appEntry = bot.position.entryPrice;
        const binanceEntry = parseFloat(binancePos.entryPrice);
        const priceDiff =
          Math.abs((appEntry - binanceEntry) / binanceEntry) * 100;

        if (priceDiff > 0.1) {
          log(
            `⚠️ ${symbol}: Entry price mismatch - App: $${appEntry.toFixed(6)}, Binance: $${binanceEntry.toFixed(6)}`,
            'warning'
          );
        }

        // Update current price and PnL from Binance
        bot.position.currentPrice = parseFloat(binancePos.markPrice);
        bot.position.pnlUsd = parseFloat(binancePos.unRealizedProfit);
        bot.position.pnlPct =
          (bot.position.pnlUsd / bot.position.marginUsed) * 100;
      }
    }

    console.log('\n📊 Reconciliation Summary:');
    console.log(`   ✅ Synced: ${synced}`);
    console.log(`   🆕 New positions imported: ${newPositions}`);
    console.log(
      `   ⚠️ Orphaned positions cleared: ${orphanedPositions.length}`
    );

    return { synced, newPositions, orphanedPositions };
  }
}
