import fs from 'fs';
import path from 'path';
import readline from 'readline';

import ccxt, { type binance, type Exchange, type Order } from 'ccxt';
import * as dotenv from 'dotenv';
import { ATR } from 'technicalindicators';

import {
  colors,
  getAmountDecimals,
  getContractMultiplier,
  getPriceDecimals,
  is1000xSymbol,
  normalize,
  rgb,
} from '../../lib/helpers.js';
import { detectRegime } from '../../lib/trading-utils.js';
import {
  type BotInstance,
  type CandleData,
  type CompletedTrade,
  type CooldownInfo,
  type EntrySignal,
  type EntryType,
  type Indicators,
  type MorayPosition,
  type OpenPositionParams,
  type OrderResult,
  type PartialTarget,
  type Position,
  type ReasonType,
  type Regime,
  type ScanResult,
  type SignalState,
  type StopLossParams,
  type StrategyId,
  type TakeProfitParams,
} from '../../lib/type.js';
import {
  adjustMorayForRegime,
  displayMorayBanner,
  formatPartialLog,
  MORAY_CONFIG,
  MorayPartialSystem,
} from '../../src/core/moray-partial-system.js';
import { BinanceDataFetcher } from '../core/binance-data-fetcher.js';
import {
  BaseTradingBotPersistence,
  type BaseTradingBot,
} from '../core/bot-persistence.js';
import { CandleManager } from '../core/candles.js';
import {
  debugCapitalState,
  getCapitalStatus,
  initializeCapital,
  releaseCapital,
  reserveCapital,
} from '../core/capital-manager.js';
import { IndicatorManager } from '../core/indicator-manager.js';
import type { LiquidityClassification } from '../core/liquidity-classifier.js';
import { classifyLiquidity } from '../core/liquidity-classifier.js';
import { PositionManager } from '../core/position-manager.js';
import { PositionReconciliationService } from '../core/position-recon-services.js';
import { PriceFetcher } from '../core/price-fetcher.js';
import { checkRegimeDegradation } from '../core/regime-degradation-check.js';
import { SymbolValidator } from '../core/symbol-validator.js';
import { initTrailingState } from '../core/trailling-monitor-loop.js';
import {
  getTrailingProfile,
  type TrailingProfile,
} from '../core/trailling-stop-mapper.js';
import { RISK_REWARD_CONFIG } from '../scanner/scan.js';
import { LoggerFactory } from './../../lib/logger.js';
import {
  CONFIG,
  getFuturesConfigForSymbol,
  validateConfig,
} from './future-config.js';
import { TradeRejectionLogger } from './trade-logger.js';

dotenv.config();

interface OrderMonitorConfig {
  pollInterval: number;
  maxRetries: number;
  useWebSocket: boolean;
}

export interface FuturesPosition extends Position {
  leverage: number;
  notionalValue: number;
  marginUsed: number;

  partialTargets?: PartialTarget[];
  breakEvenMoved?: boolean;
  partialPnlRealized?: number;
}

export interface TradeCounters {
  total: number;
  today: number;
  perSymbol: Map<string, number>;
  sessionStart: Date;
}

interface PriceFetchAttempt {
  symbol: string;
  attempts: number;
  lastAttempt: number;
  lastError?: string;
}

interface Balance {
  free?: { [currency: string]: number };
  used?: { [currency: string]: number };
  total?: { [currency: string]: number };
  info?: any;
  timestamp?: number;
  datetime?: string;
}

/**
 * Futures-specific bot instance
 */
export interface FuturesBotInstance extends BotInstance {
  position: FuturesPosition | null;
  priceHistory?: any[];
  lastUpdate?: Date;
}

if (
  !process.env.BINANCE_FUTURE_API_KEY ||
  !process.env.BINANCE_FUTURE_API_SECRET
) {
  throw Error('Missing BINANCE_FUTURE_API_KEY or BINANCE_FUTURE_API_SECRET');
}

const api = process.env.BINANCE_FUTURE_API_KEY;
const secret = process.env.BINANCE_FUTURE_API_SECRET;

export function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const configForLogging = {
  ...CONFIG,
  availableCapital: CONFIG.availableCapital,
  positionSize: CONFIG.positionSize,
  marginPerPosition: CONFIG.marginPerPosition,
};

/**
 * AGGRESSIVE MORAY (Faster exits, higher win rate)
 */
const AGGRESSIVE_MORAY = {
  partials: [
    { ratio: 1.0, percent: 0.6, label: 'Quick Snatch 🥩' },
    { ratio: 2.0, percent: 0.3, label: 'Safety Net 🍖' },
    { ratio: 4.0, percent: 0.1, label: 'Moonshot 🎯' },
  ],
  moveToBreakEvenAfter: 1.0,
};

/**
 * CONSERVATIVE MORAY (More room to run, lower win rate but bigger wins)
 */
const CONSERVATIVE_MORAY = {
  partials: [
    { ratio: 2.0, percent: 0.4, label: 'Patient Wait 🥩' },
    { ratio: 3.5, percent: 0.4, label: 'Good Profit 🍖' },
    { ratio: 6.0, percent: 0.2, label: 'Big Fish 🎯' },
  ],
  moveToBreakEvenAfter: 2.0,
};

/**
 * BALANCED MORAY (Current default - recommended for beginners)
 */
const BALANCED_MORAY = {
  partials: [
    { ratio: 1.5, percent: 0.5, label: 'First Bite 🥩' },
    { ratio: 2.5, percent: 0.3, label: 'Second Helping 🍖' },
    { ratio: 4.0, percent: 0.2, label: 'Runner 🎯' },
  ],
  moveToBreakEvenAfter: 1.5,
};

let paperBalance = CONFIG.availableCapital;
const CONFIG_FUTURE = getFuturesConfigForSymbol(
  process.env.TRADING_SYMBOL_FUTURES || 'BTCUSDT'
);
const logger = LoggerFactory.getFuturesLogger(CONFIG_FUTURE.SYMBOL);

class LightweightSignalReader {
  private signalQueue: EntrySignal[] = [];
  private outputFile = './data/signals/futures-signals.json';
  private lastReadTime = 0;
  private readonly SIGNAL_EXPIRY_MS = configForLogging.signalExpiryMs;

  constructor() {
    this.checkFileExists();
  }

