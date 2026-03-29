import fs from 'fs';
import path from 'path';
import readline from 'readline';

import * as dotenv from 'dotenv';
import { ATR, EMA, RSI } from 'technicalindicators';

import {
  colors,
  generateId,
  getAmountDecimals,
  getPriceDecimals,
  normalize,
  rgb,
} from '../../lib/helpers.js';
import type {
  BotInstance,
  BotState,
  CompletedTrade,
  EntrySignal,
  EntryType,
  Position,
  ReasonType,
  ScanResult,
  SignalQueueItem,
  SignalState,
  StrategyId,
} from '../../lib/type.js';
import { PriceFetcher } from '../../src/core/price-fetcher.js';
import { fetchCurrentPrice } from '../../src/spot/bot-spot.js';
import {
  getFuturesConfigForSymbol,
  releaseCapital,
  reserveCapital,
} from '../futures/future-config.js';

dotenv.config();

// ============================================================================
// TYPES
// ============================================================================

// type BotStatus = 'running' | 'waiting' | 'stopped' | 'idle' | 'cooldown';
// type TradeSide = 'LONG' | 'SHORT' | 'SPOT';
// type StrategyId = 'BREAKOUT' | 'EMA_PULLBACK' | 'FIB_RETRACEMENT' | 'RSI_DIVERGENCE' | 'BREAKDOWN';

// interface SignalQueueItem {
//   symbol: string;
//   confidence: number;
//   side: TradeSide;
//   strategy: StrategyId;
//   reason: string;
//   price: number;
//   stopLoss: number;
//   takeProfit: number;
//   scannedAt: Date;
// }

// interface Position {
//   side: TradeSide;
//   entryPrice: number;
//   currentPrice: number;
//   amount: number;
//   stopLoss: number;
//   takeProfit: number;
//   pnlUsd: number;
//   pnlPct: number;
//   entryTime: Date;
//   symbol: string;
//   strategy: StrategyId;
//   confidence: number;
// }

// interface BotInstance {
//   symbol: string;
//   status: BotStatus;
//   startTime: Date;
//   sessionPnl: number;
//   trades: number;
//   wins: number;
//   losses: number;
//   position: Position | null;
//   lastUpdate: Date;
//   signal: SignalQueueItem | null;
//   priceHistory: number[];
//   // ✅ NEW: Entry confirmation tracking
//   confirmationTicks: number;
//   lastPriceDirection: number; // 1 for up, -1 for down, 0 for neutral
// }

// interface CompletedTrade {
//   symbol: string;
//   strategy: StrategyId;
//   entryPrice: number;
//   exitPrice: number;
//   amount: number;
//   pnlUsd: number;
//   pnlPct: number;
//   duration: number;
//   exitReason: string;
//   entryTime: Date;
//   exitTime: Date;
//   isWin: boolean;
// }

// ============================================================================
// CONFIGURATION
// ============================================================================

const FUTURE_CONFIG = getFuturesConfigForSymbol(
  process.env.TRADING_SYMBOL_FUTURES! || 'SOL/USDT'
);

const CONFIG = {
  signalFile: './data/signals/futures-legacy-signals.json',
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '3'),
  minConfidence: 70, // ✅ INCREASED: Only take high-confidence signals
  // positionSize: 100, // USDT per position
  leverageMultiplier: 3, // 1x leverage for safety
  capitalUtilization: 0.9,
  totalCapital: parseFloat(process.env.TOTAL_CAPITAL || '226'),

  // ✅ CALCULATE POSITION SIZE DYNAMICALLY
  get availableCapital(): number {
    // This will be updated in real-time
    return this.totalCapital * this.capitalUtilization;
  },

  get positionSize(): number {
    return this.availableCapital / this.maxConcurrentPositions;
  },

  get maxPositionSize() {
    // Divide available capital by max positions
    return this.availableCapital / this.maxConcurrentPositions;
  },

  updateCapital(pnlUsd: number) {
    this.totalCapital += pnlUsd;
  },

  // Signal checking
  signalCheckInterval: 30000, // Check every 30s
  signalExpiryMs: 10 * 60 * 1000, // Signals expire after 10 minutes

  // ✅ IMPROVED: Risk management
  maxSlippagePercent: 0.3, // Tighter slippage tolerance
  trailingStopEnabled: true,
  trailingStopPercent: 5.0, // Wider trailing stop

  // ✅ FIXED: Stop loss widening (was causing issues)
  stopLossMultiplier: 1.0, // Make SL 80% wider (was 1.5)
  takeProfitMultiplier: 3.0, // Keep TP multiplier

  // ✅ NEW: Strategy filters
  blockedStrategies: [''], // Temporarily block failing strategies
  preferredStrategies: [
    'EMA_PULLBACK',
    'BREAKOUT',
    'FIB_RETRACEMENT',
    'RSI_DIVERGENCE',
  ],

  // ✅ NEW: Entry confirmation
  requirePriceConfirmation: true, // Wait for price to move in our direction
  confirmationTicks: 3, // Wait for 3 positive price updates

  // Dashboard
  dashboardRefreshMs: 3000,

  // ✅ FIXED: Price simulation (much smaller movements)
  priceUpdateInterval: 2000, // Update prices every 2s
  priceVolatility: 0.0002, // 0.02% random movement (was 0.001 = 0.1%)

  smcEnabled: true, // ✅ Make sure this is true
  smcMinScore: 40, // ✅ Lowered threshold

  liquidity: {
    enabled: true,
    minSpreadBps: 10, // 0.10% minimum spread
    maxSpreadBps: 50, // 0.50% maximum spread
    minDepthMultiplier: 10, // 10x position size in depth
    maxSlippagePct: 0.3, // 0.3% max slippage
    min24hVolumeUSD: 5_000_000, // $1M daily volume minimum
  },
};

const configForLogging = {
  ...CONFIG,
  availableCapital: CONFIG.availableCapital, // Explicitly call getter
  positionSize: CONFIG.positionSize, // Explicitly call getter
};

// ============================================================================
// LIGHTWEIGHT SIGNAL READER
// ============================================================================

class LightweightSignalReader {
  private signalQueue: EntrySignal[] = [];
  private outputFile = './data/signals/futures-legacy-signals.json';
  private lastReadTime = 0;
  private readonly SIGNAL_EXPIRY_MS = configForLogging.signalExpiryMs;

  constructor() {
    this.checkFileExists();
  }

  private checkFileExists(): void {
    if (!fs.existsSync(this.outputFile)) {
      console.log(`⚠️  Scanner output not found: ${this.outputFile}`);
      console.log('   Waiting for scanner to create file...');

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
        return this.signalQueue;
      }

      const stats = fs.statSync(this.outputFile);
      const fileTime = stats.mtimeMs;

      if (fileTime <= this.lastReadTime) {
        return this.signalQueue;
      }

      const fileContent = fs.readFileSync(this.outputFile, 'utf-8');

      if (!fileContent.trim()) {
        this.signalQueue = [];
        return this.signalQueue;
      }

      const data = JSON.parse(fileContent);

      if (!Array.isArray(data) || data.length === 0) {
        this.signalQueue = [];
        return [];
      }

      if (!Array.isArray(data) || data.length === 0) {
        this.signalQueue = [];
        return this.signalQueue;
      }

      this.signalQueue = data
        .filter((result: ScanResult) => {
          if (!result || !result.signal) return false;
          if (!result.symbol) return false;
          // ✅ Filter by confidence
          if (result.confidence < CONFIG.minConfidence) return false;

          // ✅ Filter by strategy
          const strategy = result.signal.strategy as StrategyId;
          if (configForLogging.blockedStrategies.includes(strategy)) {
            log(
              `⛔ Blocked strategy: ${strategy} for ${result.symbol}`,
              'warning'
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
              const reward = risk * 3; // 3:1 risk-reward

              return result.signal.side === 'LONG'
                ? entry + reward
                : entry - reward;
            })(),
            timestamp: new Date(result.timestamp || Date.now()),
          };

          // console.log(`✅ ${signal.symbol} ${signal.side} ${signal.strategy} @ $${signal.entryPrice?.toFixed(6)} (${signal.confidence.toFixed(1)}%)`);

          return signal;
        })
        .sort((a, b) => b.confidence - a.confidence);

      this.lastReadTime = fileTime;
      this.cleanupExpiredSignals();

      if (this.signalQueue.length > 0) {
        log(
          `📊 Read ${this.signalQueue.length} signals from scanner`,
          'success'
        );
      }

