import fs from 'fs';
import path from 'path';
import readline from 'readline';

import * as dotenv from 'dotenv';
import * as rfs from 'rotating-file-stream';
import { ATR, EMA, RSI } from 'technicalindicators';

import {
  colors,
  formatQuantity,
  generateId,
  getAmountDecimals,
  getPriceDecimals,
  normalize,
  rgb,
} from '../../lib/helpers.js';
import { LoggerFactory, type BotLogger } from '../../lib/logger.js';
import { detectRegime } from '../../lib/trading-utils.js';
import {
  LogLevel,
  type BotInstance,
  type BotState,
  type CompletedTrade,
  type EntrySignal,
  type HTFConfirmation,
  type Indicators,
  type Position,
  type ReasonType,
  type ScanResult,
  type SignalQueueItem,
  type SignalState,
  type StrategyId,
} from '../../lib/type.js';
import { CandleManager } from '../core/candles.js';
import { CONFIG, getConfigForSymbol, SYMBOL_CONFIGS } from './config-spot.js';

dotenv.config();

// const CONFIG = getConfigForSymbol(process.env.TRADING_SYMBOL || 'SOL/USDT');
const logger = LoggerFactory.getSpotLogger(CONFIG.SYMBOL);

const configForLogging = {
  ...CONFIG,
  availableCapital: CONFIG.availableCapital, // Explicitly call getter
  positionSize: CONFIG.positionSize, // Explicitly call getter
};

// ============================================================================
// CONFIGURATION
// ============================================================================

const SPOT_CONFIG = {
  signalFile: './signals/spot-signals.json',
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),
  minConfidence: 70,

  // Capital Management
  totalCapital: parseFloat(process.env.TOTAL_CAPITAL || '200'),
  capitalUtilization: 0.9,
  reserveRatio: parseFloat(process.env.RESERVE_RATIO || '0.10'),

  get availableCapital(): number {
    return this.totalCapital * (1 - this.reserveRatio);
  },

  get positionSize(): number {
    return this.availableCapital / this.maxConcurrentPositions;
  },

  // Signal Management
  signalCheckInterval: 30000,
  signalExpiryMs: 10 * 60 * 1000,

  // Risk Management
  maxSlippagePercent: 1.0,
  trailingStopEnabled: true,
  trailingStopPercent: 1.5,

  stopLossMultiplier: 1.0,
  takeProfitMultiplier: 1.0,

  // Dashboard
  dashboardRefreshMs: 3000,
  priceUpdateInterval: 2000,

  // Strategy Filters
  blockedStrategies: [] as StrategyId[],
  preferredStrategies: [
    'EMA_PULLBACK',
    'FIB_RETRACEMENT',
    'BREAKOUT',
    'RSI_DIVERGENCE',
  ] as StrategyId[],
};

// ============================================================================
// LIGHTWEIGHT SIGNAL READER (Enhanced)
// ============================================================================

// ============================================================================
// LIGHTWEIGHT SIGNAL READER
// ============================================================================

class LightweightSignalReader {
  private signalQueue: EntrySignal[] = [];
  private outputFile = './signals/futures-signals.json';
  private lastReadTime = 0;
  private readonly SIGNAL_EXPIRY_MS = configForLogging.signalExpiryMs;

  constructor() {
    this.checkFileExists();
  }

