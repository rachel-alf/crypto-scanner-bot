import * as fs from 'fs';
import * as path from 'path';

import type { BotInstance, CompletedTrade, Position } from '../../lib/type.js';

/**
 * Base interface for bot state that can be extended by Spot/Futures
 */
export interface BaseBotState<T extends BotInstance, P extends Position> {
  version: string;
  lastSave: string;
  totalCapital: number;
  availableCapital: number;
  bots: T[];
  tradeHistory: CompletedTrade[];
}

/**
 * Base interface for trading bot (generic across spot/futures)
 */
export interface BaseTradingBot<T extends BotInstance> {
  getBots(): Map<string, T>;
  getTradeHistory(): CompletedTrade[];
  setTradeHistory(history: CompletedTrade[]): void;
  addBot(bot: T): void;
}

/**
 * Generic Trading Bot Persistence
 * Handles save/load/restore operations for both Spot and Futures bots
 */
export abstract class BaseTradingBotPersistence<
  T extends BotInstance,
  P extends Position,
> {
  protected stateFile: string;
  protected backupFile: string;
  protected autoSaveInterval: NodeJS.Timeout | null = null;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.backupFile = `${stateFile}.backup`;
    this.ensureDirectory();
  }

  /**
   * Ensure state directory exists
   */
  protected ensureDirectory(): void {
    const dir = path.dirname(this.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✅ Created state directory: ${dir}`);
    }
  }

  /**
   * Save bot state to disk
   */
  saveState(
    bot: BaseTradingBot<T>,
    config: { totalCapital: number; availableCapital: number }
  ): void {
    try {
      const bots = bot.getBots();

      const state: BaseBotState<T, P> = {
        version: '1.0.0',
        lastSave: new Date().toISOString(),
        totalCapital: config.totalCapital,
        availableCapital: config.availableCapital,
        bots: this.serializeBots(bot.getBots()),
        tradeHistory: bot.getTradeHistory().slice(0, 50), // Keep last 50
      };

      // Create backup of previous state
      if (fs.existsSync(this.stateFile)) {
        fs.copyFileSync(this.stateFile, this.backupFile);
      }

      // Write new state
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));

      console.log(
        `💾 State saved: ${bots.size} bots, ${state.tradeHistory.length} trades`
      );
    } catch (err: any) {
      console.error(`❌ Failed to save state: ${err.message}`);
    }
  }

  /**
   * Load bot state from disk
   */
  loadState(): BaseBotState<T, P> | null {
    try {
      if (!fs.existsSync(this.stateFile)) {
        console.log('ℹ️  No previous state found');
        return null;
      }

      const content = fs.readFileSync(this.stateFile, 'utf-8');
      const state: BaseBotState<T, P> = JSON.parse(content);

      console.log(`📂 State loaded from: ${state.lastSave}`);
      console.log(`   Bots: ${state.bots.length}`);
      console.log(`   Trade History: ${state.tradeHistory.length}`);
      console.log(`   Capital: $${state.totalCapital}`);

      return state;
    } catch (err: any) {
      console.error(`❌ Failed to load state: ${err.message}`);

      // Try backup
      if (fs.existsSync(this.backupFile)) {
        console.log('🔄 Attempting to load backup...');
        try {
          const content = fs.readFileSync(this.backupFile, 'utf-8');
          return JSON.parse(content);
        } catch {
          console.error('❌ Backup also corrupted');
        }
      }

      return null;
    }
  }

  /**
   * Restore bot state into active bot instance
   */
  restoreState(
    bot: BaseTradingBot<T>,
    state: BaseBotState<T, P>,
    config: { totalCapital: number; availableCapital: number }
  ): void {
    try {
      // Restore capital
      config.totalCapital = state.totalCapital as number;

      // Restore bots with positions
      state.bots.forEach((botState) => {
        const restoredBot = this.deserializeBot(botState);
        bot.addBot(restoredBot);

        if (restoredBot.position) {
          console.log(
            `♻️  Restored position: ${restoredBot.symbol} ${restoredBot.position.side} @ $${restoredBot.position.entryPrice}`
          );
        }
      });

      // Validate and correct trade history
      if (state.tradeHistory && Array.isArray(state.tradeHistory)) {
        let correctionsMade = 0;

        const correctedTrades = state.tradeHistory.map((trade) => {
          const deserializedTrade = this.deserializeTrade(trade);

          // Validate: If isWin doesn't match exitReason, fix it
          if (
            deserializedTrade.isWin &&
            deserializedTrade.exitReason === 'STOP_LOSS'
          ) {
            console.log(
              `⚠️  Correcting ${deserializedTrade.symbol}: WIN but marked as STOP_LOSS → TAKE_PROFIT`
            );
            deserializedTrade.exitReason = 'TAKE_PROFIT';
            correctionsMade++;
          } else if (
            !deserializedTrade.isWin &&
            deserializedTrade.exitReason === 'TAKE_PROFIT'
          ) {
            console.log(
              `⚠️  Correcting ${deserializedTrade.symbol}: LOSS but marked as TAKE_PROFIT → STOP_LOSS`
            );
            deserializedTrade.exitReason = 'STOP_LOSS';
            correctionsMade++;
          }

          // Double-check: Validate isWin matches pnlUsd sign
          const shouldBeWin = deserializedTrade.pnlUsd > 0;
          if (deserializedTrade.isWin !== shouldBeWin) {
            console.log(
              `⚠️  Correcting ${deserializedTrade.symbol}: isWin=${deserializedTrade.isWin} but PnL=$${deserializedTrade.pnlUsd.toFixed(2)}`
            );
            deserializedTrade.isWin = shouldBeWin;
            deserializedTrade.exitReason = shouldBeWin
              ? 'TAKE_PROFIT'
              : 'STOP_LOSS';
            correctionsMade++;
          }

          return deserializedTrade;
        });

        bot.setTradeHistory(correctedTrades);

        console.log(
          `📜 Restored ${correctedTrades.length} completed trades from history`
        );

        if (correctionsMade > 0) {
          console.log(
            `✅ Auto-corrected ${correctionsMade} trades with mismatched exit reasons`
          );

          // Save the corrected data back to disk immediately
          console.log(`💾 Saving corrected trade history...`);
          setTimeout(() => {
            this.saveState(bot, config);
          }, 1000);
        }

        if (correctedTrades.length > 0) {
          const wins = correctedTrades.filter((t) => t.isWin).length;
          const losses = correctedTrades.length - wins;
          const totalPnl = correctedTrades.reduce(
            (sum, t) => sum + t.pnlUsd,
            0
          );

          console.log(
            `   Wins: ${wins} | Losses: ${losses} | Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT`
          );
        }
      }

      console.log(
        `✅ Bot state restored successfully. Capital: $${config.totalCapital}`
      );
    } catch (err: any) {
      console.error(`❌ Failed to restore state: ${err.message}`);
    }
  }

  /**
   * Start auto-save (default: every 30 seconds)
   */
  startAutoSave(
    bot: BaseTradingBot<T>,
    config: { totalCapital: number; availableCapital: number },
    intervalMs: number = 30000
  ): void {
    this.autoSaveInterval = setInterval(() => {
      this.saveState(bot, config);
    }, intervalMs);

    console.log(`✅ Auto-save enabled (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop auto-save
   */
  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }

  /**
   * Serialize bots for storage
   */
  protected serializeBots(bots: Map<string, T>): T[] {
    const serialized: T[] = [];

    bots.forEach((bot) => {
      serialized.push({
        ...bot,
        position: bot.position
          ? this.serializePosition(bot.position as P)
          : null,
      } as T);
    });

    return serialized;
  }

  /**
   * Deserialize trade from storage
   */
  protected deserializeTrade(trade: CompletedTrade): CompletedTrade {
    return {
      symbol: trade.symbol,
      strategy: trade.strategy,
      side: trade.side,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      amount: trade.amount,
      stopLoss: trade.stopLoss || 0,
      takeProfit: trade.takeProfit || 0,
      pnlUsd: trade.pnlUsd,
      pnlPct: trade.pnlPct,
      duration: trade.duration,
      exitReason: trade.exitReason,
      entryTime: new Date(trade.entryTime),
      exitTime: new Date(trade.exitTime),
      isWin: trade.isWin,
    };
  }

  // ============================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ============================================

  /**
   * Serialize position for storage (Futures vs Spot differ here)
   */
  protected abstract serializePosition(pos: P): P;

  /**
   * Deserialize bot from storage (Futures vs Spot differ here)
   */
  protected abstract deserializeBot(state: T): T;

  /**
   * Deserialize position from storage (Futures vs Spot differ here)
   */
  protected abstract deserializePosition(state: P): P;
}
