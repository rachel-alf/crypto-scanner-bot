import fs from 'fs';
import path from 'path';
import readline from 'readline';

import ccxt from 'ccxt';
import * as dotenv from 'dotenv';

import {
  colors,
  generateId,
  getAmountDecimals,
  getPriceDecimals,
  normalize,
  rgb,
} from '../../lib/helpers.js';
import {
  type BotInstance,
  type BotState,
  type CompletedTrade,
  type CooldownInfo,
  type EntrySignal,
  type EntryType,
  type Position,
  type ReasonType,
  type ScanResult,
  type SignalState,
  type StrategyId,
} from '../../lib/type.js';
import {
  BaseTradingBotPersistence,
  type BaseTradingBot,
} from '../core/bot-persistence.js';
import {
  CONFIG,
  getCapitalUtilization,
  releaseCapital,
  reserveCapital,
  validateConfig,
} from './future-config.js';

dotenv.config();

export interface FuturesPosition extends Position {
  leverage: number;
  notionalValue: number;
  marginUsed: number;
}

/**
 * Futures-specific bot instance
 */
export interface FuturesBotInstance extends BotInstance {
  position: FuturesPosition | null;
  priceHistory?: any[];
  lastUpdate?: Date;
}

// ---------- EXCHANGE INIT ----------
if (
  !process.env.BINANCE_FUTURE_API_KEY ||
  !process.env.BINANCE_FUTURE_API_SECRET
) {
  throw Error('Missing BINANCE_FUTURE_API_KEY or BINANCE_FUTURE_API_SECRET');
}

export const binance = new ccxt.binance({
  apiKey: process.env.BINANCE_FUTURE_API_KEY,
  secret: process.env.BINANCE_FUTURE_API_SECRET,
  enableRateLimit: true,
  timeout: 60000,
  options: {
    defaultType: 'future',
  },
});

// ============================================================================
// CONFIGURATION
// ============================================================================

const configForLogging = {
  ...CONFIG,
  availableCapital: CONFIG.availableCapital, // Explicitly call getter
  positionSize: CONFIG.positionSize, // Explicitly call getter
};
// console.log("🥑 ~ Full CONFIG:", configForLogging);

