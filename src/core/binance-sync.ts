import ccxt, { type Balances } from 'ccxt';
import * as dotenv from 'dotenv';

import type { BotInstance } from '../../lib/type.js';
import { getRequiredEnvVar } from '../futures/launcher-future.js';

dotenv.config();

export class BinanceSync {
  private lastSyncTime: number = 0;
  private syncInterval: number = 10000; // 10 seconds
  private isShuttingDown: boolean = false;

  private binance = new ccxt.binance({
    apiKey: getRequiredEnvVar('BINANCE_FUTURE_API_KEY'),
    secret: getRequiredEnvVar('BINANCE_FUTURE_API_SECRET'),
    enableRateLimit: true,
    timeout: 60000,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true,
    },
  });

  // constructor(binance: ccxt.binance) {
  //   this.binance = binance;
  // }

  /**
   * ✅ CALL THIS ON BOT STARTUP
   * Reconciles any existing Binance positions with bot state
   */
  async syncOnStartup(bots: Map<string, BotInstance>): Promise<void> {
    console.log('\n🔄 SYNCING WITH BINANCE ON STARTUP...\n');

    try {
      // 1. Get Binance positions
      const positions = await this.binance.fetchPositions();
      const openPositions = positions.filter((p) => {
        const contracts = p.contracts as any;
        return parseFloat(contracts) !== 0 && contracts !== null;
      });

      console.log(`📊 Found ${openPositions.length} open positions on Binance`);

      // 2. Get Binance open orders
      const openOrders = await this.binance.fetchOpenOrders();
      console.log(`📋 Found ${openOrders.length} open orders on Binance`);

      // 3. Check for orphaned positions (on Binance but not in bot)
      for (const binancePos of openPositions) {
        const symbol = binancePos.symbol;
        const bot = bots.get(symbol);

        if (!bot || !bot.position) {
          console.warn(`⚠️ ORPHANED POSITION: ${symbol}`);
          console.warn(`   Binance has open position but bot doesn't track it`);
          console.warn(`   Size: ${binancePos.contracts}`);
          console.warn(
            `   Unrealized PnL: $${(binancePos.unrealizedPnl || 0).toFixed(2)}`
          );
          console.warn(`   ⚠️ Consider closing this manually or adding to bot`);
        }
      }

      // 4. Check for phantom positions (in bot but not on Binance)
      for (const [symbol, bot] of bots.entries()) {
        if (!bot.position) continue;

        const binancePos = openPositions.find((p) => p.symbol === symbol);

        if (!binancePos || parseFloat(binancePos.contracts as any) === 0) {
          console.warn(`⚠️ PHANTOM POSITION: ${symbol}`);
          console.warn(
            `   Bot thinks position is open but Binance shows closed`
          );
          console.warn(`   Bot PnL: $${bot.position.pnlUsd?.toFixed(2)}`);
          console.warn(`   🚨 This position should be cleaned up!`);

          // Optional: Auto-cleanup
          // return { needsCleanup: true, symbol };
        }
      }

      // 5. Get account balance
      const balance = (await this.binance.fetchBalance()) as Balances;
      const totalBalance = balance.USDT?.total as number;
      const usedBalance = balance.USDT?.used as number;

      console.log(`\n💰 Account Status:`);
      console.log(`   Total: $${totalBalance.toFixed(2)}`);
      console.log(`   Used: $${usedBalance.toFixed(2)}`);
      console.log(`   Free: $${(totalBalance - usedBalance).toFixed(2)}`);

      console.log('\n✅ Startup sync complete\n');

      return;
    } catch (error: any) {
      console.error('❌ Startup sync failed:', error.message);
      throw error;
    }
  }

  /**
   * ✅ CALL THIS IN YOUR MAIN UPDATE LOOP
   * Continuously monitors Binance for order fills
   */
  async monitorPositions(
    bots: Map<string, BotInstance>,
    onOrderFilled: (
      symbol: string,
      orderType: 'SL' | 'TP',
      fillPrice: number
    ) => void
  ): Promise<void> {
    // Throttle checks to avoid rate limits
    const now = Date.now();
    if (now - this.lastSyncTime < this.syncInterval) {
      return;
    }
    this.lastSyncTime = now;

    try {
      // Check each bot's orders
      for (const [symbol, bot] of bots.entries()) {
        if (!bot.position) continue;

        const pos = bot.position;

        // Check stop-loss order
        if (pos.stopLossOrderId) {
          try {
            const slOrder = await this.binance.fetchOrder(
              pos.stopLossOrderId,
              symbol
            );

            if (slOrder.status === 'closed' || slOrder.status === 'filled') {
              const fillPrice = slOrder.average || slOrder.price;
              console.log(`\n🛑 ${symbol} STOP-LOSS TRIGGERED ON BINANCE`);
              console.log(`   Order ID: ${pos.stopLossOrderId}`);
              console.log(`   Fill Price: $${fillPrice}`);
              console.log(
                `   Fill Time: ${new Date(slOrder.timestamp).toLocaleString()}`
              );

              onOrderFilled(symbol, 'SL', fillPrice);
              continue; // Skip TP check since position is closed
            }

            // Check if order was cancelled
            if (slOrder.status === 'canceled') {
              console.warn(`⚠️ ${symbol} Stop-Loss order was CANCELLED!`);
              console.warn(`   Order ID: ${pos.stopLossOrderId}`);
              console.warn(`   🚨 Position has no stop-loss protection!`);
            }
          } catch (error: any) {
            // Order might not exist if it was filled and archived
            if (error.message.includes('Order does not exist')) {
              console.log(
                `⚠️ ${symbol} SL order not found - may have been filled`
              );
            }
          }
        }

        // Check take-profit order
        if (pos.takeProfitOrderId) {
          try {
            const tpOrder = await this.binance.fetchOrder(
              pos.takeProfitOrderId,
              symbol
            );

            if (tpOrder.status === 'closed' || tpOrder.status === 'filled') {
              const fillPrice = tpOrder.average || tpOrder.price;
              console.log(`\n🎯 ${symbol} TAKE-PROFIT TRIGGERED ON BINANCE`);
              console.log(`   Order ID: ${pos.takeProfitOrderId}`);
              console.log(`   Fill Price: $${fillPrice}`);
              console.log(
                `   Fill Time: ${new Date(tpOrder.timestamp).toLocaleString()}`
              );

              onOrderFilled(symbol, 'TP', fillPrice);
            }

            if (tpOrder.status === 'canceled') {
              console.warn(`⚠️ ${symbol} Take-Profit order was CANCELLED!`);
            }
          } catch (error: any) {
            if (error.message.includes('Order does not exist')) {
              console.log(
                `⚠️ ${symbol} TP order not found - may have been filled`
              );
            }
          }
        }
      }
    } catch (error: any) {
      console.error('❌ Position monitoring error:', error.message);
    }
  }

  /**
   * ✅ CALL THIS AFTER ENTERING A POSITION
   * Verifies the order was placed correctly
   */
  async verifyOrderPlacement(
    symbol: string,
    entryOrderId: string,
    stopLossOrderId: string,
    takeProfitOrderId: string
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      console.log(`\n🔍 Verifying orders for ${symbol}...`);

      // Check entry order
      const entryOrder = await this.binance.fetchOrder(entryOrderId, symbol);
      if (entryOrder.status !== 'closed' && entryOrder.status !== 'filled') {
        errors.push(`Entry order not filled: ${entryOrder.status}`);
      } else {
        console.log(
          `✅ Entry order filled: ${entryOrder.filled} @ $${entryOrder.average}`
        );
      }

      // Check stop-loss order
      const slOrder = await this.binance.fetchOrder(stopLossOrderId, symbol);
      if (slOrder.status === 'canceled' || slOrder.status === 'expired') {
        errors.push(`Stop-loss order inactive: ${slOrder.status}`);
      } else {
        console.log(`✅ Stop-loss order active: ${slOrder.id}`);
      }

      // Check take-profit order
      const tpOrder = await this.binance.fetchOrder(takeProfitOrderId, symbol);
      if (tpOrder.status === 'canceled' || tpOrder.status === 'expired') {
        errors.push(`Take-profit order inactive: ${tpOrder.status}`);
      } else {
        console.log(`✅ Take-profit order active: ${tpOrder.id}`);
      }

      if (errors.length === 0) {
        console.log(`✅ All orders verified for ${symbol}\n`);
        return { valid: true, errors: [] };
      } else {
        console.error(`❌ Order verification failed for ${symbol}:`);
        errors.forEach((err) => console.error(`   - ${err}`));
        return { valid: false, errors };
      }
    } catch (error: any) {
      errors.push(`Verification error: ${error.message}`);
      return { valid: false, errors };
    }
  }

  /**
   * ✅ HELPER: Get current Binance position
   */
  async getPositionInfo(symbol: string): Promise<any> {
    try {
      const positions = await this.binance.fetchPositions([symbol]);
      const position = positions.find((p) => p.symbol === symbol);

      if (!position || parseFloat(position.contracts as any) === 0) {
        return null;
      }

      return {
        symbol: position.symbol,
        side: position.side,
        contracts: position.contracts,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
        unrealizedPnl: position.unrealizedPnl,
        percentage: position.percentage,
        leverage: position.leverage,
        notional: position.notional,
        liquidationPrice: position.liquidationPrice,
      };
    } catch (error: any) {
      console.error(`❌ Error fetching position for ${symbol}:`, error.message);
      return null;
    }
  }

  /**
   * ✅ HELPER: Cancel all orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<void> {
    try {
      const openOrders = await this.binance.fetchOpenOrders(symbol);

      for (const order of openOrders) {
        await this.binance.cancelOrder(order.id, symbol);
        console.log(`🗑️  Cancelled order ${order.id} for ${symbol}`);
      }

      console.log(`✅ All orders cancelled for ${symbol}`);
    } catch (error: any) {
      console.error(`❌ Error cancelling orders for ${symbol}:`, error.message);
    }
  }

  /**
   * ✅ HELPER: Close position manually
   */
  async closePosition(symbol: string, side: 'LONG' | 'SHORT'): Promise<void> {
    try {
      // Get position size
      const position = await this.getPositionInfo(symbol);

      if (!position) {
        console.log(`No position to close for ${symbol}`);
        return;
      }

      // Cancel all orders first
      await this.cancelAllOrders(symbol);

      // Close position with market order
      const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
      const closeOrder = await this.binance.createMarketOrder(
        symbol,
        closeSide,
        Math.abs(position.contracts)
      );

      console.log(`✅ Position closed for ${symbol}`);
      console.log(`   Close price: $${closeOrder.average}`);
      console.log(`   PnL: $${position.unrealizedPnl?.toFixed(2)}`);
    } catch (error: any) {
      console.error(`❌ Error closing position for ${symbol}:`, error.message);
      throw error;
    }
  }

  /**
   * ✅ Get account summary
   */
  async getAccountSummary(): Promise<{
    totalBalance: number;
    usedBalance: number;
    freeBalance: number;
    openPositions: number;
    totalUnrealizedPnl: number;
  }> {
    try {
      const balance = (await this.binance.fetchBalance()) as Balances;
      const positions = await this.binance.fetchPositions();
      const openPositions = positions.filter(
        (p: any) => parseFloat(p.contracts as any) !== 0
      );

      const totalBalance = balance.USDT?.total as number;
      const usedBalance = balance.USDT?.used as number;
      const totalUnrealizedPnl = openPositions.reduce(
        (sum, p) => sum + (p.unrealizedPnl || 0),
        0
      );

      return {
        totalBalance,
        usedBalance,
        freeBalance: totalBalance - usedBalance,
        openPositions: openPositions.length,
        totalUnrealizedPnl,
      };
    } catch (error: any) {
      console.error('❌ Error getting account summary:', error.message);
      throw error;
    }
  }

  /**
   * Set sync interval (in milliseconds)
   */
  setSyncInterval(ms: number): void {
    this.syncInterval = ms;
  }
}