  private checkFileExists(): void {
    if (!fs.existsSync(this.outputFile)) {
      console.log(`⚠️  Scanner output not found: ${this.outputFile}`);

      const dir = './signals';
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
  private stateFile = './signals/signal-state.json';
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
// PRICE FETCHER
// ============================================================================

class PriceFetcher {
  private baseUrl = 'https://api.binance.com/api/v3';

  async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const binanceSymbol = symbol.replace('/', '');
      const response = await fetch(
        `${this.baseUrl}/ticker/price?symbol=${binanceSymbol}`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as BinanceTickerResponse;

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
      const response = await fetch(`${this.baseUrl}/ticker/price`);
      const data = await response.json();

      if (Array.isArray(data)) {
        data.forEach((ticker: any) => {
          if (ticker.symbol && ticker.price) {
            const normalSymbol = ticker.symbol.replace('USDT', '/USDT');
            priceMap.set(normalSymbol, parseFloat(ticker.price));
          }
        });
      }
    } catch (err: any) {
      console.error(`Failed to fetch multiple prices: ${err.message}`);
    }

    return priceMap;
  }
}

// ============================================================================
// PERSISTENCE
// ============================================================================

class BotPersistence {
  private stateFile: string;
  private backupFile: string;

  constructor(stateFile: string = './state/spot-bot-state.json') {
    this.stateFile = stateFile;
    this.backupFile = `${stateFile}.backup`;
    this.ensureDirectory();
  }

  private ensureDirectory() {
    const dir = path.dirname(this.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✅ Created state directory: ${dir}`);
    }
  }

  saveState(launcher: SpotTradingLauncher): void {
    try {
      const bots = launcher.getBots();

      const state: BotState = {
        version: '1.0.0',
        lastSave: new Date().toISOString(),
        totalCapital: SPOT_CONFIG.totalCapital,
        availableCapital: SPOT_CONFIG.availableCapital,
        bots: this.serializeBots(bots),
        tradeHistory: launcher.getTradeHistory().slice(0, 50),
      };

      if (fs.existsSync(this.stateFile)) {
        fs.copyFileSync(this.stateFile, this.backupFile);
      }

      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));

      console.log(
        `💾 State saved: ${bots.size} bots, ${state.tradeHistory.length} trades`
      );
    } catch (err: any) {
      console.error(`❌ Failed to save state: ${err.message}`);
    }
  }

  loadState(): BotState | null {
    try {
      if (!fs.existsSync(this.stateFile)) {
        console.log('ℹ️  No previous state found');
        return null;
      }

      const content = fs.readFileSync(this.stateFile, 'utf-8');
      const state: BotState = JSON.parse(content);

      console.log(`📂 State loaded from: ${state.lastSave}`);
      console.log(`   Bots: ${state.bots.length}`);
      console.log(`   Trade History: ${state.tradeHistory.length}`);
      console.log(`   Capital: $${state.totalCapital}`);

      return state;
    } catch (err: any) {
      console.error(`❌ Failed to load state: ${err.message}`);
      return null;
    }
  }

  restoreState(launcher: SpotTradingLauncher, state: BotState): void {
    try {
      SPOT_CONFIG.totalCapital = state.totalCapital;

      state.bots.forEach((botState) => {
        const restoredBot = this.deserializeBot(botState);
        launcher.addBot(restoredBot);

        if (restoredBot.position) {
          console.log(
            `♻️  Restored position: ${restoredBot.symbol} @ $${restoredBot.position.entryPrice}`
          );
        }
      });

      launcher.setTradeHistory(state.tradeHistory);

      console.log(
        `✅ Bot state restored successfully. Capital: $${SPOT_CONFIG.totalCapital}`
      );
    } catch (err: any) {
      console.error(`❌ Failed to restore state: ${err.message}`);
    }
  }

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
        signal: bot.signal,
      } as BotInstance);
    });

    return serialized;
  }

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
      side: pos.side,
      confidence: pos.confidence,
    } as Position;
  }

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
      signal: state.signal,
    } as BotInstance;
  }

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
      side: state.side,
      confidence: state.confidence,
    } as Position;
  }
}

// ============================================================================
// MAIN LAUNCHER CLASS
// ============================================================================

class SpotTradingLauncher {
  private signalReader: EnhancedSignalReader;
  private priceFetcher: PriceFetcher;
  private persistence: BotPersistence;
  private candleManager: CandleManager | null = null;

  private bots: Map<string, BotInstance> = new Map();
  private tradeHistory: CompletedTrade[] = [];

  private signalCheckInterval: NodeJS.Timeout | null = null;
  private dashboardInterval: NodeJS.Timeout | null = null;
  private priceUpdateInterval: NodeJS.Timeout | null = null;

  private capitalAllocated = 0;
  private maxHistorySize = 50;

  constructor() {
    this.signalReader = new EnhancedSignalReader();
    this.priceFetcher = new PriceFetcher();
    this.persistence = new BotPersistence();
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

  async initialize(): Promise<void> {
    logger.log('🚀 Initializing Spot Trading Launcher...', 'info');

    // Initialize CandleManager
    const symbols = process.env.ENABLED_SYMBOLS?.split(',') || ['SOL/USDT'];
    this.candleManager = new CandleManager('15m');
    logger.log(
      `✅ CandleManager initialized with ${symbols.length} symbols`,
      'success'
    );

    // Try to restore previous state
    const previousState = this.persistence.loadState();

    if (previousState && previousState.bots.length > 0) {
      logger.log(
        `♻️  Found previous state with ${previousState.bots.length} active bots`,
        'info'
      );
      this.persistence.restoreState(this, previousState);

      const activePositions = Array.from(this.bots.values()).filter(
        (b) => b.position
      ).length;
      logger.log(
        `✅ Restored ${activePositions} active position(s)`,
        'success'
      );

      // Update prices for restored positions
      await this.updatePrices();
    } else {
      logger.log('ℹ️  Starting fresh - no previous state found', 'info');
    }

    logger.log(`Signal File: ${SPOT_CONFIG.signalFile}`, 'info');
    logger.log(`Total Capital: $${SPOT_CONFIG.totalCapital} USDT`, 'info');
    logger.log(
      `Available Capital: $${SPOT_CONFIG.availableCapital.toFixed(2)} USDT`,
      'info'
    );
    logger.log(`Max Positions: ${SPOT_CONFIG.maxConcurrentPositions}`, 'info');
    logger.log(
      `Position Size: $${SPOT_CONFIG.positionSize.toFixed(2)} USDT per position`,
      'info'
    );
    logger.log('═'.repeat(80), 'info');

    logger.log('✅ Launcher initialized and ready', 'success');
  }

  private createBot(signal: SignalQueueItem): BotInstance {
    if (!signal || !signal.price) {
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
    };
    console.log(
      '🥑 ~ SpotTradingLauncher ~ createBot ~ bot:',
      JSON.stringify(bot, null, 2)
    );

    this.bots.set(signal.symbol, bot);

    // Mark signal as taken
    this.signalReader.markSignalAsTaken(
      signal.symbol,
      generateId(),
      signal.price // ✅ Correct property
    );

    logger.log(
      `🤖 Bot created for ${signal.symbol} (${signal.strategy}, confidence: ${signal.confidence}%)`,
      'success'
    );

    // ✅ FIX: Use signal.price, NOT signal.entryPrice
    setTimeout(() => {
      if (!bot.position && bot.signal) {
        const price = bot.signal.entryPrice; // ✅ CHANGED FROM entryPrice to price

        // ✅ ADDITIONAL SAFETY: Validate before calling
        if (!price || isNaN(price) || price <= 0) {
          console.error(`❌ Invalid signal price for ${bot.symbol}: ${price}`);
          console.error('Signal data:', JSON.stringify(bot.signal, null, 2));
          this.bots.delete(bot.symbol); // Clean up bad bot
          this.signalReader.releaseSignal(bot.symbol); // Release signal
          return;
        }

        this.enterPosition(bot, price);
      }
    }, 1000);

    return bot;
  }

  private enterPosition(bot: BotInstance, currentPrice: number) {
    if (bot.position || !bot.signal) return;

    // ✅ SAFETY: Validate inputs
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
      console.error(
        `❌ Invalid entry price for ${bot.symbol}: ${currentPrice}`
      );
      return;
    }

    if (!bot.signal.stopLoss || !bot.signal.takeProfit) {
      console.error(`❌ Invalid signal data for ${bot.symbol}:`, bot.signal);
      return;
    }

    const positionSizeUSD = SPOT_CONFIG.positionSize;
    const tokenQuantity = positionSizeUSD / currentPrice;

    // Check capital
    if (
      this.capitalAllocated + positionSizeUSD >
      SPOT_CONFIG.availableCapital
    ) {
      logger.log(
        `❌ Insufficient capital: ${(this.capitalAllocated + positionSizeUSD).toFixed(2)} > ${SPOT_CONFIG.availableCapital.toFixed(2)}`,
        'error'
      );
      return;
    }

    bot.position = {
      side: 'SPOT',
      entryPrice: currentPrice,
      currentPrice: currentPrice,
      amount: tokenQuantity,
      remainingAmount: tokenQuantity,
      stopLoss: bot.signal.stopLoss,
      takeProfit: bot.signal.takeProfit,
      pnlUsd: 0,
      pnlPct: 0,
      entryTime: new Date(),
      symbol: bot.symbol,
      strategy: bot.signal.strategy,
      partialsSold: 0,
      positionId: generateId(),
      confidence: bot.signal.confidence,
    };

    this.capitalAllocated += positionSizeUSD;
    bot.status = 'running';

    logger.log(
      `🚀 ${bot.symbol} entered at ${currentPrice.toFixed(6)} (${bot.signal.strategy})`,
      'success'
    );
    logger.log(`   Quantity: ${tokenQuantity.toFixed(8)} tokens`, 'info');
    logger.log(`   Position Size: ${positionSizeUSD.toFixed(2)}`, 'info');
    logger.log(
      `   SL: ${bot.signal.stopLoss.toFixed(6)} | TP: ${bot.signal.takeProfit.toFixed(6)}`,
      'info'
    );
  }

  private updatePosition(bot: BotInstance, currentPrice: number) {
    if (!bot.position) return;

    // ✅ SAFETY: Validate currentPrice
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
      console.error(`❌ Invalid price for ${bot.symbol}: ${currentPrice}`);
      return;
    }

    const pos = bot.position;

    // ✅ SAFETY: Validate position data
    if (
      !pos.entryPrice ||
      !pos.remainingAmount ||
      !pos.stopLoss ||
      !pos.takeProfit
    ) {
      console.error(`❌ Invalid position data for ${bot.symbol}:`, {
        entryPrice: pos.entryPrice,
        remainingAmount: pos.remainingAmount,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
      });
      return;
    }

    const oldPrice = pos.currentPrice || pos.entryPrice;
    pos.currentPrice = currentPrice;

    // Calculate PnL
    const priceChange = currentPrice - pos.entryPrice;
    pos.pnlUsd = priceChange * pos.remainingAmount;
    pos.pnlPct = (priceChange / pos.entryPrice) * 100;

    // Check exit conditions
    const hitStopLoss = currentPrice <= pos.stopLoss;
    const hitTakeProfit = currentPrice >= pos.takeProfit;

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

    // Trailing stop
    if (SPOT_CONFIG.trailingStopEnabled && pos.pnlPct > 2) {
      const newStopLoss =
        currentPrice * (1 - SPOT_CONFIG.trailingStopPercent / 100);
      if (newStopLoss > pos.stopLoss) {
        const oldSL = pos.stopLoss;
        pos.stopLoss = newStopLoss;
        console.log(
          `📊 ${bot.symbol} trailing stop: ${oldSL.toFixed(6)} → ${newStopLoss.toFixed(6)}`
        );
      }
    }
  }

  private exitPosition(bot: BotInstance, reason: ReasonType) {
    if (!bot.position) return;

    const pos = bot.position;
    const exitPrice = pos.currentPrice;
    const positionSizeUSD = pos.amount * pos.entryPrice;

    // Ensure stats exist
    if (bot.trades === undefined) bot.trades = 0;
    if (bot.wins === undefined) bot.wins = 0;
    if (bot.losses === undefined) bot.losses = 0;
    if (bot.pnl === undefined) bot.pnl = 0;

    bot.trades++;

    const isWin = pos.pnlUsd > 0;
    if (isWin) {
      bot.wins++;
    } else {
      bot.losses++;
    }

    bot.pnl += pos.pnlUsd;

    const duration = Date.now() - pos.entryTime.getTime();

    const trade: CompletedTrade = {
      symbol: bot.symbol,
      strategy: pos.strategy,
      side: 'SPOT',
      entryPrice: pos.entryPrice,
      exitPrice: exitPrice,
      amount: pos.amount,
      pnlUsd: pos.pnlUsd,
      pnlPct: pos.pnlPct,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      duration,
      exitReason: reason,
      marginUsed: pos.marginUsed || 0,
      entryTime: pos.entryTime,
      exitTime: new Date(),
      isWin: isWin,
    };

    this.tradeHistory.unshift(trade);
    if (this.tradeHistory.length > this.maxHistorySize) {
      this.tradeHistory.pop();
    }

    // Update capital
    this.capitalAllocated -= positionSizeUSD;
    SPOT_CONFIG.totalCapital += pos.pnlUsd;

    // Mark signal as completed
    this.signalReader.markSignalAsCompleted(bot.symbol, pos.pnlUsd);

    const icon = isWin ? '✅' : '❌';
    console.log(`\n${icon} ╔${'═'.repeat(40)}`);
    console.log(`${icon} ${bot.symbol} CLOSED`);
    console.log(`${icon} Entry: $${pos.entryPrice.toFixed(6)}`);
    console.log(`${icon} Exit:  ${exitPrice.toFixed(6)}`);
    console.log(
      `${icon} PnL:   ${colorPnL(pos.pnlUsd)} (${colorPnL(pos.pnlPct, true)})`
    );
    console.log(`${icon} Reason: ${reason}`);
    console.log(`${icon} Duration: ${Math.floor(duration / 60000)}m`);
    console.log(`${icon} ╚${'═'.repeat(40)}\n`);

    bot.position = null;
    bot.status = 'waiting';
    bot.signal = null;

    // Remove bot after cooldown
    setTimeout(() => {
      this.bots.delete(bot.symbol);
      console.log(`🗑️  Bot removed: ${bot.symbol}`);
    }, 5000);
  }

  private async updatePrices() {
    try {
      const bots = Array.from(this.bots.values());
      if (bots.length === 0) return;

      const symbols = bots.map((b) => b.symbol);
      const priceMap = await this.priceFetcher.getMultiplePrices(symbols);

      let updatedCount = 0;

      for (const bot of bots) {
        const currentPrice = priceMap.get(bot.symbol);

        // ✅ SAFETY: Validate price before using
        if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
          console.warn(`⚠️  Invalid price for ${bot.symbol}: ${currentPrice}`);
          continue;
        }

        if (!bot.priceHistory) bot.priceHistory = [];
        bot.priceHistory.push(currentPrice);
        if (bot.priceHistory.length > 100) {
          bot.priceHistory.shift();
        }

        if (bot.position) {
          this.updatePosition(bot, currentPrice);
        }

        bot.lastUpdate = new Date();
        updatedCount++;
      }

      if (updatedCount > 0) {
        console.log(
          `✅ Updated ${updatedCount}/${bots.length} bot(s) with current prices`
        );
      }
    } catch (err: any) {
      console.error(`❌ Price update error: ${err.message}`);
      console.error(err.stack);
    }
  }

  private async checkForNewSignals() {
    const signals = this.signalReader.readLatestSignals();

    if (signals.length === 0) return;

    const activeBots = Array.from(this.bots.values());
    const activePositions = activeBots.filter((b) => b?.position).length;

    const availableSlots = SPOT_CONFIG.maxConcurrentPositions - activePositions;

    if (availableSlots <= 0) {
      logger.log(
        `⛔ Max positions reached (${activePositions}/${SPOT_CONFIG.maxConcurrentPositions}) - waiting...`,
        'info'
      );
      return;
    }

    const activeSymbols = new Set(Array.from(this.bots.keys()));
    const bestSignal = this.signalReader.getBestSignal(
      activeSymbols
    ) as SignalQueueItem;

    if (bestSignal) {
      logger.log(
        `🎯 Launching bot for ${bestSignal.symbol} (${bestSignal.strategy}, ${bestSignal.confidence}%)`,
        'info'
      );
      this.createBot(bestSignal);
      this.signalReader.removeSignal(bestSignal.symbol);
    }
  }

  private printDashboard() {
    console.clear();
    console.log(colorize('═'.repeat(140), colors.cyan));
    console.log(
      colorize(
        '  🤖 SPOT TRADING LAUNCHER - SIGNAL-DRIVEN EXECUTION  ',
        colors.brightCyan
      )
    );
    console.log(colorize('═'.repeat(140), colors.cyan));

    const totalBots = this.bots.size;
    const activePos = Array.from(this.bots.values()).filter(
      (b) => b.position
    ).length;

    const totalRealizedPnL = Array.from(this.bots.values()).reduce(
      (s, b) => s + (b?.sessionPnl || 0),
      0
    );
    const totalUnrealizedPnL = Array.from(this.bots.values())
      .filter((b) => b.position)
      .reduce((sum, b) => sum + (b.position?.pnlUsd || 0), 0);
    const totalPnL = totalRealizedPnL + totalUnrealizedPnL;

    const totalWins = Array.from(this.bots.values()).reduce(
      (s, b) => s + (b?.wins || 0),
      0
    );
    const totalLosses = Array.from(this.bots.values()).reduce(
      (s, b) => s + (b?.losses || 0),
      0
    );
    const totalTrades = totalWins + totalLosses;
    const winRate =
      totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';

    const usedCapital = this.capitalAllocated;
    const availableCapital = SPOT_CONFIG.availableCapital - usedCapital;
    const currentEquity = SPOT_CONFIG.totalCapital + totalPnL;
    const equityPct = (currentEquity / SPOT_CONFIG.totalCapital - 1) * 100;

    console.log(
      `Positions: ${activePos}/${SPOT_CONFIG.maxConcurrentPositions} | Completed Trades: ${totalTrades}`
    );
    console.log(
      `Unrealized PnL: ${colorPnL(totalUnrealizedPnL)} | Realized PnL: ${colorPnL(totalRealizedPnL)} | Total PnL: ${colorPnL(totalPnL)}`
    );

    console.log(
      `  💰 Capital: ${SPOT_CONFIG.totalCapital.toFixed(2)} | Equity: ${currentEquity.toFixed(2)} (${colorPnL(equityPct, true)}) | ` +
        `Used: ${colorize(usedCapital.toFixed(2), colors.yellow)}/${SPOT_CONFIG.availableCapital.toFixed(2)} | ` +
        `Free: ${availableCapital.toFixed(2)}`
    );

    console.log(
      `  Active Bots: ${totalBots} | Win Rate: ${winRate}% (${totalWins}W/${totalLosses}L)`
    );

    const signalStats = this.signalReader.getStats(this.bots);
    console.log(
      `  Available Signals: ${signalStats.totalSignals} | ` +
        `Long: ${signalStats.longSignals} | Short: ${signalStats.shortSignals} | ` +
        `In Trade: ${colorize(signalStats.inTrade.toString(), colors.orange)} | ` +
        `Avg Confidence: ${signalStats.avgConfidence.toFixed(0)}%`
    );

    console.log(colorize('─'.repeat(140), colors.gray));

    // Active Positions
    const withPos = Array.from(this.bots.values()).filter((b) => b?.position);
    if (withPos.length > 0) {
      console.log(colorize('📈 ACTIVE POSITIONS', colors.brightGreen));
      console.log('');

      withPos.forEach((bot) => {
        console.log('🥑 ~ SpotTradingLauncher ~ printDashboard ~ bot:', bot);
        if (!bot || !bot.position) return;

        const p = bot.position;
        const duration = Math.floor(
          (Date.now() - p.entryTime.getTime()) / 60000
        );
        const pnlPctStr = colorPnL(p.pnlPct, true);
        const pnlUsdStr = colorPnL(p.pnlUsd);

        console.log(
          `  ${colorize(bot.symbol.padEnd(12), colors.cyan)} ` +
            `${colorize(p.strategy.padEnd(18), colors.brightOrange)} ` +
            `Entry: ${colorize(p.entryPrice.toFixed(6), colors.white)} ` +
            `Current: ${colorize(p.currentPrice.toFixed(6), colors.yellow)} ` +
            `PnL: ${pnlPctStr} ${pnlUsdStr} ` +
            `Time: ${duration}m ` +
            `Conf: ${p.confidence?.toFixed(1) || 0}%`
        );

        console.log(
          `    ${colorize('SL:', colors.gray)} ${p.stopLoss.toFixed(6)} | ` +
            `${colorize('TP:', colors.gray)} ${p.takeProfit.toFixed(6)}`
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

    // Trade History
    if (this.tradeHistory.length > 0) {
      console.log(colorize('📜 RECENT TRADES (Last 20)', colors.brightYellow));
      this.tradeHistory.slice(0, 20).forEach((trade) => {
        const icon = trade.isWin ? '✅ WIN' : '❌ LOSS';
        const pnlPctStr = colorPnL(trade.pnlPct, true);
        const pnlUsdStr = colorPnL(trade.pnlUsd);

        console.log(
          `  ${icon.padEnd(10)} ${trade.symbol.padEnd(12)} ${trade.strategy.padEnd(18)} ` +
            `${pnlPctStr.padEnd(12)} ${pnlUsdStr.padEnd(20)} ` +
            `${Math.floor(trade.duration / 60000)}m ${trade.exitReason}`
        );
      });
      console.log(colorize('─'.repeat(140), colors.gray));
    }

    // Session Summary
    console.log(colorize('📊 SESSION SUMMARY', colors.brightYellow));
    console.log(
      `  Completed Trades: ${totalTrades} | Wins: ${totalWins} | Losses: ${totalLosses} | Win Rate: ${winRate}%`
    );
    console.log(
      `  Unrealized PnL: ${colorPnL(totalUnrealizedPnL)} | Realized PnL: ${colorPnL(totalRealizedPnL)} | Total PnL: ${colorPnL(totalPnL)}`
    );
    console.log(colorize('─'.repeat(140), colors.gray));

    console.log(colorize('Commands: (r)efresh signals | (q)uit', colors.gray));
    console.log(colorize('═'.repeat(140), colors.cyan));
  }

  start() {
    this.signalCheckInterval = setInterval(() => {
      this.checkForNewSignals();
    }, SPOT_CONFIG.signalCheckInterval);

    this.dashboardInterval = setInterval(() => {
      this.printDashboard();
    }, SPOT_CONFIG.dashboardRefreshMs);

    this.priceUpdateInterval = setInterval(async () => {
      await this.updatePrices();
    }, SPOT_CONFIG.priceUpdateInterval);

    // Auto-save
    setInterval(() => {
      this.persistence.saveState(this);
    }, 30000);

    // Initial checks
    setTimeout(async () => {
      await this.updatePrices();
      this.checkForNewSignals();
    }, 500);

    setTimeout(() => this.printDashboard(), 1000);
  }

  stop() {
    if (this.signalCheckInterval) clearInterval(this.signalCheckInterval);
    if (this.dashboardInterval) clearInterval(this.dashboardInterval);
    if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval);

    this.signalReader.stopAutoSave();

    logger.log('💾 Saving launcher state...', 'info');
    this.persistence.saveState(this);

    if (this.candleManager) {
      this.candleManager.destroy();
    }

    logger.log('Launcher stopped', 'warning');
  }
}

// ============================================================================
// UTILITIES
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

// ============================================================================
// INTERFACE & MAIN
// ============================================================================

function setupInterface(launcher: SpotTradingLauncher) {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      launcher.stop();
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
      '🚀 Spot Trading Launcher - Self-Contained v2.0',
      colors.brightCyan
    )
  );
  console.log(colorize('   No bot-spot.js Required - All-in-One', colors.gray));
  console.log(colorize('═'.repeat(80), colors.cyan));

  const launcher = new SpotTradingLauncher();

  try {
    await launcher.initialize();
    launcher.start();
    setupInterface(launcher);
  } catch (err: any) {
    log(`Fatal error: ${err.message}`, 'error');
    process.exit(1);
  }
}

process.on('uncaughtException', (err: any) => {
  log(`Exception: ${err.message}`, 'error');
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down...', 'warning');
  process.exit(0);
});

main();

interface BinanceTickerResponse {
  symbol: string;
  price: string;
  // Add other fields if they exist in the response
}