  private checkFileExists(): void {
    if (!fs.existsSync(this.outputFile)) {
      console.log(`⚠️  Scanner output not found: ${this.outputFile}`);

      const dir = './data/signals';
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created signals directory: ${dir}`);
      }
    } else {
      console.log(`✅ Found scanner output: ${this.outputFile}`);
    }
  }

  readLatestSignals(): EntrySignal[] {
    try {
      if (!fs.existsSync(this.outputFile)) {
        return [];
      }

      const stats = fs.statSync(this.outputFile);
      const fileTime = stats.mtimeMs;

      if (fileTime <= this.lastReadTime) {
        return this.signalQueue;
      }

      const fileContent = fs.readFileSync(this.outputFile, 'utf-8');

      if (!fileContent.trim()) {
        this.signalQueue = [];
        return [];
      }

      const data = JSON.parse(fileContent);

      if (!Array.isArray(data) || data.length === 0) {
        this.signalQueue = [];
        return [];
      }

      this.signalQueue = data
        .filter((result: ScanResult) => {
          if (!result || !result.signal) return false;
          if (!result.symbol) return false;
          if (result.confidence < configForLogging.minConfidence) return false;

          const strategy = result.signal.strategy as StrategyId;
          if (configForLogging.blockedStrategies.includes(strategy)) {
            console.log(
              `⛔ Blocked strategy: ${strategy} for ${result.symbol}`
            );
            return false;
          }

          return true;
        })
        .map((result: any) => {
          const futuresSymbol = normalize(result.symbol);

          const signal: EntrySignal = {
            symbol: futuresSymbol,
            confidence: result.confidence,
            side: result.signal.side,
            strategy: result.signal.strategy,
            reason: result.signal.reason,
            entryPrice: result.price,
            stopLoss: result.signal.stopLoss,
            takeProfit: (() => {
              const entry = result.price;
              const scannerSL = result.signal.stopLoss;
              const risk = Math.abs(entry - scannerSL);
              const reward = risk * 2.7;

              return result.signal.side === 'LONG'
                ? entry + reward
                : entry - reward;
            })(),
            timestamp: new Date(result.timestamp || Date.now()),
          };

          return signal;
        })
        .sort((a, b) => b.confidence - a.confidence);

      this.lastReadTime = fileTime;
      this.cleanupExpiredSignals();

      if (this.signalQueue.length > 0) {
        const longCount = this.signalQueue.filter(
          (s) => s?.side === 'LONG'
        ).length;
        const shortCount = this.signalQueue.filter(
          (s) => s?.side === 'SHORT'
        ).length;
        console.log(`   LONG: ${longCount}, SHORT: ${shortCount}`);
      }

      return this.signalQueue;
    } catch (err: any) {
      log(`❌ Error reading signals: ${err.message}`, 'error');
      return [];
    }
  }

  private cleanupExpiredSignals(): void {
    const now = Date.now();
    const beforeCount = this.signalQueue.length;

    this.signalQueue = this.signalQueue.filter((signal) => {
      if (!signal || !signal.timestamp) return false;
      const age = now - signal.timestamp.getTime();
      return age < this.SIGNAL_EXPIRY_MS;
    });

    const removed = beforeCount - this.signalQueue.length;
    if (removed > 0) {
      log(`🧹 Removed ${removed} expired signals`, 'info');
    }
  }

  getBestSignal(excludeSymbols: Set<string>): EntrySignal | null {
    const available = this.signalQueue.filter(
      (s) => s && !excludeSymbols.has(s.symbol)
    );

    if (available.length > 0) {
      const best = available[0] as EntrySignal;
      console.log(
        `🎯 Best signal: ${best?.symbol} ${best?.side} (${best?.confidence.toFixed(1)}%)`
      );
      return best;
    }

    return null;
  }

  removeSignal(symbol: string): void {
    this.signalQueue = this.signalQueue.filter((s) => s?.symbol !== symbol);
  }

  getStats(activeBots: Map<string, BotInstance>) {
    const validSignals = this.signalQueue.filter((s) => s != null);

    return {
      totalSignals: validSignals.length,
      longSignals: validSignals.filter((s) => s.side === 'LONG').length,
      shortSignals: validSignals.filter((s) => s.side === 'SHORT').length,
      avgConfidence:
        validSignals.length > 0
          ? validSignals.reduce((sum, s) => sum + (s.confidence || 0), 0) /
            validSignals.length
          : 0,
    };
  }
}

class EnhancedSignalReader extends LightweightSignalReader {
  private signalStates: Map<string, SignalState> = new Map();
  private tradeHistory: CompletedTrade[] = [];
  private stateFile = './data/signals/scanner-output.json';
  private historyFile = './data/signals/trade-history.json';
  private autoSaveInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.loadState();
    this.loadTradeHistory();
    this.startAutoSave();
  }

  importTradesFromBot(botTradeHistory: CompletedTrade[]): void {
    const newTrades = botTradeHistory.filter((botTrade) => {
      return !this.tradeHistory.some(
        (existingTrade) =>
          existingTrade.symbol === botTrade.symbol &&
          existingTrade.entryTime.getTime() === botTrade.entryTime.getTime()
      );
    });

    if (newTrades.length > 0) {
      this.tradeHistory.push(...newTrades);

      this.tradeHistory.sort(
        (a, b) => b.exitTime.getTime() - a.exitTime.getTime()
      );

      if (this.tradeHistory.length > 1000) {
        this.tradeHistory = this.tradeHistory.slice(0, 1000);
      }

      this.saveTradeHistory();

      console.log(`📝 Imported ${newTrades.length} new trades to history`);
    }
  }

  /**
   * ✅ NEW: Load trade history from disk
   */
  private loadTradeHistory(): void {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
      }

      if (!fs.existsSync(this.historyFile)) {
        console.log('ℹ️  No trade history found, starting fresh');
        this.tradeHistory = [];
        return;
      }

      const content = fs.readFileSync(this.historyFile, 'utf-8');

      if (!content || content.trim() === '') {
        console.log('⚠️  History file is empty, starting fresh');
        this.tradeHistory = [];
        return;
      }

      const data = JSON.parse(content);

      if (!data || !Array.isArray(data.history)) {
        console.warn('⚠️  Invalid history format, starting fresh');
        this.tradeHistory = [];
        return;
      }

      this.tradeHistory = data.history.map((entry: any) => ({
        symbol: entry.symbol,
        side: entry.side,
        strategy: entry.strategy,
        entryPrice: entry.entryPrice,
        exitPrice: entry.exitPrice,
        stopLoss: entry.stopLoss,
        takeProfit: entry.takeProfit,
        amount: entry.amount,

        pnlUsd: entry.pnlUsd || entry.pnl || 0,
        pnlPct: entry.pnlPct || entry.pnlPercent || 0,

        duration: entry.duration,
        confidence: entry.confidence,
        entryTime: new Date(entry.entryTime),
        exitTime: new Date(entry.exitTime),
        exitReason: entry.exitReason,
        isWin: entry.isWin,
        leverage: entry.leverage,
        marginUsed: entry.marginUsed,
        notionalValue: entry.notionalValue || entry.positionSize,
        rawPnl: entry.rawPnl,
        tradeId: entry.tradeId || entry.botId,
      }));

      console.log(`📚 Loaded ${this.tradeHistory.length} historical trades`);

      if (this.tradeHistory.length > 0) {
        const oldest = this.tradeHistory[
          this.tradeHistory.length - 1
        ] as CompletedTrade;
        const newest = this.tradeHistory[0] as CompletedTrade;
        console.log(`   Oldest: ${oldest.exitTime.toLocaleDateString()}`);
        console.log(`   Newest: ${newest.exitTime.toLocaleDateString()}`);
      }
    } catch (err: any) {
      console.error(`❌ Failed to load trade history: ${err.message}`);
      console.error(`   Starting with empty history`);
      this.tradeHistory = [];
    }
  }

  /**
   * ✅ IMPROVED: Save both states and history
   */
  private saveState(
    bot?: FuturesTradingBot,
    tradeCounters?: {
      total: number;
      today: number;
      perSymbol: Map<string, number>;
      sessionStart: Date;
    }
  ): void {
    try {
      const counters = (tradeCounters ||
        bot?.getTradeCounters?.()) as TradeCounters;
      const states: Record<string, any> = {};

      this.signalStates.forEach((state, symbol) => {
        states[symbol] = {
          status: state.status,
          takenAt: state.takenAt?.toISOString(),
          botId: state.botId,
          entryPrice: state.entryPrice,
          exitedAt: state.exitedAt?.toISOString(),
          pnl: state.pnl,
        };
      });

      const stateData = {
        lastUpdate: new Date().toISOString(),
        totalStates: this.signalStates.size,
        tradeCounters: (counters as TradeCounters)
          ? {
              total: counters.total,
              today: counters.today,
              perSymbol: Object.fromEntries(counters.perSymbol),
              sessionStart: counters.sessionStart.toISOString(),
            }
          : undefined,
        states,
      };

      fs.writeFileSync(this.stateFile, JSON.stringify(stateData, null, 2));

      this.saveTradeHistory();
    } catch (err: any) {
      console.error(`Failed to save state: ${err.message}`);
    }
  }

  /**
   * ✅ NEW: Save trade history to disk
   */
  private saveTradeHistory(): void {
    try {
      console.log(`\n💾 Saving trade history...`);
      console.log(`   Total trades: ${this.tradeHistory.length}`);

      if (this.tradeHistory.length === 0) {
        console.log(`   ⚠️ Trade history is EMPTY! Nothing to save.`);
        console.log(`   This means trades are not being added to the array!`);
      }

      const historyData = {
        lastUpdate: new Date().toISOString(),
        totalTrades: this.tradeHistory.length,
        history: this.tradeHistory.map((entry: any) => ({
          symbol: entry.symbol,
          side: entry.side,
          strategy: entry.strategy,
          entryPrice: entry.entryPrice,
          exitPrice: entry.exitPrice,
          stopLoss: entry.stopLoss,
          takeProfit: entry.takeProfit,
          pnl: entry.pnlUsd,
          pnlPercent: entry.pnlPct,
          confidence: entry.confidence,
          entryTime: entry.entryTime.toISOString(),
          exitTime: entry.exitTime.toISOString(),
          exitReason: entry.exitReason,
          botId: entry.tradeId,
          positionSize: entry.notionalValue,
          leverage: entry.leverage,
        })),
      };

      fs.writeFileSync(this.historyFile, JSON.stringify(historyData, null, 2));
      console.log(`   ✅ Saved to ${this.historyFile}\n`);
    } catch (err: any) {
      console.error(`   ❌ Failed to save trade history: ${err.message}`);
    }
  }

  /**
   * Load signal states from disk
   */
  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFile)) {
        console.log('ℹ️  No previous signal state found, starting fresh');
        return;
      }

      const content = fs.readFileSync(this.stateFile, 'utf-8');
      const data = JSON.parse(content);

      if (data && data.states) {
        Object.entries(data.states).forEach(
          ([symbol, state]: [string, any]) => {
            this.signalStates.set(symbol, {
              status: state.status,
              takenAt: state.takenAt
                ? new Date(state.takenAt)
                : (undefined as any),
              botId: state.botId,
              entryPrice: state.entryPrice,
              exitedAt: state.exitedAt
                ? new Date(state.exitedAt)
                : (undefined as any),
              pnl: state.pnl,
            } as SignalState);
          }
        );

        console.log(`📂 Loaded state for ${this.signalStates.size} signals`);
        this.cleanupOldStates();
      }
    } catch (err: any) {
      console.error(`Failed to load signal state: ${err.message}`);
    }
  }

  /**
   * Save signal states to disk
   */

  /**
   * Start auto-save every 30 seconds
   */
  private startAutoSave(bot?: FuturesTradingBot): void {
    this.autoSaveInterval = setInterval(() => {
      this.saveState(bot);
    }, 30000);
  }

  /**
   * Record a completed trade to history
   */

  recordCompletedTrade(trade: CompletedTrade): void {
    const isDupe = this.tradeHistory.some((t) => t.tradeId === trade.tradeId);
    if (isDupe) return;

    this.tradeHistory.unshift(trade);

    if (this.tradeHistory.length > 1000) {
      this.tradeHistory = this.tradeHistory.slice(0, 1000);
    }

    this.saveTradeHistory();

    console.log(`📝 Saved trade #${this.tradeHistory.length}`);
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
   * Override: Read latest signals and filter by state
   */
  readLatestSignals(): EntrySignal[] {
    const allSignals = super.readLatestSignals();

    const availableSignals = allSignals.filter((signal) => {
      const state = this.signalStates.get(signal.symbol);

      if (state && state.status === 'IN_TRADE') {
        console.log(`⏳ ${signal.symbol} already in trade - skipping`);
        return false;
      }

      if (state && state.status === 'COMPLETED' && state.exitedAt) {
        const timeSinceExit = Date.now() - state.exitedAt.getTime();
        if (timeSinceExit < 120000) {
          console.log(`🕐 ${signal.symbol} recently completed - cooling down`);
          return false;
        }
      }

      return true;
    });

    return availableSignals;
  }

  /**
   * Override: Get best signal (excludes in-trade signals automatically)
   */
  getBestSignal(excludeSymbols: Set<string>): EntrySignal | null {
    const available = this.readLatestSignals().filter(
      (s) => s && !excludeSymbols.has(s.symbol)
    );

    if (available.length > 0) {
      const best = available[0] as EntrySignal;
      console.log(
        `🎯 Best signal: ${best?.symbol} ${best?.side} (${best?.confidence.toFixed(1)}%)`
      );
      return best;
    }

    console.log('ℹ️  No available signals');
    return null;
  }

  /**
   * Mark signal as taken (in trade)
   */
  markSignalAsTaken(symbol: string, botId: string, entryPrice: number): void {
    this.signalStates.set(symbol, {
      status: 'IN_TRADE',
      takenAt: new Date(),
      botId,
      entryPrice,
    });

    this.saveState();
    console.log(`🔒 Marked ${symbol} as IN_TRADE @ $${entryPrice.toFixed(6)}`);
  }

  /**
   * Mark signal as completed (position closed)
   */
  markSignalAsCompleted(
    symbol: string,
    pnl?: number,
    trade?: CompletedTrade
  ): void {
    const state = this.signalStates.get(symbol);

    if (state) {
      state.status = 'COMPLETED';
      state.exitedAt = new Date();
      state.pnl = pnl as number;

      this.saveState();
      console.log(
        `✅ Marked ${symbol} as COMPLETED ${pnl !== undefined ? `(PnL: $${pnl.toFixed(2)})` : ''}`
      );

      setTimeout(() => {
        this.signalStates.delete(symbol);
        this.saveState();
        console.log(`🗑️  Removed ${symbol} state (cooldown complete)`);
      }, 300000);
    }
  }

  /**
   * Release signal (make available again if bot fails)
   */
  releaseSignal(symbol: string): void {
    const state = this.signalStates.get(symbol);

    if (state && state.status === 'IN_TRADE') {
      this.signalStates.delete(symbol);
      this.saveState();
      console.log(`🔓 Released ${symbol} back to available pool`);
    }
  }

  /**
   * Check if symbol is currently in trade
   */
  isInTrade(symbol: string): boolean {
    const state = this.signalStates.get(symbol);
    return state?.status === 'IN_TRADE';
  }

  /**
   * Get state for a symbol
   */
  getSignalState(symbol: string): SignalState | undefined {
    return this.signalStates.get(symbol);
  }

  /**
   * Clean up old completed/expired states (older than 1 hour)
   */
  private cleanupOldStates(): void {
    const now = Date.now();
    let removed = 0;

    for (const [symbol, state] of this.signalStates.entries()) {
      if (state.status === 'COMPLETED' && state.exitedAt) {
        const age = now - state.exitedAt.getTime();
        if (age > 3600000) {
          this.signalStates.delete(symbol);
          removed++;
        }
      } else if (state.status === 'IN_TRADE' && state.takenAt) {
        const age = now - state.takenAt.getTime();
        if (age > 86400000) {
          console.log(`⚠️  ${symbol} in trade for 24h+ - marking as stale`);
          this.signalStates.delete(symbol);
          removed++;
        }
      }
    }

    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} old signal states`);
      this.saveState();
    }
  }

  /**
   * Override: Get enhanced stats including state info
   */
  getStats(activeBots: Map<string, BotInstance>) {
    const baseStats = super.getStats(activeBots);

    const stateInTradeCount = Array.from(this.signalStates.values()).filter(
      (s) => s.status === 'IN_TRADE'
    ).length;

    const actualInTradeCount = Array.from(activeBots.values()).filter(
      (b) => b.position !== null
    ).length;

    if (stateInTradeCount !== actualInTradeCount) {
      console.log(`\n⚠️  Signal state mismatch detected!`);
      console.log(`   State file says: ${stateInTradeCount} in trade`);
      console.log(`   Actual bots: ${actualInTradeCount} in trade`);
      console.log(`   Cleaning up stale signals...\n`);

      this.syncStateWithBots(activeBots);
    }

    const completedCount = Array.from(this.signalStates.values()).filter(
      (s) => s.status === 'COMPLETED'
    ).length;

    return {
      ...baseStats,
      inTrade: actualInTradeCount,
      completed: completedCount,
      totalTracked: this.signalStates.size,
    };
  }

  /**
   * ✅ NEW: Sync signal state with actual active bots
   */
  private syncStateWithBots(activeBots: Map<string, BotInstance>): void {
    const activeSymbols = new Set<string>();

    for (const [symbol, bot] of activeBots.entries()) {
      if (bot.position) {
        activeSymbols.add(symbol);

        const state = this.signalStates.get(symbol);

        if (!state || state.status !== 'IN_TRADE') {
          console.log(`   📝 Adding missing IN_TRADE signal: ${symbol}`);
          this.signalStates.set(symbol, {
            status: 'IN_TRADE',
            takenAt: bot.position.entryTime || new Date(),
            botId: bot.position.positionId,
            entryPrice: bot.position.entryPrice,
          });
        }
      }
    }

    let fixed = 0;
    for (const [symbol, state] of this.signalStates.entries()) {
      if (state.status === 'IN_TRADE' && !activeSymbols.has(symbol)) {
        console.log(`   🧹 Removing stale IN_TRADE signal: ${symbol}`);
        this.signalStates.delete(symbol);
        fixed++;
      }
    }

    if (fixed > 0) {
      this.saveState();
      console.log(`   ✅ Cleaned up ${fixed} stale signal(s)\n`);
    } else {
      this.saveState();
      console.log(`✅ Signal states synced successfully\n`);
    }
  }

  /**
   * ✅ NEW: Get detailed signal state for debugging
   */
  getStateDebugInfo() {
    const states = Array.from(this.signalStates.entries()).map(
      ([symbol, state]) => ({
        symbol,
        status: state.status,
        takenAt: state.takenAt?.toISOString(),
        exitedAt: state.exitedAt?.toISOString(),
        botId: state.botId,
      })
    );

    return {
      totalTracked: this.signalStates.size,
      inTrade: states.filter((s) => s.status === 'IN_TRADE').length,
      completed: states.filter((s) => s.status === 'COMPLETED').length,
      states,
    };
  }

  /**
   * Get all signals in trade
   */
  getInTradeSignals(): Array<{ symbol: string; state: SignalState }> {
    const inTrade: Array<{ symbol: string; state: SignalState }> = [];

    this.signalStates.forEach((state, symbol) => {
      if (state.status === 'IN_TRADE') {
        inTrade.push({ symbol, state });
      }
    });

    return inTrade;
  }

  /**
   * Export state for debugging
   */
  exportState(): any {
    return {
      totalSignals: this.signalStates.size,
      states: Array.from(this.signalStates.entries()).map(
        ([symbol, state]) => ({
          symbol,
          status: state.status,
          takenAt: state.takenAt?.toISOString(),
          entryPrice: state.entryPrice,
          exitedAt: state.exitedAt?.toISOString(),
          pnl: state.pnl,
        })
      ),
    };
  }
}

class PriceCache {
  private cacheFile = './data/signals/price-cache.json';
  private cache: Map<string, { price: number; timestamp: number }> = new Map();
  private cacheExpiryMs = 60000;
  private cleanupInterval?: NodeJS.Timeout | undefined;

  constructor() {
    this.loadCache();
    this.startAutoCleanup();
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        console.log('ℹ️  No price cache found, starting fresh');
        return;
      }

      const content = fs.readFileSync(this.cacheFile, 'utf-8');
      const data = JSON.parse(content);

      if (data && data.prices) {
        let loadedCount = 0;
        let expiredCount = 0;
        const now = Date.now();

        Object.entries(data.prices).forEach(([symbol, info]: [string, any]) => {
          const age = now - info.timestamp;
          if (age > this.cacheExpiryMs) {
            expiredCount++;
            return;
          }

          this.cache.set(symbol, {
            price: info.price,
            timestamp: info.timestamp,
          });
          loadedCount++;
        });

        if (loadedCount > 0) {
          console.log(`💾 Loaded ${loadedCount} cached price(s)`);
        }
        if (expiredCount > 0) {
          console.log(`🧹 Skipped ${expiredCount} expired price(s)`);
        }
      }
    } catch (err: any) {
      console.error(`❌ Failed to load price cache: ${err.message}`);
    }
  }

  private saveCache(): void {
    try {
      const prices: Record<string, any> = {};

      this.cache.forEach((info, symbol) => {
        prices[symbol] = {
          price: info.price,
          timestamp: info.timestamp,
        };
      });

      const data = {
        lastUpdate: new Date().toISOString(),
        expiryMs: this.cacheExpiryMs,
        totalCached: this.cache.size,
        prices,
      };

      const dir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`❌ Failed to save price cache: ${err.message}`);
    }
  }

  getPrice(symbol: string): number | null {
    const cached = this.cache.get(symbol);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > this.cacheExpiryMs) {
      this.cache.delete(symbol);
      return null;
    }

    return cached.price;
  }

  setPrice(symbol: string, price: number): void {
    if (!price || isNaN(price) || price <= 0) {
      console.error(`❌ Invalid price for ${symbol}: ${price}`);
      return;
    }

    this.cache.set(symbol, {
      price,
      timestamp: Date.now(),
    });
  }

  setPrices(prices: Map<string, number>): void {
    let validCount = 0;
    let invalidCount = 0;

    prices.forEach((price, symbol) => {
      if (!price || isNaN(price) || price <= 0) {
        console.error(`❌ Invalid price for ${symbol}: ${price}`);
        invalidCount++;
        return;
      }

      this.cache.set(symbol, {
        price,
        timestamp: Date.now(),
      });
      validCount++;
    });

    if (validCount > 0) {
      this.saveCache();
      console.log(`💾 Cached ${validCount} price(s) to disk`);
    }

    if (invalidCount > 0) {
      console.log(`⚠️  Skipped ${invalidCount} invalid price(s)`);
    }
  }

  hasPrice(symbol: string): boolean {
    return this.getPrice(symbol) !== null;
  }

  getCacheAge(symbol: string): number | null {
    const cached = this.cache.get(symbol);
    if (!cached) return null;

    return Date.now() - cached.timestamp;
  }

  getCachedSymbols(): string[] {
    const now = Date.now();
    const validSymbols: string[] = [];

    this.cache.forEach((info, symbol) => {
      const age = now - info.timestamp;
      if (age <= this.cacheExpiryMs) {
        validSymbols.push(symbol);
      }
    });

    return validSymbols;
  }

  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.saveCache();
    console.log(`🗑️  Cleared ${count} cached price(s)`);
  }

  clearSymbol(symbol: string): boolean {
    const existed = this.cache.delete(symbol);
    if (existed) {
      this.saveCache();
      console.log(`🗑️  Cleared cache for ${symbol}`);
    }
    return existed;
  }

  getStats(): {
    total: number;
    valid: number;
    expired: number;
    oldestAge: number;
    newestAge: number;
  } {
    const now = Date.now();
    let valid = 0;
    let expired = 0;
    let oldestAge = 0;
    let newestAge = Infinity;

    this.cache.forEach((info) => {
      const age = now - info.timestamp;

      if (age > this.cacheExpiryMs) {
        expired++;
      } else {
        valid++;
        oldestAge = Math.max(oldestAge, age);
        newestAge = Math.min(newestAge, age);
      }
    });

    return {
      total: this.cache.size,
      valid,
      expired,
      oldestAge,
      newestAge: newestAge === Infinity ? 0 : newestAge,
    };
  }

  printStatus(): void {
    const stats = this.getStats();
    console.log('\n📊 Price Cache Status:');
    console.log(`   Total: ${stats.total}`);
    console.log(`   Valid: ${stats.valid}`);
    console.log(`   Expired: ${stats.expired}`);

    if (stats.valid > 0) {
      console.log(`   Oldest: ${(stats.oldestAge / 1000).toFixed(1)}s ago`);
      console.log(`   Newest: ${(stats.newestAge / 1000).toFixed(1)}s ago`);
    }
  }

  private startAutoCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let removed = 0;

      for (const [symbol, info] of this.cache.entries()) {
        const age = now - info.timestamp;
        if (age > this.cacheExpiryMs) {
          this.cache.delete(symbol);
          removed++;
        }
      }

      if (removed > 0) {
        console.log(`🧹 Cleaned up ${removed} expired price(s)`);
        this.saveCache();
      }
    }, 60000);
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.saveCache();
    console.log('💾 Price cache saved and destroyed');
  }
}

function colorize(text: string, color: string): string {
  return `${color}${text}${colors.reset}`;
}

function colorPnL(value: number, isPercent: boolean = false): string {
  if (typeof value !== 'number' || isNaN(value)) {
    return colorize('N/A', colors.gray);
  }
  const formatted = isPercent
    ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
    : `${value >= 0 ? '+' : ''}${value.toFixed(2)} USDT`;
  if (value > 0) return colorize(formatted, colors.brightGreen);
  if (value < 0) return colorize(formatted, colors.brightRed);
  return colorize(formatted, colors.gray);
}

function log(
  message: string,
  level: 'info' | 'success' | 'warning' | 'error' = 'info'
) {
  const timestamp = new Date().toLocaleTimeString();
  let prefix = '';
  let color = colors.cyan;

  switch (level) {
    case 'success':
      prefix = '✅';
      color = colors.brightGreen;
      break;
    case 'warning':
      prefix = '⚠️';
      color = colors.brightYellow;
      break;
    case 'error':
      prefix = '❌';
      color = colors.brightRed;
      break;
    default:
      prefix = 'ℹ️';
      color = colors.cyan;
      break;
  }

  console.log(colorize(`[${timestamp}] ${prefix} ${message}`, color));
}

/**
 * Futures Trading Bot Persistence
 * Handles futures-specific serialization (leverage, margin, notional value)
 */
export class FuturesPersistence extends BaseTradingBotPersistence<
  FuturesBotInstance,
  FuturesPosition
> {
  constructor(stateFile: string = './data/futures-bot-state.json') {
    super(stateFile);
  }

  /**
   * Serialize futures position (includes leverage, margin, notional value)
   */
  protected serializePosition(pos: FuturesPosition): FuturesPosition {
    return {
      symbol: pos.symbol,
      entryPrice: pos.entryPrice,
      amount: pos.amount,
      remainingAmount: pos.remainingAmount,
      takeProfit: pos.takeProfit,
      entryTime: pos.entryTime,
      strategy: pos.strategy,
      partialsSold: pos.partialsSold,
      currentPrice: pos.currentPrice,
      stopLoss: pos.stopLoss,
      pnlUsd: pos.pnlUsd,
      pnlPct: pos.pnlPct,
      positionId: pos.positionId,
      leverage: pos.leverage || 1,
      notionalValue: pos.notionalValue || 0,
      marginUsed: pos.marginUsed || 0,
      side: pos.side,
      confidence: pos.confidence || 0,
    };
  }

  /**
   * Deserialize futures bot from storage
   */
  protected deserializeBot(state: FuturesBotInstance): FuturesBotInstance {
    return {
      symbol: state.symbol,
      status: state.status,
      startTime: state.startTime,
      pnl: state.pnl,
      sessionPnl: state.sessionPnl || 0,
      trades: state.trades,
      wins: state.wins || 0,
      losses: state.losses || 0,
      position: state.position
        ? this.deserializePosition(state.position)
        : null,
      lastHeartbeat: new Date(),
      priceHistory: [],
      lastUpdate: new Date(),

      ...(state.confirmationTicks !== undefined && {
        confirmationTicks: state.confirmationTicks,
      }),
      ...(state.lastPriceDirection !== undefined && {
        lastPriceDirection: state.lastPriceDirection,
      }),
      ...(state.signal !== undefined && { signal: state.signal }),
      confirmationTicks: state.confirmationTicks || 0,
      lastPriceDirection: state.lastPriceDirection || 0,
      signal: state.signal as EntrySignal,
    };
  }

  /**
   * Deserialize futures position from storage
   */
  protected deserializePosition(state: FuturesPosition): FuturesPosition {
    return {
      symbol: state.symbol,
      entryPrice: state.entryPrice,
      amount: state.amount,
      remainingAmount: state.remainingAmount,
      stopLoss: state.stopLoss,
      takeProfit: state.takeProfit,
      entryTime: new Date(state.entryTime),
      strategy: state.strategy,
      partialsSold: state.partialsSold,
      currentPrice: state.currentPrice,
      pnlUsd: state.pnlUsd,
      pnlPct: state.pnlPct,
      positionId: state.positionId,
      leverage: state.leverage || 1,
      notionalValue: state.notionalValue || 0,
      marginUsed: state.marginUsed || 0,
      side: state.side,
      confidence: state.confidence || 0,
    };
  }
}

class OrderMonitor {
  private exchange: Exchange;
  private config: OrderMonitorConfig;
  private isRunning: boolean = false;
  private pollingInterval?: NodeJS.Timeout;
  private wsConnection?: any;

  constructor(exchange: Exchange, config?: Partial<OrderMonitorConfig>) {
    this.exchange = exchange;
    this.config = {
      pollInterval: 5000,
      maxRetries: 3,
      useWebSocket: true,
      ...config,
    };
  }

  async startWebSocketMonitoring(
    onOrderFilled: (order: Order) => void,
    onError: (error: Error) => void
  ) {
    if (!this.exchange.has['watchOrders']) {
      console.warn(
        '⚠️ Exchange does not support websocket orders, falling back to polling'
      );
      this.startPollingMonitoring(onOrderFilled, onError);
      return;
    }

    this.isRunning = true;
    console.log('🔌 Starting WebSocket order monitoring...');

    try {
      while (this.isRunning) {
        try {
          const orders = await this.exchange.watchOrders();

          for (const order of orders) {
            if (order.status === 'closed' || order.status === 'filled') {
              console.log(
                `📨 Order filled: ${order.id} - ${order.symbol} - ${order.type}`
              );
              onOrderFilled(order);
            }
          }
        } catch (error: any) {
          if (this.isRunning) {
            console.error('WebSocket error:', error.message);
            onError(error);

            await this.sleep(5000);
          }
        }
      }
    } catch (error: any) {
      console.error('Fatal WebSocket error:', error.message);
      onError(error);
    }
  }

  async startPollingMonitoring(
    onOrderFilled: (order: Order) => void,
    onError: (error: Error) => void
  ) {
    this.isRunning = true;
    console.log(
      `🔄 Starting polling order monitoring (every ${this.config.pollInterval}ms)...`
    );

    this.pollingInterval = setInterval(async () => {
      try {
        const openOrders = await this.exchange.fetchOpenOrders();

        const openOrderIds = new Set(openOrders.map((o) => o.id));
      } catch (error: any) {
        console.error('Polling error:', error.message);
        onError(error);
      }
    }, this.config.pollInterval);
  }

  async checkOrderStatus(
    symbol: string,
    orderId: string
  ): Promise<Order | null> {
    console.log('🥑 ~ OrderMonitor ~ checkOrderStatus ~ symbol:', symbol);
    console.log('🥑 ~ OrderMonitor ~ checkOrderStatus ~ orderId:', orderId);
    try {
      const order = await this.exchange.fetchOrder(orderId, symbol);
      return order;
    } catch (error: any) {
      console.error(`Error fetching order ${orderId}:`, error.message);
      return null;
    }
  }

  stop() {
    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    console.log('⏹️ Order monitoring stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class FuturesTradingBot {
  private reconciliationService: PositionReconciliationService;
  private testStartTime: number;
  private isShuttingDown: boolean = false;
  private totalCompletedTrades: number = 0;
  private shutdownReason: string = '';

  private indicatorManager: IndicatorManager;
  private candleManager: CandleManager;
  private totalCapital = 225;
  private positionManager: PositionManager;
  private priceFetchAttempts: Map<string, PriceFetchAttempt> = new Map();
  private readonly MAX_FETCH_ATTEMPTS = 3;
  private readonly FETCH_RETRY_DELAY = 5000;
  private allocatedCapital = 0;
  private signalReader: EnhancedSignalReader;
  private binanceDataFetcher: BinanceDataFetcher;
  private tradeCounters = {
    total: 0,
    today: 0,
    perSymbol: new Map<string, number>(),
    sessionStart: new Date(),
  };

  private symbolCooldowns: Map<string, CooldownInfo> = new Map();
  private consecutiveLosses: Map<string, number> = new Map();

  private readonly COOLDOWN_AFTER_LOSS = 2 * 60 * 60 * 1000;
  private readonly COOLDOWN_AFTER_2_LOSSES = 4 * 60 * 60 * 1000;
  private readonly COOLDOWN_AFTER_3_LOSSES = 8 * 60 * 60 * 1000;
  private readonly BIG_LOSS_THRESHOLD = 5;
  private readonly COOLDOWN_AFTER_BIG_LOSS = 6 * 60 * 60 * 1000;
  private bots: Map<string, BotInstance> = new Map();
  private tradeHistory: CompletedTrade[] = [];
  private signalCheckInterval: NodeJS.Timeout | null = null;
  private dashboardInterval: NodeJS.Timeout | null = null;
  private priceUpdateInterval: NodeJS.Timeout | null = null;
  private persistence: FuturesPersistence;
  private priceFetcher: PriceFetcher;
  private priceCache: PriceCache;
  private maxHistorySize = 50;

  private sessionStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalFees: 0,
  };

  private moraySystem: MorayPartialSystem;

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

  private capitalAllocated = 0;

  private syncTradeHistory(): void {
    const signalReader = this.signalReader as EnhancedSignalReader;

    signalReader.importTradesFromBot(this.tradeHistory);
  }

  constructor(totalCapital: number, moraySystem: MorayPartialSystem) {
    this.reconciliationService = new PositionReconciliationService(
      this.binance
    );
    this.binanceDataFetcher = new BinanceDataFetcher('apiKey', 'secretKey');
    this.signalReader = new EnhancedSignalReader();
    this.persistence = new FuturesPersistence('./data/futures-bot-state.json');
    this.priceFetcher = new PriceFetcher();
    this.positionManager = new PositionManager(totalCapital, moraySystem);
    this.candleManager = new CandleManager(configForLogging.timeframe);
    this.indicatorManager = new IndicatorManager();
    this.priceCache = new PriceCache();
    this.loadCooldowns();

    if (configForLogging.resetTradeCountDaily) {
      this.startDailyReset();
    }

    this.moraySystem = new MorayPartialSystem();
    if (MORAY_CONFIG.enabled) {
      displayMorayBanner();
    }
    this.testStartTime = Date.now();
    this.setupKeyboardControls();
    initializeCapital(totalCapital);
  }

  private hasReachedTradeLimit(): boolean {
    return this.totalCompletedTrades >= CONFIG.maxTotalTrades;
  }

  private checkTestDuration(): boolean {
    const elapsed = Date.now() - this.testStartTime;

    return false;
  }

  /**
   * Paper Trading: Simulate individual limit order fills
   */
  private async simulatePaperMorayPartials(
    bot: BotInstance,
    currentPrice: number
  ): Promise<void> {
    const pos = bot.position as MorayPosition;
    if (!pos.partialTargets) return;

    for (let i = 0; i < pos.partialTargets.length; i++) {
      const target = pos.partialTargets[i];

      if (!target || target?.executed) continue;

      if (
        typeof target.ratio !== 'number' ||
        typeof target.percent !== 'number'
      ) {
        console.error(`Invalid target at index ${i}`);
        continue;
      }

      const targetPrice = this.moraySystem.calculateTargetPrice(
        pos.entryPrice,
        pos.side as EntryType,
        target.ratio,
        pos.stopLoss
      );

      const priceReachedTarget =
        pos.side === 'LONG'
          ? currentPrice >= targetPrice
          : currentPrice <= targetPrice;

      if (priceReachedTarget) {
        const targetPct = target.percent;
        const fillPrice = targetPrice;
        const fillAmount = pos.remainingAmount * targetPct;

        console.log(
          `\n📝 PAPER: ${target.label || `Target ${i}`} filled at target price`
        );
        console.log(`   Target: $${targetPrice.toFixed(6)}`);
        console.log(`   Current: $${currentPrice.toFixed(6)}`);
        console.log(`   Filled at: $${fillPrice.toFixed(6)} ✅`);
        console.log(`   Amount: ${fillAmount.toFixed(8)}`);

        target.executed = true;
        target.executedAt = fillPrice;

        const priceChange =
          pos.side === 'LONG'
            ? fillPrice - pos.entryPrice
            : pos.entryPrice - fillPrice;

        const rawPnl = priceChange * fillAmount;
        const leverage = pos.leverage || 1;
        const leveragedPnl = rawPnl * leverage;

        pos.remainingAmount -= fillAmount;
        pos.partialsSold = (pos.partialsSold || 0) + 1;
        pos.partialPnlRealized = (pos.partialPnlRealized || 0) + leveragedPnl;

        this.moraySystem.recordPartialTrade(
          pos,
          fillPrice,
          fillAmount,
          leveragedPnl,
          target,
          leverage
        );

        console.log(`   PnL: $${leveragedPnl.toFixed(2)}`);
        console.log(`   Accumulated: $${pos.partialPnlRealized.toFixed(2)}`);
        console.log(`   Remaining: ${pos.remainingAmount.toFixed(8)}`);

        this.moraySystem.processPartialFill(
          pos,
          i,
          fillPrice,
          fillAmount,
          leverage
        );
      }
    }

    const allFilled = pos.partialTargets.every((t) => t?.executed);

    if (allFilled && pos.remainingAmount === 0) {
      console.log(`\n✅ PAPER: All Moray partials filled!`);
      await this.exitPosition(bot, 'ALL_PARTIALS_HIT');
    }
  }

  /**
   * ✅ ADD: Set Leverage for a Symbol (One-time setup)
   */
  private async setLeverage(
    binance: binance,
    symbol: string,
    leverage: number
  ): Promise<boolean> {
    if (!this.binance) {
      console.log(
        `ℹ️  No Binance client - leverage ${leverage}x simulated for ${symbol}`
      );
      return true;
    }

    try {
      await binance.setLeverage(leverage, symbol);
      console.log(`✅ ${symbol}: Leverage set to ${leverage}x`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to set leverage for ${symbol}:`, error.message);
      return false;
    }
  }

  /**
   * ✅ ADD: Set Margin Mode (One-time setup)
   */
  private async setMarginMode(
    binance: binance,
    symbol: string,
    marginMode: 'ISOLATED' | 'CROSS' = 'ISOLATED'
  ): Promise<boolean> {
    if (!this.binance) {
      console.log(
        `ℹ️  No Binance client - margin mode ${marginMode} simulated for ${symbol}`
      );
      return true;
    }

    try {
      await binance.setMarginMode(marginMode, symbol);
      console.log(`✅ ${symbol}: Margin mode set to ${marginMode}`);
      return true;
    } catch (error: any) {
      if (error.message.includes('No need to change')) {
        console.log(`ℹ️  ${symbol}: Already in ${marginMode} mode`);
        return true;
      }
      console.error(
        `❌ Failed to set margin mode for ${symbol}:`,
        error.message
      );
      return false;
    }
  }

  /**
   * ✅ ADD: Configure Symbol for Futures Trading
   * Call this before trading any new symbol
   */
  private async configureSymbolForFutures(
    binance: binance,
    symbol: string
  ): Promise<boolean> {
    console.log(`⚙️  Configuring ${symbol} for futures trading...`);

    const leverageSuccess = await this.setLeverage(
      binance,
      symbol,
      configForLogging.leverageMultiplier
    );

    if (!leverageSuccess) {
      return false;
    }

    const marginModeSuccess = await this.setMarginMode(
      binance,
      symbol,
      'ISOLATED'
    );

    if (!marginModeSuccess) {
      return false;
    }

    console.log(`✅ ${symbol} configured for futures trading`);
    return true;
  }

  /**
   * ✅ Check if bot should stop due to trade limits
   */

  private checkTradeLimits(): { shouldStop: boolean; reason: string } {
    const reasons: string[] = [];

    if (
      CONFIG.maxTotalTrades !== Infinity &&
      this.tradeCounters.total >= CONFIG.maxTotalTrades
    ) {
      reasons.push(
        `Trade limit: ${this.tradeCounters.total}/${CONFIG.maxTotalTrades}`
      );
    }

    if (CONFIG.maxTestDuration) {
      const elapsed = Date.now() - this.tradeCounters.sessionStart.getTime();
      if (elapsed >= CONFIG.maxTestDuration) {
        const minutes = (elapsed / 60000).toFixed(1);
        reasons.push(`Time limit: ${minutes} minutes`);
      }
    }

    if (CONFIG.maxLossStreak) {
      const recentTrades = this.tradeHistory.slice(0, CONFIG.maxLossStreak);
      const allLosses = recentTrades.every((t) => !t.isWin);
      if (allLosses && recentTrades.length >= CONFIG.maxLossStreak) {
        reasons.push(`Loss streak: ${CONFIG.maxLossStreak} losses`);
      }
    }

    if (CONFIG.targetPnL) {
      const totalPnL = this.tradeHistory.reduce((sum, t) => sum + t.pnlUsd, 0);
      if (totalPnL >= CONFIG.targetPnL) {
        reasons.push(
          `Target profit: $${totalPnL.toFixed(2)} >= $${CONFIG.targetPnL}`
        );
      }
    }

    if (
      CONFIG.maxTradesPerDay !== Infinity &&
      this.tradeCounters.today >= CONFIG.maxTradesPerDay
    ) {
      reasons.push(
        `Daily limit: ${this.tradeCounters.today}/${CONFIG.maxTradesPerDay}`
      );
    }

    if (reasons.length > 0) {
      return {
        shouldStop: true,
        reason: reasons.join(' | '),
      };
    }

    return { shouldStop: false, reason: '' };
  }

  /**
   * ✅ Check if symbol has reached its trade limit
   */
  private canTradeSymbol(symbol: string): {
    canTrade: boolean;
    reason?: string;
  } {
    const cooldown = this.symbolCooldowns.get(symbol);

    if (!cooldown) {
      return { canTrade: true };
    }

    const now = Date.now();

    if (now < cooldown.cooldownUntil.getTime()) {
      const minutesLeft = Math.ceil(
        (cooldown.cooldownUntil.getTime() - now) / (1000 * 60)
      );
      const hoursLeft = (minutesLeft / 60).toFixed(1);

      let emoji = '🚬';
      let activity = 'having a cigar';

      if (cooldown.reason === 'CONSECUTIVE_LOSSES') {
        emoji = '🍷';
        activity = 'drinking wine';
      } else if (cooldown.reason === 'BIG_LOSS') {
        emoji = '😤';
        activity = 'in therapy';
      } else if (minutesLeft > 360) {
        emoji = '😴';
        activity = 'sleeping it off';
      }

      return {
        canTrade: false,
        reason: `${emoji} ${symbol} on cooldown - ${activity} (${hoursLeft}h / ${minutesLeft}m left)`,
      };
    }

    this.symbolCooldowns.delete(symbol);
    this.consecutiveLosses.delete(symbol);

    log(`✅ ${symbol} cooldown expired - ready to trade again!`, 'success');

    return { canTrade: true };
  }

  private async onPositionClosed(position: Position): Promise<void> {
    const symbol = position.symbol;
    const pnl = position.pnlUsd;

    if (pnl > 0) {
      log(`✅ ${symbol} WIN - Resetting cooldown counter`, 'success');
      this.consecutiveLosses.delete(symbol);
      this.symbolCooldowns.delete(symbol);
      return;
    }

    const consecutiveCount = (this.consecutiveLosses.get(symbol) || 0) + 1;
    this.consecutiveLosses.set(symbol, consecutiveCount);

    let cooldownDuration: number;
    let reason: CooldownInfo['reason'];
    let emoji: string;
    let message: string;

    if (Math.abs(pnl) >= this.BIG_LOSS_THRESHOLD) {
      cooldownDuration = this.COOLDOWN_AFTER_BIG_LOSS;
      reason = 'BIG_LOSS';
      emoji = '😤';
      message = `BIG LOSS (${pnl.toFixed(2)} USDT) - Go to therapy`;
    } else if (consecutiveCount >= 3) {
      cooldownDuration = this.COOLDOWN_AFTER_3_LOSSES;
      reason = 'CONSECUTIVE_LOSSES';
      emoji = '😴';
      message = `${consecutiveCount} losses in a row - Sleep it off`;
    } else if (consecutiveCount === 2) {
      cooldownDuration = this.COOLDOWN_AFTER_2_LOSSES;
      reason = 'CONSECUTIVE_LOSSES';
      emoji = '🍷';
      message = `${consecutiveCount} losses in a row - Have some wine`;
    } else {
      cooldownDuration = this.COOLDOWN_AFTER_LOSS;
      reason = 'LOSS';
      emoji = '🚬';
      message = 'Loss - Take a cigar break';
    }

    const cooldownUntil = new Date(Date.now() + cooldownDuration);

    this.symbolCooldowns.set(symbol, {
      symbol,
      reason,
      cooldownUntil,
      lossAmount: pnl,
      consecutiveLosses: consecutiveCount,
    });

    const hours = (cooldownDuration / (1000 * 60 * 60)).toFixed(1);

    log(`${emoji} ${symbol} ${message} - Cooldown: ${hours}h`, 'warning');
    log(`   Consecutive losses: ${consecutiveCount}`, 'info');
    log(`   Loss amount: ${pnl.toFixed(2)} USDT`, 'info');
    log(`   Resume trading: ${cooldownUntil.toLocaleTimeString()}`, 'info');
  }

  /**
   * ✅ Update trade counters after completing a trade
   */
  private updateTradeCounters(trade: CompletedTrade): void {
    this.tradeCounters.total++;

    this.tradeCounters.today++;

    const symbolCount = this.tradeCounters.perSymbol.get(trade.symbol) || 0;
    this.tradeCounters.perSymbol.set(trade.symbol, symbolCount + 1);

    console.log('📊 Trade Counters:');
    console.log(
      `   Total: ${this.tradeCounters.total}/${CONFIG.maxTotalTrades || '∞'}`
    );
    console.log(
      `   Today: ${this.tradeCounters.today}/${CONFIG.maxTradesPerDay || '∞'}`
    );
    console.log(
      `   ${trade.symbol}: ${symbolCount + 1}/${CONFIG.maxTradesPerSymbol || '∞'}`
    );

    const limitCheck = this.checkTradeLimits();

    if (limitCheck.shouldStop && !this.isShuttingDown) {
      console.log(`\n🛑 TRADE LIMIT REACHED: ${limitCheck.reason}`);

      if (configForLogging.stopOnLimit) {
        this.initiateGracefulShutdown(limitCheck.reason);
      }
    }
  }

  /**
   * 🐍 Sync exchange-based partial fills with Moray system
   */
  private async syncExchangePartials(bot: BotInstance): Promise<void> {
    if (!bot.position || CONFIG.paperTrading) return;

    const morayPos = bot.position as MorayPosition;
    if (!morayPos.partialTargets) return;

    const currentPrice = await this.getCurrentMarketPrice(morayPos.symbol);

    for (let i = 0; i < morayPos.partialTargets.length; i++) {
      const target = morayPos.partialTargets[i];

      if (target?.executed || !target?.orderId) continue;

      try {
        const order = await this.binance.fetchOrder(
          target?.orderId,
          morayPos.symbol
        );

        if (order.status === 'closed' || order.status === 'filled') {
          const fillPrice = order.average || order.price;
          const fillAmount = order.filled;
          const moLeverage = morayPos.leverage as number;

          console.log(`✅ Exchange partial ${i + 1} filled: ${target.label}`);

          this.moraySystem.processPartialFill(
            morayPos,
            i,
            fillPrice,
            fillAmount,
            moLeverage
          );

          if (
            i === 0 &&
            this.moraySystem.shouldMoveToBreakeven(morayPos, currentPrice)
          ) {
            await this.moveStopLossToBreakeven(morayPos);
          }

          await this.updateTakeProfitQuantity(morayPos);
        }
      } catch (error: any) {
        console.error(
          `❌ Failed to check order ${target.orderId}:`,
          error.message
        );
      }
    }
  }

  private async getCurrentMarketPrice(symbol: string): Promise<number> {
    try {
      const ticker = await this.binance.fetchTicker(symbol);
      return ticker.last || ticker.close || 0;
    } catch (error) {
      console.error(`❌ Failed to fetch price for ${symbol}:`, error);
      return 0;
    }
  }

  /**
   * 🛡️ Move stop loss to breakeven on Binance
   */
  private async moveStopLossToBreakeven(
    position: MorayPosition
  ): Promise<void> {
    if (position.breakEvenMoved || !position.stopLossOrderId) return;

    try {
      await this.binance.cancelOrder(position.stopLossOrderId, position.symbol);
      console.log(`❌ Cancelled old SL: ${position.stopLossOrderId}`);

      const newSL = await this.placeStopLoss(this.binance, {
        symbol: position.symbol,
        side: position.side,
        quantity: position.remainingAmount,
        stopPrice: position.entryPrice,
      });

      position.stopLossOrderId = newSL.id as string;
      position.stopLoss = position.entryPrice;
      position.breakEvenMoved = true;

      console.log(
        `✅ SL moved to breakeven @ $${position.entryPrice.toFixed(6)}`
      );
    } catch (error: any) {
      console.error(`❌ Failed to move SL to breakeven:`, error.message);
    }
  }

  /**
   * 🎯 Update TP quantity after partial fills
   */
  private async updateTakeProfitQuantity(
    position: MorayPosition
  ): Promise<void> {
    if (!position.takeProfitOrderId || position.remainingAmount <= 0) return;

    try {
      await this.binance.cancelOrder(
        position.takeProfitOrderId,
        position.symbol
      );

      const newTP = await this.placeTakeProfit(this.binance, {
        symbol: position.symbol,
        side: position.side,
        quantity: position.remainingAmount,
        takeProfitPrice: position.takeProfit,
      });

      position.takeProfitOrderId = newTP.id as string;
      console.log(
        `✅ TP updated for ${position.remainingAmount.toFixed(8)} remaining`
      );
    } catch (error: any) {
      console.error(`❌ Failed to update TP:`, error.message);
    }
  }

  private initiateGracefulShutdown(reason: string): void {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    this.shutdownReason = reason;

    const activePositions = Array.from(this.bots.values()).filter(
      (b) => b.position
    ).length;

    console.log('\n' + '═'.repeat(80));
    console.log('🛑 GRACEFUL SHUTDOWN INITIATED');
    console.log('═'.repeat(80));
    console.log(`Reason: ${reason}`);
    console.log(`Active positions: ${activePositions}`);

    if (activePositions > 0) {
      console.log('⏳ Waiting for active positions to close...');
      console.log('   - No new signals will be processed');
      console.log('   - Existing positions will be managed normally');
      console.log('   - Bot will exit once all positions are closed');
    } else {
      console.log('✅ No active positions - shutting down immediately');
      this.finalizeShutdown();
    }

    console.log('═'.repeat(80) + '\n');
  }

  private checkShutdownComplete(): void {
    if (!this.isShuttingDown) return;

    const activePositions = Array.from(this.bots.values()).filter(
      (b) => b.position
    ).length;

    if (activePositions === 0) {
      console.log('\n✅ All positions closed - finalizing shutdown...');
      this.finalizeShutdown();
    } else {
      console.log(
        `⏳ Shutdown in progress: ${activePositions} position(s) remaining...`
      );
    }
  }

  private finalizeShutdown(): void {
    console.log('\n' + '═'.repeat(80));
    console.log('🏁 FINALIZING SHUTDOWN');
    console.log('═'.repeat(80));

    this.printFinalStats();

    this.printTestSummary();

    console.log('\n💾 Saving final state...');
    this.persistence.saveState(
      this as unknown as BaseTradingBot<FuturesBotInstance>,
      configForLogging
    );

    this.stop();

    console.log('✅ Shutdown complete');
    console.log('👋 Goodbye!\n');

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }

  /**
   * ✅ Handle trade limit reached
   */
  private handleTradeLimitReached(reason: string): void {
    console.log('\n' + '═'.repeat(80));
    console.log('🏁 BOT STOPPING - TRADE LIMIT REACHED');
    console.log('═'.repeat(80));
    console.log(`Reason: ${reason}`);
    console.log(`Total Trades Completed: ${this.tradeCounters.total}`);
    console.log(`Session Duration: ${this.getSessionDuration()}`);

    this.printTestSummary();

    this.printFinalStats();

    if (configForLogging.saveAndExit) {
      console.log('\n💾 Saving final state...');
      this.persistence.saveState(
        this as unknown as BaseTradingBot<FuturesBotInstance>,
        configForLogging
      );

      setTimeout(() => {
        console.log('✅ State saved. Exiting...');
        console.log('👋 Goodbye!\n');
        process.exit(0);
      }, 1000);
    }
  }

  /**
   * ✅ Print final statistics
   */
  private printFinalStats(): void {
    const wins = this.tradeHistory.filter((t) => t.isWin).length;
    const losses = this.tradeHistory.length - wins;
    const winRate =
      this.tradeHistory.length > 0
        ? ((wins / this.tradeHistory.length) * 100).toFixed(1)
        : '0.0';
    const totalPnL = this.tradeHistory.reduce((sum, t) => sum + t.pnlUsd, 0);

    console.log('\n📊 FINAL SESSION STATS');
    console.log('─'.repeat(80));
    console.log(`Completed Trades: ${this.tradeHistory.length}`);
    console.log(`Wins: ${wins} | Losses: ${losses} | Win Rate: ${winRate}%`);
    console.log(
      `Total PnL: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} USDT`
    );
    console.log(
      `Average PnL per Trade: ${(totalPnL / this.tradeHistory.length).toFixed(2)} USDT`
    );

    console.log('\n📈 Per-Symbol Summary:');
    this.tradeCounters.perSymbol.forEach((count, symbol) => {
      const symbolTrades = this.tradeHistory.filter((t) => t.symbol === symbol);
      const symbolPnL = symbolTrades.reduce((sum, t) => sum + t.pnlUsd, 0);
      const symbolWins = symbolTrades.filter((t) => t.isWin).length;
      console.log(
        `   ${symbol}: ${count} trades, ${symbolWins}W/${count - symbolWins}L, PnL: ${symbolPnL >= 0 ? '+' : ''}${symbolPnL.toFixed(2)}`
      );
    });

    console.log('─'.repeat(80));
  }

  /**
   * ✅ Get session duration
   */
  private getSessionDuration(): string {
    const now = new Date();
    const duration = now.getTime() - this.tradeCounters.sessionStart.getTime();
    const hours = Math.floor(duration / (1000 * 60 * 60));
    const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  /**
   * ✅ Reset daily counters at midnight
   */
  private startDailyReset(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    setTimeout(() => {
      console.log('🌅 New day! Resetting daily trade counter...');
      this.tradeCounters.today = 0;

      this.startDailyReset();
    }, msUntilMidnight);

    console.log(`⏰ Daily reset scheduled for ${tomorrow.toLocaleString()}`);
  }

  /**
   * ✅ MODIFIED: Check limits before opening position
   */

  /**
   * ✅ PRODUCTION-READY: Open position with real Binance orders
   * This method handles the complete order lifecycle:
   * 1. Get live price
   * 2. Validate order parameters
   * 3. Set leverage and margin mode
   * 4. Execute entry order
   * 5. Place protective SL/TP orders
   * 6. Handle errors and partial fills
   */
  private async openPosition(
    binance: binance,
    params: OpenPositionParams
  ): Promise<OrderResult | null> {
    const { symbol, side, notionalValue, leverage, stopLoss, takeProfit } =
      params;

    if (process.env.BINANCE_ENV === 'testnet') {
      this.binance.setSandboxMode(true);
    }

    try {
      console.log(`\n🚀 Opening ${side} position for ${symbol}`);
      console.log(`   Notional: $${notionalValue.toFixed(2)}`);
      console.log(`   Leverage: ${leverage}x`);
      console.log(`   Stop Loss: $${stopLoss.toFixed(6)}`);
      console.log(`   Take Profit: $${takeProfit.toFixed(6)}`);

      const priceResult = await this.priceFetcher.getCurrentPrice(
        symbol,
        'entry',
        true
      );

      if (!priceResult || !priceResult.price) {
        throw new Error(`Cannot get live price for ${symbol}`);
      }

      const currentPrice = priceResult.price;
      const quantity = notionalValue / currentPrice;

      console.log(
        `   Live Price: $${currentPrice.toFixed(6)} (${priceResult.confidence})`
      );
      console.log(`   Quantity: ${quantity.toFixed(8)}`);

      const validation = await this.validateOrderBeforeExecution(
        symbol,
        side === 'LONG' ? 'BUY' : 'SELL',
        quantity,
        currentPrice
      );

      if (!validation.valid) {
        console.error(`❌ Order validation failed: ${validation.reason}`);
        return null;
      }

      await this.setLeverage(binance, symbol, leverage);
      await this.setMarginMode(binance, symbol, 'ISOLATED');

      const orderSide = side === 'LONG' ? 'BUY' : 'SELL';

      if (CONFIG.paperTrading) {
        console.warn('⚠️ PAPER TRADING MODE - NO REAL ORDERS');

        return {
          entryOrder: {
            id: `paper-${symbol}-${Date.now()}`,
            symbol: symbol,
            type: 'market',
            side: orderSide,
            price: currentPrice,
            average: currentPrice,
            filled: quantity,
            remaining: 0,
            status: 'closed',
            timestamp: Date.now(),
          },
          stopLossOrder: {
            id: `paper-sl-${Date.now()}`,
            symbol: symbol,
            type: 'STOP_MARKET',
            side: side === 'LONG' ? 'SELL' : 'BUY',
            price: stopLoss,
            stopPrice: stopLoss,
          },
          takeProfitOrder: {
            id: `paper-tp-${Date.now()}`,
            symbol: symbol,
            type: 'TAKE_PROFIT_MARKET',
            side: side === 'LONG' ? 'SELL' : 'BUY',
            price: takeProfit,
            stopPrice: takeProfit,
          },
        };
      }

      console.log(`📤 Placing REAL ${orderSide.toUpperCase()} market order...`);
      console.log(`   Symbol: ${symbol}`);
      console.log(`   Quantity: ${quantity.toFixed(8)}`);
      console.log(`   Expected fill: ~$${currentPrice.toFixed(6)}`);

      const entryOrder = await binance.createMarketOrder(
        symbol,
        orderSide,
        quantity
      );

      console.log(`✅ Entry order FILLED`);
      console.log(`   Order ID: ${entryOrder.id}`);
      console.log(`   Filled: ${entryOrder.filled} @ $${entryOrder.average}`);
      console.log(`   Status: ${entryOrder.status}`);

      if (entryOrder.status !== 'closed' && entryOrder.status !== 'filled') {
        console.error(`❌ Order not fully filled: ${entryOrder.status}`);
        throw new Error(`Order status: ${entryOrder.status}`);
      }

      if (!entryOrder.filled || entryOrder.filled === 0) {
        console.error(`❌ No quantity filled!`);
        throw new Error('Order filled quantity is 0');
      }

      console.log(`\n🛡️ Placing Stop-Loss order...`);

      const slOrder = await this.placeStopLoss(binance, {
        symbol,
        side,
        quantity: entryOrder.filled,
        stopPrice: stopLoss,
      });

      console.log(
        `✅ Stop Loss placed: ${slOrder.id} @ $${stopLoss.toFixed(6)}`
      );

      console.log(`\n🎯 Placing Take-Profit order...`);

      const tpOrder = await this.placeTakeProfit(binance, {
        symbol,
        side,
        quantity: entryOrder.filled,
        takeProfitPrice: takeProfit,
      });

      console.log(
        `✅ Take Profit placed: ${tpOrder.id} @ $${takeProfit.toFixed(6)}`
      );

      console.log(`\n✅ Position opened successfully`);
      console.log(
        `   Entry: $${entryOrder.average} (${entryOrder.filled} filled)`
      );
      console.log(`   SL: $${stopLoss.toFixed(6)}`);
      console.log(`   TP: $${takeProfit.toFixed(6)}`);

      return {
        entryOrder,
        stopLossOrder: slOrder,
        takeProfitOrder: tpOrder,
      } as OrderResult;
    } catch (error: any) {
      console.error(`❌ Failed to open position for ${symbol}:`, error.message);

      console.log(`🔍 Checking for partial fills or orphaned positions...`);
      await this.handleFailedOrderRecovery(symbol, side);

      return null;
    }
  }

  /**
   * ✅ Validate order parameters before execution
   * Prevents invalid orders from being sent to exchange
   */
  private async validateOrderBeforeExecution(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const sym = normalize(symbol, 'FUTURES');

      const market = this.binance.market(sym);

      if (!market) {
        return { valid: false, reason: `Market ${sym} not found` };
      }

      if (!market.active) {
        return {
          valid: false,
          reason: `Market ${sym} is not active for trading`,
        };
      }

      if (market.limits.amount?.min && quantity < market.limits.amount.min) {
        return {
          valid: false,
          reason: `Quantity ${quantity.toFixed(8)} below minimum ${market.limits.amount.min}`,
        };
      }

      if (market.limits.amount?.max && quantity > market.limits.amount.max) {
        return {
          valid: false,
          reason: `Quantity ${quantity.toFixed(8)} above maximum ${market.limits.amount.max}`,
        };
      }

      const notional = quantity * price;

      if (market.limits.cost?.min && notional < market.limits.cost?.min) {
        return {
          valid: false,
          reason: `Notional $${notional.toFixed(2)} below minimum $${market.limits.cost.min}`,
        };
      }

      const balance = (await this.binance.fetchBalance()) as Balance;

      if (!balance || !balance.free) {
        return { valid: false, reason: 'Failed to fetch balance' };
      }

      if (!balance.free || typeof balance.free !== 'object') {
        return { valid: false, reason: 'Invalid balance structure' };
      }

      const availableUSDT = balance.free['USDT'] ?? 0;
      const requiredMargin = notional / CONFIG.leverageMultiplier;

      if (availableUSDT < requiredMargin) {
        return {
          valid: false,
          reason: `Insufficient balance: need $${requiredMargin.toFixed(2)}, have $${availableUSDT.toFixed(2)}`,
        };
      }

      console.log(`✅ Order validation passed`);
      console.log(`   Quantity OK: ${quantity.toFixed(8)}`);
      console.log(`   Notional OK: $${notional.toFixed(2)}`);
      console.log(`   Balance OK: $${availableUSDT.toFixed(2)}`);

      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        reason: `Validation error: ${error.message}`,
      };
    }
  }

  /**
   * ✅ Handle failed order recovery
   * Checks for orphaned positions and adds protective orders if needed
   */
  private async handleFailedOrderRecovery(
    symbol: string,
    side: string
  ): Promise<void> {
    try {
      console.log(
        `🔍 Recovery: Checking for orphaned positions on ${symbol}...`
      );

      const positions = await this.binance.fetchPositions([symbol]);
      const position = positions.find((p: any) => p.symbol === symbol);
      const posCon = position?.contracts as number;
      if (!position || Math.abs(posCon) === 0) {
        console.log(`✅ No orphaned positions found`);
        return;
      }

      console.warn(`⚠️ ALERT: Found orphaned position on ${symbol}!`);
      console.warn(`   Contracts: ${position.contracts}`);
      console.warn(`   Entry Price: $${position.entryPrice}`);
      console.warn(`   Unrealized PnL: $${position.unrealizedPnl}`);

      const openOrders = await this.binance.fetchOpenOrders(symbol);
      const hasStopLoss = openOrders.some((o: any) => o.type === 'STOP_MARKET');
      const hasTakeProfit = openOrders.some(
        (o: any) => o.type === 'TAKE_PROFIT_MARKET'
      );

      if (hasStopLoss && hasTakeProfit) {
        console.log(`✅ Position already has protective orders`);
        return;
      }

      console.warn(`🚨 Adding EMERGENCY protective orders...`);

      const quantity = Math.abs(posCon);
      const entryPrice = position.entryPrice as number;

      const emergencySL =
        side === 'LONG' ? entryPrice * 0.98 : entryPrice * 1.02;

      const emergencyTP =
        side === 'LONG' ? entryPrice * 1.04 : entryPrice * 0.96;

      if (!hasStopLoss) {
        await this.placeStopLoss(this.binance, {
          symbol,
          side,
          quantity,
          stopPrice: emergencySL,
        });
        console.log(`✅ Emergency SL placed @ $${emergencySL.toFixed(6)}`);
      }

      if (!hasTakeProfit) {
        await this.placeTakeProfit(this.binance, {
          symbol,
          side,
          quantity,
          takeProfitPrice: emergencyTP,
        });
        console.log(`✅ Emergency TP placed @ $${emergencyTP.toFixed(6)}`);
      }

      console.log(`✅ Orphaned position secured with protective orders`);
    } catch (error: any) {
      console.error(`❌ Recovery failed: ${error.message}`);
      console.error(`🚨 MANUAL INTERVENTION MAY BE REQUIRED FOR ${symbol}`);
    }
  }

  private async placeStopLoss(
    binance: binance,
    params: StopLossParams
  ): Promise<any> {
    const { symbol, side, quantity, stopPrice } = params;

    try {
      const orderSide = side === 'LONG' ? 'SELL' : 'BUY';

      console.log(
        `🛡️ Posting Native Stop Loss for ${symbol} at $${stopPrice}...`
      );

      const order = await binance.createOrder(
        symbol,
        'STOP_MARKET',
        orderSide,
        quantity,
        undefined,
        {
          stopPrice: stopPrice,
          reduceOnly: true,
          workingType: 'MARK_PRICE',
        }
      );

      return order;
    } catch (error: any) {
      console.error(`❌ Failed to place stop loss:`, error.message);
      throw error;
    }
  }

  private async placeTakeProfit(
    binance: binance,
    params: TakeProfitParams
  ): Promise<any> {
    const { symbol, side, quantity, takeProfitPrice } = params;

    try {
      const orderSide = side === 'LONG' ? 'SELL' : 'BUY';

      console.log(
        `🎯 Posting Native Take Profit for ${symbol} at $${takeProfitPrice}...`
      );

      const order = await binance.createOrder(
        symbol,
        'TAKE_PROFIT_MARKET',
        orderSide,
        quantity,
        undefined,
        {
          stopPrice: takeProfitPrice,
          reduceOnly: true,
          workingType: 'LAST_PRICE',
        }
      );

      return order;
    } catch (error: any) {
      console.error(`❌ Failed to place take profit:`, error.message);
      throw error;
    }
  }

  private async closePosition(
    binance: binance,
    symbol: string,
    side: 'LONG' | 'SHORT'
  ): Promise<any> {
    try {
      console.log(`\n🛑 Closing ${side} position for ${symbol}`);

      const positions = await binance.fetchPositions([symbol]);
      const position = positions.find(
        (p: any) => p.symbol === symbol
      ) as unknown as Position;

      if (!position || position.contracts === 0) {
        console.log(`ℹ️  No open position for ${symbol}`);
        return null;
      }

      await binance.cancelAllOrders(symbol);
      console.log(`✅ Cancelled all orders for ${symbol}`);

      const orderSide = side === 'LONG' ? 'sell' : 'buy';
      const contracts = position.contracts as number;
      const quantity = Math.abs(contracts);

      const order = await binance.createOrder(
        symbol,
        'market',
        orderSide,
        quantity,
        undefined,
        {
          reduceOnly: true,
        }
      );

      console.log(`✅ Position closed: ${order.id}`);
      console.log(`   Filled: ${order.filled} @ $${order.average}`);

      return order;
    } catch (error: any) {
      console.error(`❌ Failed to close position:`, error.message);
      throw error;
    }
  }

  private async getOpenPositions(
    binance: binance,
    symbol: string
  ): Promise<any> {
    try {
      const positions = symbol
        ? await binance.fetchPositions([symbol])
        : await binance.fetchPositions();

      const openPositions = positions.filter((p: any) => p.contracts !== 0);

      return openPositions;
    } catch (error: any) {
      console.error(`❌ Failed to get positions:`, error.message);
      return [];
    }
  }

  /**
   * ✅ Get current trade counters (for display)
   */
  getTradeCounters() {
    return {
      total: this.tradeCounters.total,
      maxTotal: configForLogging.maxTotalTrades || Infinity,
      today: this.tradeCounters.today,
      maxToday: configForLogging.maxTradesPerDay || Infinity,
      remaining: configForLogging.maxTotalTrades
        ? configForLogging.maxTotalTrades - this.tradeHistory.length
        : Infinity,
    };
  }

  debugCooldownSystem() {
    console.log('\n🔍 COOLDOWN SYSTEM DEBUG:');
    console.log(`Symbol cooldowns size: ${this.symbolCooldowns.size}`);
    console.log(`Consecutive losses size: ${this.consecutiveLosses.size}`);

    if (this.symbolCooldowns.size > 0) {
      console.log('\nActive cooldowns:');
      this.symbolCooldowns.forEach((info, symbol) => {
        const timeLeft = info.cooldownUntil.getTime() - Date.now();
        const minutesLeft = Math.ceil(timeLeft / (1000 * 60));
        console.log(`  ${symbol}: ${info.reason}, ${minutesLeft}m left`);
      });
    }

    console.log('\nConsecutive losses:');
    this.consecutiveLosses.forEach((count, symbol) => {
      console.log(`  ${symbol}: ${count} losses`);
    });

    const testSymbol = 'BTCUSDT';
    const canTrade = this.canTradeSymbol(testSymbol);
    console.log(`\nCan trade ${testSymbol}? ${canTrade.canTrade}`);
    if (!canTrade.canTrade) {
      console.log(`Reason: ${canTrade.reason}`);
    }
  }

  getTradeCountersPerSymbol() {
    return Object.fromEntries(this.tradeCounters.perSymbol);
  }

  /**
   * ✅ ENHANCED: Update prices with fallback to exchange API
   */

  private async updatePricesFromScanner() {
    try {
      const bots = Array.from(this.bots.values());
      const priceMap = new Map<string, number>();

      const activePositionBots = bots.filter((bot) => bot.position);
      const waitingBots = bots.filter((bot) => !bot.position);

      console.log(
        `📊 Price Update: ${activePositionBots.length} active positions, ${waitingBots.length} waiting`
      );

      if (activePositionBots.length > 0) {
        console.log(
          `🔴 Fetching LIVE prices for ${activePositionBots.length} active position(s)...`
        );

        for (const bot of activePositionBots) {
          try {
            const symbol = normalize(bot.symbol, 'FUTURES');

            const result = await this.priceFetcher.getCurrentPrice(
              symbol,
              'monitor',
              false
            );

            if (result && result.price) {
              priceMap.set(bot.symbol, result.price);
              console.log(
                `💰 ${bot.symbol}: $${result.price.toFixed(6)} (${result.source}, ${result.confidence}, ${result.age}ms old)`
              );
            } else {
              console.warn(
                `⚠️  ${bot.symbol}: Failed to get live price, using fallback`
              );

              if (bot.position?.currentPrice) {
                priceMap.set(bot.symbol, bot.position.currentPrice);
                console.log(
                  `   Fallback: Using position's last price $${bot.position.currentPrice.toFixed(6)}`
                );
              }
            }
          } catch (error: any) {
            console.error(
              `❌ ${bot.symbol}: Price fetch error - ${error.message}`
            );

            if (bot.position?.currentPrice) {
              priceMap.set(bot.symbol, bot.position.currentPrice);
              console.log(
                `   Emergency fallback: $${bot.position.currentPrice.toFixed(6)}`
              );
            }
          }
        }
      }

      const scannerPrices = await this.getPricesFromScanner();
      console.log(`📊 Got ${scannerPrices.size} prices from scanner`);

      for (const bot of bots) {
        if (!priceMap.has(bot.symbol) && scannerPrices.has(bot.symbol)) {
          const price = scannerPrices.get(bot.symbol)!;
          priceMap.set(bot.symbol, price);
          console.log(`📡 ${bot.symbol}: $${price.toFixed(6)} (from scanner)`);
        }
      }

      const missingSymbols: string[] = [];
      for (const bot of bots) {
        if (!priceMap.has(bot.symbol)) {
          const cachedPrice = this.priceCache.getPrice(bot.symbol);
          if (cachedPrice) {
            priceMap.set(bot.symbol, cachedPrice);
            const age = this.priceCache.getCacheAge(bot.symbol);
            console.log(
              `💾 ${bot.symbol}: Using cached price $${cachedPrice.toFixed(6)} (${(age! / 1000).toFixed(1)}s old)`
            );
          } else {
            missingSymbols.push(bot.symbol);
          }
        }
      }

      if (missingSymbols.length > 0) {
        console.log(
          `🔍 Fetching ${missingSymbols.length} missing prices from Binance:`,
          missingSymbols
        );

        const symbolsToFetch = missingSymbols.filter((symbol) => {
          const attempt = this.priceFetchAttempts.get(symbol);
          if (!attempt) return true;

          const timeSinceLastAttempt = Date.now() - attempt.lastAttempt;
          if (attempt.attempts >= this.MAX_FETCH_ATTEMPTS) {
            if (timeSinceLastAttempt < this.FETCH_RETRY_DELAY) {
              console.log(
                `⏳ ${symbol}: Skipping (${attempt.attempts} failed attempts, retry in ${Math.ceil((this.FETCH_RETRY_DELAY - timeSinceLastAttempt) / 1000)}s)`
              );
              return false;
            } else {
              this.priceFetchAttempts.delete(symbol);
              return true;
            }
          }

          return true;
        });

        if (symbolsToFetch.length > 0) {
          try {
            const exchangePrices =
              await this.priceFetcher.getMultiplePrices(symbolsToFetch);
            console.log(
              `✅ Fetched ${exchangePrices.size}/${symbolsToFetch.length} prices from Binance`
            );

            for (const [symbol, price] of exchangePrices.entries()) {
              priceMap.set(symbol, price);
              this.priceCache.setPrice(symbol, price);
              this.priceFetchAttempts.delete(symbol);
              console.log(`💰 ${symbol}: $${price.toFixed(6)}`);
            }

            for (const symbol of symbolsToFetch) {
              if (!exchangePrices.has(symbol)) {
                this.trackFailedFetch(symbol, 'Not returned by exchange');
              }
            }
          } catch (error: any) {
            console.error(`❌ Binance batch fetch error:`, error.message);

            for (const symbol of symbolsToFetch) {
              this.trackFailedFetch(symbol, error.message);
            }
          }
        }
      }

      let updatedCount = 0;
      let missingCount = 0;

      for (const bot of bots) {
        let currentPrice = priceMap.get(bot.symbol);

        if (!currentPrice && bot.position?.currentPrice) {
          console.log(
            `⚠️  ${bot.symbol}: Using last known price $${bot.position.currentPrice.toFixed(6)}`
          );
          currentPrice = bot.position.currentPrice;
          this.priceCache.setPrice(bot.symbol, currentPrice);
        }

        if (currentPrice) {
          this.updateBotWithPrice(bot, currentPrice);
          updatedCount++;
        } else {
          missingCount++;
          this.handleMissingPrice_SafeVersion(bot);
        }
      }

      if (updatedCount > 0) {
        console.log(
          `✅ Updated ${updatedCount}/${bots.length} bot(s) with prices`
        );
      }

      if (missingCount > 0) {
        console.log(`⚠️  ${missingCount} bot(s) still missing prices`);
      }
    } catch (err: any) {
      console.error(`❌ Price update error: ${err.message}`);
    }
  }

  private trackFailedFetch(symbol: string, error: string) {
    const attempt = this.priceFetchAttempts.get(symbol) || {
      symbol,
      attempts: 0,
      lastAttempt: 0,
    };

    attempt.attempts++;
    attempt.lastAttempt = Date.now();
    attempt.lastError = error;

    this.priceFetchAttempts.set(symbol, attempt);

    if (attempt.attempts === 1) {
      console.log(
        `⚠️  ${symbol}: Price fetch failed (attempt 1/${this.MAX_FETCH_ATTEMPTS})`
      );
    } else if (attempt.attempts < this.MAX_FETCH_ATTEMPTS) {
      console.log(
        `⚠️  ${symbol}: Price fetch failed (attempt ${attempt.attempts}/${this.MAX_FETCH_ATTEMPTS})`
      );
    } else {
      console.log(
        `❌ ${symbol}: Price fetch failed ${attempt.attempts} times, pausing fetches`
      );
    }
  }

  private handleMissingPrice(bot: BotInstance) {
    const attempt = this.priceFetchAttempts.get(bot.symbol);

    if (bot.position) {
      if (bot.position.currentPrice && bot.position.currentPrice > 0) {
        this.updateBotWithPrice(bot, bot.position.currentPrice);

        if (attempt && attempt.attempts >= 2) {
          console.log(
            `⚠️  ${bot.symbol}: Using last known price $${bot.position.currentPrice.toFixed(6)} ` +
              `(${attempt.attempts} failed fetch attempts)`
          );
        }

        return;
      }

      console.log(`🚨 CRITICAL: ${bot.symbol} has position but NO price data!`);

      const timeSinceEntry = Date.now() - bot.position.entryTime.getTime();
      const MAX_TIME_WITHOUT_PRICE = 300000;
      const MIN_FAILED_ATTEMPTS = 3;

      if (
        attempt &&
        attempt.attempts >= MIN_FAILED_ATTEMPTS &&
        timeSinceEntry > MAX_TIME_WITHOUT_PRICE
      ) {
        console.log(
          `🚨 ${bot.symbol}: Closing position due to prolonged price unavailability\n` +
            `   Failed attempts: ${attempt.attempts}\n` +
            `   Time since entry: ${(timeSinceEntry / 60000).toFixed(1)} minutes`
        );
        this.exitPosition(bot, 'PRICE_UNAVAILABLE');
      } else {
        console.log(
          `⚠️  ${bot.symbol}: Using ENTRY price as emergency fallback $${bot.position.entryPrice.toFixed(6)}`
        );
        this.updateBotWithPrice(bot, bot.position.entryPrice);
      }
    } else {
      if (!attempt || attempt.attempts === 1) {
        console.log(
          `ℹ️  ${bot.symbol}: No price available (no active position)`
        );
      }
    }
  }

  private handleMissingPrice_SafeVersion(bot: BotInstance) {
    const attempt = this.priceFetchAttempts.get(bot.symbol);

    if (bot.position) {
      let fallbackPrice: number | null = null;
      let fallbackSource = '';

      if (bot.position.currentPrice && bot.position.currentPrice > 0) {
        fallbackPrice = bot.position.currentPrice;
        fallbackSource = 'last known price';
      } else if (bot.position.entryPrice && bot.position.entryPrice > 0) {
        fallbackPrice = bot.position.entryPrice;
        fallbackSource = 'entry price';
      } else if (bot.position.stopLoss && bot.position.takeProfit) {
        fallbackPrice = (bot.position.stopLoss + bot.position.takeProfit) / 2;
        fallbackSource = 'midpoint of SL/TP';
      }

      if (fallbackPrice) {
        this.updateBotWithPrice(bot, fallbackPrice);

        if (attempt && attempt.attempts >= 2) {
          console.log(
            `⚠️  ${bot.symbol}: Using ${fallbackSource} $${fallbackPrice.toFixed(6)} ` +
              `(${attempt.attempts} failed attempts)`
          );
        }
      } else {
        console.error(
          `🚨 CRITICAL ERROR: ${bot.symbol} has position but NO fallback price available!\n` +
            `   Entry: ${bot.position.entryPrice}\n` +
            `   Current: ${bot.position.currentPrice}\n` +
            `   This should not be possible!`
        );
      }
    } else {
      if (!attempt || attempt.attempts === 1) {
        console.log(`ℹ️  ${bot.symbol}: No price (no position)`);
      }
    }
  }

  /**
   * ✅ Helper: Get prices from scanner file
   */
  private async getPricesFromScanner(): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();

    try {
      const scannerFile = './data/signals/futures-signals.json';

      if (!fs.existsSync(scannerFile)) {
        return priceMap;
      }

      const content = fs.readFileSync(scannerFile, 'utf-8');
      const data = JSON.parse(content);

      if (!Array.isArray(data)) {
        return priceMap;
      }

      data.forEach((result: any) => {
        if (result && result.symbol && result.price) {
          const symbol = normalize(result.symbol);
          priceMap.set(symbol, result.price);
        }
      });
    } catch (err: any) {
      console.error(`Error reading scanner file: ${err.message}`);
    }

    return priceMap;
  }

  getBots(): Map<string, BotInstance> {
    return this.bots;
  }

  getTradeHistory(): CompletedTrade[] {
    return this.tradeHistory;
  }

  setTradeHistory(history: CompletedTrade[]) {
    this.tradeHistory = history;
  }

  addBot(bot: BotInstance) {
    this.bots.set(bot.symbol, bot);
  }

  /**
   * ✅ UPDATED: Initialize method with better restore logic
   */
  async initialize(): Promise<void> {
    validateConfig();
    log('🚀 Initializing Futures Trading Bot...', 'info');

    const previousState = this.persistence.loadState();

    if (previousState && previousState.bots.length > 0) {
      log(
        `♻️  Found previous state with ${previousState.bots.length} active bots`,
        'info'
      );
      log('   Restoring positions...', 'info');

      this.persistence.restoreState(
        this as unknown as BaseTradingBot<FuturesBotInstance>,
        previousState,
        configForLogging
      );

      if (MORAY_CONFIG.enabled && this.moraySystem) {
        let reinitCount = 0;
        for (const [symbol, bot] of this.bots.entries()) {
          if (bot.position && !bot.position.partialTargets) {
            log(`🐍 Re-initializing Moray for ${symbol}...`, 'info');
            bot.position = this.moraySystem.initializePosition(bot.position);
            reinitCount++;
          }
        }
        if (reinitCount > 0) {
          log(
            `✅ Re-initialized Moray for ${reinitCount} position(s)`,
            'success'
          );
        }
      }

      const activePositions = Array.from(this.bots.values()).filter(
        (b) => b.position
      ).length;
      log(`✅ Restored ${activePositions} active position(s)`, 'success');

      log('🔄 Fetching current prices for restored positions...', 'info');
      await this.updatePricesFromScanner();

      log('✅ Restored positions updated with current prices', 'success');
    } else {
      log('ℹ️  Starting fresh - no previous state found', 'info');
    }

    if (this.tradeHistory && this.tradeHistory.length > 0) {
      console.log(
        `\n🔧 Checking ${this.tradeHistory.length} trade record(s)...`
      );
      this.fixLegacyTradeRecords();
    }

    console.log('🔄 Syncing signal states with active positions...');
    const activeBotSymbols = new Set(Array.from(this.bots.keys()));

    const inTradeSignals = this.signalReader.getInTradeSignals();
    let cleaned = 0;

    for (const { symbol } of inTradeSignals) {
      if (!activeBotSymbols.has(symbol)) {
        console.log(`   🧹 Releasing stale signal: ${symbol}`);
        this.signalReader.releaseSignal(symbol);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`   ✅ Cleaned up ${cleaned} stale signal(s)`);
    }

    log(`Signal File: ${configForLogging.signalFile}`, 'info');
    log(`Total Capital: $${configForLogging.totalCapital} USDT`, 'info');
    log(
      `Available Capital: $${configForLogging.availableCapital.toFixed(2)} USDT`,
      'info'
    );
    log(`Max Positions: ${configForLogging.maxConcurrentPositions}`, 'info');
    log(
      `Position Size: $${configForLogging.positionSize.toFixed(2)} USDT per position`,
      'info'
    );
    log(`Leverage: ${configForLogging.leverageMultiplier}x`, 'info');
    log('═'.repeat(80), 'info');

    log('✅ Bot initialized and ready', 'success');

    this.startMonitoring();
  }

  /**
   * ✅ NEW: Helper method to update a bot with a price
   */

  private updateBotWithPrice(bot: BotInstance, currentPrice: number) {
    if (!bot.priceHistory || bot.priceHistory.length === 0) {
      bot.priceHistory = [currentPrice];
    }

    bot.priceHistory.push(currentPrice);
    if (bot.priceHistory.length > 100) {
      bot.priceHistory.shift();
    }

    if (bot.position) {
      this.updatePosition(bot, currentPrice);
    } else if (bot.signal && bot.priceHistory.length >= 3) {
      this.checkEntryCondition(bot, currentPrice);
    }

    bot.lastUpdate = new Date();
  }

  /**
   * Get total number of trades (active + completed)
   */
  private getTotalTradeCount(): number {
    return this.getActiveTradeCount() + this.tradeHistory.length;
  }

  /**
   * Get number of active/running positions
   */
  private getActiveTradeCount(): number {
    let activeCount = 0;

    for (const bot of this.bots.values()) {
      if (bot.position && bot.status === 'running') {
        activeCount++;
      }
    }

    return activeCount;
  }

  /**
   * Check if we can still open new positions
   */
  private canOpenNewPosition(): boolean {
    const totalTrades = this.getTotalTradeCount();
    const canOpen = totalTrades < CONFIG.maxTotalTrades;

    if (!canOpen) {
      const active = this.getActiveTradeCount();
      console.log(`\n🚫 TRADE LIMIT REACHED:`);
      console.log(`   Max Allowed: ${CONFIG.maxTotalTrades}`);
      console.log(`   Currently Active: ${active}`);
      console.log(`   Completed: ${this.totalCompletedTrades}`);
      console.log(`   Total: ${totalTrades}`);
    }

    return canOpen;
  }

  private incrementCompletedTrades() {
    this.totalCompletedTrades++;
    log(
      `📊 Completed trades: ${this.totalCompletedTrades}/${CONFIG.maxTotalTrades}`,
      'info'
    );

    if (this.hasReachedTradeLimit()) {
      log(
        `🛑 Maximum trades reached (${CONFIG.maxTotalTrades}). Stopping new positions.`,
        'warning'
      );
    }
  }

  private displayCooldownStatus(): void {
    if (this.symbolCooldowns.size === 0) {
      return;
    }

    console.log('\n🧊 SYMBOLS ON COOLDOWN:');
    console.log('─'.repeat(80));

    const now = Date.now();
    const cooldowns = Array.from(this.symbolCooldowns.values()).sort(
      (a, b) => a.cooldownUntil.getTime() - b.cooldownUntil.getTime()
    );

    for (const cooldown of cooldowns) {
      const minutesLeft = Math.ceil(
        (cooldown.cooldownUntil.getTime() - now) / (1000 * 60)
      );
      const hoursLeft = (minutesLeft / 60).toFixed(1);

      let emoji = '🚬';
      if (cooldown.reason === 'CONSECUTIVE_LOSSES') {
        emoji = cooldown.consecutiveLosses >= 3 ? '😴' : '🍷';
      } else if (cooldown.reason === 'BIG_LOSS') {
        emoji = '😤';
      }

      console.log(
        `  ${emoji} ${cooldown.symbol.padEnd(12)} | ` +
          `Losses: ${cooldown.consecutiveLosses} | ` +
          `PnL: ${cooldown.lossAmount.toFixed(2)} USDT | ` +
          `Resume: ${hoursLeft}h (${cooldown.cooldownUntil.toLocaleTimeString()})`
      );
    }

    console.log('─'.repeat(80));
  }

  private cleanupExpiredCooldowns(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [symbol, cooldown] of this.symbolCooldowns.entries()) {
      if (now >= cooldown.cooldownUntil.getTime()) {
        this.symbolCooldowns.delete(symbol);
        this.consecutiveLosses.delete(symbol);
        cleaned++;
        log(`✅ ${symbol} cooldown expired - ready to trade!`, 'success');
      }
    }

    if (cleaned > 0) {
      log(`🧹 Cleaned up ${cleaned} expired cooldown(s)`, 'info');
    }
  }

  private clearAllCooldowns(): void {
    const count = this.symbolCooldowns.size;
    this.symbolCooldowns.clear();
    this.consecutiveLosses.clear();
    log(
      `🔥 Cleared ${count} cooldown(s) - All symbols ready to trade`,
      'warning'
    );
  }

  private saveCooldowns(): void {
    const cooldownData = Array.from(this.symbolCooldowns.entries()).map(
      ([symbol, info]) => ({
        symbol,
        reason: info.reason,
        cooldownUntil: info.cooldownUntil.toISOString(),
        lossAmount: info.lossAmount,
        consecutiveLosses: info.consecutiveLosses,
      })
    );

    fs.writeFileSync('cooldowns.json', JSON.stringify(cooldownData, null, 2));
  }

  private loadCooldowns(): void {
    try {
      if (!fs.existsSync('cooldowns.json')) return;

      const data = JSON.parse(fs.readFileSync('cooldowns.json', 'utf-8'));
      const now = Date.now();
      let loaded = 0;

      for (const item of data) {
        const cooldownUntil = new Date(item.cooldownUntil);

        if (cooldownUntil.getTime() > now) {
          this.symbolCooldowns.set(item.symbol, {
            symbol: item.symbol,
            reason: item.reason,
            cooldownUntil,
            lossAmount: item.lossAmount,
            consecutiveLosses: item.consecutiveLosses,
          });

          this.consecutiveLosses.set(item.symbol, item.consecutiveLosses);
          loaded++;
        }
      }

      if (loaded > 0) {
        log(`📂 Loaded ${loaded} cooldown(s) from previous session`, 'info');
      }
    } catch (error: any) {
      log(`⚠️ Could not load cooldowns: ${error.message}`, 'warning');
    }
  }

  private async checkEntryCondition(
    bot: BotInstance,
    currentPrice: number
  ): Promise<void> {
    if (bot.position || !bot.signal?.entryPrice) return;

    const signal = bot.signal as EntrySignal;
    const signalPrice = signal.entryPrice as number;

    const priceDiff = Math.abs(
      ((currentPrice - signalPrice) / signalPrice) * 100
    );

    if (priceDiff > configForLogging.maxSlippagePercent) {
      log(
        `⏳ ${bot.symbol} waiting — slippage ${priceDiff.toFixed(2)}% ` +
          `> limit ${configForLogging.maxSlippagePercent}%`,
        'info'
      );
      return;
    }

    if (
      configForLogging.requirePriceConfirmation &&
      (bot.priceHistory as number[]).length >= 2
    ) {
      const prevPrice = (bot.priceHistory as number[])[
        (bot.priceHistory as number[]).length - 2
      ] as number;
      const priceChange = currentPrice - prevPrice;
      const favorableMove =
        signal.side === 'LONG' ? priceChange > 0 : priceChange < 0;

      if (favorableMove) {
        bot.confirmationTicks = (bot.confirmationTicks ?? 0) + 1;
      } else {
        bot.confirmationTicks = Math.max(0, (bot.confirmationTicks ?? 0) - 1);
      }

      if (bot.confirmationTicks < configForLogging.confirmationTicks) {
        log(
          `⏳ ${bot.symbol} waiting for confirmation ` +
            `(${bot.confirmationTicks}/${configForLogging.confirmationTicks} ticks)`,
          'info'
        );
        return;
      }
    }

    const r = new TradeRejectionLogger(signal);
    await this.enterPosition(bot, signal);
  }

  /**
   * Calculates limit order price with slippage buffer
   */
  private calculateLimitPrice(
    side: EntryType,
    marketPrice: number,
    slippageBps: number = 10
  ): number {
    const slippageMultiplier = 1 + slippageBps / 10000;
    return side === 'LONG'
      ? marketPrice * slippageMultiplier
      : marketPrice / slippageMultiplier;
  }

  /**
   * Validates basic entry conditions
   */
  private validateEntryConditions(
    bot: BotInstance,
    signal: EntrySignal
  ): { valid: boolean; reason?: string } {
    if (bot.position) {
      return { valid: false, reason: `${bot.symbol} already has position` };
    }

    if (!SymbolValidator.isSymbolAllowed(bot.symbol)) {
      return { valid: false, reason: `${bot.symbol} blocked - unsafe symbol` };
    }

    return { valid: true };
  }

  /**
   * Validates candle data sufficiency
   */
  private validateCandleData(candles: any, symbol: string): boolean {
    if (!candles || !candles.closes) {
      log(`❌ ${symbol} candle data unavailable`, 'error');
      return false;
    }

    if (candles.closes.length < 50) {
      log(
        `❌ ${symbol} insufficient candle history (requires 50 candles)`,
        'error'
      );
      return false;
    }

    return true;
  }

  /**
   * Validates spread and calculates entry price
   */
  private async validateAndGetEntryPrice(
    symbol: string,
    side: 'LONG' | 'SHORT',
    marketPrice: number
  ): Promise<{ valid: boolean; entryPrice?: number; spread?: number }> {
    try {
      const orderBook = await this.binance.fetchOrderBook(symbol, 5);
      const bestBid = orderBook.bids[0]?.[0] || marketPrice;
      const bestAsk = orderBook.asks[0]?.[0] || marketPrice;
      const spread = ((bestAsk - bestBid) / marketPrice) * 100;

      if (spread > 0.3) {
        log(`❌ Spread too wide: ${spread.toFixed(2)}%`, 'error');
        return { valid: false, spread };
      }

      const entryPrice = this.calculateLimitPrice(side, marketPrice);
      return { valid: true, entryPrice, spread };
    } catch (error: any) {
      log(`❌ Failed to fetch order book: ${error.message}`, 'error');
      return { valid: false };
    }
  }

  /**
   * Executes entry order (paper or real)
   */
  private async executeEntryOrder(
    bot: BotInstance,
    side: 'LONG' | 'SHORT',
    quantity: number,
    limitPrice: number,
    leverageMultiplier: number,
    marginRequired: number
  ): Promise<{
    success: boolean;
    entryPrice?: number;
    quantity?: number;
    orderId?: string;
  }> {
    if (CONFIG.paperTrading) {
      console.log('⚠️ PAPER TRADING MODE');
      return {
        success: true,
        entryPrice: limitPrice,
        quantity,
        orderId: `paper-${bot.symbol}-${Date.now()}`,
      };
    }

    console.log('🚀 REAL TRADING MODE');
    try {
      await this.setLeverage(this.binance, bot.symbol, leverageMultiplier);
      await this.setMarginMode(this.binance, bot.symbol, 'ISOLATED');

      const roundedPrice = SymbolValidator.roundPrice(bot.symbol, limitPrice);

      console.log(
        `📊 Placing LIMIT order: ${quantity.toFixed(8)} @ $${roundedPrice.toFixed(6)}`
      );

      const entryOrder = await this.binance.createLimitOrder(
        bot.symbol,
        side === 'LONG' ? 'BUY' : 'SELL',
        quantity,
        roundedPrice,
        { timeInForce: 'GTC' }
      );

      const filledPrice = entryOrder.average || entryOrder.price || limitPrice;
      console.log(`✅ FILLED at $${filledPrice.toFixed(6)}`);

      return {
        success: true,
        entryPrice: filledPrice,
        quantity: entryOrder.filled,
        orderId: entryOrder.id as string,
      };
    } catch (error: any) {
      console.error(`❌ Real trade failed: ${error.message}`);
      releaseCapital(marginRequired, 0);
      return { success: false };
    }
  }

  /**
   * Calculates ATR-based stop loss with constraints
   */
  private calculateStopLoss(
    candles: any,
    entryPrice: number,
    side: 'LONG' | 'SHORT'
  ): { stopLoss: number; atr: number; riskDistance: number } {
    const atrArray = ATR.calculate({
      high: candles.highs,
      low: candles.lows,
      close: candles.closes,
      period: 14,
    });
    const atr = atrArray[atrArray.length - 1] as number;

    let riskDistance = atr * (RISK_REWARD_CONFIG.atrMultiplier || 2.37);

    const maxRiskVal = entryPrice * (RISK_REWARD_CONFIG.maxRiskPercent / 100);
    const minRiskVal = entryPrice * (RISK_REWARD_CONFIG.minRiskPercent / 100);
    riskDistance = Math.max(minRiskVal, Math.min(riskDistance, maxRiskVal));

    const stopLoss =
      side === 'LONG' ? entryPrice - riskDistance : entryPrice + riskDistance;

    return { stopLoss, atr, riskDistance };
  }

  /**
   * Calculates structural take profit
   */
  private calculateTakeProfit(
    candles: any,
    side: EntryType,
    lookback: number = 50
  ): number {
    const recentHighs = candles.highs.slice(-lookback);
    const recentLows = candles.lows.slice(-lookback);

    if (side === 'LONG') {
      const structuralHigh = Math.max(...recentHighs);
      return structuralHigh * 0.999;
    } else {
      const structuralLow = Math.min(...recentLows);
      return structuralLow * 1.001;
    }
  }

  /**
   * Gets market regime and trailing profile
   */
  private getMarketContext(
    bot: BotInstance,
    candles: CandleData
  ): {
    regime: Regime | null;
    liquidityClass: LiquidityClassification;
    trailingProfile: TrailingProfile;
  } {
    const indicators = this.indicatorManager.getIndicators(
      bot.symbol,
      candles
    ) as Indicators;

    if (!indicators) {
      console.error(`❌ [${bot.symbol}] Failed to calculate indicators`);
      return {
        regime: null,
        liquidityClass: {
          tier: 'LOW',
          volume24h: 0,
          volumeCV: 0,
          reason: 'Indicators unavailable',
        },
        trailingProfile: {
          eligible: false,
          reason: 'Indicators unavailable',
          activationR: 0,
          atrMultiplier: 0,
          minCandlesBeforeActivation: 0,
          degradationRule: 'EXIT_IMMEDIATELY',
        },
      };
    }

    const regime = detectRegime(indicators, candles);
    const liquidityClass = classifyLiquidity({
      volume24h: bot.ticker?.quoteVolume ?? 0,
      volumes: candles.volumes,
    });
    const trailingProfile = getTrailingProfile({
      marketQuality: regime.marketQuality,
      volatility: regime.volatility,
      liquidityTier: liquidityClass.tier,
    });

    console.log(
      `💧 [${bot.symbol}] Liquidity: ${liquidityClass.tier} — ${liquidityClass.reason}`
    );
    console.log(
      `🎯 [${bot.symbol}] Trailing: ${trailingProfile.eligible ? 'ENABLED' : 'DISABLED'} — ${trailingProfile.reason}`
    );

    return { regime, liquidityClass, trailingProfile };
  }

  /**
   * Places stop loss order (real or virtual)
   */
  private async placeStopLossOrder(
    bot: BotInstance,
    side: EntryType,
    quantity: number,
    stopPrice: number,
    trailingEnabled: boolean
  ): Promise<string | undefined> {
    if (CONFIG.paperTrading || trailingEnabled) {
      const mode = trailingEnabled ? 'VIRTUAL (trailing enabled)' : 'PAPER';
      console.log(`\n🛡️ Using ${mode} Stop-Loss @ $${stopPrice.toFixed(6)}`);
      if (trailingEnabled) {
        console.log(
          `   ℹ️ Monitor loop will execute market close if price crosses SL`
        );
      }
      return undefined;
    }

    try {
      console.log(`\n🛡️ Placing Stop-Loss @ $${stopPrice.toFixed(6)}...`);
      const slOrder = await this.placeStopLoss(this.binance, {
        symbol: bot.symbol,
        side,
        quantity,
        stopPrice,
      });

      const orderId = slOrder.id as string;
      console.log(`✅ SL Order ID: ${orderId}`);

      if (!orderId) {
        throw new Error('CRITICAL: Position opened without exchange SL');
      }

      return orderId;
    } catch (error: any) {
      console.error(`❌ CRITICAL: Failed to place Stop Loss: ${error.message}`);
      await this.emergencyClosePosition(bot.symbol, side, quantity);
      throw error;
    }
  }

  /**
   * Emergency position close
   */
  private async emergencyClosePosition(
    symbol: string,
    side: EntryType,
    quantity: number
  ): Promise<void> {
    try {
      await this.binance.createMarketOrder(
        symbol,
        side === 'LONG' ? 'SELL' : 'BUY',
        quantity,
        undefined,
        { reduceOnly: true }
      );
      console.log(`✅ Emergency close executed`);
    } catch (closeError: any) {
      console.error(`❌ CRITICAL: Emergency close FAILED!`, closeError.message);
      console.error(`🚨 MANUAL INTERVENTION REQUIRED FOR ${symbol}!`);
    }
  }

  /**
   * Places all Moray partial orders
   */
  private async placeMorayPartials(
    bot: BotInstance,
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    totalQuantity: number,
    stopLoss: number
  ): Promise<string[]> {
    if (!MORAY_CONFIG.enabled) {
      return [];
    }

    console.log(`\n🐍 PLACING MORAY PARTIAL ORDERS...`);
    console.log(`   Entry: $${entryPrice.toFixed(6)}`);
    console.log(`   Stop Loss: $${stopLoss.toFixed(6)}`);
    console.log(`   Total Qty: ${totalQuantity.toFixed(8)}`);

    const partialOrderIds: string[] = [];
    const placedQuantities: number[] = [];

    for (let i = 0; i < MORAY_CONFIG.partials.length; i++) {
      const partial = MORAY_CONFIG.partials[i] as PartialTarget;

      const targetPrice = this.moraySystem.calculateTargetPrice(
        entryPrice,
        side as EntryType,
        partial.ratio,
        stopLoss
      );

      console.log(`\n   🎯 Partial ${i + 1}: ${partial.label}`);
      console.log(`      Ratio: ${partial.ratio}R`);
      console.log(`      Target: $${targetPrice.toFixed(6)}`);

      if (!this.isValidPartialTarget(side, targetPrice, entryPrice)) {
        console.error(`      ❌ INVALID: Target in wrong direction`);
        continue;
      }

      const partialQty = this.calculatePartialQuantity(
        i,
        partial,
        totalQuantity,
        placedQuantities
      );

      const roundedQty = SymbolValidator.roundQuantity(
        bot.symbol,
        partialQty,
        targetPrice
      );
      const roundedPrice = SymbolValidator.roundPrice(bot.symbol, targetPrice);

      if (roundedQty <= 0) {
        console.error(`      ❌ INVALID: Quantity is ${roundedQty}`);
        continue;
      }

      console.log(
        `      Placing: ${roundedQty.toFixed(8)} @ $${roundedPrice.toFixed(6)}`
      );

      try {
        const partialOrder = await this.binance.createLimitOrder(
          bot.symbol,
          side === 'LONG' ? 'SELL' : 'BUY',
          roundedQty,
          roundedPrice,
          { reduceOnly: true, timeInForce: 'GTC' }
        );

        partialOrderIds.push(partialOrder.id as string);
        placedQuantities.push(roundedQty);
        console.log(`      ✅ Order ID: ${partialOrder.id}`);
      } catch (error: any) {
        console.error(`      ❌ Failed to place partial: ${error.message}`);
      }
    }

    console.log(
      `\n✅ Moray: Placed ${partialOrderIds.length}/${MORAY_CONFIG.partials.length} partial orders`
    );
    return partialOrderIds;
  }

  /**
   * Validates partial target is in correct direction
   */
  private isValidPartialTarget(
    side: 'LONG' | 'SHORT',
    targetPrice: number,
    entryPrice: number
  ): boolean {
    if (side === 'LONG' && targetPrice <= entryPrice) return false;
    if (side === 'SHORT' && targetPrice >= entryPrice) return false;
    return true;
  }

  /**
   * Calculates quantity for a partial order
   */
  private calculatePartialQuantity(
    index: number,
    partial: PartialTarget,
    totalQuantity: number,
    placedQuantities: number[]
  ): number {
    if (index === MORAY_CONFIG.partials.length - 1) {
      const totalPlaced = placedQuantities.reduce((sum, q) => sum + q, 0);
      const remaining = totalQuantity - totalPlaced;

      console.log(`      🔥 FINAL PARTIAL:`);
      console.log(`         Total: ${totalQuantity.toFixed(8)}`);
      console.log(`         Placed so far: ${totalPlaced.toFixed(8)}`);
      console.log(`         Remaining: ${remaining.toFixed(8)}`);

      return remaining;
    }

    return totalQuantity * partial.percent;
  }

  /**
   * Places safety net take profit order
   */
  private async placeSafetyTakeProfit(
    bot: BotInstance,
    side: 'LONG' | 'SHORT',
    totalQuantity: number,
    takeProfitPrice: number,
    partialOrderIds: string[]
  ): Promise<string | undefined> {
    if (CONFIG.paperTrading) {
      return undefined;
    }

    const allPartialsPlaced =
      MORAY_CONFIG.enabled &&
      partialOrderIds.length === MORAY_CONFIG.partials.length;

    if (allPartialsPlaced) {
      console.log(
        `\n⏭️ Skipping safety-net TP — all ${partialOrderIds.length} Moray partials on exchange`
      );
      return undefined;
    }

    let tpQuantity = totalQuantity;
    if (MORAY_CONFIG.enabled && partialOrderIds.length > 0) {
      const coveredQty = MORAY_CONFIG.partials
        .slice(0, partialOrderIds.length)
        .reduce((sum, p) => sum + totalQuantity * p.percent, 0);
      tpQuantity = totalQuantity - coveredQty;
      console.log(
        `\n⚠️ Partial failure — safety TP covers remaining: ${tpQuantity.toFixed(8)}`
      );
    }

    const roundedQty = SymbolValidator.roundQuantity(
      bot.symbol,
      tpQuantity,
      takeProfitPrice
    );
    const roundedPrice = SymbolValidator.roundPrice(
      bot.symbol,
      takeProfitPrice
    );

    try {
      console.log(
        `\n🎯 Placing Take-Profit @ $${roundedPrice.toFixed(6)} (qty: ${roundedQty.toFixed(8)})...`
      );

      const tpOrder = await this.placeTakeProfit(this.binance, {
        symbol: bot.symbol,
        side,
        quantity: roundedQty,
        takeProfitPrice: roundedPrice,
      });

      const orderId = tpOrder.id as string;
      console.log(`✅ TP Order ID: ${orderId}`);
      return orderId;
    } catch (error: any) {
      console.error(
        `❌ WARNING: Failed to place Take Profit: ${error.message}`
      );

      if (MORAY_CONFIG.enabled && partialOrderIds.length > 0) {
        console.log(`   ℹ️ Moray partials still active, TP not critical`);
      } else {
        console.warn(`   ⚠️ No TP protection! Relying on SL only`);
      }

      return undefined;
    }
  }

  /**
   * Logs order placement summary
   */
  private logOrderSummary(
    bot: BotInstance,
    entryOrderId: string | undefined,
    stopLossOrderId: string | undefined,
    takeProfitOrderId: string | undefined,
    partialOrderIds: string[]
  ): void {
    console.log('\n=== ORDER PLACEMENT SUMMARY ===');
    console.log(`Symbol: ${bot.symbol}`);
    console.log(`Entry Order ID: ${entryOrderId}`);
    console.log(`Stop Loss Order ID: ${stopLossOrderId ?? 'VIRTUAL'}`);
    console.log(`Take Profit Order ID: ${takeProfitOrderId ?? 'NONE'}`);
    console.log(
      `Partial Order IDs (${partialOrderIds.length}):`,
      partialOrderIds
    );
    console.log(`MORAY_CONFIG.enabled: ${MORAY_CONFIG.enabled}`);
    console.log(`CONFIG.paperTrading: ${CONFIG.paperTrading}`);
    console.log('================================\n');

    console.log(`✅ Position Protection Status:`);
    console.log(
      `   Stop Loss: ${stopLossOrderId ? '✅ ACTIVE' : '⚠️ VIRTUAL'}`
    );
    console.log(
      `   Take Profit: ${takeProfitOrderId ? '✅ ACTIVE' : '⚠️ MISSING'}`
    );

    if (MORAY_CONFIG.enabled) {
      console.log(
        `   Moray Partials: ${partialOrderIds.length > 0 ? `✅ ${partialOrderIds.length} orders` : '⚠️ NONE'}`
      );
    }
  }

  private computeStopLossTakeProfit(
    side: EntryType,
    entryPrice: number,
    riskDistance: number,
    recentHighs: number[],
    recentLows: number[]
  ): { stopLoss: number; takeProfit: number } {
    const stopLoss =
      side === 'LONG' ? entryPrice - riskDistance : entryPrice + riskDistance;

    const takeProfit =
      side === 'LONG'
        ? Math.max(...recentHighs) * 0.999
        : Math.min(...recentLows) * 1.001;

    return { stopLoss, takeProfit };
  }

  private computeRR(
    entryPrice: number,
    stopLoss: number,
    takeProfit: number
  ): number {
    const riskDist = Math.abs(entryPrice - stopLoss);
    const rewardDist = Math.abs(takeProfit - entryPrice);
    return riskDist > 0 ? rewardDist / riskDist : 0;
  }

  private async getOpenPositionCount(): Promise<{
    local: number;
    exchange: number;
    effective: number;
  }> {
    const local = [...this.bots.values()].filter(
      (b) => b.position !== null
    ).length;

    if (CONFIG.paperTrading) {
      return { local, exchange: local, effective: local };
    }

    try {
      const positions = await this.binance.fetchPositions();
      const exchange = positions.filter(
        (p: any) => Math.abs(parseFloat(p.contracts ?? p.positionAmt ?? 0)) > 0
      ).length;

      const effective = Math.max(local, exchange);

      if (exchange !== local) {
        log(
          `⚠️  Position count mismatch — local: ${local}, exchange: ${exchange}. ` +
            `Using ${effective} (higher value) as safety margin.`,
          'warning'
        );
      }

      return { local, exchange, effective };
    } catch (err: any) {
      log(
        `⚠️  Could not fetch exchange positions: ${err.message}. ` +
          `Falling back to local count (${local}).`,
        'warning'
      );
      return { local, exchange: -1, effective: local };
    }
  }

  private async getAvailableBalance(): Promise<number> {
    if (CONFIG.paperTrading) {
      return CONFIG.availableCapital;
    }
    try {
      const balance = await this.binance.fetchBalance({ type: 'future' });
      return (balance?.USDT?.free as number) ?? 0;
    } catch (err: any) {
      log(`❌ Failed to fetch account balance: ${err.message}`, 'error');
      return 0;
    }
  }

  private async enterPosition(
    bot: BotInstance,
    signal: EntrySignal
  ): Promise<boolean> {
    if (bot.position) {
      log(`⚠️ ${bot.symbol} already has position`, 'warning');
      return false;
    }

    if (!SymbolValidator.isSymbolAllowed(bot.symbol)) {
      log(`🚫 ${bot.symbol} blocked - unsafe symbol`, 'error');
      return false;
    }

    console.log(`\n🔍 Evaluating entry for ${bot.symbol} ${signal.side}`);

    const initialized = await this.candleManager.initializeHistoricalCandles(
      bot.symbol,
      500,
      0,
      'FUTURES'
    );

    if (!initialized) {
      log(`❌ ${bot.symbol} candle initialization failed`, 'error');
      return false;
    }

    const candles = this.candleManager.getCandles(bot.symbol, 'FUTURES');

    if (!candles || !candles.closes) {
      log(`❌ ${bot.symbol} candle data unavailable`, 'error');
      return false;
    }

    if (candles.closes.length < 50) {
      log(`❌ ${bot.symbol} insufficient candle history`, 'error');
      return false;
    }

    const currentPriceData = await this.priceFetcher.getCurrentPrice(
      bot.symbol
    );
    const curPrice = currentPriceData?.price as number;

    if (!curPrice || curPrice <= 0) {
      log(`❌ ${bot.symbol} invalid price: ${curPrice}`, 'error');
      return false;
    }

    const signalSlippage = Math.abs(
      ((curPrice - (signal.entryPrice as number)) /
        (signal.entryPrice as number)) *
        100
    );

    if (signalSlippage > configForLogging.maxSlippagePercent) {
      log(
        `⚠️ ${bot.symbol} slippage too high (${signalSlippage.toFixed(2)}%)`,
        'warning'
      );
      return false;
    }

    const side = signal.side as EntryType;
    const leverageMultiplier = configForLogging.leverageMultiplier;

    const atrArray = ATR.calculate({
      high: candles.highs,
      low: candles.lows,
      close: candles.closes,
      period: 14,
    });
    const atr = atrArray[atrArray.length - 1] as number;

    if (!atr || atr <= 0) {
      log(`❌ ${bot.symbol} invalid ATR: ${atr}`, 'error');
      return false;
    }

    let riskDistance = atr * (RISK_REWARD_CONFIG.atrMultiplier || 2.37);
    const maxRiskVal = curPrice * (RISK_REWARD_CONFIG.maxRiskPercent / 100);
    const minRiskVal = curPrice * (RISK_REWARD_CONFIG.minRiskPercent / 100);
    riskDistance = Math.max(minRiskVal, Math.min(riskDistance, maxRiskVal));

    const positionSizeUSD = configForLogging.positionSize;
    const contractQuantity = positionSizeUSD / curPrice;
    const marginRequired = positionSizeUSD / leverageMultiplier;

    const preStopLoss =
      side === 'LONG' ? curPrice - riskDistance : curPrice + riskDistance;

    const lookback = 50;
    const recentHighs = candles.highs.slice(-lookback);
    const recentLows = candles.lows.slice(-lookback);

    const preTakeProfit =
      side === 'LONG'
        ? Math.max(...recentHighs) * 0.999
        : Math.min(...recentLows) * 1.001;

    const preRiskDist = Math.abs(curPrice - preStopLoss);
    const preRewardDist = Math.abs(preTakeProfit - curPrice);
    const preRRRatio = preRewardDist / preRiskDist;

    console.log(`\n📊 ${bot.symbol} PRE-TRADE RR CHECK:`);
    console.log(`   Entry: $${curPrice.toFixed(6)}`);
    console.log(
      `   SL   : $${preStopLoss.toFixed(6)} (risk $${preRiskDist.toFixed(4)})`
    );
    console.log(
      `   TP   : $${preTakeProfit.toFixed(6)} (reward $${preRewardDist.toFixed(4)})`
    );
    console.log(`   RR   : ${preRRRatio.toFixed(2)}`);

    if (preRRRatio < 1.5) {
      log(
        `🚫 ${bot.symbol} RR (${preRRRatio.toFixed(2)}) below 1.5 - REJECTED BEFORE ORDER ✅ (no fee paid)`,
        'warning'
      );
      return false;
    }

    if (!reserveCapital(marginRequired)) {
      log(`❌ ${bot.symbol} insufficient capital`, 'error');
      return false;
    }

    if (!CONFIG.paperTrading) {
      try {
        const orderBook = await this.binance.fetchOrderBook(bot.symbol, 5);
        const bestBid = orderBook.bids[0]?.[0] || curPrice;
        const bestAsk = orderBook.asks[0]?.[0] || curPrice;
        const spread = ((bestAsk - bestBid) / curPrice) * 100;

        console.log(`📊 ${bot.symbol} Spread: ${spread.toFixed(3)}%`);

        if (spread > 0.3) {
          log(
            `❌ ${bot.symbol} spread too wide: ${spread.toFixed(2)}%`,
            'error'
          );
          releaseCapital(marginRequired, 0);
          return false;
        }
      } catch (err: any) {
        log(
          `❌ ${bot.symbol} order book fetch failed: ${err.message}`,
          'error'
        );
        releaseCapital(marginRequired, 0);
        return false;
      }
    }

    console.log(
      `\n✅ ${bot.symbol} All pre-trade gates passed - placing order...`
    );

    const roundedQuantity = SymbolValidator.roundQuantity(
      bot.symbol,
      contractQuantity,
      curPrice
    );

    let actualEntryPrice: number;
    let actualQuantity: number;
    let entryOrderId: string | undefined;

    if (CONFIG.paperTrading) {
      console.log(`\n⚠️ PAPER TRADING MODE - ${bot.symbol}`);
      actualEntryPrice = curPrice;
      actualQuantity = contractQuantity;
      entryOrderId = `paper-${bot.symbol}-${Date.now()}`;
    } else {
      console.log(`\n🚀 REAL TRADING MODE - ${bot.symbol}`);
      try {
        await this.setLeverage(this.binance, bot.symbol, leverageMultiplier);
        await this.setMarginMode(this.binance, bot.symbol, 'ISOLATED');

        const entryOrder = await this.binance.createMarketOrder(
          bot.symbol,
          side === 'LONG' ? 'BUY' : 'SELL',
          roundedQuantity
        );

        if (entryOrder.status !== 'closed' && entryOrder.status !== 'filled') {
          throw new Error(
            `Order not fully filled: status=${entryOrder.status}`
          );
        }

        actualEntryPrice = entryOrder.average || entryOrder.price;
        actualQuantity = entryOrder.filled;
        entryOrderId = entryOrder.id as string;

        const fillSlippage = Math.abs(
          ((actualEntryPrice - curPrice) / curPrice) * 100
        );
        console.log(
          `✅ ${bot.symbol} FILLED at $${actualEntryPrice.toFixed(6)} ` +
            `(fill slippage: ${fillSlippage.toFixed(3)}%)`
        );
      } catch (error: any) {
        console.error(`❌ ${bot.symbol} market order failed: ${error.message}`);
        releaseCapital(marginRequired, 0);
        return false;
      }
    }

    let stopLoss: number;
    let takeProfit: number;

    try {
      const actualRiskDistance =
        side === 'LONG'
          ? actualEntryPrice - preStopLoss + (actualEntryPrice - curPrice)
          : preStopLoss - actualEntryPrice + (curPrice - actualEntryPrice);

      stopLoss =
        side === 'LONG'
          ? actualEntryPrice - Math.abs(actualRiskDistance)
          : actualEntryPrice + Math.abs(actualRiskDistance);

      takeProfit =
        side === 'LONG'
          ? Math.max(...recentHighs) * 0.999
          : Math.min(...recentLows) * 1.001;

      const finalRiskDist = Math.abs(actualEntryPrice - stopLoss);
      const finalRewardDist = Math.abs(takeProfit - actualEntryPrice);
      const finalRRRatio = finalRewardDist / finalRiskDist;

      console.log(
        `\n📊 ${bot.symbol} POST-FILL RR: ${finalRRRatio.toFixed(2)}`
      );

      if (finalRRRatio < 1.0) {
        log(
          `🚫 ${bot.symbol} CRITICAL: post-fill RR (${finalRRRatio.toFixed(2)}) < 1.0 - emergency close`,
          'error'
        );

        if (!CONFIG.paperTrading) {
          await this.binance.createMarketOrder(
            bot.symbol,
            side === 'LONG' ? 'SELL' : 'BUY',
            actualQuantity,
            undefined,
            { reduceOnly: true }
          );
        }

        releaseCapital(marginRequired, 0);
        return false;
      }

      if (finalRRRatio < 1.5 && finalRRRatio >= 1.0) {
        log(
          `⚠️ ${bot.symbol} RR degraded to ${finalRRRatio.toFixed(2)} (was ${preRRRatio.toFixed(2)}) - ACCEPTING`,
          'warning'
        );
      }
    } catch (e: any) {
      log(`❌ ${bot.symbol} SL/TP recalculation failed: ${e.message}`, 'error');

      if (!CONFIG.paperTrading) {
        try {
          await this.binance.createMarketOrder(
            bot.symbol,
            side === 'LONG' ? 'SELL' : 'BUY',
            actualQuantity,
            undefined,
            { reduceOnly: true }
          );
        } catch (closeErr) {
          console.error(`❌ Emergency close failed!`);
        }
      }

      releaseCapital(marginRequired, 0);
      return false;
    }

    const roundedSL = SymbolValidator.roundPrice(bot.symbol, stopLoss);
    const roundedTP = SymbolValidator.roundPrice(bot.symbol, takeProfit);

    let trailingProfile: TrailingProfile;
    let liquidityClass: LiquidityClassification;
    let regime: Regime;

    const indicators = this.indicatorManager.getIndicators(
      bot.symbol,
      candles
    ) as Indicators;

    if (!indicators) {
      trailingProfile = {
        eligible: false,
        reason: 'Indicators unavailable',
        activationR: 0,
        atrMultiplier: 0,
        minCandlesBeforeActivation: 0,
        degradationRule: 'EXIT_IMMEDIATELY',
      };
      liquidityClass = {
        tier: 'LOW',
        volume24h: 0,
        volumeCV: 0,
        reason: 'Indicators unavailable',
      };
      regime = null as any;
    } else {
      regime = detectRegime(indicators, candles);
      liquidityClass = classifyLiquidity({
        volume24h: bot.ticker?.quoteVolume ?? 0,
        volumes: candles.volumes,
      });
      trailingProfile = getTrailingProfile({
        marketQuality: regime.marketQuality,
        volatility: regime.volatility,
        liquidityTier: liquidityClass.tier,
      });
    }

    let stopLossOrderId: string | undefined;
    let takeProfitOrderId: string | undefined;
    let partialOrderIds: string[] = [];

    if (!CONFIG.paperTrading) {
      if (trailingProfile.eligible) {
        console.log(
          `\n🛡️ VIRTUAL Stop-Loss @ $${roundedSL.toFixed(6)} (trailing enabled)`
        );
        stopLossOrderId = undefined;
      } else {
        try {
          console.log(`\n🛡️ Placing Stop-Loss @ $${roundedSL.toFixed(6)}...`);

          const slOrder = await this.placeStopLoss(this.binance, {
            symbol: bot.symbol,
            side,
            quantity: actualQuantity,
            stopPrice: roundedSL,
          });

          stopLossOrderId = slOrder.id as string;

          if (!stopLossOrderId) {
            throw new Error('SL order returned no ID');
          }

          console.log(`✅ SL Order ID: ${stopLossOrderId}`);
        } catch (error: any) {
          console.error(
            `❌ CRITICAL: Failed to place Stop Loss: ${error.message}`
          );
          console.error(
            `⚠️ Position is OPEN but UNPROTECTED - monitoring manually`
          );

          stopLossOrderId = undefined;
        }
      }

      if (MORAY_CONFIG.enabled) {
        console.log(`\n🐍 Placing Moray partial orders...`);

        const placedQuantities: number[] = [];

        for (let i = 0; i < MORAY_CONFIG.partials.length; i++) {
          const partial = MORAY_CONFIG.partials[i] as PartialTarget;

          const targetPrice = this.moraySystem.calculateTargetPrice(
            actualEntryPrice,
            side as EntryType,
            partial.ratio,
            roundedSL
          );

          if (
            (side === 'LONG' && targetPrice <= actualEntryPrice) ||
            (side === 'SHORT' && targetPrice >= actualEntryPrice)
          ) {
            console.error(`   ❌ ${partial.label}: invalid target price`);
            continue;
          }

          let partialQty: number;
          if (i === MORAY_CONFIG.partials.length - 1) {
            const totalPlaced = placedQuantities.reduce((sum, q) => sum + q, 0);
            partialQty = actualQuantity - totalPlaced;
          } else {
            partialQty = actualQuantity * partial.percent;
          }

          const roundedPartialQty = SymbolValidator.roundQuantity(
            bot.symbol,
            partialQty,
            targetPrice
          );

          const roundedTargetPrice = SymbolValidator.roundPrice(
            bot.symbol,
            targetPrice
          );

          if (roundedPartialQty <= 0) continue;

          try {
            const partialOrder = await this.binance.createLimitOrder(
              bot.symbol,
              side === 'LONG' ? 'SELL' : 'BUY',
              roundedPartialQty,
              roundedTargetPrice,
              { reduceOnly: true, timeInForce: 'GTC' }
            );

            partialOrderIds.push(partialOrder.id as string);
            placedQuantities.push(roundedPartialQty);
            console.log(`   ✅ ${partial.label}: Order ID ${partialOrder.id}`);
          } catch (error: any) {
            console.error(`   ❌ ${partial.label}: ${error.message}`);
          }
        }

        console.log(
          `\n✅ Moray: ${partialOrderIds.length}/${MORAY_CONFIG.partials.length} orders placed`
        );
      }

      const allPartialsPlaced =
        MORAY_CONFIG.enabled &&
        partialOrderIds.length === MORAY_CONFIG.partials.length;

      if (!allPartialsPlaced) {
        let tpQuantity = actualQuantity;

        if (MORAY_CONFIG.enabled && partialOrderIds.length > 0) {
          const coveredQty = MORAY_CONFIG.partials
            .slice(0, partialOrderIds.length)
            .reduce((sum, p) => sum + actualQuantity * p.percent, 0);
          tpQuantity = actualQuantity - coveredQty;
        }

        const roundedTPQty = SymbolValidator.roundQuantity(
          bot.symbol,
          tpQuantity,
          roundedTP
        );

        try {
          console.log(
            `\n🎯 Placing Take-Profit @ $${roundedTP.toFixed(6)} (qty: ${roundedTPQty.toFixed(8)})`
          );

          const tpOrder = await this.placeTakeProfit(this.binance, {
            symbol: bot.symbol,
            side,
            quantity: roundedTPQty,
            takeProfitPrice: roundedTP,
          });

          takeProfitOrderId = tpOrder.id as string;
          console.log(`✅ TP Order ID: ${takeProfitOrderId}`);
        } catch (error: any) {
          console.error(
            `❌ WARNING: Failed to place Take Profit: ${error.message}`
          );

          if (MORAY_CONFIG.enabled && partialOrderIds.length > 0) {
            console.log(
              `   ℹ️ Moray partials active - TP failure non-critical`
            );
          } else {
            console.warn(`   ⚠️ No TP - protected by SL only`);
          }
        }
      }

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  PROTECTION STATUS - ${bot.symbol}`);
      console.log(`${'═'.repeat(60)}`);
      console.log(`  Entry: ✅ FILLED`);
      console.log(
        `  SL   : ${stopLossOrderId ? '✅ on exchange' : '⚠️ MANUAL MONITORING'}`
      );
      console.log(
        `  TP   : ${takeProfitOrderId ? '✅ on exchange' : '⚠️ missing'}`
      );
      console.log(
        `  Moray: ${partialOrderIds.length > 0 ? `✅ ${partialOrderIds.length} orders` : 'none'}`
      );
      console.log(`${'═'.repeat(60)}\n`);

      if (!stopLossOrderId && !trailingProfile.eligible) {
        console.error(`🚨 CRITICAL: Position open without SL protection!`);
        console.error(`   Manual monitoring REQUIRED`);
      }
    } else {
      stopLossOrderId = `paper-sl-${bot.symbol}-${Date.now()}`;
      takeProfitOrderId = `paper-tp-${bot.symbol}-${Date.now()}`;

      if (MORAY_CONFIG.enabled) {
        partialOrderIds = MORAY_CONFIG.partials.map(
          (_, i) => `paper-partial-${i}-${bot.symbol}-${Date.now() + i}`
        );
      }
    }

    const position: Position = {
      positionId: `${bot.symbol}-${Date.now()}`,
      symbol: bot.symbol,
      side: side,
      entryPrice: actualEntryPrice,
      currentPrice: actualEntryPrice,
      amount: actualQuantity,
      remainingAmount: actualQuantity,
      stopLoss: roundedSL,
      takeProfit: roundedTP,
      pnlUsd: 0,
      pnlPct: 0,
      leverage: leverageMultiplier,
      marginUsed: marginRequired,
      notionalValue: actualQuantity * actualEntryPrice,
      entryTime: new Date(),
      strategy: signal.strategy,
      partialsSold: 0,
      entryOrderId,
      stopLossOrderId,
      takeProfitOrderId,
      partialOrderIds,
      trailing: initTrailingState({
        profile: trailingProfile,
        marketQuality: regime?.marketQuality,
        volatility: regime?.volatility,
        liquidityTier: liquidityClass.tier,
      }),
    };

    bot.position = position;
    bot.status = 'running';

    if (MORAY_CONFIG.enabled && this.moraySystem) {
      const dynamicMoray = adjustMorayForRegime(regime, liquidityClass);

      if (dynamicMoray) {
        bot.position = this.moraySystem.initializePosition(
          position,
          dynamicMoray.partials
        );

        const morayPos = bot.position as MorayPosition;

        if (morayPos.partialTargets && partialOrderIds.length > 0) {
          morayPos.partialTargets.forEach((target, index) => {
            if (index < partialOrderIds.length) {
              target.orderId = partialOrderIds[index];
              target.onExchange = true;
            }
          });
        }

        log(
          `🐍 ${bot.symbol} Moray initialized (${partialOrderIds.length} orders)`,
          'info'
        );
      }
    }

    const mode = CONFIG.paperTrading ? '[PAPER]' : '[REAL]';
    log(
      `🚀 ${bot.symbol} ${side} OPENED at $${actualEntryPrice.toFixed(6)} ${mode}`,
      'success'
    );
    log(
      `   SL: $${roundedSL.toFixed(6)} | TP: $${roundedTP.toFixed(6)}`,
      'info'
    );
    log(`   Moray: ${partialOrderIds.length} partials active`, 'info');

    if (trailingProfile.eligible) {
      log(
        `   Trailing: ENABLED (${trailingProfile.activationR}R, ${trailingProfile.atrMultiplier}×ATR)`,
        'info'
      );
    }

    return true;
  }
  private async createBot(signal: EntrySignal): Promise<BotInstance | null> {
    const sym = normalize(signal.symbol, 'FUTURES');
    const r = new TradeRejectionLogger(signal);

    const cooldownCheck = this.canTradeSymbol(sym);
    if (!cooldownCheck.canTrade) {
      return r.reject(
        'COOLDOWN',
        cooldownCheck.reason ?? 'Symbol in cooldown period',
        undefined,
        null
      );
    }

    const totalTrades = this.getTotalTradeCount();
    if (totalTrades >= CONFIG.maxTotalTrades) {
      return r.reject(
        'TRADE_LIMIT',
        `${totalTrades}/${CONFIG.maxTotalTrades} trades reached`,
        undefined,
        null
      );
    }

    const positionCount = await this.getOpenPositionCount();
    if (positionCount.effective >= CONFIG.maxConcurrentPositions) {
      return r.reject(
        'CONCURRENT_POSITIONS',
        `at limit ${CONFIG.maxConcurrentPositions}`,
        { local: positionCount.local, exchange: positionCount.exchange },
        null
      );
    }

    if (!signal.entryPrice) {
      return r.reject('INVALID_SIGNAL', 'missing entryPrice', undefined, null);
    }

    const currentPrice = await this.priceFetcher.getCurrentPrice(sym);
    if (!currentPrice) {
      return r.reject(
        'PRICE_FETCH',
        'getCurrentPrice returned null',
        undefined,
        null
      );
    }

    const curPrice = currentPrice.price as number;
    const slippage =
      (Math.abs(curPrice - signal.entryPrice) / signal.entryPrice) * 100;

    if (slippage > configForLogging.maxSlippagePercent) {
      return r.reject(
        'ENTRY_SLIPPAGE',
        `${slippage.toFixed(2)}% > limit ${configForLogging.maxSlippagePercent}%`,
        {
          slippage: +slippage.toFixed(2),
          signal: signal.entryPrice,
          current: curPrice,
        },
        null
      );
    }

    const bot: BotInstance = {
      symbol: signal.symbol,
      status: 'waiting',
      startTime: new Date(),
      pnl: 0,
      sessionPnl: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      position: null,
      lastHeartbeat: new Date(),
      priceHistory: [],
      lastUpdate: new Date(),
      signal,
      confirmationTicks: 0,
      lastPriceDirection: 0,
    };

    this.bots.set(signal.symbol, bot);

    log(
      `🤖 Bot created for ${sym} ` +
        `(${signal.strategy}, ${signal.side}, confidence: ${signal.confidence}%) ` +
        `[${positionCount.effective + 1}/${CONFIG.maxConcurrentPositions} positions]`,
      'success'
    );

    const success = await this.enterPosition(bot, signal);

    if (!success) {
      this.bots.delete(signal.symbol);
      return null;
    }

    r.accept();
    return bot;
  }

  /**
   * ✅ COMPLETE FIXED enterPosition METHOD
   * Ready to copy-paste directly into your FuturesTradingBot class
   */

  private async enterMorayPosition(
    bot: BotInstance,
    signal: EntrySignal,
    position: Position
  ): Promise<boolean> {
    const morayPos = this.moraySystem.initializePosition(position);
    const targets = morayPos.partialTargets!;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i] as PartialTarget;
      const tarRatio = target?.ratio as number;

      const targetPrice = this.moraySystem.calculateTargetPrice(
        morayPos.entryPrice,
        morayPos.side as EntryType,
        tarRatio,
        morayPos.stopLoss
      );

      const quantity = morayPos.amount * target.percent;

      const roundedQty = SymbolValidator.roundQuantity(
        bot.symbol,
        quantity,
        targetPrice
      );
      const roundedPrice = SymbolValidator.roundPrice(bot.symbol, targetPrice);

      try {
        const limitOrder = await this.binance.createLimitOrder(
          bot.symbol,
          morayPos.side === 'LONG' ? 'SELL' : 'BUY',
          roundedQty,
          roundedPrice,
          {
            reduceOnly: true,
          }
        );

        target.orderId = limitOrder.id as string;
        target.targetPrice = roundedPrice;

        console.log(`✅ ${target.label}: ${limitOrder.id} (reduceOnly: true)`);
      } catch (error: any) {
        console.error(`❌ Failed to place ${target.label}: ${error.message}`);
        return false;
      }
    }

    return true;
  }

  private async updatePosition(bot: BotInstance, currentPrice: number) {
    if (!bot.position) return;

    const pos = bot.position as Position;
    if (!pos) return;

    const candles = this.candleManager.getCandles(bot.symbol, 'FUTURES');
    if (!candles) return;
    const indicators = this.indicatorManager.getIndicators(bot.symbol, candles);

    if (!indicators) {
      throw new Error('no indicators');
    }
    const currentRegime = detectRegime(indicators, candles);

    const hoursInTrade =
      (Date.now() - pos.entryTime.getTime()) / (1000 * 60 * 60);

    const degradation = checkRegimeDegradation({
      position: pos,
      currentRegime,
      hoursInTrade,
    });

    if (degradation.shouldExit) {
      console.log(`🚨 REGIME EXIT [${pos.symbol}]: ${degradation.reason}`);

      if (!CONFIG.paperTrading) {
        await this.binance.createMarketOrder(
          pos.symbol,
          pos.side === 'LONG' ? 'SELL' : 'BUY',
          pos.remainingAmount
        );
      }
      const posMarginUsed = pos.marginUsed as number;

      releaseCapital(posMarginUsed, pos.pnlUsd);
      bot.position = null;
      bot.status = 'idle';

      return;
    }

    const slPrice = pos.trailing?.currentTrailingStop ?? pos.stopLoss;
    const side = pos.side;

    let stopLossHit = false;
    if (side === 'LONG' && currentPrice <= slPrice) {
      stopLossHit = true;
    }
    if (side === 'SHORT' && currentPrice >= slPrice) {
      stopLossHit = true;
    }

    if (stopLossHit) {
      console.log(`🚨 STOP LOSS HIT [${pos.symbol}]`);

      return;
    }

    const oldPrice = pos.currentPrice;
    pos.currentPrice = currentPrice;

    if (MORAY_CONFIG.enabled) {
      const morayPos = pos as MorayPosition;

      if (!CONFIG.paperTrading && MORAY_CONFIG.enabled) {
        await this.moraySystem.checkExchangePartialFills(
          morayPos,
          this.binance,

          (params) => this.placeStopLoss(this.binance, params),

          (params) => this.placeTakeProfit(this.binance, params)
        );
      }
      const lvg = pos.leverage as number;

      if (CONFIG.paperTrading && MORAY_CONFIG.enabled) {
        this.moraySystem.checkPartialTargets(
          morayPos,
          currentPrice,
          lvg,
          (amount, pnl, target) => {
            log(`🥩 ${target.label} hit! PnL: $${pnl.toFixed(2)}`, 'success');
          },
          () => {
            log(`🛡️ Stop loss moved to breakeven`, 'info');
          }
        );
      }

      if (!morayPos.partialTargets) {
        console.error(
          `❌ ${bot.symbol} has NO partial targets! Moray not initialized!`
        );
      } else {
        if (!morayPos._loggedTargets) {
          console.log(
            `🐍 ${bot.symbol} Moray active with ${morayPos.partialTargets.length} targets`
          );
          morayPos._loggedTargets = true;
        }
      }
    }

    if (MORAY_CONFIG.enabled) {
      await this.syncMorayWithBinance(bot);

      const anyPartialHit = this.moraySystem.checkPartialTargets(
        bot.position as MorayPosition,
        currentPrice,
        bot.position.leverage || configForLogging.leverageMultiplier,

        (amount, pnl, target) => {
          log(
            formatPartialLog(
              bot.symbol,
              target,
              currentPrice,
              amount,
              pnl,
              bot.position!.leverage || configForLogging.leverageMultiplier
            ),
            'success'
          );

          const pos = bot.position as MorayPosition;
        },

        () => {
          log(`🛡️ ${bot.symbol} ${MORAY_CONFIG.messages.breakeven}`, 'info');
        }
      );

      if (this.moraySystem.allPartialsExecuted(bot.position as MorayPosition)) {
        log(`🎉 ${bot.symbol} ${MORAY_CONFIG.messages.fullExit}`, 'success');
        this.exitPosition(bot, 'ALL_PARTIALS_HIT');
        return;
      }

      if (
        (bot.position.side === 'LONG' &&
          currentPrice <= bot.position.stopLoss) ||
        (bot.position.side === 'SHORT' && currentPrice >= bot.position.stopLoss)
      ) {
        this.exitPosition(bot, 'STOP_LOSS');
        return;
      }
    } else {
      if (
        (bot.position.side === 'LONG' &&
          currentPrice >= bot.position.takeProfit) ||
        (bot.position.side === 'SHORT' &&
          currentPrice <= bot.position.takeProfit)
      ) {
        this.exitPosition(bot, 'TAKE_PROFIT');
        return;
      }
    }

    const totalTrades = this.getTotalTradeCount();

    const tokenQuantity = pos.amount;
    const leverage = pos.leverage || CONFIG.leverageMultiplier;
    const marginUsed = pos.marginUsed || CONFIG.positionSize / leverage;

    let priceChange: number;

    if (pos.side === 'LONG') {
      priceChange = currentPrice - pos.entryPrice;
    } else {
      priceChange = pos.entryPrice - currentPrice;
    }

    const pnlUsd = priceChange * pos.amount;

    const leveragedPnl = pnlUsd * leverage;

    const rawPnl = priceChange * tokenQuantity;

    const positionSize = rawPnl * leverage;

    const pnlPct = (pnlUsd / marginUsed) * 100;

    pos.pnlUsd = pnlUsd;
    pos.pnlPct = pnlPct;

    if (is1000xSymbol(pos.symbol)) {
      const multiplier = getContractMultiplier(pos.symbol);
      const actualTokens = pos.amount;
      console.log(`📊 ${pos.symbol} PnL Check:`);
      console.log(`   Contracts: ${pos.amount.toFixed(4)}`);
      console.log(`   Actual Tokens: ${actualTokens.toFixed(0)}`);
      console.log(`   Price Change: $${priceChange.toFixed(8)}`);
      console.log(`   Raw PnL: $${pnlUsd.toFixed(2)}`);
      console.log(`   Leveraged PnL: $${leveragedPnl.toFixed(2)}`);
    }

    if (!MORAY_CONFIG.enabled) {
      if (
        (bot.position.side === 'LONG' &&
          currentPrice >= bot.position.takeProfit) ||
        (bot.position.side === 'SHORT' &&
          currentPrice <= bot.position.takeProfit)
      ) {
        this.exitPosition(bot, 'TAKE_PROFIT');
        return;
      }
    }

    const priceMovement = (
      ((currentPrice - oldPrice) / oldPrice) *
      100
    ).toFixed(4);
    if (Math.abs(currentPrice - oldPrice) > oldPrice * 0.0001) {
      console.log(
        `📈 ${bot.symbol}: $${oldPrice.toFixed(6)} → $${currentPrice.toFixed(6)} (${priceMovement}%) | PnL: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}% ${pos.pnlUsd >= 0 ? '+' : ''}$${pos.pnlUsd.toFixed(2)}`
      );
    }
  }

  private async exitPosition(bot: BotInstance, reason: string) {
    if (!bot.position) return;

    console.log(`🔍 exitPosition called for ${bot.symbol}, reason: ${reason}`);
    if (!CONFIG.leverageMultiplier) {
      throw new Error('Leverage multiplier is not defined in CONFIG');
    }

    const pos = bot.position as MorayPosition;
    const marginUsed =
      pos.marginUsed || CONFIG.positionSize / CONFIG.leverageMultiplier;
    const entryPrice = pos.entryPrice;
    const amount = pos.amount;
    const leverage =
      pos.leverage ||
      CONFIG.leverageMultiplier ||
      configForLogging.leverageMultiplier ||
      3;
    const notionalValue = pos.notionalValue || CONFIG.positionSize;

    let exitPrice: number;
    let finalPnlUsd: number;
    let rawPnl: number;

    const fPnLUsd = pos.partialPnlRealized;
    const rPnl = fPnLUsd ? fPnLUsd / leverage : 0;
    const ePrice = pos.currentPrice;
    const poLev = pos.leverage as number;
    marginUsed;

    if (reason === 'ALL_PARTIALS_HIT') {
      finalPnlUsd = pos.partialPnlRealized || 0;
      rawPnl = finalPnlUsd / leverage;
      exitPrice = pos.currentPrice;

      console.log(`\n🐍 MORAY EXIT for ${bot.symbol}:`);
      console.log(`   Partials executed: ${pos.partialsSold}`);
      console.log(`   Entry: $${pos.entryPrice.toFixed(6)}`);
      console.log(`   Current: $${exitPrice.toFixed(6)}`);
      console.log(`   Accumulated PnL: $${finalPnlUsd.toFixed(2)}`);
      console.log(`   Raw PnL: $${rawPnl.toFixed(4)}`);
      console.log(`   Leverage: ${leverage}x`);

      const verification = rawPnl * leverage;
      const match = Math.abs(verification - finalPnlUsd) < 0.01;
      console.log(
        `   Verification: ${rawPnl.toFixed(4)} × ${leverage} = ${verification.toFixed(2)} ${match ? '✅' : '❌'}`
      );
    } else {
      exitPrice = pos.pnlUsd > 0 ? pos.takeProfit : pos.stopLoss;

      const priceChange =
        pos.side === 'LONG'
          ? exitPrice - pos.entryPrice
          : pos.entryPrice - exitPrice;

      rawPnl = priceChange * pos.amount;
      finalPnlUsd = rawPnl * leverage;

      pos.pnlUsd = finalPnlUsd;
      pos.pnlPct = (finalPnlUsd / (pos.marginUsed as number)) * 100;

      console.log(`\n🔍 REGULAR EXIT for ${bot.symbol}:`);
      console.log(`   Entry: $${pos.entryPrice.toFixed(6)}`);
      console.log(`   Exit: $${exitPrice.toFixed(6)}`);
      console.log(`   Raw PnL: $${rawPnl.toFixed(4)}`);
      console.log(`   Leveraged PnL: $${finalPnlUsd.toFixed(2)}`);
    }
    if (this.signalReader instanceof EnhancedSignalReader) {
      this.signalReader.markSignalAsCompleted(bot.symbol, rawPnl);

      const calculatedLeveraged = rawPnl * leverage;
      const match = Math.abs(calculatedLeveraged - finalPnlUsd) < 0.01;
      console.log(
        `   Verification: ${rawPnl.toFixed(4)} × ${leverage} = ${calculatedLeveraged.toFixed(2)} ${match ? '✅' : '❌'}`
      );
    }

    const finalPnlPct = (finalPnlUsd / marginUsed) * 100;
    const isWin = finalPnlUsd > 0;

    console.log(
      '🥑 ~ FuturesTradingBot ~ exitPosition ~ finalPnlUsd:',
      finalPnlUsd
    );
    console.log(`   Margin: $${marginUsed.toFixed(2)}`);
    console.log(`   PnL %: ${finalPnlPct.toFixed(2)}%`);
    console.log(`   Result: ${isWin ? '✅ WIN' : '❌ LOSS'}`);

    console.log(`\n💰 CAPITAL RELEASE for ${bot.symbol}:`);
    console.log(`   BEFORE:`);
    console.log(`      Total: $${CONFIG.totalCapital.toFixed(2)}`);
    console.log(`      Available: $${CONFIG.availableCapital.toFixed(2)}`);
    console.log(`      Allocated: $${this.allocatedCapital.toFixed(2)}`);

    releaseCapital(marginUsed, finalPnlUsd);

    this.allocatedCapital -= marginUsed;
    console.log(`   AFTER:`);
    console.log(
      `      Total: $${CONFIG.totalCapital.toFixed(2)} (${finalPnlUsd >= 0 ? '+' : ''}${finalPnlUsd.toFixed(2)})`
    );
    console.log(
      `      Available: $${CONFIG.availableCapital.toFixed(2)} (+${marginUsed.toFixed(2)})`
    );
    console.log(
      `      Allocated: $${this.allocatedCapital.toFixed(2)} (-${notionalValue.toFixed(2)})`
    );

    if (bot.trades === undefined) bot.trades = 0;
    if (bot.wins === undefined) bot.wins = 0;
    if (bot.losses === undefined) bot.losses = 0;
    if (bot.pnl === undefined) bot.pnl = 0;

    this.tradeCounters.total++;
    bot.trades++;

    if (isWin) {
      bot.wins++;
    } else {
      bot.losses++;
    }

    bot.pnl += finalPnlUsd;

    let finalExitReason = reason as ReasonType;

    if (reason === 'STOP_LOSS' && isWin) {
      finalExitReason = 'TAKE_PROFIT';
    } else if (reason === 'TAKE_PROFIT' && !isWin) {
      finalExitReason = 'STOP_LOSS';
    }

    console.log(`\n🔍 PNL DIAGNOSTIC:`);
    console.log(`   Exit reason: ${reason}`);

    if (reason === 'ALL_PARTIALS_HIT') {
      console.log(
        `   Moray accumulated: $${pos.partialPnlRealized?.toFixed(2) || 'UNDEFINED!'}`
      );
      console.log(`   Using for trade: $${finalPnlUsd.toFixed(2)}`);

      if (!pos.partialPnlRealized) {
        console.error(`   ❌ partialPnlRealized is UNDEFINED!`);
        console.error(`   This is the bug - Moray PnL not being accumulated!`);
      }

      if (Math.abs(Number(pos.partialPnlRealized) - finalPnlUsd) > 0.01) {
        console.error(`   ❌ MISMATCH DETECTED!`);
        console.error(`   Moray: $${pos.partialPnlRealized?.toFixed(2)}`);
        console.error(`   Trade: $${finalPnlUsd.toFixed(2)}`);
      }
    }

    console.log(`   Final PnL for trade: $${finalPnlUsd.toFixed(2)}\n`);

    if (reason === 'ALL_PARTIALS_HIT' && !CONFIG.paperTrading) {
      console.log(`\n🧹 MORAY CLEANUP for ${bot.symbol}:`);

      if (pos.takeProfitOrderId) {
        try {
          await this.binance.cancelOrder(pos.takeProfitOrderId, bot.symbol);
          console.log(
            `   ✅ Cancelled safety TP order: ${pos.takeProfitOrderId}`
          );
          pos.takeProfitOrderId = undefined;
        } catch (error: any) {
          if (!error.message.includes('Order does not exist')) {
            console.warn(`   ⚠️ Could not cancel TP: ${error.message}`);
          }
        }
      }

      if (pos.stopLossOrderId) {
        try {
          await this.binance.cancelOrder(pos.stopLossOrderId, bot.symbol);
          console.log(`   ✅ Cancelled SL order: ${pos.stopLossOrderId}`);
          pos.stopLossOrderId = undefined;
        } catch (error: any) {
          if (!error.message.includes('Order does not exist')) {
            console.warn(`   ⚠️ Could not cancel SL: ${error.message}`);
          }
        }
      }

      try {
        const positions = await this.binance.fetchPositions([bot.symbol]);
        const binancePos = positions.find((p: any) => p.symbol === bot.symbol);

        const biCon = binancePos?.contracts as number;

        if (binancePos && Math.abs(biCon) > 0) {
          const dustQty = Math.abs(biCon);

          console.log(
            `   🧹 Closing ${dustQty.toFixed(8)} dust contracts on Binance`
          );

          await this.binance.createMarketOrder(
            bot.symbol,
            pos.side === 'LONG' ? 'SELL' : 'BUY',
            dustQty,
            undefined,
            {
              reduceOnly: true,
            }
          );

          console.log(`   ✅ Dust closed successfully`);
        } else {
          console.log(`   ✅ No dust found - position fully closed`);
        }
      } catch (error: any) {
        console.error(`   ❌ Dust cleanup failed: ${error.message}`);
      }
    }

    const trade: CompletedTrade = {
      symbol: bot.symbol,
      strategy: pos.strategy,
      side: pos.side,
      entryPrice: entryPrice,
      exitPrice: exitPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      amount: amount,
      pnlUsd: finalPnlUsd,
      pnlPct: finalPnlPct,
      duration: Date.now() - pos.entryTime.getTime(),
      exitReason: finalExitReason,
      entryTime: pos.entryTime,
      exitTime: new Date(),
      isWin: isWin,
      leverage: leverage,
      marginUsed: marginUsed,
      notionalValue: notionalValue,
      rawPnl: rawPnl,
      tradeId: pos.positionId,
    };

    this.signalReader.recordCompletedTrade(trade);

    this.signalReader.markSignalAsCompleted(bot.symbol, finalPnlUsd, trade);

    const trRawPnl = trade.rawPnl as number;
    const trLev = trade.leverage as number;

    console.log(`\n📊 Trade Record Verification:`);
    console.log(`   Symbol: ${trade.symbol}`);
    console.log(`   Raw PnL: $${trade.rawPnl?.toFixed(4)}`);
    console.log(`   Leverage: ${trade.leverage}x`);
    console.log(`   Leveraged PnL: $${trade.pnlUsd.toFixed(2)}`);
    console.log(
      `   Calculation: ${trade.rawPnl?.toFixed(4)} × ${trade.leverage} = ${(trRawPnl * trLev).toFixed(2)}`
    );

    const calculationMatch = Math.abs(trRawPnl * trLev - trade.pnlUsd) < 0.01;
    console.log(`   Match: ${calculationMatch ? '✅' : '❌'}`);

    if (!calculationMatch) {
      console.warn(`   ⚠️ PnL calculation mismatch!`);
      console.warn(`      Expected: ${(trRawPnl * trLev).toFixed(2)}`);
      console.warn(`      Got: ${trade.pnlUsd.toFixed(2)}`);
    }

    this.tradeHistory.unshift(trade);
    if (this.tradeHistory.length > this.maxHistorySize) {
      this.tradeHistory.pop();
    }

    this.onPositionClosed(pos);

    if (process.env.DEBUG_CAPITAL) {
      debugCapitalState();
    }

    const icon = isWin ? '✅' : '❌';
    const pnlStr =
      finalPnlUsd >= 0
        ? `+$${finalPnlUsd.toFixed(2)}`
        : `-$${Math.abs(finalPnlUsd).toFixed(2)}`;

    console.log(`\n${icon} ${bot.symbol} ${finalExitReason}`);
    console.log(`   Raw PnL: $${rawPnl.toFixed(4)} × ${leverage}x = ${pnlStr}`);
    console.log(`   PnL %: ${finalPnlPct.toFixed(2)}%`);
    console.log(`   PnL: ${pnlStr} (${finalPnlPct.toFixed(2)}%)`);
    console.log(
      `   Duration: ${Math.floor((Date.now() - pos.entryTime.getTime()) / 60000)}m`
    );

    if (reason === 'ALL_PARTIALS_HIT') {
      console.log(
        `   🐍 Moray: ${(pos as MorayPosition).partialsSold} partials executed`
      );
    }

    bot.position = null;
    bot.status = 'stopped';
    bot.signal = null;

    this.bots.delete(bot.symbol);
    console.log(
      `🗑️  Bot removed: ${bot.symbol} (capital released immediately)`
    );

    console.log(
      `📊 Completed: ${this.tradeCounters.total}/${CONFIG.maxTotalTrades}`
    );

    console.log(
      `📊 Completed: ${this.tradeCounters.total}/${CONFIG.maxTotalTrades}`
    );

    if (
      this.tradeCounters.total >= CONFIG.maxTotalTrades &&
      !this.isShuttingDown
    ) {
      console.log('🏁 TRADE LIMIT REACHED! Initiating graceful shutdown...');
      this.persistence.saveState(
        this as unknown as BaseTradingBot<FuturesBotInstance>,
        configForLogging
      );

      this.initiateGracefulShutdown(
        `Trade limit reached (${CONFIG.maxTotalTrades} trades)`
      );
    }

    if (this.isShuttingDown) {
      this.checkShutdownComplete();
    }
  }

  private async syncMorayWithBinance(bot: BotInstance): Promise<void> {
    if (!bot.position) return;

    const morayPos = bot.position as MorayPosition;

    try {
      const livePositions =
        await this.binanceDataFetcher.fetchActivePositions();
      console.log(
        '🥑 ~ FuturesTradingBot ~ syncMorayWithBinance ~ livePositions:',
        livePositions
      );
      const livePos = livePositions.find((p) => p.symbol === bot.symbol);

      if (!livePos) {
        log(
          `🔄 ${bot.symbol} closed on Binance, cleaning up locally`,
          'warning'
        );
        this.exitPosition(bot, 'CLOSED_ON_EXCHANGE');
        return;
      }

      morayPos.remainingAmount = livePos.quantity;

      if (!morayPos.partialTargets) return;

      for (let i = 0; i < morayPos.partialTargets.length; i++) {
        const target = morayPos.partialTargets[i] as PartialTarget;

        if (target.executed || !target.orderId) continue;

        const order = await this.binance.fetchOrder(target.orderId, bot.symbol);

        if (order.status === 'closed' || order.status === 'filled') {
          log(`✅ ${target.label} filled on Binance`, 'success');

          target.executed = true;
          target.executedAt = order.average || order.price;

          const fillPrice = order.average || order.price;
          const fillAmount = order.filled;

          const pnl = this.moraySystem.calculateLeveragedPnl(
            morayPos.entryPrice,
            fillPrice,
            fillAmount,
            morayPos.side as EntryType,
            morayPos.leverage as number
          );

          morayPos.remainingAmount -= fillAmount;
          morayPos.partialsSold = (morayPos.partialsSold || 0) + 1;
          morayPos.partialPnlRealized =
            (morayPos.partialPnlRealized || 0) + pnl.leveragedPnl;

          this.moraySystem.recordPartialTrade(
            morayPos,
            fillPrice,
            fillAmount,
            pnl.leveragedPnl,
            target,
            morayPos.leverage as number
          );

          log(
            formatPartialLog(
              bot.symbol,
              target,
              fillPrice,
              fillAmount,
              pnl.leveragedPnl,
              morayPos.leverage as number
            ),
            'success'
          );
        }
      }
    } catch (error: any) {
      log(`❌ Sync error for ${bot.symbol}: ${error.message}`, 'error');
    }
  }

  /**
   * Update stop loss dynamically based on regime and profit
   */
  private async updateDynamicStops(bot: BotInstance): Promise<void> {
    const pos = bot.position;
    if (!pos) return;

    const currentPrice = pos.currentPrice;
    const leverage = pos.leverage || CONFIG.leverageMultiplier || 3;

    const priceChange =
      pos.side === 'LONG'
        ? currentPrice - pos.entryPrice
        : pos.entryPrice - currentPrice;

    const pnlPct = (priceChange / pos.entryPrice) * 100 * leverage;

    console.log(`\n🔄 ${bot.symbol}: Checking dynamic stops`);
    console.log(`   Current: $${currentPrice.toFixed(6)}`);
    console.log(`   Entry: $${pos.entryPrice.toFixed(6)}`);
    console.log(`   PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);
    console.log(`   Current SL: $${pos.stopLoss.toFixed(6)}`);
    console.log(
      `   Regime: ${pos.entryRegime?.trend} / ${pos.entryRegime?.volatility}`
    );
    console.log(`   Trailing enabled: ${pos.trailingEnabled ? '✅' : '❌'}`);

    if (CONFIG.breakEvenEnabled && pnlPct >= CONFIG.breakEvenActivationPct) {
      const breakEvenBuffer = CONFIG.breakEvenBuffer / 100;
      const breakEvenPrice =
        pos.side === 'LONG'
          ? pos.entryPrice * (1 + breakEvenBuffer)
          : pos.entryPrice * (1 - breakEvenBuffer);

      const isBetter =
        pos.side === 'LONG'
          ? breakEvenPrice > pos.stopLoss
          : breakEvenPrice < pos.stopLoss;

      if (isBetter) {
        console.log(
          `\n🛡️  BREAK-EVEN triggered at ${pnlPct.toFixed(2)}% profit`
        );
        await this.updateStopLossOnExchange(bot, breakEvenPrice, 'Break-even');
        return;
      }
    }

    if (!pos.trailingEnabled) {
      console.log(
        `   ⏭️  Trailing disabled for ${pos.entryRegime?.trend} regime`
      );
      return;
    }

    if (
      CONFIG.trailingStopEnabled &&
      pnlPct >= CONFIG.trailingStopActivationPct
    ) {
      let trailingPct = CONFIG.trailingStopPercent;

      if (pos.trailingMultiplier) {
        trailingPct = trailingPct * pos.trailingMultiplier;
        console.log(`   📈 Regime multiplier: ${pos.trailingMultiplier}x`);
      }

      if (CONFIG.dynamicTrailingEnabled && CONFIG.dynamicTrailingLevels) {
        for (const level of CONFIG.dynamicTrailingLevels.reverse()) {
          if (pnlPct >= level.minPnlPct) {
            const dynamicPct =
              level.trailingPct * (pos.trailingMultiplier || 1.0);
            console.log(
              `   🎯 At ${pnlPct.toFixed(2)}% profit: Using ${dynamicPct.toFixed(2)}% trail`
            );
            trailingPct = dynamicPct;
            break;
          }
        }
      }

      console.log(`   📊 Final trailing: ${trailingPct.toFixed(2)}%`);

      const trailingStopPrice =
        pos.side === 'LONG'
          ? currentPrice * (1 - trailingPct / 100)
          : currentPrice * (1 + trailingPct / 100);

      const isTrailingBetter =
        pos.side === 'LONG'
          ? trailingStopPrice > pos.stopLoss
          : trailingStopPrice < pos.stopLoss;

      const improvement =
        pos.side === 'LONG'
          ? (trailingStopPrice - pos.stopLoss) / pos.stopLoss
          : (pos.stopLoss - trailingStopPrice) / pos.stopLoss;

      if (isTrailingBetter && improvement > 0.001) {
        console.log(`\n📈 TRAILING STOP triggered`);
        console.log(`   Old SL: $${pos.stopLoss.toFixed(6)}`);
        console.log(`   New SL: $${trailingStopPrice.toFixed(6)}`);
        console.log(`   Improvement: +${(improvement * 100).toFixed(2)}%`);

        await this.updateStopLossOnExchange(
          bot,
          trailingStopPrice,
          `Trailing (${trailingPct.toFixed(1)}% - ${pos.entryRegime?.trend})`
        );
      } else if (isTrailingBetter) {
        console.log(
          `   ⏸️  Trail would improve by only ${(improvement * 100).toFixed(3)}% - waiting`
        );
      }
    } else if (CONFIG.trailingStopEnabled) {
      console.log(
        `   ⏸️  Waiting for ${CONFIG.trailingStopActivationPct}% profit (currently ${pnlPct.toFixed(2)}%)`
      );
    }
  }

  /**
   * Update stop loss on exchange
   */
  private async updateStopLossOnExchange(
    bot: BotInstance,
    newStopLoss: number,
    reason: string
  ): Promise<void> {
    const pos = bot.position;
    if (!pos) return;

    try {
      console.log(`\n🔄 Updating stop loss on exchange...`);
      console.log(`   Reason: ${reason}`);

      if (CONFIG.paperTrading) {
        pos.stopLoss = newStopLoss;
        console.log(`   ✅ Paper: Updated SL to $${newStopLoss.toFixed(6)}`);
        return;
      }

      if (pos.stopLossOrderId) {
        try {
          await this.binance.cancelOrder(pos.stopLossOrderId, bot.symbol);
          console.log(`   ✅ Canceled old SL order: ${pos.stopLossOrderId}`);
        } catch (error: any) {
          console.warn(`   ⚠️  Could not cancel old SL: ${error.message}`);
        }
      }

      const roundedSL = SymbolValidator.roundPrice(bot.symbol, newStopLoss);

      const newSLOrder = await this.binance.createOrder(
        bot.symbol,
        'STOP_MARKET',
        pos.side === 'LONG' ? 'SELL' : 'BUY',
        pos.remainingAmount || pos.amount,
        undefined,
        {
          stopPrice: roundedSL,
          reduceOnly: true,
        }
      );

      pos.stopLoss = roundedSL;
      pos.stopLossOrderId = newSLOrder.id as string;

      console.log(`   ✅ New SL order placed: ${newSLOrder.id}`);
      console.log(`   📍 New SL: $${roundedSL.toFixed(6)}`);
    } catch (error: any) {
      console.error(`\n❌ Failed to update stop loss: ${error.message}`);
    }
  }

  private startMonitoring(): void {
    console.log('✅ Position monitoring started (every 5s)');
  }

  private async forceClosePosition(bot: BotInstance): Promise<void> {
    const pos = bot.position;
    if (!pos) return;

    try {
      console.log(`🔨 Force closing position for ${pos.symbol}...`);

      if (pos.stopLossOrderId) {
        try {
          await this.binance.cancelOrder(pos.stopLossOrderId, pos.symbol);
        } catch (error: any) {
          console.log(`Could not cancel SL order: ${error.message}`);
        }
      }

      if (pos.takeProfitOrderId) {
        try {
          await this.binance.cancelOrder(pos.takeProfitOrderId, pos.symbol);
        } catch (error: any) {
          console.log(`Could not cancel TP order: ${error.message}`);
        }
      }

      const side = pos.side === 'LONG' ? 'SELL' : 'BUY';
      const order = await this.binance.createOrder(
        pos.symbol,
        'MARKET',
        side,
        pos.remainingAmount || pos.amount,
        undefined,
        { reduceOnly: true }
      );

      console.log(`✅ Force closed ${pos.symbol} at market price`);
      await this.exitPosition(bot, 'FORCE_CLOSED');
    } catch (error: any) {
      console.error(`❌ Failed to force close ${pos.symbol}:`, error.message);
    }
  }

  /**
   * Paper Trading: Check if SL/TP hit
   */
  private async checkPaperStopLossTakeProfit(
    bot: BotInstance,
    currentPrice: number
  ): Promise<void> {
    const pos = bot.position;
    if (!pos) return;

    const slHit =
      pos.side === 'LONG'
        ? currentPrice <= pos.stopLoss
        : currentPrice >= pos.stopLoss;

    if (slHit) {
      console.log(`\n🛑 PAPER: Stop Loss hit!`);
      console.log(`   SL: $${pos.stopLoss.toFixed(6)}`);
      console.log(`   Current: $${currentPrice.toFixed(6)}`);

      pos.currentPrice = pos.stopLoss;

      await this.exitPosition(bot, 'STOP_LOSS');
      return;
    }

    const tpHit =
      pos.side === 'LONG'
        ? currentPrice >= pos.takeProfit
        : currentPrice <= pos.takeProfit;

    if (tpHit) {
      console.log(`\n🎯 PAPER: Take Profit hit!`);
      console.log(`   TP: $${pos.takeProfit.toFixed(6)}`);
      console.log(`   Current: $${currentPrice.toFixed(6)}`);

      pos.currentPrice = pos.takeProfit;

      await this.exitPosition(bot, 'TAKE_PROFIT');
      return;
    }
  }

  private async checkMorayTargets(bot: BotInstance): Promise<void> {
    const pos = bot.position as MorayPosition;
    if (!pos.partialTargets) return;

    for (const target of pos.partialTargets) {
      if (!target.orderId) continue;
      if (target.filled === 1) continue;

      try {
        const order = await this.binance.fetchOrder(target.orderId, bot.symbol);

        if (order.status === 'closed' || order.status === 'filled') {
          console.log(
            `🎯 ${bot.symbol}: ${target.label} filled at $${order.average || order.price}`
          );

          target.filled = 1;
          pos.partialsSold += 1;
          pos.remainingAmount -= order.filled;

          const fillPrice = order.average || order.price;
          const priceChange =
            pos.side === 'LONG'
              ? fillPrice - pos.entryPrice
              : pos.entryPrice - fillPrice;

          const pLeverage = pos.leverage as number;
          let pPartialPnlRealized = pos.partialPnlRealized as number;

          const partialPnl = priceChange * order.filled * pLeverage;
          pPartialPnlRealized += partialPnl;

          console.log(`   Sold: ${order.filled} at $${fillPrice}`);
          console.log(`   Partial PnL: $${partialPnl.toFixed(2)}`);
          console.log(`   Total realized: $${pPartialPnlRealized.toFixed(2)}`);
          console.log(`   Remaining: ${pos.remainingAmount}`);
        }
      } catch (error: any) {
        if (!error.message.includes('Order does not exist')) {
          console.error(`Error checking ${target.label}: ${error.message}`);
        }
      }
    }

    const allFilled = pos.partialTargets.every((t) => t.filled);
    if (allFilled && pos.remainingAmount === 0) {
      console.log(`✅ ${bot.symbol}: All Moray targets completed!`);
      await this.exitPosition(bot, 'ALL_PARTIALS_HIT');
    }
  }

  private async checkOrderStatus(bot: BotInstance): Promise<void> {
    const pos = bot.position;
    if (!pos) return;

    try {
      if (pos.stopLossOrderId) {
        try {
          const slOrder = await this.binance.fetchOrder(
            pos.stopLossOrderId,
            bot.symbol
          );

          if (slOrder.status === 'closed' || slOrder.status === 'filled') {
            console.log(
              `🛑 ${bot.symbol}: Stop Loss filled at $${slOrder.average || slOrder.price}`
            );
            pos.currentPrice = slOrder.average || slOrder.price;
            await this.exitPosition(bot, 'STOP_LOSS');
            return;
          }
        } catch (error: any) {
          if (!error.message.includes('Order does not exist')) {
            throw error;
          }
        }
      }

      if (pos.takeProfitOrderId) {
        try {
          const tpOrder = await this.binance.fetchOrder(
            pos.takeProfitOrderId,
            bot.symbol
          );

          if (tpOrder.status === 'closed' || tpOrder.status === 'filled') {
            console.log(
              `🎯 ${bot.symbol}: Take Profit filled at $${tpOrder.average || tpOrder.price}`
            );
            pos.currentPrice = tpOrder.average || tpOrder.price;
            await this.exitPosition(bot, 'TAKE_PROFIT');
            return;
          }
        } catch (error: any) {
          if (!error.message.includes('Order does not exist')) {
            throw error;
          }
        }
      }
    } catch (error: any) {
      console.error(
        `Error checking order status for ${bot.symbol}: ${error.message}`
      );
    }
  }

  /**
   * ✅ FIX 6: Add method to fix legacy trade records
   */
  private fixLegacyTradeRecords(): void {
    if (this.tradeHistory.length === 0) return;

    let fixed = 0;
    const defaultLeverage =
      CONFIG.leverageMultiplier || configForLogging.leverageMultiplier || 1;

    this.tradeHistory = this.tradeHistory.map((trade) => {
      let needsFix = false;

      if (
        !trade.leverage ||
        trade.leverage === undefined ||
        isNaN(trade.leverage)
      ) {
        trade.leverage = defaultLeverage;
        needsFix = true;
        console.log(
          `   Fixed leverage for ${trade.symbol}: ${defaultLeverage}x`
        );
      }

      if (trade.rawPnl === undefined || isNaN(trade.rawPnl)) {
        trade.rawPnl = trade.pnlUsd / trade.leverage;
        needsFix = true;
        console.log(
          `   Fixed rawPnl for ${trade.symbol}: $${trade.rawPnl.toFixed(4)}`
        );
      }

      if (needsFix) {
        fixed++;
      }

      return trade;
    });

    if (fixed > 0) {
      console.log(`🔧 Fixed ${fixed} legacy trade record(s)`);
    } else {
      console.log(`✅ All trade records valid`);
    }
  }

  private async checkForNewSignals() {
    if (this.checkTestDuration()) {
      console.log('🏁 Stopping test...');
      this.stop();
      process.exit(0);
    }
    const signals = this.signalReader.readLatestSignals();

    if (signals.length === 0) return;

    if (this.isShuttingDown) {
      console.log('🛑 Shutdown in progress - not accepting new signals');
      return;
    }

    const marginNeeded =
      configForLogging.positionSize / configForLogging.leverageMultiplier;
    if (CONFIG.availableCapital < marginNeeded) {
      log(
        `💰 Insufficient capital: Need $${marginNeeded}, Have $${CONFIG.availableCapital.toFixed(2)}`,
        'warning'
      );
      return;
    }

    const activeBots = Array.from(this.bots.values());
    const activePositions = activeBots.filter((b) => b?.position).length;
    const waitingBots = activeBots.filter(
      (b) => b && !b.position && b.signal
    ).length;
    const totalBots = activePositions + waitingBots;

    const availableSlots = configForLogging.maxConcurrentPositions - totalBots;

    if (availableSlots <= 0) {
      log(
        `⛔ Max positions reached (${totalBots}/${configForLogging.maxConcurrentPositions}) - waiting...`,
        'info'
      );
      return;
    }

    const activeSymbols = new Set(Array.from(this.bots.keys()));
    const bestSignal = this.signalReader.getBestSignal(activeSymbols);

    if (bestSignal) {
      log(
        `🎯 Launching bot for ${bestSignal.symbol} (${bestSignal.strategy}, ${bestSignal.confidence}%)`,
        'info'
      );
      this.createBot(bestSignal);
      this.signalReader.removeSignal(bestSignal.symbol);
    }
  }

  private handleBotCreationFailure(signal: EntrySignal, reason: string) {
    log(`❌ Failed to create bot for ${signal.symbol}: ${reason}`, 'error');

    this.signalReader.releaseSignal(signal.symbol);
  }

  private printTestSummary() {
    const duration = Date.now() - this.tradeCounters.sessionStart.getTime();
    const totalPnL = this.tradeHistory.reduce((sum, t) => sum + t.pnlUsd, 0);
    const wins = this.tradeHistory.filter((t) => t.isWin).length;
    const losses = this.tradeHistory.length - wins;

    console.log('\n' + '═'.repeat(80));
    console.log(colorize('🏁 TEST COMPLETED', colors.brightCyan));
    console.log('═'.repeat(80));

    console.log(colorize('\n⏱️  DURATION', colors.brightYellow));
    console.log(
      `  Started: ${this.tradeCounters.sessionStart.toLocaleString()}`
    );
    console.log(`  Ended: ${new Date().toLocaleString()}`);
    console.log(`  Duration: ${(duration / 60000).toFixed(1)} minutes`);

    console.log(colorize('\n📊 TRADE SUMMARY', colors.brightYellow));
    console.log(`  Total Trades: ${this.tradeHistory.length}`);
    console.log(`  Wins: ${wins} | Losses: ${losses}`);
    console.log(
      `  Win Rate: ${((wins / this.tradeHistory.length) * 100).toFixed(1)}%`
    );

    console.log(colorize('\n💰 FINANCIAL SUMMARY', colors.brightYellow));
    console.log(`  Starting Capital: $${CONFIG.totalCapital.toFixed(2)}`);
    console.log(
      `  Ending Capital: $${(CONFIG.totalCapital + totalPnL).toFixed(2)}`
    );
    console.log(`  Total PnL: ${colorPnL(totalPnL)}`);
    console.log(
      `  Return: ${colorPnL((totalPnL / CONFIG.totalCapital) * 100, true)}`
    );

    if (MORAY_CONFIG.enabled) {
      const morayStats = this.moraySystem.getStats();
      console.log(colorize('\n🐍 MORAY PERFORMANCE', colors.brightYellow));
      console.log(`  Partials Executed: ${morayStats.totalPartials}`);
      console.log(`  Partials PnL: ${colorPnL(morayStats.totalPnl)}`);
      console.log(`  Avg per Partial: ${colorPnL(morayStats.avgPnl)}`);
      console.log(
        `  First Bite Hit Rate: ${morayStats.firstBiteHitRate.toFixed(1)}%`
      );
      console.log(
        `  Second Helping Hit Rate: ${morayStats.secondHitRate.toFixed(1)}%`
      );
      console.log(`  Runner Hit Rate: ${morayStats.runnerHitRate.toFixed(1)}%`);
    }

    console.log(colorize('\n📈 PER-SYMBOL BREAKDOWN', colors.brightYellow));
    const symbolStats = new Map<
      string,
      { wins: number; losses: number; pnl: number }
    >();

    this.tradeHistory.forEach((trade) => {
      if (!symbolStats.has(trade.symbol)) {
        symbolStats.set(trade.symbol, { wins: 0, losses: 0, pnl: 0 });
      }
      const stats = symbolStats.get(trade.symbol)!;
      if (trade.isWin) stats.wins++;
      else stats.losses++;
      stats.pnl += trade.pnlUsd;
    });

    Array.from(symbolStats.entries())
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .forEach(([symbol, stats]) => {
        const total = stats.wins + stats.losses;
        const winRate = (stats.wins / total) * 100;
        console.log(
          `  ${symbol.padEnd(12)} ` +
            `${total} trades | ${stats.wins}W/${stats.losses}L | ` +
            `WR: ${winRate.toFixed(0)}% | ` +
            `PnL: ${colorPnL(stats.pnl)}`
        );
      });

    console.log('\n' + '═'.repeat(80));
    console.log(
      colorize('📝 Test data saved to: ./data/test-results.json', colors.gray)
    );
    console.log('═'.repeat(80) + '\n');
  }

  private async printDashboard() {
    await this.binanceDataFetcher.testConnection();

    try {
      console.clear();
      console.log(colorize('═'.repeat(140), colors.cyan));
      console.log(
        colorize(
          '  🤖 FUTURES TRADING BOT - SIGNAL-DRIVEN EXECUTION  ',
          colors.brightCyan
        )
      );

      if (this.isShuttingDown) {
        console.log(colorize('╠'.repeat(140), colors.red));
        console.log(
          colorize(
            '  🛑 GRACEFUL SHUTDOWN IN PROGRESS  ',
            colors.brightRed + colors.blink
          )
        );
        console.log(
          colorize(`  Reason: ${this.shutdownReason}`, colors.yellow)
        );

        const activePos = Array.from(this.bots.values()).filter(
          (b) => b.position
        ).length;

        console.log(
          colorize(
            `  Waiting for ${activePos} position(s) to close...`,
            colors.brightYellow
          )
        );
        console.log(colorize('╠'.repeat(140), colors.red));
      }
      console.log(colorize('═'.repeat(140), colors.cyan));

      const totalBots = this.bots.size;
      const activePos = Array.from(this.bots.values()).filter(
        (b) => b.position
      ).length;

      const totalUnrealizedPnL = Array.from(this.bots.values())
        .filter((b) => b.position)
        .reduce((sum, b) => sum + (b.position?.pnlUsd || 0), 0);

      const totalRealizedPnL = this.tradeHistory.reduce(
        (sum, t) => sum + t.pnlUsd,
        0
      );

      const totalPnL = totalRealizedPnL + totalUnrealizedPnL;

      const totalCompletedTrades = this.tradeHistory.length;
      const winCount = this.tradeHistory.filter((t) => t.isWin).length;
      const lossCount = this.tradeHistory.filter((t) => !t.isWin).length;
      const winRate =
        totalCompletedTrades > 0 ? (winCount / totalCompletedTrades) * 100 : 0;

      const morayWins = this.tradeHistory.filter(
        (t) => t.isWin && t.exitReason === 'ALL_PARTIALS_HIT'
      );
      const morayWinCount = morayWins.length;
      const regularWinCount = winCount - morayWinCount;

      const morayRealizedPnL = morayWins.reduce((sum, t) => sum + t.pnlUsd, 0);

      const regularExits = this.tradeHistory.filter(
        (t) => t.exitReason === 'STOP_LOSS' || t.exitReason === 'TAKE_PROFIT'
      );
      const regularPnL = regularExits.reduce((sum, t) => sum + t.pnlUsd, 0);

      const totalExposure =
        activePos * CONFIG.marginPerPosition * CONFIG.leverageMultiplier;
      const currentEquity = CONFIG.totalCapital + totalPnL;
      const equityPct = (currentEquity / CONFIG.totalCapital - 1) * 100;

      const totalTra = this.getTotalTradeCount();
      const counters = this.getTradeCounters();
      const capStatus = getCapitalStatus();

      console.log(colorize('📊 TRADE LIMITS', colors.brightYellow));
      console.log(
        `  Total Traded: (${activePos}) ${totalCompletedTrades}/${counters.maxTotal === Infinity ? '∞' : counters.maxTotal} ` +
          `(${counters.remaining === Infinity ? '∞' : this.tradeHistory.length} traded (${activePos} ᯓ🏃🏻‍♀️‍➡️ running trades))`
      );
      console.log(
        `  Today's Trades: ${totalTra}/${counters.maxToday === Infinity ? '∞' : counters.maxToday}`
      );

      if (counters.remaining <= 1 && counters.remaining !== Infinity) {
        console.log(
          colorize('  ⚠️ WARNING: Only 1 trade remaining!', colors.red)
        );
      }

      console.log(colorize('─'.repeat(140), colors.gray));

      console.log(colorize('💰 CAPITAL STATUS', colors.brightYellow));
      console.log(
        `  Starting Capital: $${colorize(CONFIG.totalCapital.toFixed(2), colors.lime)} | ` +
          `Current Equity: $${colorize(currentEquity.toFixed(2), equityPct >= 0 ? colors.green : colors.red)} ` +
          `(${colorPnL(equityPct, true)})`
      );

      console.log(
        `  Available: $${capStatus.available.toFixed(2)} | ` +
          `Allocated: $${capStatus.allocated.toFixed(2)} | ` +
          `Utilization: ${capStatus.utilizationPercent.toFixed(1)}%`
      );
      console.log(
        `Exposure: $${colorize(totalExposure.toFixed(2), colors.orange)}`
      );

      console.log(colorize('─'.repeat(140), colors.gray));

      console.log(
        `  Active Bots: ${totalBots} | ` +
          `Positions: ${activePos}/${CONFIG.maxConcurrentPositions} | ` +
          `Completed: ${totalCompletedTrades} | ` +
          `Win Rate: ${colorize(winRate.toFixed(1) + '%', winRate >= 50 ? colors.green : colors.red)} ` +
          `(${colorize(winCount.toString(), colors.green)}W/${colorize(lossCount.toString(), colors.red)}L)`
      );

      const signalStats = this.signalReader.getStats(this.bots);
      console.log(
        `  Available Signals: ${signalStats.totalSignals} | ` +
          `Long: ${signalStats.longSignals} | ` +
          `Short: ${signalStats.shortSignals} | ` +
          `In Trade: ${colorize(signalStats.inTrade.toString(), colors.orange)} | ` +
          `Completed: ${totalCompletedTrades} | ` +
          `Avg Confidence: ${signalStats.avgConfidence.toFixed(0)}%`
      );

      console.log(colorize('─'.repeat(140), colors.gray));

      const withPos = Array.from(this.bots.values()).filter((b) => b?.position);

      if (withPos.length > 0) {
        console.log(colorize('📈 ACTIVE POSITIONS', colors.brightGreen));
        console.log('');

        withPos.forEach(async (bot) => {
          if (!bot || !bot.position) return;

          const p = bot.position;
          const curPriceDec = getPriceDecimals(p.currentPrice);
          const symbol = bot.symbol;
          const side = p.side;
          const strategy = p.strategy;
          const entryPrice = p.entryPrice;
          const currentPrice = p.currentPrice;
          const pnlPct = p.pnlPct;
          const pnlUsd = p.pnlUsd;
          const stopLoss = p.stopLoss;
          const takeProfit = p.takeProfit;
          const confidence = p.confidence || 0;
          const amount = p.amount;

          const duration = Math.floor(
            (Date.now() - p.entryTime.getTime()) / 60000
          );

          const sideColor =
            side === 'LONG'
              ? colors.bgGreen + colors.brightYellow
              : colors.bgRed + colors.brightCyan;

          const currentColor =
            currentPrice === entryPrice
              ? colors.brightWhite
              : (currentPrice > entryPrice && side === 'LONG') ||
                  (currentPrice < entryPrice && side === 'SHORT')
                ? rgb(1, 50, 32) + colors.bgBrightGreen + colors.bright
                : colors.brightPeach + colors.bgMaroon + colors.bright;

          const pnlPctStr = colorPnL(pnlPct, true);
          const pnlUsdStr = colorPnL(pnlUsd);
          const amountDes = getAmountDecimals(amount, currentPrice);
          console.log(
            '🥑 ~ FuturesTradingBot ~ printDashboard ~ confidence:',
            confidence
          );

          console.log(
            `  ${colorize(symbol.padEnd(10), colors.cyan)} ` +
              `${colorize(side.padEnd(5), sideColor)} ` +
              `${colorize(strategy.padEnd(16), colors.brightOrange)} ` +
              `Entry: ${colorize(entryPrice.toFixed(curPriceDec), colors.bgBlue + colors.brightWhite)} ` +
              `Amount: ${colorize(amount.toFixed(amountDes), rgb(177, 54, 0) + colors.bgBrightYellow)} ` +
              `Current: ${colorize(currentPrice.toFixed(curPriceDec), currentColor)} ` +
              `PnL: ${pnlPctStr} ${pnlUsdStr} ` +
              `Time: ${colorize(duration + 'm', colors.brightGreen)}`
          );

          console.log(
            `  ${colorize('SL:', colors.gray)} ${stopLoss.toFixed(curPriceDec)} | ` +
              `${colorize('TP:', colors.gray)} ${takeProfit.toFixed(curPriceDec)} | ` +
              `${colorize('Size:', colors.gray)} ${CONFIG.positionSize.toFixed(2)} USDT | ` +
              `${colorize('Leverage:', colors.gray)} ${CONFIG.leverageMultiplier}x | ` +
              `${colorize('Margin:', colors.gray)} ${CONFIG.marginPerPosition.toFixed(2)} USDT`
          );
          console.log('');
        });
      } else {
        console.log(
          colorize(
            '  ⏳ No active positions - waiting for signals...',
            colors.yellow
          )
        );
      }

      console.log(colorize('─'.repeat(140), colors.gray));

      const waiting = Array.from(this.bots.values()).filter(
        (b) => b && !b.position && b.signal
      );

      if (waiting.length > 0) {
        console.log(colorize('⏳ WAITING FOR ENTRY', colors.yellow));
        waiting.forEach((bot) => {
          if (!bot || !bot.signal) return;

          const signal = bot.signal;
          const entryPrice = signal.entryPrice as number;
          console.log(
            `  ${bot.symbol.padEnd(12)} ${signal.strategy.padEnd(18)} ` +
              `${signal.side.padEnd(6)} Confidence: ${signal.confidence.toFixed(1)}% ` +
              `Target: $${entryPrice.toFixed(6)}`
          );
        });
        console.log(colorize('─'.repeat(140), colors.gray));
      }

      if (this.tradeHistory.length > 0) {
        console.log(
          colorize('📜 RECENT TRADES (Last 30)', colors.brightYellow)
        );

        const uniqueTradesMap = new Map();
        this.tradeHistory.slice(0, 30).forEach((trade) => {
          if (!trade) return;

          const tradeKey = `${trade.symbol}_${trade.strategy}_${trade.side}_${trade.entryPrice.toFixed(6)}_${trade.exitPrice.toFixed(6)}_${trade.duration}`;

          if (!uniqueTradesMap.has(tradeKey)) {
            uniqueTradesMap.set(tradeKey, trade);
          }
        });

        Array.from(uniqueTradesMap.values()).forEach((trade) => {
          const curPriceDec = getPriceDecimals(trade.entryPrice);
          const icon = trade.isWin ? '✅ WIN ' : '❌ LOSS';

          const priceChange =
            trade.side === 'LONG'
              ? trade.exitPrice - trade.entryPrice
              : trade.entryPrice - trade.exitPrice;

          const rawPnl = priceChange * trade.quantity;
          const pnlUsd = rawPnl * trade.leverage;
          const pnlPct = (pnlUsd / trade.marginUsed) * 100;

          const pnlPctStr = colorPnL(pnlPct, true);
          const pnlUsdStr = colorPnL(pnlUsd);
          const exitColor = trade.isWin ? colors.green : colors.red;

          const currentColor =
            trade.exitPrice === trade.entryPrice
              ? colors.brightWhite
              : (trade.exitPrice > trade.entryPrice && trade.side === 'LONG') ||
                  (trade.exitPrice < trade.entryPrice && trade.side === 'SHORT')
                ? rgb(0, 17, 6) + colors.bgBrightGreen + colors.bright
                : colors.brightPeach + colors.bgMaroon + colors.bright;

          const tp1Str = trade.tp1
            ? `TP1: ${colorize(trade.tp1.toFixed(curPriceDec), colors.cyan)} `
            : '';

          const tp2Str = trade.tp2
            ? `TP2: ${colorize(trade.tp2.toFixed(curPriceDec), colors.cyan)} `
            : '';

          const tpStr = trade.takeProfit
            ? `TP: ${colorize(trade.takeProfit.toFixed(curPriceDec), currentColor)} `
            : tp1Str + tp2Str;

          console.log(
            `  ${icon.padEnd(10)} ` +
              `${trade.symbol.padEnd(12)} ` +
              `${trade.strategy.padEnd(18)} ` +
              `${trade.side.padEnd(6)} ` +
              `${pnlPctStr} ${pnlUsdStr} ` +
              `SL: ${colorize(trade.stopLoss.toFixed(curPriceDec), currentColor)} ` +
              `${tpStr}` +
              `Entry: ${colorize(trade.entryPrice.toFixed(curPriceDec), currentColor)} ` +
              `Exit: ${colorize(trade.exitPrice.toFixed(curPriceDec), exitColor)} ` +
              `Raw: ${colorPnL(rawPnl)} × ${trade.leverage}x = ${pnlUsd.toFixed(2)} ` +
              `${Math.floor(trade.duration / 60000)}m ` +
              `${colorize(trade.exitReason, exitColor)}`
          );
        });

        console.log(colorize('─'.repeat(140), colors.gray));
      }

      if (MORAY_CONFIG.enabled) {
        const recentPartials = this.moraySystem.getRecentPartials(10);

        if (recentPartials.length > 0) {
          console.log(
            colorize('🐍 RECENT PARTIALS (Last 10)', colors.brightYellow)
          );

          recentPartials.forEach((partial) => {
            const pnlStr = colorPnL(partial.pnlUsd);
            console.log(
              `  ${partial.targetLabel.padEnd(18)} ` +
                `${partial.symbol.padEnd(12)} ` +
                `${pnlStr} ` +
                `@ $${partial.exitPrice.toFixed(6)} ` +
                `(${partial.ratio}R)`
            );
          });
          console.log(colorize('─'.repeat(140), colors.gray));
        }
      }

      console.log(colorize('📊 SESSION SUMMARY', colors.brightYellow));
      console.log(
        `  Completed Trades: ${totalCompletedTrades} | ` +
          `Wins: ${colorize(winCount.toString(), colors.green)} ` +
          `(${morayWinCount} Moray, ${regularWinCount} Regular) | ` +
          `Losses: ${colorize(lossCount.toString(), colors.red)} | ` +
          `Win Rate: ${colorize(winRate.toFixed(1) + '%', winRate >= 50 ? colors.green : colors.red)}`
      );

      if (MORAY_CONFIG.enabled) {
        const morayStats = this.moraySystem.getStats();

        console.log(colorize('\n🐍 MORAY PARTIAL SYSTEM', colors.brightYellow));
        console.log(
          `  Partial Executions: ${morayStats.totalPartials} ` +
            `(across ${morayWinCount} winning trades)`
        );
        console.log(
          `  Partials Total PnL: ${colorPnL(morayStats.totalPnl)} | ` +
            `Avg per Partial: ${colorPnL(morayStats.avgPnl)}`
        );
        console.log(
          `  Moray Trades PnL: ${colorPnL(morayRealizedPnL)} ` +
            `${Math.abs(morayStats.totalPnl - morayRealizedPnL) < 0.1 ? '✅' : '⚠️'}`
        );

        if (Math.abs(morayStats.totalPnl - morayRealizedPnL) > 0.1) {
          console.log(
            colorize(
              `  ⚠️ Mismatch: Partials (${morayStats.totalPnl.toFixed(2)}) vs Trades (${morayRealizedPnL.toFixed(2)})`,
              colors.yellow
            )
          );
        }

        console.log(
          `  Hit Rates - ` +
            `First: ${morayStats.firstBiteHitRate.toFixed(1)}% | ` +
            `Second: ${morayStats.secondHitRate.toFixed(1)}% | ` +
            `Runner: ${morayStats.runnerHitRate.toFixed(1)}%`
        );
      }

      console.log(colorize('\n💰 PNL BREAKDOWN', colors.brightYellow));
      console.log(
        `  Unrealized (${activePos} positions): ${colorPnL(totalUnrealizedPnL)}`
      );
      console.log(
        `  Realized (${totalCompletedTrades} trades): ${colorPnL(totalRealizedPnL)}`
      );
      console.log(
        `    ├─ Moray Exits (${morayWinCount}): ${colorPnL(morayRealizedPnL)}`
      );
      console.log(
        `    └─ Regular Exits (${regularExits.length}): ${colorPnL(regularPnL)}`
      );
      console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(
        `  Total Session PnL: ${colorPnL(totalPnL)} ` +
          `(${colorPnL(equityPct, true)} from start)`
      );

      console.log(colorize('─'.repeat(140), colors.gray));
      console.log(
        colorize('Commands: (r)efresh signals | (q)uit', colors.gray)
      );
      console.log(colorize('═'.repeat(140), colors.cyan));

      this.displayCooldownStatus();
    } catch (err: any) {
      console.error(colorize(`❌ Dashboard error: ${err.message}`, colors.red));
      console.error(err.stack);
    }
  }

  private setupKeyboardControls() {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      const char = key.toString();

      if (char === 's') {
        console.log('\n🛑 MANUAL GRACEFUL SHUTDOWN REQUESTED');
        this.initiateGracefulShutdown('Manual shutdown by user');
      }

      if (char === 'c') {
        console.log('\n🛑 MANUAL CLOSE ALL POSITIONS');
        this.closeAllPositions();
      }

      if (char === 'q') {
        this.stop();
        process.exit(0);
      }
    });
  }

  private closeAllPositions() {
    const activeBots = Array.from(this.bots.values()).filter((b) => b.position);

    console.log(`Closing ${activeBots.length} position(s)...`);

    activeBots.forEach((bot) => {
      if (bot.position) {
        this.exitPosition(bot, 'MANUAL_CLOSE');
      }
    });
  }

  async start() {
    if (!CONFIG.paperTrading) {
      console.log('📊 Loading Binance markets...');
      await this.binance.loadMarkets();
      console.log('✅ Markets loaded');
    }

    this.signalCheckInterval = setInterval(
      () => this.checkForNewSignals(),
      configForLogging.signalCheckInterval
    );

    this.dashboardInterval = setInterval(
      () => this.printDashboard(),
      configForLogging.dashboardRefreshMs
    );

    this.persistence.startAutoSave(
      this as unknown as BaseTradingBot<FuturesBotInstance>,
      configForLogging
    );

    try {
      await this.updatePricesFromScanner();
    } catch (error) {
      console.error('❌ Initial price update failed:', error);
    }

    this.priceUpdateInterval = setInterval(async () => {
      try {
        await this.updatePricesFromScanner();
      } catch (error) {
        console.error('❌ Price update interval failed:', error);
      }
    }, 3000);

    this.checkForNewSignals();
    setTimeout(() => this.printDashboard(), 1000);
  }

  stop() {
    if (this.signalCheckInterval) clearInterval(this.signalCheckInterval);
    if (this.dashboardInterval) clearInterval(this.dashboardInterval);
    if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval);

    this.signalReader.stopAutoSave();

    log('💾 Saving bot state...', 'info');
    this.persistence.saveState(
      this as unknown as BaseTradingBot<FuturesBotInstance>,
      configForLogging
    );
    this.persistence.stopAutoSave();

    log('Bot stopped', 'warning');
  }
}

function setupInterface(bot: FuturesTradingBot) {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      bot.stop();
      setTimeout(() => {
        log('Goodbye! 👋', 'success');
        process.exit(0);
      }, 500);
    } else if (key.name === 'r') {
      log('Manually checking for signals...', 'info');
    }
  });
}
async function main() {
  console.log(colorize('═'.repeat(80), colors.cyan));
  console.log(
    colorize(
      '🚀 Futures Trading Bot - Scanner Integration v2.0',
      colors.brightCyan
    )
  );
  console.log(
    colorize('   Using LightweightSignalReader (No WebSocket)', colors.gray)
  );
  console.log(colorize('═'.repeat(80), colors.cyan));
  const bot = new FuturesTradingBot(
    configForLogging.totalCapital,
    MorayPartialSystem as unknown as MorayPartialSystem
  );
  try {
    await bot.initialize();
    bot.start();

    setupInterface(bot);
  } catch (err: any) {
    log(`Fatal error: ${err.message}`, 'error');
    process.exit(1);
  }
}

process.on('uncaughtException', (err: any) => {
  log(`Exception: ${err.message}`, 'error');
});

main();