      return this.signalQueue;
    } catch (err: any) {
      log(`⚠️  Error reading scanner output: ${err.message}`, 'warning');
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
      (s) => !excludeSymbols.has(s.symbol)
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
    this.signalQueue = this.signalQueue.filter((s) => s.symbol !== symbol);
  }

  getStats() {
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
  private stateFile = './data/signals/legacy-signal-state.json';
  private autoSaveInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.loadState();
    this.startAutoSave();
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
                : (undefined as any), // Type assertion
              botId: state.botId,
              entryPrice: state.entryPrice,
              exitedAt: state.exitedAt
                ? new Date(state.exitedAt)
                : (undefined as any), // Type assertion
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
  private saveState(): void {
    try {
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

      const data = {
        lastUpdate: new Date().toISOString(),
        totalStates: this.signalStates.size,
        states,
      };

      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
      // console.log(`💾 Saved state for ${this.signalStates.size} signals`);
    } catch (err: any) {
      console.error(`Failed to save signal state: ${err.message}`);
    }
  }

  /**
   * Start auto-save every 30 seconds
   */
  private startAutoSave(): void {
    this.autoSaveInterval = setInterval(() => {
      this.saveState();
    }, 30000);
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
    // Get signals from parent class
    const allSignals = super.readLatestSignals();

    // Filter out signals that are already in trade
    const availableSignals = allSignals.filter((signal) => {
      const state = this.signalStates.get(signal.symbol);

      // Skip if signal is in trade
      if (state && state.status === 'IN_TRADE') {
        console.log(`⏳ ${signal.symbol} already in trade - skipping`);
        return false;
      }

      // Skip if recently completed (within 2 minutes)
      if (state && state.status === 'COMPLETED' && state.exitedAt) {
        const timeSinceExit = Date.now() - state.exitedAt.getTime();
        if (timeSinceExit < 120000) {
          // 2 minutes
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
  getBestSignal(excludeSymbols: Set<string>): SignalQueueItem | null {
    const available = this.readLatestSignals().filter(
      (s) => s && !excludeSymbols.has(s.symbol)
    );

    if (available.length > 0) {
      const best = available[0] as EntrySignal;
      console.log(
        `🎯 Best signal: ${best?.symbol} ${best?.side} (${best?.confidence.toFixed(1)}%)`
      );
      return best as SignalQueueItem;
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
  markSignalAsCompleted(symbol: string, pnl?: number): void {
    const state = this.signalStates.get(symbol);

    if (state) {
      state.status = 'COMPLETED';
      state.exitedAt = new Date();
      state.pnl = pnl as number;

      this.saveState();
      console.log(
        `✅ Marked ${symbol} as COMPLETED ${pnl !== undefined ? `(PnL: $${pnl.toFixed(2)})` : ''}`
      );

      // Auto-remove after 5 minutes
      setTimeout(() => {
        this.signalStates.delete(symbol);
        this.saveState();
        console.log(`🗑️  Removed ${symbol} state (cooldown complete)`);
      }, 300000); // 5 minutes
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
          // 1 hour
          this.signalStates.delete(symbol);
          removed++;
        }
      } else if (state.status === 'IN_TRADE' && state.takenAt) {
        const age = now - state.takenAt.getTime();
        if (age > 86400000) {
          // 24 hours - stale trade
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
  getStats() {
    const baseStats = super.getStats();

    const inTradeCount = Array.from(this.signalStates.values()).filter(
      (s) => s.status === 'IN_TRADE'
    ).length;

    const completedCount = Array.from(this.signalStates.values()).filter(
      (s) => s.status === 'COMPLETED'
    ).length;

    return {
      ...baseStats,
      inTrade: inTradeCount,
      completed: completedCount,
      totalTracked: this.signalStates.size,
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

// ============================================================================
// COLORS & UTILITIES
// ============================================================================

// const colors = {
//   reset: '\x1b[0m',
//   red: '\x1b[31m',
//   green: '\x1b[32m',
//   yellow: '\x1b[33m',
//   cyan: '\x1b[36m',
//   gray: '\x1b[90m',
//   brightGreen: '\x1b[1m\x1b[32m',
//   brightRed: '\x1b[1m\x1b[31m',
//   brightYellow: '\x1b[1m\x1b[33m',
//   brightCyan: '\x1b[1m\x1b[36m',
//   magenta: '\x1b[35m',
// };

function colorize(text: string, color: string): string {
  return `${color}${text}${colors.reset}`;
}

function colorPnL(value: number, isPercent: boolean = false): string {
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

// ============================================================================
// PRICE SIMULATOR (replaces WebSocket)
// ============================================================================

// class PriceSimulator {
//   private prices = new Map<string, number>();
//   private callbacks = new Map<string, ((price: number) => void)[]>();
//   private priceHistory = new Map<string, number[]>();

//   setInitialPrice(symbol: string, price: number) {
//     this.prices.set(symbol, price);
//     this.priceHistory.set(symbol, [price]);
//   }

//   subscribe(symbol: string, callback: (price: number) => void) {
//     if (!this.callbacks.has(symbol)) {
//       this.callbacks.set(symbol, []);
//     }
//     this.callbacks.get(symbol)!.push(callback);
//   }

//   start() {
//     setInterval(() => {
//       this.prices.forEach((price, symbol) => {
//         // ✅ FIXED: Much smaller, more realistic price movements
//         // Use 0.02% movement (0.0002) instead of 0.1%
//         const volatility = 0.0002; // 0.02% per tick

//         // Random walk with slight upward bias for LONG positions
//         const randomChange = (Math.random() - 0.48) * 2 * volatility; // Slight bullish bias
//         const newPrice = price * (1 + randomChange);

//         // ✅ Add noise but keep it realistic
//         const history = this.priceHistory.get(symbol) || [price];
//         history.push(newPrice);

//         // Keep last 100 prices
//         if (history.length > 100) {
//           history.shift();
//         }
//         this.priceHistory.set(symbol, history);

//         this.prices.set(symbol, newPrice);

//         const handlers = this.callbacks.get(symbol);
//         if (handlers) {
//           handlers.forEach(handler => handler(newPrice));
//         }
//       });
//     }, CONFIG.priceUpdateInterval);
//   }

//   // ✅ NEW: Method to get price history
//   getPriceHistory(symbol: string): number[] {
//     return this.priceHistory.get(symbol) || [];
//   }
// }

// ============================================================================
// PERSISTENCE CLASS
// ============================================================================

class BotPersistence {
  private stateFile: string;
  private backupFile: string;
  private autoSaveInterval: NodeJS.Timeout | null = null;

  constructor(stateFile: string = './data/bot-state-legacy.json') {
    this.stateFile = stateFile;
    this.backupFile = `${stateFile}.backup`;
    this.ensureDirectory();
  }

  private ensureDirectory() {
    const dir = path.dirname(this.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true }); // Make sure recursive is true
      console.log(`✅ Created state directory: ${dir}`);
    }
  }

  /**
   * Save bot state to disk
   */
  saveState(bot: FuturesTradingBot): void {
    try {
      const bots = bot.getBots();

      const state: BotState = {
        version: '1.0.0',
        lastSave: new Date().toISOString(),
        totalCapital: configForLogging.totalCapital,
        availableCapital: configForLogging.availableCapital,
        bots: this.serializeBots(bot.getBots()),
        tradeHistory: bot.getTradeHistory().slice(0, 100), // Keep last 50
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
  loadState(): BotState | null {
    try {
      if (!fs.existsSync(this.stateFile)) {
        console.log('ℹ️  No previous state found');
        return null;
      }

      const content = fs.readFileSync(this.stateFile, 'utf-8');
      console.log('🥑 ~ BotPersistence ~ loadState ~ content:', content);
      const state: BotState = JSON.parse(content);

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
  restoreState(bot: FuturesTradingBot, state: BotState): void {
    try {
      // ✅ Direct assignment for plain object
      configForLogging.totalCapital = state.totalCapital;

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

      // ✅ CRITICAL FIX: Validate and correct trade history on load
      if (state.tradeHistory && Array.isArray(state.tradeHistory)) {
        let correctionsMade = 0;

        const correctedTrades = state.tradeHistory.map((trade) => {
          const deserializedTrade = this.deserializeTrade(trade);

          // ✅ Validate: If isWin doesn't match exitReason, fix it!
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

          // ✅ Double-check: Validate isWin matches pnlUsd sign
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

          console.log(
            '🥑 ~ BotPersistence ~ restoreState ~ state.tradeHistory:',
            JSON.stringify(deserializedTrade, null, 2)
          );
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

          // ✅ Save the corrected data back to disk immediately
          console.log(`💾 Saving corrected trade history...`);
          setTimeout(() => {
            this.saveState(bot);
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
        `✅ Bot state restored successfully. Capital: $${configForLogging.totalCapital}`
      );
    } catch (err: any) {
      console.error(`❌ Failed to restore state: ${err.message}`);
    }
  }

  /**
   * Serialize bots for storage
   */
  private serializeBots(bots: Map<string, BotInstance>): BotInstance[] {
    const serialized: BotInstance[] = [];

    bots.forEach((bot) => {
      serialized.push({
        symbol: bot.symbol,
        status: bot.status,
        startTime: bot.startTime,
        pnl: bot.pnl || 0,
        sessionPnl: bot.sessionPnl || 0,
        wins: bot.wins || 0,
        losses: bot.losses || 0,
        trades: bot.trades || 0,
        position: bot.position ? this.serializePosition(bot.position) : null,
        lastHeartbeat: bot.lastHeartbeat,
        confirmationTicks: bot.confirmationTicks || 0,
        lastPriceDirection: bot.lastPriceDirection || 0,
        signal: bot.signal,
      } as BotInstance);
    });

    return serialized;
  }

  /**
   * Serialize position for storage
   */
  private serializePosition(pos: Position): Position {
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
      confidence: pos.confidence,
    } as Position;
  }

  private deserializeTrade(trade: CompletedTrade): CompletedTrade {
    return {
      symbol: trade.symbol,
      strategy: trade.strategy,
      side: trade.side,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      amount: trade.amount,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      pnlUsd: trade.pnlUsd,
      pnlPct: trade.pnlPct,
      duration: trade.duration,
      exitReason: trade.exitReason,
      marginUsed: trade.marginUsed ?? 0,
      entryTime: new Date(trade.entryTime),
      exitTime: new Date(trade.exitTime),
      isWin: trade.isWin,
    };
  }

  /**
   * Deserialize bot from storage
   */
  private deserializeBot(state: BotInstance): BotInstance {
    return {
      symbol: state.symbol,
      status: state.status,
      startTime: state.startTime,
      pnl: state.pnl,
      sessionPnl: state.sessionPnl,
      trades: state.trades,
      wins: state.wins,
      losses: state.losses,
      position: state.position
        ? this.deserializePosition(state.position)
        : null,
      lastHeartbeat: new Date(),
      priceHistory: [],
      lastUpdate: new Date(),
      confirmationTicks: state.confirmationTicks,
      lastPriceDirection: state.lastPriceDirection,
      signal: state.signal,
    } as BotInstance;
  }

  /**
   * Deserialize position from storage
   */
  private deserializePosition(state: Position): Position {
    return {
      symbol: state.symbol,
      entryPrice: state.entryPrice,
      amount: state.amount,
      remainingAmount: state.remainingAmount,
      takeProfit: state.takeProfit,
      entryTime: new Date(state.entryTime),
      strategy: state.strategy,
      partialsSold: state.partialsSold,
      currentPrice: state.currentPrice,
      stopLoss: state.stopLoss,
      pnlUsd: state.pnlUsd,
      pnlPct: state.pnlPct,
      positionId: state.positionId,
      leverage: state.leverage,
      notionalValue: state.notionalValue,
      marginUsed: state.marginUsed,
      side: state.side,
      confidence: state.confidence,
    } as Position;
  }

  /**
   * Start auto-save (every 30 seconds)
   */
  startAutoSave(bot: FuturesTradingBot, intervalMs: number = 30000) {
    this.autoSaveInterval = setInterval(() => {
      this.saveState(bot);
    }, intervalMs);

    console.log(`✅ Auto-save enabled (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop auto-save
   */
  stopAutoSave() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }
}

// ============================================================================
// BOT MANAGER
// ============================================================================

class FuturesTradingBot {
  private totalCapital = 200;
  private allocatedCapital = 0;
  private signalReader: EnhancedSignalReader;
  // private priceSimulator: PriceSimulator;
  private bots: Map<string, BotInstance> = new Map();
  private tradeHistory: CompletedTrade[] = [];
  private signalCheckInterval: NodeJS.Timeout | null = null;
  private dashboardInterval: NodeJS.Timeout | null = null;
  private priceUpdateInterval: NodeJS.Timeout | null = null;
  private persistence: BotPersistence;
  private priceFetcher: PriceFetcher;
  private maxHistorySize = 50;

  constructor() {
    this.signalReader = new EnhancedSignalReader();
    this.persistence = new BotPersistence('./data/bot-state-legacy.json');
    this.priceFetcher = new PriceFetcher();
    // this.priceSimulator = new PriceSimulator();
  }

  /**
   * ✅ ENHANCED: Update prices with fallback to exchange API
   */
  private async updatePricesFromScanner() {
    try {
      // Step 1: Try to get prices from scanner
      const priceMap = await this.getPricesFromScanner();

      // Step 2: For any missing symbols, fetch from exchange
      const bots = Array.from(this.bots.values());
      const missingSymbols: string[] = [];

      for (const bot of bots) {
        if (!priceMap.has(bot.symbol)) {
          missingSymbols.push(bot.symbol);
        }
      }

      if (missingSymbols.length > 0) {
        console.log(
          `🔍 Fetching ${missingSymbols.length} missing prices from exchange...`
        );
        const exchangePrices =
          await this.priceFetcher.getMultiplePrices(missingSymbols);

        // Merge exchange prices into map
        exchangePrices.forEach((price, symbol) => {
          priceMap.set(symbol, price);
        });
      }

      // console.log(`🔄 Price update: ${priceMap.size} prices available`);

      // Step 3: Update all bots
      let updatedCount = 0;

      for (const bot of bots) {
        const currentPrice = priceMap.get(bot.symbol);

        if (currentPrice) {
          this.updateBotWithPrice(bot, currentPrice);
          updatedCount++;
        } else {
          console.log(`❌ No price available for ${bot.symbol}`);
        }
      }

      if (updatedCount > 0) {
        console.log(
          `✅ Updated ${updatedCount}/${bots.length} bot(s) with current prices`
        );
      }
    } catch (err: any) {
      console.error(`❌ Price update error: ${err.message}`);
    }
  }

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

  // ✅ NEW: Public getters for persistence
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

  async initialize(): Promise<void> {
    log('🚀 Initializing Futures Trading Bot...', 'info');

    const previousState = this.persistence.loadState();

    if (previousState && previousState.bots.length > 0) {
      log(
        `♻️  Found previous state with ${previousState.bots.length} active bots`,
        'info'
      );
      log('   Restoring positions...', 'info');

      this.persistence.restoreState(this, previousState);

      const activePositions = Array.from(this.bots.values()).filter(
        (b) => b.position
      ).length;
      log(`✅ Restored ${activePositions} active position(s)`, 'success');

      // ✅ CRITICAL: Force immediate price update for restored positions
      log('🔄 Fetching current prices for restored positions...', 'info');
      await this.updatePricesFromScanner();

      log('✅ Restored positions updated with current prices', 'success');
    } else {
      log('ℹ️  Starting fresh - no previous state found', 'info');
    }

    log(`Signal File: ${configForLogging.signalFile}`, 'info');
    log(`Total Capital: $${configForLogging.totalCapital} USDT`, 'info');
    log(
      `Available Capital: $${configForLogging.availableCapital.toFixed(2)} USDT`,
      'info'
    );
    log(`Max Positions: ${configForLogging.maxConcurrentPositions}`, 'info');
    log(`Min Confidence: ${configForLogging.minConfidence}%`, 'info');
    log(`Position Size: ${configForLogging.positionSize} USDT`, 'info');
    log(
      `Position Size: $${configForLogging.positionSize.toFixed(2)} USDT per position`,
      'info'
    );
    log(`Leverage: ${configForLogging.leverageMultiplier}x`, 'info');
    log('═'.repeat(80), 'info');

    // this.priceSimulator.start();

    log('✅ Bot initialized and ready', 'success');
  }

  private updateBotWithPrice(bot: BotInstance, currentPrice: number) {
    // Initialize price history if empty (happens after restore)
    if (!bot.priceHistory || bot.priceHistory.length === 0) {
      bot.priceHistory = [currentPrice];
    }

    // Update price history
    bot.priceHistory.push(currentPrice);
    if (bot.priceHistory.length > 100) {
      bot.priceHistory.shift();
    }

    // Update position or check entry
    if (bot.position) {
      // ✅ Update existing position
      this.updatePosition(bot, currentPrice);
    } else if (bot.signal && bot.priceHistory.length >= 3) {
      // ✅ Check entry for waiting bots
      this.checkEntryCondition(bot, currentPrice);
    }

    bot.lastUpdate = new Date();
  }

  private createBot(signal: EntrySignal): BotInstance {
    if (!signal || !signal.entryPrice) {
      throw new Error('Invalid signal: missing entryPrice');
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
      signal: signal,
      // ✅ NEW: Entry confirmation
      confirmationTicks: 0,
      lastPriceDirection: 0,
    };

    this.bots.set(signal.symbol, bot);

    this.signalReader.markSignalAsTaken(
      signal.symbol,
      generateId(),
      signal.entryPrice
    );

    // Set initial price
    // this.priceSimulator.setInitialPrice(signal.symbol, signal.price);

    // Subscribe to price updates
    // this.priceSimulator.subscribe(signal.symbol, (price: number) => {
    //   bot.priceHistory.push(price);
    //   if (bot.priceHistory.length > 100) {
    //     bot.priceHistory.shift();
    //   }

    //   if (bot.position) {
    //     this.updatePosition(bot, price);
    //   } else if (bot.priceHistory.length >= 5) {
    //     this.checkEntryCondition(bot, price);
    //   }

    //   bot.lastUpdate = new Date();
    // });

    log(
      `🤖 Bot created for ${signal.symbol} (${signal.strategy}, confidence: ${signal.confidence}%)`,
      'success'
    );
    return bot;
  }

  private async checkEntryCondition(bot: BotInstance, currentPrice: number) {
    if (bot.position || !bot.signal) return;

    const curPrice = await fetchCurrentPrice(bot.symbol);

    const signal = bot.signal as EntrySignal;
    const signalPrice = signal.entryPrice as number;

    // Check slippage
    const priceDiff = Math.abs(
      ((currentPrice - signalPrice) / signalPrice) * 100
    );

    if (priceDiff > CONFIG.maxSlippagePercent) {
      return;
    }

    // Price confirmation logic
    if (
      CONFIG.requirePriceConfirmation &&
      bot.priceHistory &&
      bot.priceHistory.length >= 2
    ) {
      const prevPrice = bot.priceHistory[bot.priceHistory.length - 2] as number;
      const priceChange = currentPrice - prevPrice;

      const favorableMove =
        signal.side === 'LONG' ? priceChange > 0 : priceChange < 0;

      if (favorableMove && bot.confirmationTicks) {
        bot.confirmationTicks++;
      } else if (bot.confirmationTicks) {
        bot.confirmationTicks = Math.max(0, bot.confirmationTicks - 1);
      }

      if (
        bot.confirmationTicks &&
        bot.confirmationTicks < CONFIG.confirmationTicks
      ) {
        log(
          `⏳ ${bot.symbol}: Waiting for confirmation (${bot.confirmationTicks}/${CONFIG.confirmationTicks})`,
          'info'
        );
        return;
      }
    }

    let sl: number;
    let tp: number;

    if (signal.side === 'LONG') {
      sl = curPrice * 0.99;
      tp = curPrice * 1.03;
    } else {
      sl = curPrice * 1.01;
      tp = curPrice * 0.97;
    }

    // ✅ Enter position with correct strategyId from signal
    this.enterPosition(
      bot,
      signal.side,
      currentPrice,
      signal.strategy, // ✅ CRITICAL: Pass the actual strategyId from signal
      sl,
      tp
    );
  }

  private enterPosition(
    bot: BotInstance,
    side: EntryType,
    price: number,
    strategy: StrategyId, // ✅ Make sure this is passed
    stopLoss: number,
    takeProfit: number
  ) {
    if (bot.position) return;

    console.log(`🔍 ${bot.symbol} Entry Validation:`);
    console.log(`   Entry Price: $${price}`);
    console.log(`   Stop Loss: $${stopLoss}`);
    console.log(`   Take Profit: $${takeProfit}`);

    // Position size in USDT (e.g., $100)
    const positionSizeUSD = configForLogging.positionSize;

    // With leverage (e.g., $100 * 3x = $300 notional value)
    const notionalValue = positionSizeUSD * configForLogging.leverageMultiplier;

    // Token quantity = Notional Value / Entry Price
    // Example: $300 / $43,250 (BTC price) = 0.00693641 BTC
    const tokenQuantity = notionalValue / price;

    // Margin required (actual capital used)
    const marginRequired = positionSizeUSD; // Without leverage multiplier

    if (!reserveCapital(marginRequired)) {
      log('❌ Insufficient capital to open position', 'error');
      return;
    }

    bot.position = {
      side,
      entryPrice: price,
      currentPrice: price,
      amount: tokenQuantity,
      remainingAmount: 0,
      stopLoss,
      takeProfit,
      pnlUsd: 0,
      pnlPct: 0,
      entryTime: new Date(),
      symbol: bot.symbol,
      strategy,
      partialsSold: 0,
      positionId: generateId(),
      confidence: bot.signal?.confidence || 0,

      // ✅ NEW: Store additional position details
      notionalValue: notionalValue, // Total position value
      marginUsed: marginRequired, // Actual capital at risk
      leverage: configForLogging.leverageMultiplier, // Leverage used
    };
    this.allocatedCapital += notionalValue;
    bot.status = 'running';

    log(
      `💰 Allocated: $${notionalValue} | Total allocated: $${this.allocatedCapital}/$${this.totalCapital}`,
      'info'
    );
    log(
      `🚀 ${bot.symbol} entered ${side} at $${price.toFixed(6)} (${strategy})`,
      'success'
    );
    log(`   Quantity: ${tokenQuantity.toFixed(8)} tokens`, 'info');
    log(
      `   Notional: $${notionalValue.toFixed(2)} (${configForLogging.leverageMultiplier}x leverage)`,
      'info'
    );
    log(
      `   SL: $${stopLoss.toFixed(6)} | TP: $${takeProfit.toFixed(6)}`,
      'info'
    );
  }

  // private updatePosition(bot: BotInstance, price: number) {
  //   if (!bot.position) return;

  //   const pos = bot.position;
  //   const oldPrice = pos.currentPrice;
  //   pos.currentPrice = price;

  //   // Calculate PnL
  //   if (pos.side === 'LONG') {
  //     pos.pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  //   } else {
  //     pos.pnlPct = ((pos.entryPrice - price) / pos.entryPrice) * 100;
  //   }

  //   pos.pnlUsd = pos.amount * (pos.pnlPct / 100);

  //   // ✅ DEBUG: Log price movements
  //   const timeSinceEntry = Date.now() - pos.entryTime.getTime();
  //   if (timeSinceEntry < 60000) { // Log for first minute
  //     log(`${bot.symbol}: Price ${price.toFixed(6)}, Entry ${pos.entryPrice.toFixed(6)}, PnL ${pos.pnlPct.toFixed(2)}%`, 'info');
  //   }

  //   // Check exit conditions
  //   if (pos.side === 'LONG') {
  //     // ✅ FIXED: Add tolerance to prevent false triggers
  //     const hitStopLoss = price <= pos.stopLoss * 0.999; // 0.1% tolerance
  //     const hitTakeProfit = price >= pos.takeProfit * 1.001; // 0.1% tolerance

  //     if (hitStopLoss) {
  //       log(`${bot.symbol} STOP LOSS: Price ${price.toFixed(6)} <= SL ${pos.stopLoss.toFixed(6)}`, 'error');
  //       this.exitPosition(bot, 'STOP_LOSS');
  //     } else if (hitTakeProfit) {
  //       log(`${bot.symbol} TAKE PROFIT: Price ${price.toFixed(6)} >= TP ${pos.takeProfit.toFixed(6)}`, 'success');
  //       this.exitPosition(bot, 'TAKE_PROFIT');
  //     } else if (CONFIG.trailingStopEnabled && pos.pnlPct > 2) {
  //       const newStopLoss = price * (1 - CONFIG.trailingStopPercent / 100);
  //       if (newStopLoss > pos.stopLoss) {
  //         const oldSL = pos.stopLoss;
  //         pos.stopLoss = newStopLoss;
  //         log(`${bot.symbol} trailing stop updated: ${oldSL.toFixed(6)} → ${newStopLoss.toFixed(6)}`, 'info');
  //       }
  //     }
  //   } else {
  //     // SHORT positions
  //     const hitStopLoss = price >= pos.stopLoss * 1.001; // 0.1% tolerance
  //     const hitTakeProfit = price <= pos.takeProfit * 0.999; // 0.1% tolerance

  //     if (hitStopLoss) {
  //       log(`${bot.symbol} STOP LOSS: Price ${price.toFixed(6)} >= SL ${pos.stopLoss.toFixed(6)}`, 'error');
  //       this.exitPosition(bot, 'STOP_LOSS');
  //     } else if (hitTakeProfit) {
  //       log(`${bot.symbol} TAKE PROFIT: Price ${price.toFixed(6)} <= TP ${pos.takeProfit.toFixed(6)}`, 'success');
  //       this.exitPosition(bot, 'TAKE_PROFIT');
  //     } else if (CONFIG.trailingStopEnabled && pos.pnlPct > 2) {
  //       const newStopLoss = price * (1 + CONFIG.trailingStopPercent / 100);
  //       if (newStopLoss < pos.stopLoss) {
  //         const oldSL = pos.stopLoss;
  //         pos.stopLoss = newStopLoss;
  //         log(`${bot.symbol} trailing stop updated: ${oldSL.toFixed(6)} → ${newStopLoss.toFixed(6)}`, 'info');
  //       }
  //     }
  //   }
  // }

  private updatePosition(bot: BotInstance, currentPrice: number) {
    // console.log('🥑 ~ FuturesTradingBot ~ updatePosition ~ bot:', bot);
    if (!bot.position) return;

    const pos = bot.position;
    const oldPrice = pos.entryPrice;
    pos.currentPrice = currentPrice;

    const tokenQuantity = pos.amount;
    const leverage = pos.leverage || CONFIG.leverageMultiplier;
    const marginUsed = pos.marginUsed || CONFIG.positionSize;

    // console.log(`\n🔍 ${bot.symbol} ${pos.side} PnL Calculation:`);
    // console.log(`   Entry Price: $${pos.entryPrice.toFixed(6)}`);
    // console.log(`   Current Price: $${currentPrice.toFixed(6)}`);
    // console.log(`   Token Quantity: ${tokenQuantity.toFixed(8)}`);
    // console.log(`   Leverage: ${leverage}x`);
    // console.log(`   Margin Used: $${marginUsed.toFixed(2)}`);

    let priceChange = 0;

    if (pos.side === 'LONG') {
      // LONG: Profit when price INCREASES
      priceChange = currentPrice - pos.entryPrice;
    } else {
      // SHORT: Profit when price DECREASES
      priceChange = pos.entryPrice - currentPrice;
    }

    // console.log(`   Price Change: $${priceChange.toFixed(6)}`);

    // ============================================================================
    // STEP 2: Calculate RAW PnL (before leverage)
    // ============================================================================
    const rawPnl = priceChange * tokenQuantity;
    // console.log(`   Raw PnL: $${rawPnl.toFixed(2)}`);

    // ============================================================================
    // STEP 3: Apply LEVERAGE to PnL
    // ============================================================================
    const positionSize = rawPnl * leverage;
    // console.log(`   Leveraged PnL (${leverage}x): $${positionSize.toFixed(2)}`);

    // ============================================================================
    // STEP 4: Calculate PnL percentage (based on MARGIN, not notional)
    // ============================================================================
    const pnlPct = (positionSize / marginUsed) * 100;
    // console.log(`   PnL %: ${pnlPct.toFixed(2)}%`);

    // ============================================================================
    // STEP 5: Store in position
    // ============================================================================
    pos.pnlUsd = rawPnl;
    pos.pnlPct = (rawPnl / marginUsed) * 100;

    // console.log(
    //   `   ✅ Final: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}% ${pos.pnlUsd >= 0 ? '+' : ''}$${pos.pnlUsd.toFixed(2)}\n`
    // );

    // Log price movements
    const priceMovement = (
      ((currentPrice - oldPrice) / oldPrice) *
      100
    ).toFixed(4);
    if (Math.abs(currentPrice - oldPrice) > oldPrice * 0.0001) {
      console.log(
        `📈 ${bot.symbol}: $${oldPrice.toFixed(6)} → $${currentPrice.toFixed(6)} (${priceMovement}%) | PnL: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}% ${pos.pnlUsd >= 0 ? '+' : ''}$${pos.pnlUsd.toFixed(2)}`
      );
    }

    // if (pos.side === 'LONG') {
    //   // For LONG: profit when price goes up
    //   priceChange = currentPrice - pos.entryPrice;
    //   rawPnl = priceChange * tokenQuantity;
    // } else {
    //   // For SHORT: profit when price goes down
    //   priceChange = pos.entryPrice - currentPrice;
    //   rawPnl = priceChange * tokenQuantity;
    // }

    // // Apply leverage to PnL
    // pos.pnlUsd = rawPnl * configForLogging.leverageMultiplier;

    // // Calculate percentage based on margin

    // pos.pnlPct = (pos.pnlUsd / marginUsed) * 100;

    // ✅ Log price movements for active positions
    // const priceMovement = (
    //   ((currentPrice - oldPrice) / oldPrice) *
    //   100
    // ).toFixed(2);
    // if (Math.abs(currentPrice - oldPrice) > oldPrice * 0.0001) {
    //   console.log(
    //     `📈 ${bot.symbol} ${pos.side}: $${oldPrice.toFixed(6)} → $${currentPrice.toFixed(6)} (${priceMovement}%) | PnL: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}% ${pos.pnlUsd >= 0 ? '+' : ''}$${pos.pnlUsd.toFixed(2)}`
    //   );
    // }

    // ✅ Check exit conditions with LESS tolerance
    if (pos.side === 'LONG') {
      const hitStopLoss = currentPrice <= pos.stopLoss;
      const hitTakeProfit = currentPrice >= pos.takeProfit;

      // ✅ Log proximity to levels
      const slDistance = (
        ((currentPrice - pos.stopLoss) / pos.stopLoss) *
        100
      ).toFixed(2);
      const tpDistance = (
        ((pos.takeProfit - currentPrice) / currentPrice) *
        100
      ).toFixed(2);

      if (
        Math.abs(parseFloat(slDistance)) < 1 ||
        Math.abs(parseFloat(tpDistance)) < 1
      ) {
        // console.log(`⚠️  ${bot.symbol} near levels: SL ${slDistance}% away, TP ${tpDistance}% away`);
      }

      if (hitStopLoss) {
        console.log(
          `🛑 ${bot.symbol} HIT STOP LOSS: ${currentPrice.toFixed(6)} <= ${pos.stopLoss.toFixed(6)}`
        );
        this.exitPosition(bot, 'STOP_LOSS');
        return;
      }

      if (hitTakeProfit) {
        console.log(
          `🎯 ${bot.symbol} HIT TAKE PROFIT: ${currentPrice.toFixed(6)} >= ${pos.takeProfit.toFixed(6)}`
        );
        this.exitPosition(bot, 'TAKE_PROFIT');
        return;
      }

      // ✅ Trailing stop
      if (configForLogging.trailingStopEnabled && pos.pnlPct > 2) {
        const newStopLoss =
          currentPrice * (1 - configForLogging.trailingStopPercent / 100);
        if (newStopLoss > pos.stopLoss) {
          const oldSL = pos.stopLoss;
          pos.stopLoss = newStopLoss;
          console.log(
            `📊 ${bot.symbol} trailing stop: ${oldSL.toFixed(6)} → ${newStopLoss.toFixed(6)}`
          );
        }
      }
    } else {
      // SHORT positions
      const hitStopLoss = currentPrice >= pos.stopLoss;
      const hitTakeProfit = currentPrice <= pos.takeProfit;

      // ✅ Log proximity
      const slDistance = (
        ((pos.stopLoss - currentPrice) / currentPrice) *
        100
      ).toFixed(2);
      const tpDistance = (
        ((currentPrice - pos.takeProfit) / pos.takeProfit) *
        100
      ).toFixed(2);

      if (
        Math.abs(parseFloat(slDistance)) < 1 ||
        Math.abs(parseFloat(tpDistance)) < 1
      ) {
        // console.log(`⚠️  ${bot.symbol} near levels: SL ${slDistance}% away, TP ${tpDistance}% away`);
      }

      if (hitStopLoss) {
        console.log(
          `🛑 ${bot.symbol} HIT STOP LOSS: ${currentPrice.toFixed(6)} >= ${pos.stopLoss.toFixed(6)}`
        );
        this.exitPosition(bot, 'STOP_LOSS');
        return;
      }

      if (hitTakeProfit) {
        console.log(
          `🎯 ${bot.symbol} HIT TAKE PROFIT: ${currentPrice.toFixed(6)} <= ${pos.takeProfit.toFixed(6)}`
        );
        this.exitPosition(bot, 'TAKE_PROFIT');
        return;
      }

      // ✅ Trailing stop
      if (configForLogging.trailingStopEnabled && pos.pnlPct > 2) {
        const newStopLoss =
          currentPrice * (1 + configForLogging.trailingStopPercent / 100);
        if (newStopLoss < pos.stopLoss) {
          const oldSL = pos.stopLoss;
          pos.stopLoss = newStopLoss;
          console.log(
            `📊 ${bot.symbol} trailing stop: ${oldSL.toFixed(6)} → ${newStopLoss.toFixed(6)}`
          );
        }
      }
    }
  }

  //   private exitPosition(bot: BotInstance, reason: ExitReason) {
  //     if (!bot.position) return;

  //     const pos = bot.position as Position;

  //     let actualExitPrice = pos.currentPrice;

  //       if (reason === 'STOP_LOSS') {
  //     actualExitPrice = pos.stopLoss;
  //     console.log(`🛑 ${bot.symbol} Exiting at Stop Loss: $${actualExitPrice.toFixed(6)}`);
  //   } else if (reason === 'TAKE_PROFIT') {
  //     actualExitPrice = pos.takeProfit;
  //     console.log(`🎯 ${bot.symbol} Exiting at Take Profit: $${actualExitPrice.toFixed(6)}`);
  //   } else {
  //     console.log(`⚠️  ${bot.symbol} Exiting at Current Price: $${actualExitPrice.toFixed(6)} (${reason})`);
  //   }

  //    // ✅ STEP 2: RECALCULATE PnL with actual exit price (don't trust stored values)
  //   let priceChange = 0;
  //   let rawPnl = 0;

  //   if (pos.side === 'LONG') {
  //     priceChange = actualExitPrice - pos.entryPrice;
  //     rawPnl = priceChange * pos.amount;
  //   } else {
  //     priceChange = pos.entryPrice - actualExitPrice;
  //     rawPnl = priceChange * pos.amount;
  //   }

  //   const finalPnlUsd = rawPnl * CONFIG.leverageMultiplier;
  //   const marginUsed = pos.marginUsed || CONFIG.positionSize;
  //   const finalPnlPct = (priceChange / pos.entryPrice) * 100;
  //   const finalRoiPct = (finalPnlUsd / marginUsed) * 100;

  //     // ✅ STEP 3: VALIDATE exit reason matches PnL sign
  //   let actualReason = reason;

  //   if (finalPnlUsd > 0.01 && reason === 'STOP_LOSS') {
  //     console.log(`⚠️  WARNING: ${bot.symbol} has positive PnL ($${finalPnlUsd.toFixed(2)}) but exit reason is STOP_LOSS`);
  //     console.log(`   This should be TAKE_PROFIT! Correcting...`);
  //     actualReason = 'TAKE_PROFIT';
  //   } else if (finalPnlUsd < -0.01 && reason === 'TAKE_PROFIT') {
  //     console.log(`⚠️  WARNING: ${bot.symbol} has negative PnL ($${finalPnlUsd.toFixed(2)}) but exit reason is TAKE_PROFIT`);
  //     console.log(`   This should be STOP_LOSS! Correcting...`);
  //     actualReason = 'STOP_LOSS';
  //   }

  //     // ✅ STEP 4: Log detailed exit info
  //   console.log(`\n${'═'.repeat(60)}`);
  //   console.log(`${finalPnlUsd > 0 ? '✅' : '❌'} ${bot.symbol} ${pos.side} POSITION CLOSED`);
  //   console.log(`${'─'.repeat(60)}`);
  //   console.log(`   Entry Price:     $${pos.entryPrice.toFixed(6)}`);
  //   console.log(`   Exit Price:      $${actualExitPrice.toFixed(6)}`);
  //   console.log(`   Price Change:    ${finalPnlPct >= 0 ? '+' : ''}${finalPnlPct.toFixed(2)}%`);
  //   console.log(`   Token Quantity:  ${pos.amount.toFixed(8)}`);
  //   console.log(`   Raw PnL:         $${rawPnl.toFixed(4)}`);
  //   console.log(`   Leverage:        ${CONFIG.leverageMultiplier}x`);
  //   console.log(`   Final PnL:       $${finalPnlUsd.toFixed(2)}`);
  //   console.log(`   ROI:             ${finalRoiPct >= 0 ? '+' : ''}${finalRoiPct.toFixed(2)}%`);
  //   console.log(`   Exit Reason:     ${actualReason}`);
  //   console.log(`   Duration:        ${Math.floor((Date.now() - pos.entryTime.getTime()) / 60000)}m`);
  //   console.log(`${'═'.repeat(60)}\n`);

  //   // ✅ STEP 5: Update bot stats with validation
  //   if (bot.trades === undefined) bot.trades = 0;
  //   if (bot.wins === undefined) bot.wins = 0;
  //   if (bot.losses === undefined) bot.losses = 0;
  //   if (bot.sessionPnl === undefined) bot.sessionPnl = 0;

  //     bot.trades++;

  //      if (finalPnlUsd > 0) {
  //     bot.wins++;
  //   } else {
  //     bot.losses++;
  //   }

  //   bot.sessionPnl += finalPnlUsd;

  //   // ✅ STEP 6: Update global capital
  //   CONFIG.updateCapital(finalPnlUsd);

  //   const duration = Date.now() - pos.entryTime.getTime();

  //     // Record trade
  //     const trade: CompletedTrade = {
  //       symbol: bot.symbol,
  //       strategy: pos.strategy,
  //       side: pos.side,
  //       entryPrice: pos.entryPrice,
  //       exitPrice: actualExitPrice,
  //       amount: pos.amount,
  //       pnlUsd: finalPnlUsd,
  //       pnlPct: finalPnlPct,
  //       duration,
  //       exitReason: actualReason,
  //       entryTime: pos.entryTime,
  //       exitTime: new Date(),
  //       isWin: pos.pnlUsd > 0,
  //     };

  //     this.tradeHistory.unshift(trade);
  //     if (this.tradeHistory.length > this.maxHistorySize) {
  //       this.tradeHistory.pop();
  //     }

  //     const icon = finalPnlUsd > 0 ? '✅' : '❌';
  //  log(`${icon} ${bot.symbol} ${pos.side} closed: ${colorPnL(finalPnlUsd)} (${colorPnL(finalRoiPct, true)} ROI) - ${actualReason} after ${Math.floor(duration / 60000)}m`,
  //     finalPnlUsd > 0 ? 'success' : 'error');

  //     bot.position = null;
  //     bot.status = 'waiting';
  //     bot.signal = null;

  //     // Remove bot after exit
  //     setTimeout(() => {
  //       this.bots.delete(bot.symbol);
  //     }, 5000);
  //   }

  private exitPosition(bot: BotInstance, reason: ReasonType) {
    if (!bot.position) return;

    const pos = bot.position;
    const marginUsed = pos.marginUsed || CONFIG.positionSize;
    const pnl = pos.pnlUsd;
    // ✅ STEP 1: Determine the ACTUAL exit price based on reason
    const exitPrice = pos.currentPrice;
    const entryPrice = pos.entryPrice;
    const tokenQuantity = pos.amount;
    const leverage = pos.leverage || CONFIG.leverageMultiplier;

    console.log(`\n🔍 EXIT POSITION CALCULATION for ${bot.symbol}:`);
    console.log(`   Side: ${pos.side}`);
    console.log(`   Entry Price: $${entryPrice.toFixed(6)}`);
    console.log(`   Exit Price: $${exitPrice.toFixed(6)}`);
    console.log(`   Token Quantity: ${tokenQuantity.toFixed(8)}`);
    console.log(`   Leverage: ${leverage}x`);
    console.log(`   Margin Used: $${marginUsed.toFixed(2)}`);
    let actualExitPrice = pos.currentPrice;

    if (reason === 'STOP_LOSS') {
      actualExitPrice = pos.stopLoss;
    } else if (reason === 'TAKE_PROFIT') {
      actualExitPrice = pos.takeProfit;
    }

    // ✅ STEP 2: RECALCULATE PnL with actual exit price
    let priceChange = 0;
    // let rawPnl = 0;

    if (pos.side === 'LONG') {
      priceChange = exitPrice - entryPrice;
    } else {
      priceChange = entryPrice - exitPrice;
    }

    console.log(
      `   Price Change: $${priceChange.toFixed(6)} (${((priceChange / entryPrice) * 100).toFixed(2)}%)`
    );

    const rawPnl = priceChange * tokenQuantity;
    console.log(`   Raw PnL (1x): $${rawPnl.toFixed(2)}`);

    // ============================================================================
    // STEP 3: Apply LEVERAGE to PnL
    // ============================================================================
    const finalPnlUsd = rawPnl * leverage;
    console.log(`   Leveraged PnL (${leverage}x): $${finalPnlUsd.toFixed(2)}`);

    // ============================================================================
    // STEP 4: Calculate PnL percentage based on MARGIN
    // ============================================================================
    const finalPnlPct = (finalPnlUsd / marginUsed) * 100;
    console.log(`   PnL %: ${finalPnlPct.toFixed(2)}%`);
    console.log(`   Result: ${finalPnlUsd > 0 ? '✅ WIN' : '❌ LOSS'}`);

    // ============================================================================
    // STEP 5: Update bot statistics
    // ============================================================================
    if (bot.trades === undefined) bot.trades = 0;
    if (bot.wins === undefined) bot.wins = 0;
    if (bot.losses === undefined) bot.losses = 0;
    if (bot.pnl === undefined) bot.pnl = 0;

    bot.trades++;

    const isWin = finalPnlUsd > 0;

    if (isWin) {
      bot.wins++;
    } else {
      bot.losses++;
    }

    bot.pnl += finalPnlUsd;

    const duration = Date.now() - pos.entryTime.getTime();

    // ============================================================================
    // STEP 6: Record trade with CORRECT values
    // ============================================================================
    const trade: CompletedTrade = {
      symbol: bot.symbol,
      strategy: pos.strategy,
      side: pos.side, // ✅ Include side
      entryPrice: entryPrice,
      exitPrice: exitPrice, // ✅ Make sure this is the ACTUAL exit price
      amount: tokenQuantity,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      pnlUsd: finalPnlUsd, // ✅ Use calculated leveraged PnL
      pnlPct: finalPnlPct, // ✅ Use calculated PnL %
      duration,
      exitReason: reason,
      entryTime: pos.entryTime,
      exitTime: new Date(),
      isWin: isWin,

      // ✅ NEW: Store additional details for verification
      leverage: leverage,
      marginUsed: marginUsed,
      rawPnl: rawPnl, // Store unleveraged PnL for debugging
    };

    this.tradeHistory.unshift(trade);
    if (this.tradeHistory.length > this.maxHistorySize) {
      this.tradeHistory.pop();
    }

    // ============================================================================
    // STEP 7: Update capital
    // ============================================================================
    configForLogging.availableCapital += marginUsed; // Release margin
    configForLogging.totalCapital += finalPnlUsd; // Add/subtract PnL

    if (configForLogging.availableCapital > configForLogging.totalCapital) {
      configForLogging.availableCapital = configForLogging.totalCapital;
    }
    releaseCapital(marginUsed, pnl);

    // ============================================================================
    // STEP 8: Logging with verification
    // ============================================================================
    const icon = isWin ? '✅' : '❌';
    const pnlColor = isWin ? colors.brightGreen : colors.brightRed;

    console.log(`\n${icon} ═══════════════════════════════════════`);
    console.log(`${icon} ${bot.symbol} ${pos.side} CLOSED`);
    console.log(`${icon} Entry: $${entryPrice.toFixed(6)}`);
    console.log(`${icon} Exit:  $${exitPrice.toFixed(6)}`);
    console.log(
      `${icon} Price Change: $${priceChange.toFixed(6)} (${((priceChange / entryPrice) * 100).toFixed(2)}%)`
    );
    console.log(`${icon} Token Qty: ${tokenQuantity.toFixed(8)}`);
    console.log(
      `${icon} Raw PnL (1x): ${rawPnl >= 0 ? '+' : ''}$${rawPnl.toFixed(2)}`
    );
    console.log(
      `${icon} Leveraged PnL (${leverage}x): ${colorize(`${finalPnlUsd >= 0 ? '+' : ''}$${finalPnlUsd.toFixed(2)}`, pnlColor)}`
    );
    console.log(
      `${icon} PnL %: ${colorize(`${finalPnlPct >= 0 ? '+' : ''}${finalPnlPct.toFixed(2)}%`, pnlColor)}`
    );
    console.log(`${icon} Margin: $${marginUsed.toFixed(2)}`);
    console.log(`${icon} Reason: ${reason}`);
    console.log(`${icon} Duration: ${Math.floor(duration / 60000)}m`);
    console.log(`${icon} ═══════════════════════════════════════\n`);

    bot.position = null;
    bot.status = 'waiting';
    bot.signal = null;

    // Remove bot after cooldown
    setTimeout(() => {
      this.bots.delete(bot.symbol);
      console.log(`🗑️  Bot removed: ${bot.symbol}`);
    }, 5000);

    // // const finalPnlUsd = rawPnl * CONFIG.leverageMultiplier;
    // // const finalPnlPct = (priceChange / pos.entryPrice) * 100;
    // const finalRoiPct = (finalPnlUsd / marginUsed) * 100;

    // // ✅ STEP 3: DETERMINE CORRECT EXIT REASON FROM PNL (ignore input parameter)
    // let actualReason: string;

    // if (finalPnlUsd > 0.01) {
    //   // Profit = Take Profit (regardless of what was passed in)
    //   actualReason = 'TAKE_PROFIT';
    //   actualExitPrice = pos.takeProfit; // Use TP price

    //   // Recalculate with TP price
    //   if (pos.side === 'LONG') {
    //     priceChange = actualExitPrice - pos.entryPrice;
    //     rawPnl = priceChange * pos.amount;
    //   } else {
    //     priceChange = pos.entryPrice - actualExitPrice;
    //     rawPnl = priceChange * pos.amount;
    //   }
    // } else if (finalPnlUsd < -0.01) {
    //   // Loss = Stop Loss
    //   actualReason = 'STOP_LOSS';
    //   actualExitPrice = pos.stopLoss; // Use SL price

    //   // Recalculate with SL price
    //   if (pos.side === 'LONG') {
    //     priceChange = actualExitPrice - pos.entryPrice;
    //     rawPnl = priceChange * pos.amount;
    //   } else {
    //     priceChange = pos.entryPrice - actualExitPrice;
    //     rawPnl = priceChange * pos.amount;
    //   }
    // } else {
    //   // Break-even or manual exit
    //   actualReason = reason; // Keep original reason
    // }

    // // Recalculate final values with corrected exit price
    // const correctedPnlUsd = rawPnl * CONFIG.leverageMultiplier;
    // const correctedPnlPct = (priceChange / pos.entryPrice) * 100;
    // const correctedRoiPct = (correctedPnlUsd / marginUsed) * 100;

    // // ✅ STEP 4: Log if we corrected the reason
    // if (actualReason !== reason) {
    //   console.log(`⚠️  ${bot.symbol}: EXIT REASON CORRECTED`);
    //   console.log(`   Original Reason: ${reason}`);
    //   console.log(`   Corrected Reason: ${actualReason}`);
    //   console.log(
    //     `   PnL: $${correctedPnlUsd.toFixed(2)} (${correctedPnlUsd > 0 ? 'WIN' : 'LOSS'})`
    //   );
    // }

    // // ✅ STEP 5: Detailed logging
    // console.log(`\n${'═'.repeat(60)}`);
    // console.log(
    //   `${correctedPnlUsd > 0 ? '✅' : '❌'} ${bot.symbol} ${pos.side} POSITION CLOSED`
    // );
    // console.log(`${'─'.repeat(60)}`);
    // console.log(`   Entry:           $${pos.entryPrice.toFixed(6)}`);
    // console.log(`   Exit:            $${actualExitPrice.toFixed(6)}`);
    // console.log(
    //   `   Price Change:    ${correctedPnlPct >= 0 ? '+' : ''}${correctedPnlPct.toFixed(2)}%`
    // );
    // console.log(
    //   `   PnL USD:         ${correctedPnlUsd >= 0 ? '+' : ''}$${correctedPnlUsd.toFixed(2)}`
    // );
    // console.log(
    //   `   ROI:             ${correctedRoiPct >= 0 ? '+' : ''}${correctedRoiPct.toFixed(2)}%`
    // );
    // console.log(`   Exit Reason:     ${actualReason}`);
    // console.log(
    //   `   Is Win:          ${correctedPnlUsd > 0 ? 'YES ✅' : 'NO ❌'}`
    // );
    // console.log(`${'═'.repeat(60)}\n`);

    // // ✅ STEP 6: Update bot stats
    // if (bot.trades === undefined) bot.trades = 0;
    // if (bot.wins === undefined) bot.wins = 0;
    // if (bot.losses === undefined) bot.losses = 0;
    // if (bot.sessionPnl === undefined) bot.sessionPnl = 0;

    // bot.trades++;

    // if (correctedPnlUsd > 0) {
    //   bot.wins++;
    // } else {
    //   bot.losses++;
    // }

    // bot.sessionPnl += correctedPnlUsd;

    // // ✅ STEP 7: Update global capital
    // CONFIG.updateCapital(correctedPnlUsd);

    // const duration = Date.now() - pos.entryTime.getTime();

    // // ✅ STEP 8: Record trade with CORRECTED values
    // const trade: CompletedTrade = {
    //   symbol: bot.symbol,
    //   strategy: pos.strategy,
    //   side: pos.side,
    //   entryPrice: pos.entryPrice,
    //   exitPrice: actualExitPrice,
    //   amount: pos.amount,
    //   pnlUsd: correctedPnlUsd,
    //   pnlPct: correctedPnlPct,
    //   duration,
    //   exitReason: actualReason, // ✅ This will now be correct!
    //   entryTime: pos.entryTime,
    //   exitTime: new Date(),
    //   isWin: correctedPnlUsd > 0,
    // };

    // this.tradeHistory.unshift(trade);
    // if (this.tradeHistory.length > this.maxHistorySize) {
    //   this.tradeHistory.pop();
    // }

    // // ✅ STEP 9: Save state immediately after trade
    // this.persistence.saveState(this);

    // // ✅ STEP 10: Console summary
    // const icon = correctedPnlUsd > 0 ? '✅' : '❌';
    // log(
    //   `${icon} ${bot.symbol} ${pos.side} closed: ${colorPnL(correctedPnlUsd)} (${colorPnL(correctedRoiPct, true)} ROI) - ${actualReason} after ${Math.floor(duration / 60000)}m`,
    //   correctedPnlUsd > 0 ? 'success' : 'error'
    // );

    // // Clean up
    // bot.position = null;
    // bot.status = 'waiting';
    // bot.signal = null;

    // setTimeout(() => {
    //   this.bots.delete(bot.symbol);
    //   console.log(`🗑️  Bot removed: ${bot.symbol}`);
    // }, 5000);
  }

  private async checkForNewSignals() {
    const signals = this.signalReader.readLatestSignals();

    if (signals.length === 0) return;

    // ✅ Count BOTH active positions AND waiting bots
    const activeBots = Array.from(this.bots.values());
    const activePositions = activeBots.filter((b) => b?.position).length;
    const waitingBots = activeBots.filter(
      (b) => b && !b.position && b.signal
    ).length;
    const totalBots = activePositions + waitingBots;

    const availableSlots = CONFIG.maxConcurrentPositions - totalBots;

    if (availableSlots <= 0) {
      log(
        `⛔ Max positions reached (${totalBots}/${CONFIG.maxConcurrentPositions}) - waiting...`,
        'info'
      );
      return;
    }

    // Get best signal not already in use
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

  private printDashboard() {
    try {
      console.clear();
      console.log(colorize('═'.repeat(140), colors.cyan));
      console.log(
        colorize(
          '  🤖 FUTURES TRADING BOT - SIGNAL-DRIVEN EXECUTION - LEGACY ',
          colors.brightCyan
        )
      );
      console.log(colorize('═'.repeat(140), colors.cyan));

      const totalBots = this.bots.size;
      const activePos = Array.from(this.bots.values()).filter(
        (b) => b?.position
      ).length;
      const totalPnL = Array.from(this.bots.values()).reduce(
        (s, b) => s + (b?.sessionPnl || 0),
        0
      );
      const totalTrades = Array.from(this.bots.values()).reduce(
        (s, b) => s + (b?.trades || 0),
        0
      );
      const totalWins = Array.from(this.bots.values()).reduce(
        (s, b) => s + (b?.wins || 0),
        0
      );
      const winRate =
        totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';

      console.log(
        `  Active Bots: ${totalBots} | Positions: ${activePos}/${CONFIG.maxConcurrentPositions} | ` +
          `Session PnL: ${colorPnL(totalPnL)} | Trades: ${totalTrades} | Win Rate: ${winRate}%`
      );

      const signalStats = this.signalReader.getStats();
      console.log(
        `  Available Signals: ${signalStats.totalSignals} | ` +
          `Long: ${signalStats.longSignals} | Short: ${signalStats.shortSignals} | ` +
          `Avg Confidence: ${signalStats.avgConfidence.toFixed(0)}%`
      );

      console.log(colorize('─'.repeat(140), colors.gray));

      // Active Positions
      const withPos = Array.from(this.bots.values()).filter((b) => b?.position);
      if (withPos.length > 0) {
        console.log(colorize('📈 ACTIVE POSITIONS', colors.brightGreen));
        console.log('');

        withPos.forEach((bot) => {
          if (!bot || !bot.position) return;

          const p = bot.position;

          // ✅ Safely extract values with fallbacks
          const symbol = (bot.symbol || 'UNKNOWN_SYMBOL').toString();
          const side = (p.side || 'UNKNOWN_SIDE').toString();
          const strategyId = (p.strategy || 'UNKNOWN_STRATEGY').toString(); // ✅ FIX: Use strategyId
          const entryPrice = p.entryPrice || 0;
          const currentPrice = p.currentPrice || 0;
          const pnlPct = p.pnlPct || 0;
          const pnlUsd = p.pnlUsd || 0;
          const stopLoss = p.stopLoss || 0;
          const takeProfit = p.takeProfit || 0;
          const confidence = p.confidence || 0;
          const amount = p.amount || 0;

          const positionSize = amount * entryPrice;
          const leverage = configForLogging.leverageMultiplier;
          const margin = positionSize / leverage;
          const notionalValue = amount * p.currentPrice;
          const curPriceDec = getPriceDecimals(currentPrice);

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
                : colors.peach + colors.bgMaroon + colors.bright;

          const pnlPctStr = colorPnL(pnlPct, true);
          const pnlUsdStr = colorPnL(pnlUsd);
          const amountDes = getAmountDecimals(amount, currentPrice);
          const curPriceDigit = currentPrice.toString().length;
          const sideDigit = side.length;
          console.log(
            `  ${colorize(symbol.padEnd(10), colors.cyan)} ` +
              `${colorize(side.padEnd(sideDigit), sideColor)} ` +
              `${colorize(strategyId.padEnd(16), colors.brightOrange)} ` +
              `Entry: ${colorize(entryPrice.toFixed(curPriceDec).padEnd(curPriceDigit), colors.bgBlue + colors.brightWhite)} ` +
              `Amount/tokenQty: ${colorize(amount.toFixed(amountDes).padEnd(amountDes), colors.darkGray + colors.bgBrightYellow)} ` +
              `Current: ${colorize(currentPrice.toFixed(curPriceDec).padEnd(curPriceDigit), currentColor)} ` +
              `PnL: ${pnlPctStr} ${pnlUsdStr} ` +
              `Time: ${duration}m ` +
              `Conf: ${confidence.toFixed(1)}%`
          );

          console.log(
            `  ${colorize('SL:', colors.gray)} ${stopLoss.toFixed(6)} | ` +
              `${colorize('TP:', colors.gray)} ${takeProfit.toFixed(curPriceDec)} | ` +
              `${colorize('PositionSize:', colors.gray)} ${positionSize.toFixed(2)} USDT | ` +
              `${colorize('Leverage:', colors.gray)} ${leverage}x | ` +
              `${colorize('Margin:', colors.gray)} ${margin.toFixed(2)} USDT | ` +
              `${colorize('Notional:', colors.gray)} ${notionalValue.toFixed(2)} USDT`
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

      // Waiting Bots
      const waiting = Array.from(this.bots.values()).filter(
        (b) => b && !b.position && b.signal
      );
      if (waiting.length > 0) {
        console.log(colorize('⏳ WAITING FOR ENTRY', colors.yellow));
        waiting.forEach((bot) => {
          if (!bot || !bot.signal) return;

          const signal = bot.signal;
          const symbol = (bot.symbol || 'UNKNOWN_SYMBOL').toString();
          const strategyId = (signal.strategy || 'UNKNOWN_STRATEGY').toString();
          const side = (signal.side || 'UNKNOWN_SIDE').toString();
          const confidence = signal.confidence || 0;
          const price = signal.entryPrice || 0;

          console.log(
            `  ${symbol.padEnd(12)} ${strategyId.padEnd(18)} ` +
              `${side.padEnd(6)} Confidence: ${confidence}% ` +
              `Target: $${price.toFixed(6)}`
          );
        });
        console.log(colorize('─'.repeat(140), colors.gray));
      }

      // Trade History
      // console.log("🥑 ~ FuturesTradingBot ~ printDashboard ~ this.tradeHistory:", this.tradeHistory)
      if (this.tradeHistory.length > 0) {
        console.log(
          colorize('📜 RECENT TRADES (Last 10)', colors.brightYellow)
        );
        this.tradeHistory.slice(0, 10).forEach((trade) => {
          if (!trade) return;

          const symbol = (trade.symbol || 'UNKNOWN_SYMBOL').toString();
          const strategy = (trade.strategy || 'UNKNOWN_STRATEGY').toString();
          const side = (trade.side || 'UNKNOWN_SIDE').toString();
          const isWin = trade.isWin || false;
          const entryPrice = trade.entryPrice || 0;
          const currentPrice = trade.exitPrice || 0;
          const pnlPct = trade.pnlPct || 0;
          const pnlUsd = trade.pnlUsd || 0;
          const duration = trade.duration || 0;
          const exitReason = trade.exitReason || 'UNKNOWN_REASON';

          const icon = isWin ? '✅' : '❌';
          const pnlPctStr = colorPnL(pnlPct, true);
          const pnlUsdStr = colorPnL(pnlUsd);

          const winLostColor = isWin
            ? rgb(1, 50, 32) + colors.bgBrightGreen + colors.bright
            : colors.peach + colors.bgMaroon + colors.bright;

          console.log(
            `${icon} ${symbol.padEnd(12)} ${strategy.padEnd(10)} ` +
              `${colorize((isWin ? 'Won' : 'Lost').padEnd(6), winLostColor)}` +
              `${pnlPctStr} ${pnlUsdStr} ` +
              `${Math.floor(duration / 60000)}m ${exitReason}`
          );
        });
        console.log(colorize('─'.repeat(140), colors.gray));
      }

      // Session Summary
      if (totalTrades > 0) {
        console.log(colorize('📊 SESSION SUMMARY', colors.brightYellow));
        console.log(
          `  Total Trades: ${totalTrades} | Wins: ${totalWins} | Losses: ${totalTrades - totalWins} | ` +
            `Win Rate: ${winRate}% | PnL: ${colorPnL(totalPnL)}`
        );
        console.log(colorize('─'.repeat(140), colors.gray));
      }

      console.log(
        colorize('Commands: (r)efresh signals | (q)uit', colors.gray)
      );
      console.log(colorize('═'.repeat(140), colors.cyan));
    } catch (err: any) {
      console.error(colorize(`❌ Dashboard error: ${err.message}`, colors.red));
      console.error(err.stack);
    }
  }
  start() {
    // Check for signals periodically
    this.signalCheckInterval = setInterval(() => {
      this.checkForNewSignals();
    }, configForLogging.signalCheckInterval);

    // Dashboard refresh
    this.dashboardInterval = setInterval(() => {
      this.printDashboard();
    }, configForLogging.dashboardRefreshMs);

    // ✅ NEW: Add price update from scanner
    this.priceUpdateInterval = setInterval(async () => {
      await this.updatePricesFromScanner();
    }, 3000); // Update every 3 seconds (scanner updates every 30s)

    this.persistence.startAutoSave(this, 30000);

    // Initial checks
    this.checkForNewSignals();
    setTimeout(() => this.printDashboard(), 1000);
  }

  stop() {
    if (this.signalCheckInterval) clearInterval(this.signalCheckInterval);
    if (this.dashboardInterval) clearInterval(this.dashboardInterval);
    if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval);
    log('Bot stopped', 'warning');
  }
}

// class PriceFetcher {
//   private baseUrl = 'https://api.binance.com/api/v3';

//   async getCurrentPrice(symbol: string): Promise<number | null> {
//     try {
//       // Convert symbol format (e.g., AAVE/USDT -> AAVEUSDT)
//       const binanceSymbol = symbol.replace('/', '');

//       const response = await fetch(
//         `${this.baseUrl}/ticker/price?symbol=${binanceSymbol}`
//       );
//       const data = await response.json();

//       if (data && data.price) {
//         return parseFloat(data.price);
//       }

//       return null;
//     } catch (err: any) {
//       console.error(`Failed to fetch price for ${symbol}: ${err.message}`);
//       return null;
//     }
//   }

//   async getMultiplePrices(symbols: string[]): Promise<Map<string, number>> {
//     const priceMap = new Map<string, number>();

//     try {
//       const binanceSymbols = symbols.map((s) => s.replace('/', ''));

//       // Batch request for multiple symbols
//       const response = await fetch(`${this.baseUrl}/ticker/price`);
//       const data = await response.json();

//       if (Array.isArray(data)) {
//         data.forEach((ticker: any) => {
//           if (ticker.symbol && ticker.price) {
//             // Convert back to format with slash
//             const normalSymbol = ticker.symbol.replace('USDT', '/USDT');
//             priceMap.set(ticker.symbol, parseFloat(ticker.price));
//           }
//         });
//       }
//     } catch (err: any) {
//       console.error(`Failed to fetch multiple prices: ${err.message}`);
//     }

//     return priceMap;
//   }
// }

// ============================================================================
// INTERFACE & MAIN
// ============================================================================

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

  const bot = new FuturesTradingBot();

  try {
    await bot.initialize();
    bot.start();
    setupInterface(bot);
  } catch (err: any) {
    log(`Fatal error: ${err.message}`, 'error');
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  log(`Exception: ${err.message}`, 'error');
});

main();