// ============================================================================
// LIGHTWEIGHT SIGNAL READER
// ============================================================================

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

      // console.log(`📊 Found ${data.length} raw signals in file`);

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
        log(`📊 Loaded ${this.signalQueue.length} valid signals`, 'success');

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
  private stateFile = './data/signals/futures-signals.json';
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
  private saveState(
    bot?: FuturesTradingBot,
    tradeCounters?: {
      // Add as parameter
      total: number;
      today: number;
      perSymbol: Map<string, number>;
      sessionStart: Date;
    }
  ): void {
    try {
      const counters = tradeCounters || bot?.getTradeCounters?.();

      const states: Record<string, any> = {
        tradeCounters: tradeCounters
          ? {
              total: tradeCounters.total,
              today: tradeCounters.today,
              perSymbol: Object.fromEntries(tradeCounters.perSymbol),
              sessionStart: tradeCounters.sessionStart.toISOString(),
            }
          : undefined,
      };

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
  private startAutoSave(bot?: FuturesTradingBot): void {
    this.autoSaveInterval = setInterval(() => {
      this.saveState(bot);
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
  getStats(activeBots: Map<string, BotInstance>) {
    const baseStats = super.getStats(activeBots);

    // Get actual in-trade count from state
    const stateInTradeCount = Array.from(this.signalStates.values()).filter(
      (s) => s.status === 'IN_TRADE'
    ).length;

    // Get actual in-trade count from active bots
    const actualInTradeCount = Array.from(activeBots.values()).filter(
      (b) => b.position !== null
    ).length;

    // ✅ Detect mismatch
    if (stateInTradeCount !== actualInTradeCount) {
      console.log(`\n⚠️  Signal state mismatch detected!`);
      console.log(`   State file says: ${stateInTradeCount} in trade`);
      console.log(`   Actual bots: ${actualInTradeCount} in trade`);
      console.log(`   Cleaning up stale signals...\n`);

      // ✅ Fix: Sync state with reality
      this.syncStateWithBots(activeBots);
    }

    const completedCount = Array.from(this.signalStates.values()).filter(
      (s) => s.status === 'COMPLETED'
    ).length;

    return {
      ...baseStats,
      inTrade: actualInTradeCount, // ✅ Use ACTUAL count, not state count
      completed: completedCount,
      totalTracked: this.signalStates.size,
    };
  }

  /**
   * ✅ NEW: Sync signal state with actual active bots
   */
  private syncStateWithBots(activeBots: Map<string, BotInstance>): void {
    const activeSymbols = new Set<string>();

    // Get symbols with actual positions
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

    // Check all IN_TRADE signals
    let fixed = 0;
    for (const [symbol, state] of this.signalStates.entries()) {
      if (state.status === 'IN_TRADE' && !activeSymbols.has(symbol)) {
        // Stale IN_TRADE signal - remove it
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

// ============================================================================
// PRICE CACHE CLASS
// ============================================================================

class PriceCache {
  private cacheFile = './data/signals/price-cache.json';
  private cache: Map<string, { price: number; timestamp: number }> = new Map();
  private cacheExpiryMs = 60000; // 1 minute

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
        Object.entries(data.prices).forEach(([symbol, info]: [string, any]) => {
          this.cache.set(symbol, {
            price: info.price,
            timestamp: info.timestamp,
          });
        });

        console.log(`💾 Loaded ${this.cache.size} cached prices`);
      }
    } catch (err: any) {
      console.error(`Failed to load price cache: ${err.message}`);
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

      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`Failed to save price cache: ${err.message}`);
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

  setPrices(prices: Map<string, number>): void {
    prices.forEach((price, symbol) => {
      this.cache.set(symbol, {
        price,
        timestamp: Date.now(),
      });
    });

    this.saveCache();
    console.log(`💾 Cached ${prices.size} price(s) to disk`);
  }

  private startAutoCleanup(): void {
    setInterval(() => {
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
}

// ============================================================================
// COLORS & UTILITIES
// ============================================================================

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
      confidence: pos.confidence ?? 0,
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
      sessionPnl: state.sessionPnl ?? 0,
      trades: state.trades,
      wins: state.wins ?? 0,
      losses: state.losses ?? 0,
      position: state.position
        ? this.deserializePosition(state.position)
        : null,
      lastHeartbeat: new Date(),
      priceHistory: [],
      lastUpdate: new Date(),
      // Handle undefined confirmationTicks
      ...(state.confirmationTicks !== undefined && {
        confirmationTicks: state.confirmationTicks,
      }),
      ...(state.lastPriceDirection !== undefined && {
        lastPriceDirection: state.lastPriceDirection,
      }),
      ...(state.signal !== undefined && { signal: state.signal }),
      confirmationTicks: state.confirmationTicks ?? 0,
      lastPriceDirection: state.lastPriceDirection ?? 0,
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
      confidence: state.confidence ?? 0,
    };
  }
}

// ============================================================================
// PERSISTENCE CLASS
// ============================================================================

// class BotPersistence {
//   private stateFile: string;
//   private backupFile: string;
//   private autoSaveInterval: NodeJS.Timeout | null = null;

//   constructor(stateFile: string = './bot-state.json') {
//     this.stateFile = stateFile;
//     this.backupFile = `${stateFile}.backup`;
//     this.ensureDirectory();
//   }

//   private ensureDirectory() {
//     const dir = path.dirname(this.stateFile);
//     if (!fs.existsSync(dir)) {
//       fs.mkdirSync(dir, { recursive: true });
//       console.log(`✅ Created state directory: ${dir}`);
//     }
//   }

//   /**
//    * Save bot state to disk
//    */
//   saveState(bot: FuturesTradingBot): void {
//     try {
//       const bots = bot.getBots();

//       const state: BotState = {
//         version: '1.0.0',
//         lastSave: new Date().toISOString(),
//         totalCapital: configForLogging.totalCapital,
//         availableCapital: configForLogging.availableCapital,
//         bots: this.serializeBots(bot.getBots()),
//         tradeHistory: bot.getTradeHistory().slice(0, 50), // Keep last 50
//       };

//       // Create backup of previous state
//       if (fs.existsSync(this.stateFile)) {
//         fs.copyFileSync(this.stateFile, this.backupFile);
//       }

//       // Write new state
//       fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));

//       console.log(
//         `💾 State saved: ${bots.size} bots, ${state.tradeHistory.length} trades`
//       );
//     } catch (err: any) {
//       console.error(`❌ Failed to save state: ${err.message}`);
//     }
//   }

//   /**
//    * Load bot state from disk
//    */
//   loadState(): BotState | null {
//     try {
//       if (!fs.existsSync(this.stateFile)) {
//         console.log('ℹ️  No previous state found');
//         return null;
//       }

//       const content = fs.readFileSync(this.stateFile, 'utf-8');
//       const state: BotState = JSON.parse(content);

//       console.log(`📂 State loaded from: ${state.lastSave}`);
//       console.log(`   Bots: ${state.bots.length}`);
//       console.log(`   Trade History: ${state.tradeHistory.length}`);
//       console.log(`   Capital: $${state.totalCapital}`);

//       return state;
//     } catch (err: any) {
//       console.error(`❌ Failed to load state: ${err.message}`);

//       // Try backup
//       if (fs.existsSync(this.backupFile)) {
//         console.log('🔄 Attempting to load backup...');
//         try {
//           const content = fs.readFileSync(this.backupFile, 'utf-8');
//           return JSON.parse(content);
//         } catch {
//           console.error('❌ Backup also corrupted');
//         }
//       }

//       return null;
//     }
//   }

//   /**
//    * Restore bot state into active bot instance
//    */
//   restoreState(bot: FuturesTradingBot, state: BotState): void {
//     try {
//       // ✅ Direct assignment for plain object
//       configForLogging.totalCapital = state.totalCapital;
//       // availableCapital is computed, so don't try to set it directly

//       // Restore bots with positions
//       state.bots.forEach((botState) => {
//         const restoredBot = this.deserializeBot(botState);
//         bot.addBot(restoredBot);

//         if (restoredBot.position) {
//           console.log(
//             `♻️  Restored position: ${restoredBot.symbol} ${restoredBot.position.side} @ $${restoredBot.position.entryPrice}`
//           );
//         }
//       });

//       // ✅ CRITICAL FIX: Validate and correct trade history on load
//       if (state.tradeHistory && Array.isArray(state.tradeHistory)) {
//         let correctionsMade = 0;

//         const correctedTrades = state.tradeHistory.map((trade) => {
//           const deserializedTrade = this.deserializeTrade(trade);

//           // ✅ Validate: If isWin doesn't match exitReason, fix it!
//           if (
//             deserializedTrade.isWin &&
//             deserializedTrade.exitReason === 'STOP_LOSS'
//           ) {
//             console.log(
//               `⚠️  Correcting ${deserializedTrade.symbol}: WIN but marked as STOP_LOSS → TAKE_PROFIT`
//             );
//             deserializedTrade.exitReason = 'TAKE_PROFIT';
//             correctionsMade++;
//           } else if (
//             !deserializedTrade.isWin &&
//             deserializedTrade.exitReason === 'TAKE_PROFIT'
//           ) {
//             console.log(
//               `⚠️  Correcting ${deserializedTrade.symbol}: LOSS but marked as TAKE_PROFIT → STOP_LOSS`
//             );
//             deserializedTrade.exitReason = 'STOP_LOSS';
//             correctionsMade++;
//           }

//           // ✅ Double-check: Validate isWin matches pnlUsd sign
//           const shouldBeWin = deserializedTrade.pnlUsd > 0;
//           if (deserializedTrade.isWin !== shouldBeWin) {
//             console.log(
//               `⚠️  Correcting ${deserializedTrade.symbol}: isWin=${deserializedTrade.isWin} but PnL=$${deserializedTrade.pnlUsd.toFixed(2)}`
//             );
//             deserializedTrade.isWin = shouldBeWin;
//             deserializedTrade.exitReason = shouldBeWin
//               ? 'TAKE_PROFIT'
//               : 'STOP_LOSS';
//             correctionsMade++;
//           }

//           console.log(
//             '🥑 ~ BotPersistence ~ restoreState ~ state.tradeHistory:',
//             JSON.stringify(deserializedTrade, null, 2)
//           );
//           return deserializedTrade;
//         });

//         bot.setTradeHistory(correctedTrades);

//         console.log(
//           `📜 Restored ${correctedTrades.length} completed trades from history`
//         );

//         if (correctionsMade > 0) {
//           console.log(
//             `✅ Auto-corrected ${correctionsMade} trades with mismatched exit reasons`
//           );

//           // ✅ Save the corrected data back to disk immediately
//           console.log(`💾 Saving corrected trade history...`);
//           setTimeout(() => {
//             this.saveState(bot);
//           }, 1000);
//         }

//         if (correctedTrades.length > 0) {
//           const wins = correctedTrades.filter((t) => t.isWin).length;
//           const losses = correctedTrades.length - wins;
//           const totalPnl = correctedTrades.reduce(
//             (sum, t) => sum + t.pnlUsd,
//             0
//           );

//           console.log(
//             `   Wins: ${wins} | Losses: ${losses} | Total PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT`
//           );
//         }
//       }

//       // Restore trade history
//       bot.setTradeHistory(state.tradeHistory);

//       console.log(
//         `✅ Bot state restored successfully. Capital: $${configForLogging.totalCapital}`
//       );
//     } catch (err: any) {
//       console.error(`❌ Failed to restore state: ${err.message}`);
//     }
//     // Restore capital
//     // configForLogging.totalCapital = state.totalCapital;
//     // configForLogging.availableCapital = state.availableCapital;

//     // // Restore bots with positions
//     // state.bots.forEach(botState => {
//     //   const restoredBot = this.deserializeBot(botState);
//     //   bot.addBot(restoredBot);

//     //   if (restoredBot.position) {
//     //     console.log(`♻️  Restored position: ${restoredBot.symbol} ${restoredBot.position.side} @ $${restoredBot.position.entryPrice}`);
//     //   }
//     // });

//     // // Restore trade history
//     // bot.setTradeHistory(state.tradeHistory);

//     // console.log(`✅ Bot state restored successfully`);
//   }

//   /**
//    * Serialize bots for storage
//    */
//   private serializeBots(bots: Map<string, BotInstance>): BotInstance[] {
//     const serialized: BotInstance[] = [];

//     bots.forEach((bot) => {
//       serialized.push({
//         symbol: bot.symbol,
//         status: bot.status,
//         startTime: bot.startTime,
//         pnl: bot.pnl || 0,
//         sessionPnl: bot.sessionPnl || 0,
//         wins: bot.wins || 0,
//         losses: bot.losses || 0,
//         trades: bot.trades || 0,
//         position: bot.position ? this.serializePosition(bot.position) : null,
//         lastHeartbeat: bot.lastHeartbeat,
//         confirmationTicks: bot.confirmationTicks || 0,
//         lastPriceDirection: bot.lastPriceDirection || 0,
//         signal: bot.signal,
//       } as BotInstance);
//     });

//     return serialized;
//   }

//   /**
//    * Serialize position for storage
//    */
//   private serializePosition(pos: Position): Position {
//     return {
//       symbol: pos.symbol,
//       entryPrice: pos.entryPrice,
//       amount: pos.amount,
//       remainingAmount: pos.remainingAmount,
//       takeProfit: pos.takeProfit,
//       entryTime: pos.entryTime,
//       strategy: pos.strategy,
//       partialsSold: pos.partialsSold,
//       currentPrice: pos.currentPrice,
//       stopLoss: pos.stopLoss,
//       pnlUsd: pos.pnlUsd,
//       pnlPct: pos.pnlPct,
//       positionId: pos.positionId,
//       leverage: pos.leverage || 1,
//       notionalValue: pos.notionalValue || 0,
//       marginUsed: pos.marginUsed || 0,
//       side: pos.side,
//       confidence: pos.confidence,
//     } as Position;
//   }

//   private deserializeTrade(trade: CompletedTrade): CompletedTrade {
//     return {
//       symbol: trade.symbol,
//       strategy: trade.strategy,
//       side: trade.side,
//       entryPrice: trade.entryPrice,
//       exitPrice: trade.exitPrice,
//       amount: trade.amount,
//       stopLoss: trade.stopLoss || 0,
//       takeProfit: trade.takeProfit || 0,
//       pnlUsd: trade.pnlUsd,
//       pnlPct: trade.pnlPct,
//       duration: trade.duration,
//       exitReason: trade.exitReason,
//       entryTime: new Date(trade.entryTime),
//       exitTime: new Date(trade.exitTime),
//       isWin: trade.isWin,
//     };
//   }

//   /**
//    * Deserialize bot from storage
//    */
//   private deserializeBot(state: BotInstance): BotInstance {
//     return {
//       symbol: state.symbol,
//       status: state.status,
//       startTime: state.startTime,
//       pnl: state.pnl,
//       sessionPnl: state.sessionPnl,
//       trades: state.trades,
//       wins: state.wins,
//       losses: state.losses,
//       position: state.position
//         ? this.deserializePosition(state.position)
//         : null,
//       lastHeartbeat: new Date(),
//       priceHistory: [],
//       lastUpdate: new Date(),
//       confirmationTicks: state.confirmationTicks,
//       lastPriceDirection: state.lastPriceDirection,
//       signal: state.signal,
//     } as BotInstance;
//   }

//   /**
//    * Deserialize position from storage
//    */
//   private deserializePosition(state: Position): Position {
//     return {
//       symbol: state.symbol,
//       entryPrice: state.entryPrice,
//       amount: state.amount,
//       remainingAmount: state.remainingAmount,
//       stopLoss: state.stopLoss,
//       takeProfit: state.takeProfit,
//       entryTime: new Date(state.entryTime),
//       strategy: state.strategy,
//       partialsSold: state.partialsSold,
//       currentPrice: state.currentPrice,
//       pnlUsd: state.pnlUsd,
//       pnlPct: state.pnlPct,
//       positionId: state.positionId,
//       leverage: state.leverage,
//       notionalValue: state.notionalValue,
//       marginUsed: state.marginUsed,
//       side: state.side,
//       confidence: state.confidence,
//     } as Position;
//   }

//   /**
//    * Start auto-save (every 30 seconds)
//    */
//   startAutoSave(bot: FuturesTradingBot, intervalMs: number = 30000) {
//     this.autoSaveInterval = setInterval(() => {
//       this.saveState(bot);
//     }, intervalMs);

//     console.log(`✅ Auto-save enabled (every ${intervalMs / 1000}s)`);
//   }

//   /**
//    * Stop auto-save
//    */
//   stopAutoSave() {
//     if (this.autoSaveInterval) {
//       clearInterval(this.autoSaveInterval);
//       this.autoSaveInterval = null;
//     }
//   }
// }

// ============================================================================
// BOT MANAGER
// ============================================================================

class FuturesTradingBot {
  private totalCapital = 600;
  private allocatedCapital = 0;
  private signalReader: EnhancedSignalReader;
  protected tradeCounters = {
    total: 0, // Total completed trades
    today: 0, // Trades today
    perSymbol: new Map<string, number>(), // Trades per symbol
    sessionStart: new Date(),
  };
  // private priceSimulator: PriceSimulator;
  private symbolCooldowns: Map<string, CooldownInfo> = new Map();
  private consecutiveLosses: Map<string, number> = new Map();
  // ⚙️ Cooldown configuration
  private readonly COOLDOWN_AFTER_LOSS = 2 * 60 * 60 * 1000; // 2 hours (cigar break)
  private readonly COOLDOWN_AFTER_2_LOSSES = 4 * 60 * 60 * 1000; // 4 hours (wine time)
  private readonly COOLDOWN_AFTER_3_LOSSES = 8 * 60 * 60 * 1000; // 8 hours (sleep it off)
  private readonly BIG_LOSS_THRESHOLD = 5; // $5 USDT
  private readonly COOLDOWN_AFTER_BIG_LOSS = 6 * 60 * 60 * 1000; // 6 hours (therapy)
  private bots: Map<string, BotInstance> = new Map();
  private tradeHistory: CompletedTrade[] = [];
  private signalCheckInterval: NodeJS.Timeout | null = null;
  private dashboardInterval: NodeJS.Timeout | null = null;
  private priceUpdateInterval: NodeJS.Timeout | null = null;
  private persistence: FuturesPersistence;
  private priceFetcher: PriceFetcher;
  private priceCache: PriceCache;
  private maxHistorySize = 50;
  // ✅ ADD: Session-wide stats tracking
  private sessionStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalFees: 0,
  };

  // ✅ ADD: Capital tracking
  private capitalAllocated = 0;

  constructor() {
    this.signalReader = new EnhancedSignalReader();
    this.persistence = new FuturesPersistence('./data/futures-bot-state.json');
    this.priceFetcher = new PriceFetcher();
    this.priceCache = new PriceCache();
    this.loadCooldowns();
    // Start daily reset timer if enabled
    if (configForLogging.resetTradeCountDaily) {
      this.startDailyReset();
    }
    // this.priceSimulator = new PriceSimulator();
  }

  /**
   * ✅ Check if bot should stop due to trade limits
   */
  private checkTradeLimits(): { shouldStop: boolean; reason: string } {
    // Check 1: Total trade limit
    if (
      CONFIG.maxTotalTrades &&
      this.tradeCounters.total >= CONFIG.maxTotalTrades
    ) {
      return {
        shouldStop: true,
        reason: `Reached max total trades (${CONFIG.maxTotalTrades})`,
      };
    }

    // Check 2: Daily trade limit
    if (
      configForLogging.maxTradesPerDay &&
      this.tradeCounters.today >= CONFIG.maxTradesPerDay
    ) {
      return {
        shouldStop: true,
        reason: `Reached max daily trades (${CONFIG.maxTradesPerDay})`,
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

    // Cooldown expired - remove it
    this.symbolCooldowns.delete(symbol);
    this.consecutiveLosses.delete(symbol);

    log(`✅ ${symbol} cooldown expired - ready to trade again!`, 'success');

    return { canTrade: true };
  }

  // ════════════════════════════════════════════════════════════════
  // HANDLE POSITION CLOSE (APPLY COOLDOWN IF NEEDED)
  // ════════════════════════════════════════════════════════════════

  private async onPositionClosed(position: Position): Promise<void> {
    const symbol = position.symbol;
    const pnl = position.pnlUsd;

    // ✅ WIN - Reset consecutive losses
    if (pnl > 0) {
      log(`✅ ${symbol} WIN - Resetting cooldown counter`, 'success');
      this.consecutiveLosses.delete(symbol);
      this.symbolCooldowns.delete(symbol);
      return;
    }

    // ❌ LOSS - Apply cooldown
    const consecutiveCount = (this.consecutiveLosses.get(symbol) || 0) + 1;
    this.consecutiveLosses.set(symbol, consecutiveCount);

    let cooldownDuration: number;
    let reason: CooldownInfo['reason'];
    let emoji: string;
    let message: string;

    // Determine cooldown based on situation
    if (Math.abs(pnl) >= this.BIG_LOSS_THRESHOLD) {
      // 😤 BIG LOSS - Long cooldown
      cooldownDuration = this.COOLDOWN_AFTER_BIG_LOSS;
      reason = 'BIG_LOSS';
      emoji = '😤';
      message = `BIG LOSS (${pnl.toFixed(2)} USDT) - Go to therapy`;
    } else if (consecutiveCount >= 3) {
      // 😴 3+ LOSSES - Sleep it off
      cooldownDuration = this.COOLDOWN_AFTER_3_LOSSES;
      reason = 'CONSECUTIVE_LOSSES';
      emoji = '😴';
      message = `${consecutiveCount} losses in a row - Sleep it off`;
    } else if (consecutiveCount === 2) {
      // 🍷 2 LOSSES - Wine time
      cooldownDuration = this.COOLDOWN_AFTER_2_LOSSES;
      reason = 'CONSECUTIVE_LOSSES';
      emoji = '🍷';
      message = `${consecutiveCount} losses in a row - Have some wine`;
    } else {
      // 🚬 1 LOSS - Cigar break
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
    // Increment total
    this.tradeCounters.total++;

    // Increment today
    this.tradeCounters.today++;

    // Increment per-symbol
    const symbolCount = this.tradeCounters.perSymbol.get(trade.symbol) || 0;
    this.tradeCounters.perSymbol.set(trade.symbol, symbolCount + 1);

    // Log current counts
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

    // Check if limits reached
    const limitCheck = this.checkTradeLimits();
    if (limitCheck.shouldStop) {
      console.log(`\n🛑 TRADE LIMIT REACHED: ${limitCheck.reason}`);

      if (configForLogging.stopOnLimit) {
        this.handleTradeLimitReached(limitCheck.reason);
      }
    }
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

    // Print final stats
    this.printFinalStats();

    // Save and exit
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

    // Per-symbol breakdown
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

      // Schedule next reset
      this.startDailyReset();
    }, msUntilMidnight);

    console.log(`⏰ Daily reset scheduled for ${tomorrow.toLocaleString()}`);
  }

  /**
   * ✅ MODIFIED: Close position and update counters
   */
  async closePosition(
    bot: BotInstance,
    reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL'
  ): Promise<void> {
    // ... your existing close position logic ...

    if (!bot.position) {
      console.error(`❌ No position to close for ${bot.symbol}`);
      return;
    }

    const position = bot.position as Position;

    const currentPrice = await this.priceFetcher.getCurrentPrice(bot.symbol);
    if (!currentPrice) {
      console.error(`❌ Cannot get price for ${bot.symbol}`);
      return;
    }

    // Calculate PnL based on position side
    const priceChange =
      position.side === 'LONG'
        ? currentPrice - position.entryPrice
        : position.entryPrice - currentPrice;

    const rawPnl = priceChange * position.amount;
    const finalPnlUsd = rawPnl * (position.leverage || 1);
    const finalPnlPct = (finalPnlUsd / (position.marginUsed || 0)) * 100;
    const duration = Date.now() - position.entryTime.getTime();
    const isWin = finalPnlUsd > 0;

    const trade: CompletedTrade = {
      symbol: bot.symbol,
      strategy: position.strategy,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice, // Use current price as exit price
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      amount: position.amount,
      pnlUsd: finalPnlUsd,
      pnlPct: finalPnlPct,
      duration,
      exitReason: reason,
      entryTime: position.entryTime,
      exitTime: new Date(),
      isWin,
      leverage: position.leverage || 1,
      marginUsed: position.marginUsed || 0,
      rawPnl, // Optional property if defined in interface
    };

    // Add to history
    this.tradeHistory.unshift(trade);

    // ✅ NEW: Update trade counters
    this.updateTradeCounters(trade);

    // Release capital
    if (!position.marginUsed) return;
    releaseCapital(position.marginUsed);

    // Clear position
    bot.position = null;
  }

  /**
   * ✅ MODIFIED: Check limits before opening position
   */
  async openPosition(bot: BotInstance, signal: EntrySignal): Promise<void> {
    // ✅ NEW: Check if bot should stop
    const limitCheck = this.checkTradeLimits();
    if (limitCheck.shouldStop) {
      console.log(`⚠️ Cannot open position: ${limitCheck.reason}`);
      return;
    }

    // ✅ NEW: Check symbol-specific limit
    const symbolCheck = this.canTradeSymbol(signal.symbol);
    if (!symbolCheck.canTrade) {
      console.log(`⚠️ Cannot trade ${signal.symbol}: ${symbolCheck.reason}`);
      return;
    }

    // ... rest of your existing open position logic ...
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
        ? configForLogging.maxTotalTrades - this.tradeCounters.total
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

    // Test a specific symbol
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
      // Step 1: Try to get prices from scanner
      const priceMap = await this.getPricesFromScanner();
      console.log(`📊 Got ${priceMap.size} prices from scanner`);
      // Step 2: For any missing symbols, fetch from exchange
      const bots = Array.from(this.bots.values());
      const missingSymbols: string[] = [];

      for (const bot of bots) {
        if (!priceMap.has(bot.symbol)) {
          const cachedPrice = this.priceCache.getPrice(bot.symbol);
          if (cachedPrice) {
            priceMap.set(bot.symbol, cachedPrice);
            // console.log(`💾 Using cached price for ${bot.symbol}: $${cachedPrice}`);
          } else {
            missingSymbols.push(bot.symbol);
          }
        }
      }

      console.log(
        `🔍 Missing symbols: ${missingSymbols.length}`,
        missingSymbols
      ); // ✅ ADD THIS

      // if (missingSymbols.length > 0) {
      //   console.log(
      //     `🔍 Fetching ${missingSymbols.length} ${missingSymbols} missing prices from exchange...`
      //   );
      //   const exchangePrices =
      //     await this.priceFetcher.getMultiplePrices(missingSymbols);

      //   // Merge exchange prices into map
      //   exchangePrices.forEach((price, symbol) => {
      //     priceMap.set(symbol, price);
      //   });

      //   // ✅ SAVE FETCHED PRICES TO CACHE
      //   if (exchangePrices.size > 0) {
      //     // ✅ ADD THIS CHECK
      //     console.log(`💾 About to cache ${exchangePrices.size} prices...`); // ✅ ADD THIS
      //     this.priceCache.setPrices(exchangePrices);
      //   } else {
      //     console.log(`⚠️ No prices to cache`); // ✅ ADD THIS
      //     console.log(`💾 About to cache ${exchangePrices.size} prices...`);
      //   }
      // }

      if (missingSymbols.length > 0) {
        console.log(
          `🔍 Fetching ${missingSymbols.length} missing prices from exchange...`
        );

        try {
          const exchangePrices =
            await this.priceFetcher.getMultiplePrices(missingSymbols);
          console.log(`✅ Fetched ${exchangePrices.size} prices from exchange`);

          if (exchangePrices.size > 0) {
            this.priceCache.setPrices(exchangePrices);
          }
        } catch (error: any) {
          console.error(`❌ Exchange fetch error:`, error);
          console.error(`   Message: ${error.message}`);
          console.error(`   Stack: ${error.stack}`);
        }
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

  /**
   * ✅ UPDATED: Initialize method with better restore logic
   */
  async initialize(): Promise<void> {
    validateConfig();
    log('🚀 Initializing Futures Trading Bot...', 'info');

    // ✅ Try to restore previous state
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

    // ✅ NEW: Sync signal state with restored bots
    console.log('🔄 Syncing signal states with active positions...');
    const activeBotSymbols = new Set(Array.from(this.bots.keys()));

    // Get all IN_TRADE signals
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
  }

  /**
   * ✅ NEW: Helper method to update a bot with a price
   */
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

  private async createBot(signal: EntrySignal): Promise<BotInstance | null> {
    // ✅ CHECK COOLDOWN FIRST
    const cooldownCheck = this.canTradeSymbol(signal.symbol);

    if (!cooldownCheck.canTrade) {
      log(`⏰ ${cooldownCheck.reason}`, 'warning');
      return null;
    }
    if (!signal || !signal.entryPrice) {
      throw new Error('Invalid signal: missing entryPrice');
    }
    const symbol = signal.symbol;

    // const ticker = await binance.fetchTicker(symbol);

    // const curPrice = this.priceFetcher.getCurrentPrice(symbol);

    // console.log(`\n📊 ${signal.symbol} Position Setup:`);
    // console.log(`   Entry: $${signal.entryPrice}`);
    // console.log(
    //   `   Risk: ${((Math.abs(signal.entryPrice - signal.stopLoss) / signal.entryPrice) * 100).toFixed(2)}%`
    // );
    // console.log(
    //   `   Reward: ${((Math.abs(signal.takeProfit - signal.entryPrice) / signal.entryPrice) * 100).toFixed(2)}%`
    // );
    // console.log(
    //   `   R:R = 1:${(Math.abs(signal.takeProfit - signal.entryPrice) / Math.abs(signal.entryPrice - signal.stopLoss)).toFixed(2)}`
    // );

    // log(`✅ ${signal.symbol} - Cooldown clear, creating bot...`, 'success');

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
      confirmationTicks: 0,
      lastPriceDirection: 0,
    };

    this.bots.set(signal.symbol, bot);

    // ✅ Mark signal as taken IMMEDIATELY
    // this.signalReader.markSignalAsTaken(
    //   signal.symbol,
    //   generateId(),
    //   signal.entryPrice
    // );

    log(
      `🤖 Bot created for ${signal.symbol} (${signal.strategy}, confidence: ${signal.confidence}%)`,
      'success'
    );
    console.log(
      '🥑 ~ FuturesTradingBot ~ createBot ~ bot.signal.stopLoss:',
      bot.signal?.stopLoss
    );
    console.log(
      '🥑 ~ FuturesTradingBot ~ createBot ~ bot.signal.takeProfit:',
      bot.signal?.takeProfit
    );

    // Enter position after delay
    // setTimeout(() => {
    //   if (!bot.position && bot.signal && bot.signal.entryPrice) {
    //     this.enterPosition(
    //       bot,
    //       bot.signal.side,
    //       bot.signal.entryPrice,
    //       bot.signal.strategy,
    //       bot.signal.stopLoss,
    //       bot.signal.takeProfit
    //     );
    //   }
    // }, 1000);

    // ✅ FIX: Mark as IN_TRADE only AFTER successful entry
    setTimeout(async () => {
      if (
        !bot.position &&
        bot.signal &&
        bot.signal.entryPrice &&
        signal.entryPrice
      ) {
        // Get current price
        const currentPrice = await this.priceFetcher.getCurrentPrice(
          signal.symbol
        );

        if (!currentPrice) {
          log(`❌ Cannot get price for ${signal.symbol}`, 'error');
          this.bots.delete(signal.symbol);
          return;
        }

        // Check slippage
        const slippage = Math.abs(
          ((currentPrice - signal.entryPrice) / signal.entryPrice) * 100
        );

        if (slippage > configForLogging.maxSlippagePercent) {
          log(
            `⚠️ ${signal.symbol} slippage too high (${slippage.toFixed(2)}%)`,
            'warning'
          );
          this.bots.delete(signal.symbol);
          return;
        }

        // Enter position
        this.enterPosition(
          bot,
          bot.signal.side,
          currentPrice,
          bot.signal.strategy,
          bot.signal.stopLoss!,
          bot.signal.takeProfit!
        );

        // ✅ FIX: Mark as IN_TRADE only AFTER successful entry
        if (bot.position) {
          // Type assertion
          const position = bot.position as Position;
          this.signalReader.markSignalAsTaken(
            signal.symbol,
            position.positionId,
            position.entryPrice
          );
          log(`✅ ${signal.symbol} marked as IN_TRADE`, 'success');
          console.log(
            '🥑 ~ FuturesTradingBot ~ createBot ~ ticker:',
            currentPrice
          );
        } else {
          log(`❌ ${signal.symbol} failed to enter position`, 'error');
          console.log(
            '🥑 ~ FuturesTradingBot ~ createBot ~ ticker:',
            currentPrice
          );

          this.bots.delete(signal.symbol);
        }
      }
    }, 1000);

    return bot;
  }

  // ════════════════════════════════════════════════════════════════
  // DISPLAY COOLDOWN STATUS
  // ════════════════════════════════════════════════════════════════

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

  // ════════════════════════════════════════════════════════════════
  // CLEANUP EXPIRED COOLDOWNS (Run periodically)
  // ════════════════════════════════════════════════════════════════

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

  // ════════════════════════════════════════════════════════════════
  // EMERGENCY: CLEAR ALL COOLDOWNS
  // ════════════════════════════════════════════════════════════════

  private clearAllCooldowns(): void {
    const count = this.symbolCooldowns.size;
    this.symbolCooldowns.clear();
    this.consecutiveLosses.clear();
    log(
      `🔥 Cleared ${count} cooldown(s) - All symbols ready to trade`,
      'warning'
    );
  }

  // ════════════════════════════════════════════════════════════════
  // SAVE/LOAD COOLDOWNS (Persist across restarts)
  // ════════════════════════════════════════════════════════════════

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

        // Only load if not expired
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

  private checkEntryCondition(bot: BotInstance, currentPrice: number) {
    if (bot.position || !bot.signal || !bot.signal.entryPrice) return;

    const signal = bot.signal as EntrySignal;

    if (!signal) {
      throw new Error('No Signal');
    }

    const signalPrice = signal?.entryPrice;

    const priceDiff =
      signalPrice &&
      Math.abs(((currentPrice - signalPrice) / signalPrice) * 100);

    if (priceDiff && priceDiff > configForLogging.maxSlippagePercent) {
      return;
    }

    if (
      configForLogging.requirePriceConfirmation &&
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
        bot.confirmationTicks < configForLogging.confirmationTicks
      ) {
        log(
          `⏳ ${bot.symbol}: Waiting for confirmation (${bot.confirmationTicks}/${configForLogging.confirmationTicks})`,
          'info'
        );
        return;
      }
    }

    this.enterPosition(
      bot,
      signal.side,
      currentPrice,
      signal.strategy,
      signal.stopLoss!,
      signal.takeProfit!
    );
  }

  private enterPosition(
    bot: BotInstance,
    side: EntryType,
    price: number,
    strategy: StrategyId,
    stopLoss: number,
    takeProfit: number
  ): boolean {
    if (bot.position) return false;

    console.log(`🔍 ${bot.symbol} Entry Validation:`);
    console.log(`   Entry Price: $${price}`);
    console.log(`   Stop Loss: $${stopLoss}`);
    console.log(`   Take Profit: $${takeProfit}`);
    console.log(`\n📊 ${bot.symbol} Position Setup:`);
    console.log(`   Entry: $${price}`);
    console.log(
      `   Risk: ${((Math.abs(price - stopLoss) / price) * 100).toFixed(2)}%`
    );
    console.log(
      `   Reward: ${((Math.abs(takeProfit - price) / price) * 100).toFixed(2)}%`
    );
    console.log(
      `   R:R = 1:${(Math.abs(takeProfit - price) / Math.abs(price - stopLoss)).toFixed(2)}`
    );

    // Position size in USDT (e.g., $100)
    const positionSizeUSD = configForLogging.positionSize;

    // With leverage (e.g., $100 * 3x = $300 notional value)
    const notionalValue = positionSizeUSD * configForLogging.leverageMultiplier;

    // Token quantity = Notional Value / Entry Price
    // Example: $300 / $43,250 (BTC price) = 0.00693641 BTC
    const tokenQuantity = notionalValue / price;

    // Margin required (actual capital used)
    const marginRequired = positionSizeUSD; // Without leverage multiplier

    // if (this.allocatedCapital + notionalValue > this.totalCapital) {
    //   log(`❌ Insufficient capital: ${this.allocatedCapital + notionalValue} > ${this.totalCapital}`, 'error');
    //   return;
    // }

    if (!reserveCapital(marginRequired)) {
      log('❌ Insufficient capital to open position', 'error');
      return false;
    }

    console.log(`💰 Position Sizing:`);
    console.log(`   Margin: $${marginRequired.toFixed(2)}`);
    console.log(`   Leverage: ${configForLogging.leverageMultiplier}x`);
    console.log(`   Notional Value: $${notionalValue.toFixed(2)}`);
    console.log(`   Token Quantity: ${tokenQuantity.toFixed(8)} ${bot.symbol}`);

    bot.position = {
      side,
      entryPrice: price,
      currentPrice: price,
      amount: tokenQuantity, // ✅ FIXED: This is the token quantity, not USD
      remainingAmount: tokenQuantity, // ✅ For tracking partials
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
    return true;
  }

  private updatePosition(bot: BotInstance, currentPrice: number) {
    if (!bot.position) return;

    const pos = bot.position;
    const oldPrice = pos.currentPrice;
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

  private exitPosition(bot: BotInstance, reason: string) {
    if (!bot.position) return;
    console.log(`🔍 exitPosition called for ${bot.symbol}, reason: ${reason}`);
    const pos = bot.position;
    // console.log('🥑 ~ FuturesTradingBot ~ exitPosition ~ pos:', pos);
    const marginUsed = pos.marginUsed || CONFIG.positionSize;
    const pnl = pos.pnlUsd;
    // ✅ Use the CURRENT price as exit price (should be most recent)
    const exitPrice = pos.currentPrice;
    const entryPrice = pos.entryPrice;
    const tokenQuantity = pos.amount;
    const leverage = pos.leverage || CONFIG.leverageMultiplier;

    // const marginUsed = pos.marginUsed || CONFIG.positionSize;

    console.log(`\n🔍 EXIT POSITION CALCULATION for ${bot.symbol}:`);
    console.log(`   Side: ${pos.side}`);
    console.log(`   Entry Price: $${entryPrice.toFixed(6)}`);
    console.log(`   Exit Price: $${exitPrice.toFixed(6)}`);
    console.log(`   Token Quantity: ${tokenQuantity.toFixed(8)}`);
    console.log(`   Leverage: ${leverage}x`);
    console.log(`   Margin Used: $${marginUsed.toFixed(2)}`);

    // ============================================================================
    // STEP 1: Calculate price change based on position side
    // ============================================================================
    let priceChange = 0;

    if (pos.side === 'LONG') {
      priceChange = exitPrice - entryPrice;
    } else {
      priceChange = entryPrice - exitPrice;
    }

    console.log(
      `   Price Change: $${priceChange.toFixed(6)} (${((priceChange / entryPrice) * 100).toFixed(2)}%)`
    );

    // ============================================================================
    // STEP 2: Calculate RAW PnL (before leverage)
    // ============================================================================
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

    // ✅ Increment counter
    this.tradeCounters.total++;
    bot.trades++;

    console.log(
      `📊 Completed: ${this.tradeCounters.total}/${CONFIG.maxTotalTrades}`
    );

    // ✅ Check limit
    if (this.tradeCounters.total >= CONFIG.maxTotalTrades) {
      console.log('🏁 TRADE LIMIT REACHED! Stopping...');
      this.persistence.saveState(
        this as unknown as BaseTradingBot<FuturesBotInstance>,
        configForLogging
      );
      setTimeout(() => process.exit(0), 1000);
    }
    const isWin = finalPnlUsd > 0;

    // ✅ FIX: Reclassify exit reason based on actual result
    let finalExitReason = reason as ReasonType;

    if (reason === 'STOP_LOSS' && isWin) {
      // If marked as SL but actually profitable, it was likely a TP or favorable exit
      finalExitReason = 'TAKE_PROFIT';
    } else if (reason === 'TAKE_PROFIT' && !isWin) {
      // If marked as TP but actually a loss, it was likely a SL
      finalExitReason = 'STOP_LOSS';
    }

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
      stopLoss: pos.stopLoss, // ← Add this
      takeProfit: pos.takeProfit,
      amount: tokenQuantity,
      pnlUsd: finalPnlUsd, // ✅ Use calculated leveraged PnL
      pnlPct: finalPnlPct, // ✅ Use calculated PnL %
      duration,
      exitReason: finalExitReason,
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
  }

  private async checkForNewSignals() {
    const signals = this.signalReader.readLatestSignals();

    if (signals.length === 0) return;

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

    // Release signal back to available pool
    this.signalReader.releaseSignal(signal.symbol);
  }

  private printDashboard() {
    const utilization = getCapitalUtilization();

    const counters = this.getTradeCounters();

    const bot = new FuturesTradingBot();

    if (process.argv.includes('--debug-cooldown')) {
      bot.debugCooldownSystem();
    }

    console.log(colorize('📊 TRADE LIMITS', colors.brightYellow));
    console.log(
      `  Total Trades: ${counters.total}/${counters.maxTotal === Infinity ? '∞' : counters.maxTotal} ` +
        `(${counters.remaining === Infinity ? '∞' : counters.remaining} remaining)`
    );
    console.log(
      `  Today's Trades: ${counters.today}/${counters.maxToday === Infinity ? '∞' : counters.maxToday}`
    );

    // Warning colors
    if (counters.remaining <= 1 && counters.remaining !== Infinity) {
      console.log(
        colorize('  ⚠️ WARNING: Only 1 trade remaining!', colors.red)
      );
    }

    console.log(colorize('─'.repeat(140), colors.gray));

    console.log(
      `Capital Utilization: ${utilization.utilizationPercent.toFixed(1)}%`
    );
    console.log(
      `Available: $${CONFIG.availableCapital.toFixed(2)}/$${CONFIG.totalCapital.toFixed(2)}`
    );
    try {
      console.clear();
      console.log(colorize('═'.repeat(140), colors.cyan));
      console.log(
        colorize(
          '  🤖 FUTURES TRADING BOT - SIGNAL-DRIVEN EXECUTION  ',
          colors.brightCyan
        )
      );
      console.log(colorize('═'.repeat(140), colors.cyan));

      const totalBots = this.bots.size;
      const activePos = Array.from(this.bots.values()).filter(
        (b) => b.position
      ).length;

      // ✅ FIX: Separate realized and unrealized PnL
      const totalRealizedPnL = Array.from(this.bots.values()).reduce(
        (s, b) => s + (b?.sessionPnl || 0),
        0
      );

      const totalUnrealizedPnL = Array.from(this.bots.values())
        .filter((b) => b.position)
        .reduce((sum, b) => sum + (b.position?.pnlUsd || 0), 0);

      // const totalPnL = totalRealizedPnL + totalUnrealizedPnL;

      // ✅ FIX: Completed trades only (not including active positions)
      const completedTrades = Array.from(this.bots.values()).reduce(
        (s, b) => s + b.trades,
        0
      );

      const totalWins = Array.from(this.bots.values()).reduce(
        (s, b) => s + (b?.wins || 0),
        0
      );

      const totalLosses = Array.from(this.bots.values()).reduce(
        (s, b) => s + (b?.losses || 0),
        0
      );

      // ✅ FIX: Win rate based on COMPLETED trades only
      const winRate =
        completedTrades > 0
          ? ((totalWins / completedTrades) * 100).toFixed(1)
          : '0.0';

      const totalCompletedTrades = this.tradeHistory.length;
      const winCount = this.tradeHistory.filter(
        (trade) => trade.isWin === true
      ).length;
      const lossCount = this.tradeHistory.filter(
        (trade) => trade.isWin === false
      ).length;
      const totRealizedPnl = this.tradeHistory.reduce(
        (s, b) => s + b.pnlUsd,
        0
      );

      const totPnL = totRealizedPnl + totalUnrealizedPnL;

      const winRates =
        totalCompletedTrades > 0 ? (winCount / totalCompletedTrades) * 100 : 0;
      // Display summary
      console.log(
        `Positions: ${activePos} | Completed Trades: ${totalCompletedTrades}`
      );
      console.log(
        `Unrealized PnL: ${colorPnL(totalUnrealizedPnL)} | Realized PnL: ${colorPnL(totRealizedPnl)} | TotalPnL: ${colorPnL(totPnL)}`
      );

      // ✅ CAPITAL TRACKING
      const usedMargin = activePos * configForLogging.positionSize;
      const availableMargin = configForLogging.availableCapital - usedMargin;
      const totalExposure =
        activePos *
        configForLogging.positionSize *
        configForLogging.leverageMultiplier;
      const currentEquity = configForLogging.totalCapital + totPnL;
      const equityPct =
        (currentEquity / configForLogging.totalCapital - 1) * 100;

      console.log(
        `  💰 Capital: $${configForLogging.totalCapital} | Equity: $${currentEquity.toFixed(2)} (${colorPnL(equityPct, true)}) | ` +
          `Margin Used: $${colorize(usedMargin.toFixed(2), colors.yellow)}/${configForLogging.availableCapital.toFixed(2)} | ` +
          `Free: $${availableMargin.toFixed(2)} | Exposure: $${totalExposure.toFixed(2)}`
      );

      console.log(
        `  Active Bots: ${totalBots} | Positions: ${activePos}/${configForLogging.maxConcurrentPositions} | ` +
          `Win Rate: ${winRates}% (${winCount}W/${lossCount}L)`
      );

      const signalStats = this.signalReader.getStats(this.bots);
      // console.log(
      //   '🥑 ~ FuturesTradingBot ~ printDashboard ~ signalStats:',
      //   signalStats
      // );
      console.log(
        `  Available Signals: ${signalStats.totalSignals} | ` +
          `Long: ${signalStats.longSignals} | Short: ${signalStats.shortSignals} | ` +
          `In Trade: ${colorize(signalStats.inTrade.toString(), colors.orange)} | ` + // ✅ New
          `Completed: ${signalStats.completed} | ` + // ✅ New
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
          const symbol = (bot.symbol || 'UNKNOWN_SYMBOL').toString();
          const side = (p.side || 'UNKNOWN_SIDE').toString();
          const strategy = (p.strategy || 'UNKNOWN_STRATEGY').toString(); // ✅ FIX: Use strategyId
          const entryPrice = p.entryPrice || 0;
          const currentPrice = p.currentPrice || 0;
          const pnlPct = p.pnlPct || 0;
          const pnlUsd = p.pnlUsd || 0;
          const stopLoss = p.stopLoss || 0;
          const takeProfit = p.takeProfit || 0;
          const confidence = p.confidence || 0;
          const amount = p.amount || 0;

          const positionSize = configForLogging.positionSize;
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
                : colors.pink + colors.bgMaroon + colors.bright;

          const pnlPctStr = colorPnL(pnlPct, true);
          const pnlUsdStr = colorPnL(pnlUsd);
          const amountDes = getAmountDecimals(amount, currentPrice);
          const curPriceDigit = currentPrice.toString().length;
          const sideDigit = side.length;
          console.log(
            `  ${colorize(symbol.padEnd(10), colors.cyan)} ` +
              `${colorize(side.padEnd(sideDigit), sideColor)}    ` +
              `${colorize(strategy.padEnd(16), colors.brightOrange)} ` +
              `Entry: ${colorize(entryPrice.toFixed(curPriceDec).padEnd(curPriceDigit), colors.bgBlue + colors.brightWhite)} ` +
              `Amount/tokenQty: ${colorize(amount.toFixed(amountDes).padEnd(amountDes), rgb(177, 54, 0) + colors.bgBrightYellow)} ` +
              `Current: ${colorize(currentPrice.toFixed(curPriceDec).padEnd(curPriceDigit), currentColor)} ` +
              `PnL: ${pnlPctStr} ${pnlUsdStr} ` +
              `Time: ${colorize(duration.toFixed(0) + 'm', colors.brightGreen)} ` +
              `Conf: ${colorize(confidence.toFixed(1) + '%', colors.blink + colors.white)}`
          );

          console.log(
            `  ${colorize('SL:', colors.gray)} ${stopLoss.toFixed(curPriceDec)} | ` +
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
          const strategy = (signal.strategy || 'UNKNOWN_STRATEGY').toString();
          const side = (signal.side || 'UNKNOWN_SIDE').toString();
          const confidence = signal.confidence || 0;
          const price = signal.entryPrice || 0; // ✅ FIX: Use signal.price not signal.entryPrice

          console.log(
            `  ${symbol.padEnd(12)} ${strategy.padEnd(18)} ` +
              `${side.padEnd(6)} Confidence: ${confidence.toFixed(1)}% ` +
              `Target: $${price.toFixed(6)}`
          );
        });
        console.log(colorize('─'.repeat(140), colors.gray));
      }

      // Trade History
      // console.log(
      //   '🥑 ~ FuturesTradingBot ~ printDashboard ~ this.tradeHistory:',
      //   JSON.stringify(this.tradeHistory, null, 2)
      // );
      if (this.tradeHistory.length > 0) {
        console.log(
          colorize('📜 RECENT TRADES (Last 30)', colors.brightYellow)
        );
        this.tradeHistory.slice(0, 30).forEach((trade) => {
          if (!trade) return;

          const symbol = (trade.symbol || 'UNKNOWN_SYMBOL').toString();
          const side = (trade.side || 'UNKNOWN').padEnd(6);
          const strategy = (trade.strategy || 'UNKNOWN_STRATEGY').toString();
          const isWin = trade.isWin || false;
          const tradeSide = trade.side;
          const entryPrice = trade.entryPrice || 0;
          const exitPrice = trade.exitPrice || 0;
          const pnlPct = trade.pnlPct || 0;
          const pnlUsd = trade.pnlUsd || 0;
          const duration = trade.duration || 0;
          const exitReason = trade.exitReason || 'UNKNOWN_REASON';
          const icon = isWin ? '✅ WIN' : '❌ LOSS';
          const stopLoss = trade.stopLoss || 0;
          const takeProfit = trade.takeProfit || 0;
          const exitColor =
            isWin || trade.exitReason === 'TAKE_PROFIT'
              ? colors.green
              : colors.red;
          const rawPnl = trade.rawPnl || trade.pnlUsd / (trade.leverage || 3);
          const leveragedPnl = trade.pnlUsd;
          const leverage = trade.leverage || 3;
          const pnlPctStr = colorPnL(pnlPct, true);
          const pnlUsdStr = colorPnL(pnlUsd);
          const curPriceDec = getPriceDecimals(entryPrice);

          console.log(
            `  ${icon.padEnd(10)} ${symbol.padEnd(12)} ${strategy.padEnd(12)} ${tradeSide.padEnd(6)}` +
              `${pnlPctStr.padEnd(10)} ${pnlUsdStr.padEnd(12)} ` +
              `SL: ${colorize(stopLoss.toFixed(curPriceDec), colors.brightMaroon + colors.bgLightGray)} TP:${colorize(takeProfit.toFixed(curPriceDec), colors.brightLime)} ` +
              `Raw: ${colorPnL(rawPnl)} × ${leverage}x = ${leveragedPnl.toFixed(2)} ` +
              `Entry: ${colorize(entryPrice.toFixed(curPriceDec), colors.lightGreen)} Exit: ${colorize(exitPrice.toFixed(curPriceDec), exitColor)} ` +
              `${Math.floor(duration / 60000)}m ${colorize(exitReason, exitColor)}`
          );
        });
        console.log(colorize('─'.repeat(140), colors.gray));
      }

      // ✅ FIX: Session Summary with correct stats
      console.log(colorize('📊 SESSION SUMMARY', colors.brightYellow));
      console.log(
        `  Completed Trades: ${totalCompletedTrades} | ` +
          `Wins: ${winCount} | ` +
          `Losses: ${lossCount} | ` +
          `Win Rate: ${winRates}%`
      );
      console.log(
        `  Unrealized PnL: ${colorPnL(totalUnrealizedPnL)} | ` +
          `Realized PnL: ${colorPnL(totRealizedPnl)} | ` +
          `Total PnL: ${colorPnL(totPnL)}`
      );
      console.log(colorize('─'.repeat(140), colors.gray));

      console.log(
        colorize('Commands: (r)efresh signals | (q)uit', colors.gray)
      );
      console.log(colorize('═'.repeat(140), colors.cyan));
    } catch (err: any) {
      console.error(colorize(`❌ Dashboard error: ${err.message}`, colors.red));
      console.error(err.stack);
    }
  }

  private restoreState(bot: FuturesTradingBot, state: BotState): void {
    // ... restore existing state ...

    // ✅ NEW: Restore counters
    if (state.tradeCounters) {
      bot.tradeCounters.total = state.tradeCounters.total;
      bot.tradeCounters.today = state.tradeCounters.today;
      bot.tradeCounters.perSymbol = new Map(
        Object.entries(state.tradeCounters.perSymbol)
      );
      bot.tradeCounters.sessionStart = new Date(
        state.tradeCounters.sessionStart
      );

      console.log(
        `♻️  Restored trade counters: ${bot.tradeCounters.total} total trades`
      );
    }
  }

  start() {
    this.signalCheckInterval = setInterval(() => {
      this.checkForNewSignals();
    }, configForLogging.signalCheckInterval);

    this.dashboardInterval = setInterval(() => {
      this.printDashboard();
    }, configForLogging.dashboardRefreshMs);

    // ✅ NEW: Add price update from scanner
    this.priceUpdateInterval = setInterval(async () => {
      await this.updatePricesFromScanner();
    }, 3000); // Update every 3 seconds (scanner updates every 30s)

    this.persistence.startAutoSave(
      this as unknown as BaseTradingBot<FuturesBotInstance>,
      configForLogging
    );

    // ✅ CRITICAL: Update prices immediately on start
    setTimeout(async () => {
      await this.updatePricesFromScanner();
    }, 500);

    this.checkForNewSignals();
    setTimeout(() => this.printDashboard(), 1000);
  }

  stop() {
    if (this.signalCheckInterval) clearInterval(this.signalCheckInterval);
    if (this.dashboardInterval) clearInterval(this.dashboardInterval);
    if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval); // ✅ NEW

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

class PriceFetcher {
  private baseUrl = 'https://api.binance.com/api/v3';

  async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      // Convert symbol format (e.g., AAVE/USDT -> AAVEUSDT)
      const binanceSymbol = symbol.replace('/', '');

      const response = await fetch(
        `${this.baseUrl}/ticker/price?symbol=${binanceSymbol}`
      );
      const data = await response.json();

      if (data && data.price) {
        return parseFloat(data.price);
      }

      return null;
    } catch (err: any) {
      console.error(`Failed to fetch price for ${symbol}: ${err.message}`);
      return null;
    }
  }

  async getMultiplePrices(symbols: string[]): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();

    try {
      const binanceSymbols = symbols.map((s) => s.replace('/', ''));

      const promises = binanceSymbols.map(async (sym) => {
        try {
          const response = await fetch(
            `${this.baseUrl}/ticker/price?symbol=${sym}`
          );
          const data = await response.json();

          if (data && data.price) {
            // ✅ FIX 2: Store using the ORIGINAL format (without slash)
            priceMap.set(sym, parseFloat(data.price));
          }
        } catch (err: any) {
          console.error(`Failed to fetch ${sym}: ${err.message}`);
        }
      });

      // Batch request for multiple symbols

      await Promise.all(promises);
    } catch (err: any) {
      console.error(`Failed to fetch multiple prices: ${err.message}`);
    }

    return priceMap;
  }
}

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

process.on('uncaughtException', (err: any) => {
  log(`Exception: ${err.message}`, 'error');
});

main();
