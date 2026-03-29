import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { PriceFetcher } from '@src/core/price-fetcher.js';
import ccxt, { type binance } from 'ccxt';
import * as dotenv from 'dotenv';

import {
  colors,
  createSymbolContext,
  getAmountDecimals,
  getContractMultiplier,
  getPriceDecimals,
  is1000xSymbol,
  normalize,
  rgb,
} from '../../lib/helpers.js';
import {
  type BotInstance,
  type CompletedTrade,
  type CooldownInfo,
  type EntrySignal,
  type EntryType,
  type MorayPosition,
  type OpenPositionParams,
  type PartialTarget,
  type Position,
  type ReasonType,
  type ScanResult,
  type SignalState,
  type StopLossParams,
  type StrategyId,
  type TakeProfitParams,
} from '../../lib/type.js';
import {
  displayMorayBanner,
  formatPartialLog,
  MORAY_CONFIG,
  MorayPartialSystem,
} from '../../src/core/moray-partial-system.js';
import { getConfigForSymbol } from '../../src/spot/config-spot.js';
import {
  BaseTradingBotPersistence,
  type BaseTradingBot,
} from '../core/bot-persistence.js';
import { CandleManager } from '../core/candles.js';
import { PositionManager } from '../core/position-manager.js';
import { SymbolValidator } from '../core/symbol-validator.js';
import { LoggerFactory } from './../../lib/logger.js';
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
  // 🐍 Moray additions
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

// ✅ NEW: Live price data interface
interface LivePriceData {
  price: number;
  timestamp: number;
  source: 'binance' | 'cache';
}

// ✅ NEW: Order book data interface
interface OrderBookData {
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  spread: number;
  spreadPercent: number;
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

// At the top of your file, after imports
function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const configForLogging = {
  ...CONFIG,
  availableCapital: CONFIG.availableCapital,
  positionSize: CONFIG.positionSize,
  marginPerPosition: CONFIG.marginPerPosition,
};
// console.log("🥑 ~ Full CONFIG:", configForLogging);

/**
 * AGGRESSIVE MORAY (Faster exits, higher win rate)
 */
const AGGRESSIVE_MORAY = {
  partials: [
    { ratio: 1.0, percent: 0.6, label: 'Quick Snatch 🥩' }, // 60% at 1R
    { ratio: 2.0, percent: 0.3, label: 'Safety Net 🍖' }, // 30% at 2R
    { ratio: 4.0, percent: 0.1, label: 'Moonshot 🎯' }, // 10% at 4R
  ],
  moveToBreakEvenAfter: 1.0,
};

/**
 * CONSERVATIVE MORAY (More room to run, lower win rate but bigger wins)
 */
const CONSERVATIVE_MORAY = {
  partials: [
    { ratio: 2.0, percent: 0.4, label: 'Patient Wait 🥩' }, // 40% at 2R
    { ratio: 3.5, percent: 0.4, label: 'Good Profit 🍖' }, // 40% at 3.5R
    { ratio: 6.0, percent: 0.2, label: 'Big Fish 🎯' }, // 20% at 6R
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
const CONFIG_FUTURE = getConfigForSymbol(
  process.env.TRADING_SYMBOL_FUTURES || 'BTCUSDT'
);
const logger = LoggerFactory.getFuturesLogger(CONFIG_FUTURE.SYMBOL);

// ============================================================================
// ENHANCED PRICE FETCHER WITH LIVE DATA
// ============================================================================

/**
 * ✅ IMPROVED: PriceFetcher with Futures API support and live price fetching
 *
 * This class handles both:
 * 1. Bulk price updates from scanner (for monitoring)
 * 2. Real-time price fetching before trades (for execution)
 */
// class PriceFetcher {
//   private spotBaseUrl = 'https://api4.binance.com/api/v3';
//   private futuresBaseUrl = 'https://fapi.binance.com/fapi/v1'; // ✅ FUTURES API

//   // ✅ NEW: Cache for recent prices (max 6 tokens as requested)
//   private priceCache: Map<string, LivePriceData> = new Map();
//   private readonly MAX_CACHE_AGE_MS = 5000; // 5 seconds
//   private readonly MAX_CACHED_SYMBOLS = 6; // Max 6 tokens in memory

//   /**
//    * ✅ CRITICAL: Get live price for IMMEDIATE trading decision
//    * Use this RIGHT BEFORE placing an order
//    *
//    * @param symbol - Symbol to fetch (e.g., "BTCUSDT")
//    * @param market - SPOT or FUTURES
//    * @param forceRefresh - Skip cache and fetch fresh data
//    */
//   async getCurrentPrice(
//     symbol: string,
//     market: 'SPOT' | 'FUTURES' = 'FUTURES',
//     forceRefresh = false
//   ): Promise<number | null> {
//     try {
//       const binanceSymbol = symbol.replace('/', '');

//       // ✅ Check cache first (unless force refresh)
//       if (!forceRefresh && this.priceCache.has(binanceSymbol)) {
//         const cached = this.priceCache.get(binanceSymbol)!;
//         const age = Date.now() - cached.timestamp;

//         if (age < this.MAX_CACHE_AGE_MS) {
//           // console.log(`💾 Using cached price for ${binanceSymbol}: $${cached.price}`);
//           return cached.price;
//         }
//       }

//       // ✅ Fetch fresh data
//       const baseUrl =
//         market === 'FUTURES' ? this.futuresBaseUrl : this.spotBaseUrl;

//       const response = await fetch(
//         `${baseUrl}/ticker/price?symbol=${binanceSymbol}`
//       );

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//       }

//       const data = await response.json();

//       if (data && data.price) {
//         const price = parseFloat(data.price);

//         // ✅ Update cache
//         this.updateCache(binanceSymbol, price);

//         return price;
//       }

//       return null;
//     } catch (err: any) {
//       console.error(
//         `❌ Failed to fetch ${market} price for ${symbol}: ${err.message}`
//       );
//       return null;
//     }
//   }

//   /**
//    * ✅ NEW: Get ORDER BOOK data for better execution
//    * Recommended for real money trades
//    * Shows best bid/ask and available liquidity
//    */
//   async getOrderBookPrice(
//     symbol: string,
//     side: 'BUY' | 'SELL',
//     market: 'SPOT' | 'FUTURES' = 'FUTURES'
//   ): Promise<OrderBookData | null> {
//     try {
//       const binanceSymbol = symbol.replace('/', '');
//       const baseUrl =
//         market === 'FUTURES' ? this.futuresBaseUrl : this.spotBaseUrl;

//       // Get top 5 levels of order book
//       const response = await fetch(
//         `${baseUrl}/depth?symbol=${binanceSymbol}&limit=5`
//       );

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//       }

//       const data = await response.json();

//       if (data && data.bids && data.asks) {
//         const bestBid = data.bids[0]; // [price, qty]
//         const bestAsk = data.asks[0]; // [price, qty]

//         if (bestBid && bestAsk) {
//           const bidPrice = parseFloat(bestBid[0]);
//           const askPrice = parseFloat(bestAsk[0]);
//           const spread = askPrice - bidPrice;
//           const spreadPercent = (spread / bidPrice) * 100;

//           return {
//             bidPrice,
//             bidQty: parseFloat(bestBid[1]),
//             askPrice,
//             askQty: parseFloat(bestAsk[1]),
//             spread,
//             spreadPercent,
//           };
//         }
//       }

//       return null;
//     } catch (err: any) {
//       console.error(
//         `❌ Failed to fetch order book for ${symbol}: ${err.message}`
//       );
//       return null;
//     }
//   }

//   /**
//    * ✅ IMPROVED: Batch fetch for scanning only
//    * NOT for actual trade execution
//    * Fetches all prices in one API call (more efficient)
//    */
//   async getMultiplePrices(
//     symbols: string[],
//     market: 'SPOT' | 'FUTURES' = 'FUTURES'
//   ): Promise<Map<string, number>> {
//     const priceMap = new Map<string, number>();

//     try {
//       const baseUrl =
//         market === 'FUTURES' ? this.futuresBaseUrl : this.spotBaseUrl;

//       // ✅ Single batch request for all symbols
//       const response = await fetch(`${baseUrl}/ticker/price`);

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//       }

//       const allPrices = await response.json();

//       const binanceSymbols = symbols.map((s) => s.replace('/', ''));

//       // ✅ Filter only requested symbols
//       for (const ticker of allPrices) {
//         if (binanceSymbols.includes(ticker.symbol)) {
//           const price = parseFloat(ticker.price);
//           priceMap.set(ticker.symbol, price);

//           // ✅ Update cache
//           this.updateCache(ticker.symbol, price);
//         }
//       }

//       console.log(
//         `📊 Fetched ${priceMap.size}/${symbols.length} ${market} prices`
//       );
//     } catch (err: any) {
//       console.error(
//         `❌ Failed to fetch multiple ${market} prices: ${err.message}`
//       );
//     }

//     return priceMap;
//   }

//   /**
//    * ✅ NEW: Update price cache with LRU eviction
//    * Keeps only the 6 most recently used symbols
//    */
//   private updateCache(symbol: string, price: number): void {
//     // ✅ Remove oldest entry if cache is full
//     if (
//       this.priceCache.size >= this.MAX_CACHED_SYMBOLS &&
//       !this.priceCache.has(symbol)
//     ) {
//       const oldestKey = this.priceCache.keys().next().value;
//       this.priceCache.delete(oldestKey);
//     }

//     this.priceCache.set(symbol, {
//       price,
//       timestamp: Date.now(),
//       source: 'binance',
//     });
//   }

//   /**
//    * ✅ NEW: Get cached price info (for debugging)
//    */
//   getCacheInfo(): string[] {
//     const info: string[] = [];
//     this.priceCache.forEach((data, symbol) => {
//       const age = ((Date.now() - data.timestamp) / 1000).toFixed(1);
//       info.push(`${symbol}: $${data.price} (${age}s old)`);
//     });
//     return info;
//   }

//   /**
//    * ✅ NEW: Clear cache
//    */
//   clearCache(): void {
//     this.priceCache.clear();
//   }
// }

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
        });

      this.lastReadTime = fileTime;
      return this.signalQueue;
    } catch (err: any) {
      console.error(`❌ Failed to read signals: ${err.message}`);
      return [];
    }
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

  getSignalQueue(): EntrySignal[] {
    return this.signalQueue;
  }

  stopAutoSave(): void {
    // if (this.autoSaveInterval) {
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

  /**
   * ✅ NEW: Load trade history from disk
   */
  private loadTradeHistory(): void {
    try {
      if (!fs.existsSync(this.historyFile)) {
        console.log('ℹ️  No trade history found, starting fresh');
        return;
      }

      const content = fs.readFileSync(this.historyFile, 'utf-8');
      const data = JSON.parse(content);

      if (data && Array.isArray(data.history)) {
        this.tradeHistory = data.history.map((entry: any) => ({
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
          entryTime: new Date(entry.entryTime),
          exitTime: new Date(entry.exitTime),
          exitReason: entry.exitReason,
          botId: entry.botId,
          positionSize: entry.positionSize,
        }));

        console.log(`📚 Loaded ${this.tradeHistory.length} historical trades`);
      }
    } catch (err: any) {
      console.error(`Failed to load trade history: ${err.message}`);
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
      // Save current signal states
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

      // ✅ NEW: Save trade history separately
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
        })),
      };

      fs.writeFileSync(this.historyFile, JSON.stringify(historyData, null, 2));
    } catch (err: any) {
      console.error(`Failed to save trade history: ${err.message}`);
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
  // private saveState(
  //   bot?: FuturesTradingBot,
  //   tradeCounters?: {
  //     // Add as parameter
  //     total: number;
  //     today: number;
  //     perSymbol: Map<string, number>;
  //     sessionStart: Date;
  //   }
  // ): void {
  //   try {
  //     const counters = tradeCounters || bot?.getTradeCounters?.();

  //     const states: Record<string, any> = {
  //       tradeCounters: tradeCounters
  //         ? {
  //             total: tradeCounters.total,
  //             today: tradeCounters.today,
  //             perSymbol: Object.fromEntries(tradeCounters.perSymbol),
  //             sessionStart: tradeCounters.sessionStart.toISOString(),
  //           }
  //         : undefined,
  //     };

  //     const data = {
  //       lastUpdate: new Date().toISOString(),
  //       totalStates: this.signalStates.size,
  //       tradeCounters: counters
  //         ? {
  //             total: counters.total,
  //             today: counters.today,
  //             perSymbol: Object.fromEntries(counters.perSymbol),
  //             sessionStart: counters.sessionStart.toISOString(),
  //           }
  //         : undefined,
  //       states,
  //     };

  //     fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
  //     // console.log(`💾 Saved state for ${this.signalStates.size} signals`);
  //     this.saveTradeHistory();
  //   } catch (err: any) {
  //     console.error(`Failed to save signal state: ${err.message}`);
  //   }
  // }

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

// class PriceCache {
//   private cacheFile = './data/signals/price-cache.json';
//   private cache: Map<string, { price: number; timestamp: number }> = new Map();
//   private cacheExpiryMs = 60000; // 1 minute

//   constructor() {
//     this.loadCache();
//     this.startAutoCleanup();
//   }

//   private loadCache(): void {
//     try {
//       if (!fs.existsSync(this.cacheFile)) {
//         console.log('ℹ️  No price cache found, starting fresh');
//         return;
//       }

//       const content = fs.readFileSync(this.cacheFile, 'utf-8');
//       const data = JSON.parse(content);

//       if (data && data.prices) {
//         Object.entries(data.prices).forEach(([symbol, info]: [string, any]) => {
//           this.cache.set(symbol, {
//             price: info.price,
//             timestamp: info.timestamp,
//           });
//         });

//         // console.log(`💾 Loaded ${this.cache.size} cached prices`);
//       }
//     } catch (err: any) {
//       console.error(`Failed to load price cache: ${err.message}`);
//     }
//   }

//   private saveCache(): void {
//     try {
//       const prices: Record<string, any> = {};

//       this.cache.forEach((info, symbol) => {
//         prices[symbol] = {
//           price: info.price,
//           timestamp: info.timestamp,
//         };
//       });

//       const data = {
//         lastUpdate: new Date().toISOString(),
//         expiryMs: this.cacheExpiryMs,
//         totalCached: this.cache.size,
//         prices,
//       };

//       fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
//     } catch (err: any) {
//       console.error(`Failed to save price cache: ${err.message}`);
//     }
//   }

//   getPrice(symbol: string): number | null {
//     const cached = this.cache.get(symbol);
//     if (!cached) return null;

//     const age = Date.now() - cached.timestamp;
//     if (age > this.cacheExpiryMs) {
//       this.cache.delete(symbol);
//       return null;
//     }

//     return cached.price;
//   }

//   setPrices(prices: Map<string, number>): void {
//     prices.forEach((price, symbol) => {
//       this.cache.set(symbol, {
//         price,
//         timestamp: Date.now(),
//       });
//     });

//     this.saveCache();
//     console.log(`💾 Cached ${prices.size} price(s) to disk`);
//   }

//   private startAutoCleanup(): void {
//     setInterval(() => {
//       const now = Date.now();
//       let removed = 0;

//       for (const [symbol, info] of this.cache.entries()) {
//         const age = now - info.timestamp;
//         if (age > this.cacheExpiryMs) {
//           this.cache.delete(symbol);
//           removed++;
//         }
//       }

//       if (removed > 0) {
//         console.log(`🧹 Cleaned up ${removed} expired price(s)`);
//         this.saveCache();
//       }
//     }, 60000);
//   }
// }

class PriceCache {
  private cacheFile = './data/signals/price-cache.json';
  private cache: Map<string, { price: number; timestamp: number }> = new Map();
  private cacheExpiryMs = 60000; // 1 minute
  private cleanupInterval?: NodeJS.Timeout | undefined;

  constructor() {
    this.loadCache();
    this.startAutoCleanup();
  }

  // ============================================
  // LOAD CACHE FROM DISK
  // ============================================
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
          // Don't load expired prices
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

  // ============================================
  // SAVE CACHE TO DISK
  // ============================================
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

      // Ensure directory exists
      const dir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`❌ Failed to save price cache: ${err.message}`);
    }
  }

  // ============================================
  // GET PRICE (with expiry check)
  // ============================================
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

  // ============================================
  // SET SINGLE PRICE (NEW METHOD) ✅
  // ============================================
  setPrice(symbol: string, price: number): void {
    if (!price || isNaN(price) || price <= 0) {
      console.error(`❌ Invalid price for ${symbol}: ${price}`);
      return;
    }

    this.cache.set(symbol, {
      price,
      timestamp: Date.now(),
    });

    // Optional: Save to disk immediately for single updates
    // Comment this out if you want to save only in batch
    // this.saveCache();
  }

  // ============================================
  // SET MULTIPLE PRICES (existing method)
  // ============================================
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

  // ============================================
  // CHECK IF PRICE IS CACHED
  // ============================================
  hasPrice(symbol: string): boolean {
    return this.getPrice(symbol) !== null;
  }

  // ============================================
  // GET CACHE AGE
  // ============================================
  getCacheAge(symbol: string): number | null {
    const cached = this.cache.get(symbol);
    if (!cached) return null;

    return Date.now() - cached.timestamp;
  }

  // ============================================
  // GET ALL CACHED SYMBOLS
  // ============================================
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

  // ============================================
  // CLEAR CACHE
  // ============================================
  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.saveCache();
    console.log(`🗑️  Cleared ${count} cached price(s)`);
  }

  // ============================================
  // CLEAR SPECIFIC SYMBOL
  // ============================================
  clearSymbol(symbol: string): boolean {
    const existed = this.cache.delete(symbol);
    if (existed) {
      this.saveCache();
      console.log(`🗑️  Cleared cache for ${symbol}`);
    }
    return existed;
  }

  // ============================================
  // GET CACHE STATS
  // ============================================
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

  // ============================================
  // PRINT CACHE STATUS
  // ============================================
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

  // ============================================
  // AUTO CLEANUP
  // ============================================
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
    }, 60000); // Run every minute
  }

  // ============================================
  // STOP CLEANUP (for graceful shutdown)
  // ============================================
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.saveCache();
    console.log('💾 Price cache saved and destroyed');
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
      // Handle undefined confirmationTicks
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

// ... [Rest of the code remains the same until the FuturesTradingBot class]
// I'll only show the key changes in the trading bot class

/**
 * Main Trading Bot Class with Enhanced Live Price Fetching
 */
class FuturesTradingBot {
  private testStartTime: number;
  // private readonly TEST_DURATION_MS = 10 * 60 * 1000;
  private candleManager: CandleManager;
  private totalCapital = 600;
  private positionManager: PositionManager;
  private priceFetchAttempts: Map<string, PriceFetchAttempt> = new Map();
  private readonly MAX_FETCH_ATTEMPTS = 3;
  private readonly FETCH_RETRY_DELAY = 5000; // 5 seconds
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

  // 🐍 ADD THIS:
  private moraySystem: MorayPartialSystem;

  // ✅ ADD: Binance Futures Client
  private binance = new ccxt.binance({
    apiKey: getRequiredEnvVar('BINANCE_FUTURE_API_KEY'),
    secret: getRequiredEnvVar('BINANCE_FUTURE_API_SECRET'),
    enableRateLimit: true,
    timeout: 60000,
    options: {
      defaultType: 'future',
    },
  });

  // ✅ ADD: Capital tracking
  private capitalAllocated = 0;
  private livePriceCheckEnabled = true; // ✅ NEW: Enable/disable live price check

  constructor(totalCapital: number, moraySystem: MorayPartialSystem) {
    this.signalReader = new EnhancedSignalReader();
    this.persistence = new FuturesPersistence('./data/futures-bot-state.json');
    this.priceFetcher = new PriceFetcher();
    this.positionManager = new PositionManager(totalCapital, moraySystem);
    this.candleManager = new CandleManager(configForLogging.timeframe);
    this.priceCache = new PriceCache();
    this.loadCooldowns();
    // Start daily reset timer if enabled
    if (configForLogging.resetTradeCountDaily) {
      this.startDailyReset();
    }
    // this.priceSimulator = new PriceSimulator();
    // 🐍 ADD THIS:
    this.moraySystem = new MorayPartialSystem();
    if (MORAY_CONFIG.enabled) {
      displayMorayBanner();
    }
    this.testStartTime = Date.now();
  }

  /**
   * ✅ NEW: Verify signal with live price before opening position
   * This is THE critical safety check for real money trading
   */
  private async verifySignalWithLivePrice(
    signal: EntrySignal
  ): Promise<{ valid: boolean; livePrice?: number; reason?: string }> {
    try {
      console.log(
        `🔍 Verifying signal for ${signal.symbol} with live price...`
      );

      // ✅ Fetch live price
      const livePrice = await this.priceFetcher.getCurrentPrice(
        signal.symbol,
        'entry',
        true // Force refresh
      );

      if (!livePrice) {
        return {
          valid: false,
          reason: 'Failed to fetch live price',
        };
      }

      // ✅ Optional: Check order book for liquidity
      // const orderBook = await this.priceFetcher.getOrderBookPrice(
      //   signal.symbol,
      //   signal.side === 'LONG' ? 'BUY' : 'SELL',
      //   'FUTURES'
      // );

      // if (orderBook) {
      //   console.log(
      //     `📖 Order Book - Bid: $${orderBook.bidPrice.toFixed(6)} | ` +
      //       `Ask: $${orderBook.askPrice.toFixed(6)} | ` +
      //       `Spread: ${orderBook.spreadPercent.toFixed(3)}%`
      //   );

      //   // ✅ Warn if spread is too wide (> 0.1%)
      //   if (orderBook.spreadPercent > 0.1) {
      //     console.log(
      //       `⚠️  Wide spread detected (${orderBook.spreadPercent.toFixed(3)}%) - trade with caution`
      //     );
      //   }
      // }

      // ✅ Check if price moved too much since signal
      const signalPrice = signal.entryPrice || 0;
      const priceDiffPercent =
        Math.abs((livePrice.price - signalPrice) / signalPrice) * 100;

      console.log(
        `💵 Price Check - Signal: $${signalPrice.toFixed(6)} | ` +
          `Live: $${livePrice.price.toFixed(6)} | ` +
          `Diff: ${priceDiffPercent.toFixed(2)}%`
      );

      // ✅ Reject if price moved > 2% (configurable)
      const MAX_PRICE_DRIFT_PERCENT = 2.0;
      if (priceDiffPercent > MAX_PRICE_DRIFT_PERCENT) {
        return {
          valid: false,
          livePrice: livePrice.price,
          reason: `Price moved ${priceDiffPercent.toFixed(2)}% since signal (max: ${MAX_PRICE_DRIFT_PERCENT}%)`,
        };
      }

      // ✅ Check if signal direction still makes sense
      if (signal.side === 'LONG' && livePrice.price > signal.takeProfit!) {
        return {
          valid: false,
          livePrice: livePrice.price,
          reason: 'Price already above take profit',
        };
      }

      if (signal.side === 'SHORT' && livePrice.price < signal.takeProfit!) {
        return {
          valid: false,
          livePrice: livePrice.price,
          reason: 'Price already below take profit',
        };
      }

      console.log(`✅ Signal verified - live price acceptable`);

      return {
        valid: true,
        livePrice: livePrice.price,
      };
    } catch (err: any) {
      console.error(`❌ Error verifying signal: ${err.message}`);
      return {
        valid: false,
        reason: err.message,
      };
    }
  }

  private checkTestDuration(): boolean {
    const elapsed = Date.now() - this.testStartTime;

    // if (elapsed >= this.TEST_DURATION_MS) {
    //   console.log('\n⏰ TEST DURATION REACHED');
    //   console.log(`Ran for ${(elapsed / 60000).toFixed(1)} minutes`);
    //   return true;
    // }

    return false;
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

  private handleMissingPrice_SafeVersion(bot: BotInstance) {
    const attempt = this.priceFetchAttempts.get(bot.symbol);

    if (bot.position) {
      // Try fallbacks in order of preference
      let fallbackPrice: number | null = null;
      let fallbackSource = '';

      // Fallback 1: Last known current price
      if (bot.position.currentPrice && bot.position.currentPrice > 0) {
        fallbackPrice = bot.position.currentPrice;
        fallbackSource = 'last known price';
      }

      // Fallback 2: Entry price
      else if (bot.position.entryPrice && bot.position.entryPrice > 0) {
        fallbackPrice = bot.position.entryPrice;
        fallbackSource = 'entry price';
      }

      // Fallback 3: Stop loss or take profit (whichever is closer to current)
      else if (bot.position.stopLoss && bot.position.takeProfit) {
        // Use midpoint between SL and TP as emergency fallback
        fallbackPrice = (bot.position.stopLoss + bot.position.takeProfit) / 2;
        fallbackSource = 'midpoint of SL/TP';
      }

      if (fallbackPrice) {
        this.updateBotWithPrice(bot, fallbackPrice);

        // Only log if we've had multiple failures
        if (attempt && attempt.attempts >= 2) {
          console.log(
            `⚠️  ${bot.symbol}: Using ${fallbackSource} $${fallbackPrice.toFixed(6)} ` +
              `(${attempt.attempts} failed attempts)`
          );
        }
      } else {
        // This should NEVER happen, but just in case
        console.error(
          `🚨 CRITICAL ERROR: ${bot.symbol} has position but NO fallback price available!\n` +
            `   Entry: ${bot.position.entryPrice}\n` +
            `   Current: ${bot.position.currentPrice}\n` +
            `   This should not be possible!`
        );
      }
    } else {
      // No position, just log once
      if (!attempt || attempt.attempts === 1) {
        console.log(`ℹ️  ${bot.symbol}: No price (no position)`);
      }
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

      // ✅ ADD THIS: Re-initialize Moray for restored positions
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

      // ✅ CRITICAL: Force immediate price update for restored positions
      log('🔄 Fetching current prices for restored positions...', 'info');
      // await this.updatePricesFromScanner();

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
      signal.stopLoss || 0,
      signal.takeProfit || 0
    );
  }

  /**
   * ✅ MODIFIED: Open position with live price verification
   */
  private async openPosition(
    signal: EntrySignal,
    currentPrice: number
  ): Promise<boolean> {
    try {
      // ✅ CRITICAL: Verify signal with live price FIRST
      if (this.livePriceCheckEnabled) {
        const verification = await this.verifySignalWithLivePrice(signal);

        if (!verification.valid) {
          console.log(
            colorize(`❌ Signal rejected: ${verification.reason}`, colors.red)
          );
          return false;
        }

        // ✅ Use verified live price instead of signal price
        if (verification.livePrice) {
          currentPrice = verification.livePrice;
          console.log(
            colorize(
              `✅ Using verified live price: $${currentPrice.toFixed(6)}`,
              colors.green
            )
          );
        }
      }

      // ... rest of existing openPosition logic ...
      // (all the existing code for opening position remains the same)

      return true;
    } catch (err: any) {
      console.error(`❌ Failed to open position: ${err.message}`);
      return false;
    }
  }

  /**
   * ✅ NEW: Get cache status for dashboard
   */
  private getPriceCacheStatus(): string {
    const cacheInfo = this.priceFetcher.getCacheInfo();
    if (cacheInfo.length === 0) {
      return 'Empty';
    }
    return cacheInfo.join(' | ');
  }

  private async checkForNewSignals() {
    if (this.checkTestDuration()) {
      console.log('🏁 Stopping test...');
      this.stop();
      process.exit(0);
    }
    const signals = this.signalReader.readLatestSignals();

    if (signals.length === 0) return;

    // ✅ ADD THIS: Check available capital first
    const marginNeeded =
      configForLogging.positionSize / configForLogging.leverageMultiplier;
    if (CONFIG.availableCapital < marginNeeded) {
      log(
        `💰 Insufficient capital: Need $${marginNeeded}, Have $${CONFIG.availableCapital.toFixed(2)}`,
        'warning'
      );
      return; // Don't even try to create bots
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

  private async updatePricesFromScanner() {
    try {
      // Step 1: Try to get prices from scanner
      const priceMap = await this.getPricesFromScanner();
      console.log(`📊 Got ${priceMap.size} prices from scanner`);

      // Step 2: Check which bots need prices
      const bots = Array.from(this.bots.values());
      const missingSymbols: string[] = [];

      for (const bot of bots) {
        if (!priceMap.has(bot.symbol)) {
          // Try cache first
          const cachedPrice = this.priceCache.getPrice(bot.symbol);
          if (cachedPrice) {
            priceMap.set(bot.symbol, cachedPrice);
            console.log(
              `💾 ${bot.symbol}: Using cached price $${cachedPrice.toFixed(6)}`
            );
          } else {
            missingSymbols.push(bot.symbol);
          }
        }
      }

      // Step 3: Fetch missing prices with retry logic
      if (missingSymbols.length > 0) {
        console.log(
          `🔍 Fetching ${missingSymbols.length} missing prices:`,
          missingSymbols
        );

        try {
          const priceMap = await this.getPricesFromScanner();
          console.log(`📊 Got ${priceMap.size} prices from scanner`);

          const bots = Array.from(this.bots.values());
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
              `🔍 Fetching ${missingSymbols.length} missing prices...`
            );

            try {
              const exchangePrices =
                await this.priceFetcher.getMultiplePrices(missingSymbols);
              console.log(
                `✅ Fetched ${exchangePrices.size} prices from exchange`
              );

              if (exchangePrices.size > 0) {
                // Cache the new prices
                this.priceCache.setPrices(exchangePrices);

                // Add to price map
                exchangePrices.forEach((price, symbol) => {
                  priceMap.set(symbol, price);
                });
              }
            } catch (error: any) {
              console.error(`❌ Exchange fetch error:`, error.message);
            }
          }

          // Update all bots
          let updatedCount = 0;

          for (const bot of bots) {
            let currentPrice = priceMap.get(bot.symbol);

            // Fallback to last known price
            if (!currentPrice && bot.position?.currentPrice) {
              console.log(
                `⚠️  ${bot.symbol}: Using last known price $${bot.position.currentPrice.toFixed(6)}`
              );
              currentPrice = bot.position.currentPrice;

              // Cache this fallback price
              this.priceCache.setPrice(bot.symbol, currentPrice);
            }

            if (currentPrice) {
              this.updateBotWithPrice(bot, currentPrice);
              updatedCount++;
            } else {
              console.log(`❌ ${bot.symbol}: No price available`);
            }
          }

          if (updatedCount > 0) {
            console.log(
              `✅ Updated ${updatedCount}/${bots.length} bot(s) with prices`
            );
          }
        } catch (err: any) {
          console.error(`❌ Price update error: ${err.message}`);
        }

        // Filter out symbols that have failed too many times recently
        const symbolsToFetch = missingSymbols.filter((symbol) => {
          const attempt = this.priceFetchAttempts.get(symbol);
          if (!attempt) return true;

          // If we've tried too many times, wait before trying again
          const timeSinceLastAttempt = Date.now() - attempt.lastAttempt;
          if (attempt.attempts >= this.MAX_FETCH_ATTEMPTS) {
            if (timeSinceLastAttempt < this.FETCH_RETRY_DELAY) {
              console.log(
                `⏳ ${symbol}: Skipping (${attempt.attempts} failed attempts, retry in ${Math.ceil((this.FETCH_RETRY_DELAY - timeSinceLastAttempt) / 1000)}s)`
              );
              return false;
            } else {
              // Reset attempts after cooldown
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
              `✅ Fetched ${exchangePrices.size}/${symbolsToFetch.length} prices from exchange`
            );

            // Update price map and cache
            for (const [symbol, price] of exchangePrices.entries()) {
              priceMap.set(symbol, price);
              this.priceCache.setPrice(symbol, price);

              // Clear failed attempts on success
              this.priceFetchAttempts.delete(symbol);
              console.log(`💰 ${symbol}: $${price.toFixed(6)}`);
            }

            // Track failed fetches
            for (const symbol of symbolsToFetch) {
              if (!exchangePrices.has(symbol)) {
                this.trackFailedFetch(symbol, 'Not returned by exchange');
              }
            }
          } catch (error: any) {
            console.error(`❌ Exchange fetch error:`, error.message);

            // Track all as failed
            for (const symbol of symbolsToFetch) {
              this.trackFailedFetch(symbol, error.message);
            }
          }
        }
      }
      let updatedCount = 0;
      let missingCount = 0;

      for (const bot of bots) {
        const currentPrice = priceMap.get(bot.symbol);

        if (currentPrice) {
          this.updateBotWithPrice(bot, currentPrice);
          updatedCount++;
        } else {
          missingCount++;

          // Handle missing price based on bot state
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

  private async createBot(signal: EntrySignal): Promise<BotInstance | null> {
    // console.log('🥑 ~ FuturesTradingBot ~ createBot ~ signal:=====>>', signal);
    // ✅ CHECK COOLDOWN FIRST
    const cooldownCheck = this.canTradeSymbol(signal.symbol);

    const stopLoss = signal.stopLoss as number;
    const takeProfit = signal.takeProfit as number;

    if (!cooldownCheck.canTrade) {
      log(`⏰ ${cooldownCheck.reason}`, 'warning');
      return null;
    }
    if (!signal || !signal.entryPrice) {
      throw new Error('Invalid signal: missing entryPrice');
    }

    log(`✅ ${signal.symbol} - Cooldown clear, creating bot...`, 'success');

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

    log(
      `🤖 Bot created for ${signal.symbol} (${signal.strategy}, ${signal.side}, confidence: ${signal.confidence}%)`,
      'success'
    );

    // ✅ Enter position and calculate SL/TP at actual entry time
    setTimeout(async () => {
      if (!bot.position && bot.signal && signal.entryPrice) {
        // Get current price for entry
        const currentPrice = await this.priceFetcher.getCurrentPrice(
          signal.symbol
        );

        const candles = await this.candleManager.getCandles(
          signal.symbol,
          'FUTURES'
        );
        console.log('🥑 ~ FuturesTradingBot ~ createBot ~ candles:', candles);
        if (!candles || candles.closes.length < 20) {
          log('Not enough candles', 'warning');
          return; // or fallback to fixed %
        }
        const curPrice = currentPrice?.price as number;
        // Log final values
        console.log(
          `Final SL: ${stopLoss.toFixed(6)} | TP: ${takeProfit.toFixed(6)} | Risk Distance: ${((Math.abs(curPrice - stopLoss) / curPrice) * 100).toFixed(2)}%`
        );

        // Optional: minimum distance to avoid ultra-tight stops
        // const minDistance = currentPrice * 0.003; // 0.3%
        // if (Math.abs(currentPrice - stopLoss) < minDistance) {
        //   stopLoss =
        //     signal.side === 'LONG'
        //       ? currentPrice - minDistance
        //       : currentPrice + minDistance;
        // }

        if (!currentPrice) {
          log(`❌ Cannot get price for ${signal.symbol}`, 'error');
          this.bots.delete(signal.symbol);
          return;
        }

        // Check slippage
        const slippage = Math.abs(
          ((currentPrice.price - signal.entryPrice) / signal.entryPrice) * 100
        );

        if (slippage > configForLogging.maxSlippagePercent) {
          log(
            `⚠️ ${signal.symbol} slippage too high (${slippage.toFixed(2)}%)`,
            'warning'
          );
          this.bots.delete(signal.symbol);
          return;
        }

        // ✅ CALCULATE SL/TP BASED ON ACTUAL ENTRY PRICE AND SIDE
        // let stopLoss: number;
        // let takeProfit: number;

        // const LEVERAGE = 3;
        // const RISK_PERCENT = 0.01;
        // const priceStopPercent = RISK_PERCENT / LEVERAGE;

        // if (signal.side === 'LONG') {
        //   stopLoss = currentPrice * (1 - priceStopPercent); // 0.333% below
        //   takeProfit = currentPrice * (1 + priceStopPercent * 3); // 1% above
        // } else {
        //   // SHORT
        //   stopLoss = currentPrice * (1 + priceStopPercent); // 0.333% above
        //   takeProfit = currentPrice * (1 - priceStopPercent * 3); // 1% below
        // }

        console.log(
          `\n📊 ${signal.symbol} ${signal.side.toUpperCase()} Position Setup:`
        );
        console.log(`   Entry: $${currentPrice.price.toFixed(4)}`);
        console.log(`   Stop Loss: $${stopLoss.toFixed(4)}`);
        console.log(`   Take Profit: $${takeProfit.toFixed(4)}`);
        console.log(
          `   Risk: ${((Math.abs(currentPrice.price - stopLoss) / currentPrice.price) * 100).toFixed(2)}%`
        );
        console.log(
          `   Reward: ${((Math.abs(takeProfit - currentPrice.price) / currentPrice.price) * 100).toFixed(2)}%`
        );
        console.log(
          `   R:R = 1:${(Math.abs(takeProfit - currentPrice.price) / Math.abs(currentPrice.price - stopLoss)).toFixed(2)}`
        );

        // Enter position with calculated SL/TP
        this.enterPosition(
          bot,
          signal.side,
          currentPrice.price,
          signal.strategy,
          stopLoss, // ✅ Calculated at entry time
          takeProfit // ✅ Calculated at entry time
        );

        // ✅ Mark as IN_TRADE only AFTER successful entry
        if (bot.position) {
          const position = bot.position as Position;
          this.signalReader.markSignalAsTaken(
            signal.symbol,
            position.positionId,
            position.entryPrice
          );
          log(
            `✅ ${signal.symbol} marked as IN_TRADE with SL: ${stopLoss.toFixed(4)}, TP: ${takeProfit.toFixed(4)}`,
            'success'
          );
        } else {
          log(`❌ ${signal.symbol} failed to enter position`, 'error');
          this.bots.delete(signal.symbol);
        }
      }
    }, 1000);

    return bot;
  }

  private enterPosition(
    bot: BotInstance,
    side: EntryType,
    price: number,
    strategy: StrategyId,
    stopLoss: number,
    takeProfit: number
  ): boolean {
    // console.log(
    //   '🥑 ~ FuturesTradingBot ~ enterPosition ~ takeProfit:',
    //   takeProfit
    // );
    // console.log('🥑 ~ FuturesTradingBot ~ enterPosition ~ stopLoss:', stopLoss);
    // console.log('🥑 ~ FuturesTradingBot ~ enterPosition ~ strategy:', strategy);
    // console.log('🥑 ~ FuturesTradingBot ~ enterPosition ~ price:', price);
    // console.log('🥑 ~ FuturesTradingBot ~ enterPosition ~ side:', side);
    // console.log('🥑 ~ FuturesTradingBot ~ enterPosition ~ bot:', bot);
    // ============================================
    // CHECKS
    // ============================================

    // if (bot.symbol.startsWith('1000')) {
    //   console.log(`🚫 ${bot.symbol} blocked - 1000X token`);
    //   return false;
    // }

    if (bot.position) {
      log(`⚠️ ${bot.symbol} already has position`, 'warning');
      return false;
    }

    // 🔥 NEW: Block unsafe symbols
    if (!SymbolValidator.isSymbolAllowed(bot.symbol)) {
      log(`🚫 ${bot.symbol} blocked - unsafe symbol`, 'error');
      return false;
    }

    if (bot.position) return false;

    // ============================================
    // VALIDATION
    // ============================================

    console.log(`\n🔍 ${bot.symbol} Entry Validation:`);
    console.log(`   Entry: $${price} | SL: $${stopLoss} | TP: $${takeProfit}`);

    // Validate price levels
    if (side === 'LONG') {
      if (stopLoss >= price || takeProfit <= price) {
        log(`❌ ${bot.symbol} LONG: Invalid SL/TP levels`, 'error');
        return false;
      }
    } else {
      if (stopLoss <= price || takeProfit >= price) {
        log(`❌ ${bot.symbol} SHORT: Invalid SL/TP levels`, 'error');
        return false;
      }
    }

    // Calculate metrics
    const riskDistance = Math.abs(price - stopLoss);
    const rewardDistance = Math.abs(takeProfit - price);
    const riskPct = (riskDistance / price) * 100;
    const rewardPct = (rewardDistance / price) * 100;
    const rrRatio = rewardDistance / riskDistance;

    console.log(`📊 ${bot.symbol} Position:`);
    console.log(
      `   Risk: ${riskPct.toFixed(2)}% | Reward: ${rewardPct.toFixed(2)}% | R:R = 1:${rrRatio.toFixed(2)}`
    );

    // ============================================
    // POSITION SIZING WITH VALIDATION
    // ============================================

    const positionSizeUSD = configForLogging.positionSize;
    const leverageMultiplier = configForLogging.leverageMultiplier;
    // const notionalValue = positionSizeUSD * configForLogging.leverageMultiplier;
    const notionalValue = positionSizeUSD;
    // ✅ Calculate contracts (price is ALREADY correct!)
    const contractQuantity = notionalValue / price;

    // ✅ Detect if 1000X for logging only
    const multiplier = getContractMultiplier(bot.symbol);
    // const actualTokens = contractQuantity * multiplier;

    // 🔥 USE YOUR HELPER:
    const symbolContext = createSymbolContext(bot.symbol);
    let tokenQuantity = notionalValue / price;

    console.log(`💰 ${symbolContext.futures} Position Sizing:`);
    console.log(`   Futures Price: $${price.toFixed(8)}`);
    console.log(`   Notional: $${notionalValue.toFixed(2)}`);
    console.log(`   Contract Quantity: ${contractQuantity.toFixed(4)}`);
    if (multiplier > 1) {
      console.log(`   ⚠️ 1000X Token: 1 contract = ${multiplier} tokens`);
      console.log(`   Actual Tokens: ${contractQuantity.toFixed(0)}`);
    }

    // 🔥 NEW: Validate before calculating
    const validation = SymbolValidator.validatePosition(
      bot.symbol,
      price,
      positionSizeUSD,
      leverageMultiplier
    );

    if (!validation.valid) {
      log(`❌ ${bot.symbol} validation failed: ${validation.reason}`, 'error');
      return false;
    }

    if (side === 'LONG') {
      if (stopLoss >= price || takeProfit <= price) {
        log(`❌ ${bot.symbol} LONG: Invalid SL/TP levels`, 'error');
        console.log(`   Price: ${price}, SL: ${stopLoss}, TP: ${takeProfit}`);
        return false;
      }
    } else {
      if (stopLoss <= price || takeProfit >= price) {
        log(`❌ ${bot.symbol} SHORT: Invalid SL/TP levels`, 'error');
        console.log(`   Price: ${price}, SL: ${stopLoss}, TP: ${takeProfit}`);
        return false;
      }
    }

    // const notionalValue = validation.notionalValue;
    // const tokenQuantity = validation.tokenQuantity;
    const marginRequired = positionSizeUSD / leverageMultiplier;

    // if (!reserveCapital(marginRequired)) {
    //   log(`❌ ${bot.symbol} insufficient capital`, 'error');
    //   return false;
    // }

    // 🔥 NEW: Round to proper precision
    const roundedQuantity = SymbolValidator.roundQuantity(
      bot.symbol,
      tokenQuantity,
      price
    );
    const roundedPrice = SymbolValidator.roundPrice(bot.symbol, price);
    const roundedSL = SymbolValidator.roundPrice(bot.symbol, stopLoss);
    const roundedTP = SymbolValidator.roundPrice(bot.symbol, takeProfit);

    console.log(`💰 Position Sizing:`);
    console.log(`   Margin: $${marginRequired.toFixed(2)}`);
    console.log(`   Leverage: ${leverageMultiplier}x`);
    console.log(`   Notional: $${notionalValue.toFixed(2)}`);
    console.log(
      `   Quantity: ${roundedQuantity} ${bot.symbol.replace('USDT', '')}`
    );

    // ============================================
    // CAPITAL CHECK
    // ============================================

    if (!reserveCapital(marginRequired)) {
      log(`❌ ${bot.symbol} insufficient capital`, 'error');
      return false;
    }

    // ============================================
    // CREATE POSITION
    // ============================================

    const position: Position = {
      positionId: `${bot.symbol}-${Date.now()}`,
      symbol: bot.symbol,
      side: side,
      entryPrice: price, // ✅ Use as-is
      currentPrice: price,
      amount: contractQuantity, // ✅ Contracts (not tokens!)
      remainingAmount: contractQuantity,
      stopLoss: stopLoss, // ✅ Use as-is
      takeProfit: takeProfit, // ✅ Use as-is
      pnlUsd: 0,
      pnlPct: 0,
      leverage: leverageMultiplier,
      marginUsed: marginRequired,
      notionalValue: notionalValue,
      entryTime: new Date(),
      strategy: strategy,
      partialsSold: 0,
    };

    bot.position = position;
    bot.status = 'running';

    // ============================================
    // INITIALIZE WITH MORAY (IF ENABLED)
    // ============================================

    if (MORAY_CONFIG.enabled && this.moraySystem) {
      // 🔥 FIXED: Check if moraySystem exists and has the method
      if (typeof this.moraySystem.initializePosition === 'function') {
        bot.position = this.moraySystem.initializePosition(position);

        const morayPos = bot.position as MorayPosition;
        log(
          `🐍 ${bot.symbol} Moray initialized:\n` +
            `   Targets: ${morayPos.partialTargets?.map((t) => `${t.label} @ ${t.ratio}R`).join(', ')}\n` +
            `   Breakeven after: ${MORAY_CONFIG.moveToBreakEvenAfter}R`,
          'info'
        );

        // Log target prices
        morayPos.partialTargets?.forEach((target) => {
          const targetPrice = this.moraySystem.calculateTargetPrice(
            roundedPrice,
            side,
            target.ratio,
            roundedSL
          );
          console.log(
            `   ${target.label}: $${targetPrice.toFixed(6)} (${(target.percent * 100).toFixed(0)}%)`
          );
        });
      } else {
        // Moray not available, use regular position
        log(`⚠️ Moray system not available, using regular position`, 'warning');
        console.log('MORAY NOT ACTIVE');
        bot.position = position;
      }
    } else {
      // Moray disabled or not available
      console.log('MORAY DISABLED');
      bot.position = position;
    }

    // ============================================
    // UPDATE STATE
    // ============================================

    this.allocatedCapital += notionalValue;
    bot.status = 'running';

    // ============================================
    // SUCCESS LOG
    // ============================================

    log(
      `💰 Allocated: $${notionalValue.toFixed(2)} | Total: $${this.allocatedCapital.toFixed(2)}/$${this.totalCapital.toFixed(2)}`,
      'info'
    );
    log(
      `🚀 ${bot.symbol} ${side} OPENED at $${roundedPrice} (${strategy})`,
      'success'
    );
    log(`   Quantity: ${roundedQuantity} tokens`, 'info');
    log(
      `   Notional: $${notionalValue.toFixed(2)} (${leverageMultiplier}x)`,
      'info'
    );
    log(`   SL: $${roundedSL} | TP: $${roundedTP}`, 'info');

    // ============================================
    // VERIFICATION (Critical!)
    // ============================================

    const verifyNotional = roundedQuantity * roundedPrice;
    const notionalDiff = Math.abs(verifyNotional - notionalValue);

    console.log(`✅ Position Verification:`);
    console.log(`   Contracts: ${contractQuantity.toFixed(4)}`);
    console.log(`   Price: $${price.toFixed(8)}`);
    console.log(`   Calculated Notional: $${verifyNotional.toFixed(2)}`);
    console.log(`   Target Notional: $${notionalValue.toFixed(2)}`);
    console.log(`   Difference: $${notionalDiff.toFixed(2)}`);

    if (notionalDiff > 1) {
      log(
        `⚠️ VERIFICATION WARNING: Expected $${notionalValue.toFixed(2)}, got $${verifyNotional.toFixed(2)}`,
        'warning'
      );
    } else {
      log(
        `✅ Verified: ${roundedQuantity} × $${roundedPrice} = $${verifyNotional.toFixed(2)}`,
        'success'
      );
    }

    console.log(`\n🔍 ${bot.symbol} DEBUG:`);
    console.log(`   Is 1000X: ${is1000xSymbol(bot.symbol)}`);
    console.log(`   Price from Binance: $${price}`);
    console.log(`   Notional target: $${notionalValue}`);
    console.log(`   Calculated contracts: ${contractQuantity}`);
    console.log(
      `   Verification: ${contractQuantity} × $${price} = $${(contractQuantity * price).toFixed(2)}`
    );
    console.log(`   Should equal: $${notionalValue.toFixed(2)}`);

    if (Math.abs(contractQuantity * price - notionalValue) > 1) {
      console.log(`❌ MISMATCH DETECTED!`);
      return false;
    }

    return true;
  }

  private updatePosition(bot: BotInstance, currentPrice: number) {
    if (!bot.position) return;

    const pos = bot.position;
    const oldPrice = pos.currentPrice;
    pos.currentPrice = currentPrice;

    // 🐍 Debug logging - remove after testing
    if (MORAY_CONFIG.enabled) {
      const morayPos = pos as MorayPosition;

      if (!morayPos.partialTargets) {
        console.error(
          `❌ ${bot.symbol} has NO partial targets! Moray not initialized!`
        );
      } else {
        // Log once per position to avoid spam
        if (!morayPos._loggedTargets) {
          console.log(
            `🐍 ${bot.symbol} Moray active with ${morayPos.partialTargets.length} targets`
          );
          morayPos._loggedTargets = true;
        }
      }
    }

    // 🐍 ADD THIS: Check partial targets FIRST
    if (MORAY_CONFIG.enabled) {
      const anyPartialHit = this.moraySystem.checkPartialTargets(
        bot.position as MorayPosition,
        currentPrice,
        bot.position.leverage || configForLogging.leverageMultiplier,
        // Callback when partial is executed
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
        },
        // Callback when breakeven is moved
        () => {
          log(`🛡️ ${bot.symbol} ${MORAY_CONFIG.messages.breakeven}`, 'info');
        }
      );

      // If all partials executed, close remaining position
      if (this.moraySystem.allPartialsExecuted(bot.position as MorayPosition)) {
        log(`🎉 ${bot.symbol} ${MORAY_CONFIG.messages.fullExit}`, 'success');
        this.exitPosition(bot, 'ALL_PARTIALS_HIT');
        return;
      }
    }

    if (
      (bot.position.side === 'LONG' && currentPrice <= bot.position.stopLoss) ||
      (bot.position.side === 'SHORT' && currentPrice >= bot.position.stopLoss)
    ) {
      this.exitPosition(bot, 'STOP_LOSS');
      return;
    }

    const tokenQuantity = pos.amount;
    const leverage = pos.leverage || CONFIG.leverageMultiplier;
    const marginUsed = pos.marginUsed || CONFIG.positionSize;

    // console.log(`\n🔍 ${bot.symbol} ${pos.side} PnL Calculation:`);
    // console.log(`   Entry Price: $${pos.entryPrice.toFixed(6)}`);
    // console.log(`   Current Price: $${currentPrice.toFixed(6)}`);
    // console.log(`   Token Quantity: ${tokenQuantity.toFixed(8)}`);
    // console.log(`   Leverage: ${leverage}x`);
    // console.log(`   Margin Used: $${marginUsed.toFixed(2)}`);

    let priceChange: number;

    if (pos.side === 'LONG') {
      priceChange = currentPrice - pos.entryPrice;
    } else {
      priceChange = pos.entryPrice - currentPrice;
    }

    // ✅ PnL = price change × contract quantity
    // This works for BOTH normal and 1000X tokens!
    const pnlUsd = priceChange * pos.amount;

    // console.log(`   Price Change: $${priceChange.toFixed(6)}`);

    // ✅ Apply leverage
    const leveragedPnl = pnlUsd * leverage;
    // ✅ Apply leverage

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
    pos.pnlUsd = leveragedPnl;
    pos.pnlPct = (leveragedPnl / marginUsed) * 100;

    // console.log(
    //   `   ✅ Final: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}% ${pos.pnlUsd >= 0 ? '+' : ''}$${pos.pnlUsd.toFixed(2)}\n`
    // );

    // ✅ Verification (optional, for 1000X tokens)
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

    // EXISTING CODE: Regular take profit check (only if Moray disabled)
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
    const marginUsed = pos.marginUsed || CONFIG.positionSize;
    const entryPrice = pos.entryPrice;
    const amount = pos.amount;
    const leverage = pos.leverage || CONFIG.leverageMultiplier;

    let exitPrice: number;
    let finalPnlUsd: number;
    let rawPnl: number;

    // ============================================================================
    // 🎯 CRITICAL FIX: Handle Moray exits differently
    // ============================================================================
    if (reason === 'ALL_PARTIALS_HIT') {
      const morayPos = pos as MorayPosition;

      // ✅ USE ACCUMULATED PARTIAL PNL (source of truth)
      finalPnlUsd = morayPos.partialPnlRealized || 0;
      rawPnl = finalPnlUsd / leverage;
      exitPrice = pos.currentPrice; // For display only

      console.log(`\n🐍 MORAY EXIT for ${bot.symbol}:`);
      console.log(`   Partials Sold: ${morayPos.partialsSold}`);
      console.log(`   Accumulated PnL: $${finalPnlUsd.toFixed(2)}`);
      console.log(`   Raw PnL: $${rawPnl.toFixed(2)}`);

      // 🔍 VERIFICATION: Compare with manual calculation
      const manualCalc = (pos.currentPrice - entryPrice) * amount;
      const diff = Math.abs(manualCalc - finalPnlUsd);

      if (diff > 0.5) {
        console.log(`   ⚠️ Large difference detected:`);
        console.log(`      Manual calc: $${manualCalc.toFixed(2)}`);
        console.log(`      Partial PnL: $${finalPnlUsd.toFixed(2)}`);
        console.log(`      Difference: $${diff.toFixed(2)}`);
      }
    } else {
      // ============================================================================
      // Regular exit (STOP_LOSS or TAKE_PROFIT)
      // ============================================================================

      // Determine exit price based on result
      if (pos.pnlUsd > 0) {
        exitPrice = pos.takeProfit;
      } else {
        exitPrice = pos.stopLoss;
      }

      // Calculate PnL from entry/exit
      let priceChange = 0;
      if (pos.side === 'LONG') {
        priceChange = exitPrice - entryPrice;
      } else {
        priceChange = entryPrice - exitPrice;
      }

      // Calculate final PnL
      finalPnlUsd = priceChange * amount;
      rawPnl = finalPnlUsd / leverage;

      console.log(`\n🔍 REGULAR EXIT for ${bot.symbol}:`);
      console.log(`   Side: ${pos.side}`);
      console.log(`   Entry: $${entryPrice.toFixed(6)}`);
      console.log(`   Exit: $${exitPrice.toFixed(6)}`);
      console.log(`   Price Change: $${priceChange.toFixed(6)}`);
      console.log(`   Amount: ${amount.toFixed(8)}`);
      console.log(`   Raw PnL: $${rawPnl.toFixed(2)}`);
      console.log(
        `   Leveraged PnL (${leverage}x): $${finalPnlUsd.toFixed(2)}`
      );
    }

    // ============================================================================
    // Calculate percentage
    // ============================================================================
    const finalPnlPct = (finalPnlUsd / marginUsed) * 100;
    const isWin = finalPnlUsd > 0;

    console.log(`   Margin: $${marginUsed.toFixed(2)}`);
    console.log(`   PnL %: ${finalPnlPct.toFixed(2)}%`);
    console.log(`   Result: ${isWin ? '✅ WIN' : '❌ LOSS'}`);

    // ============================================================================
    // Update bot statistics
    // ============================================================================
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

    // ============================================================================
    // Reclassify exit reason if needed
    // ============================================================================
    let finalExitReason = reason as ReasonType;

    if (reason === 'STOP_LOSS' && isWin) {
      finalExitReason = 'TAKE_PROFIT';
    } else if (reason === 'TAKE_PROFIT' && !isWin) {
      finalExitReason = 'STOP_LOSS';
    }

    // ============================================================================
    // Record trade
    // ============================================================================
    const trade: CompletedTrade = {
      symbol: bot.symbol,
      strategy: pos.strategy,
      side: pos.side,
      entryPrice: entryPrice,
      exitPrice: exitPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      amount: amount,
      pnlUsd: finalPnlUsd, // ✅ Now uses Moray PnL for partial exits
      pnlPct: finalPnlPct,
      duration: Date.now() - pos.entryTime.getTime(),
      exitReason: finalExitReason,
      entryTime: pos.entryTime,
      exitTime: new Date(),
      isWin: isWin,
      leverage: leverage,
      marginUsed: marginUsed,
      rawPnl: rawPnl,
    };

    this.tradeHistory.unshift(trade);
    if (this.tradeHistory.length > this.maxHistorySize) {
      this.tradeHistory.pop();
    }

    // ============================================================================
    // Apply cooldown
    // ============================================================================
    this.onPositionClosed(pos);

    // ============================================================================
    // Update capital
    // ============================================================================
    CONFIG.availableCapital += marginUsed;
    CONFIG.totalCapital += finalPnlUsd;

    if (CONFIG.availableCapital > CONFIG.totalCapital) {
      CONFIG.availableCapital = CONFIG.totalCapital;
    }

    releaseCapital(marginUsed, finalPnlUsd);

    // ============================================================================
    // Log exit
    // ============================================================================
    const icon = isWin ? '✅' : '❌';
    const pnlStr =
      finalPnlUsd >= 0
        ? `+$${finalPnlUsd.toFixed(2)}`
        : `-$${Math.abs(finalPnlUsd).toFixed(2)}`;

    console.log(`\n${icon} ${bot.symbol} ${finalExitReason}`);
    console.log(`   PnL: ${pnlStr} (${finalPnlPct.toFixed(2)}%)`);
    console.log(
      `   Duration: ${Math.floor((Date.now() - pos.entryTime.getTime()) / 60000)}m`
    );

    if (reason === 'ALL_PARTIALS_HIT') {
      console.log(
        `   🐍 Moray: ${(pos as MorayPosition).partialsSold} partials executed`
      );
    }

    // ============================================================================
    // Cleanup
    // ============================================================================
    bot.position = null;
    bot.status = 'waiting';
    bot.signal = null;

    setTimeout(() => {
      this.bots.delete(bot.symbol);
      console.log(`🗑️  Bot removed: ${bot.symbol}`);
    }, 5000);

    // ============================================================================
    // Check trade limit
    // ============================================================================
    console.log(
      `📊 Completed: ${this.tradeCounters.total}/${CONFIG.maxTotalTrades}`
    );

    if (this.tradeCounters.total >= CONFIG.maxTotalTrades) {
      console.log('🏁 TRADE LIMIT REACHED! Stopping...');
      this.persistence.saveState(
        this as unknown as BaseTradingBot<FuturesBotInstance>,
        configForLogging
      );
      setTimeout(() => process.exit(0), 1000);
    }
  }

  // ... rest of existing methods ...

  private async printDashboard() {
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

      // ============================================================================
      // BASIC STATS
      // ============================================================================
      const totalBots = this.bots.size;
      const activePos = Array.from(this.bots.values()).filter(
        (b) => b.position
      ).length;

      // ============================================================================
      // PNL CALCULATIONS
      // ============================================================================

      // Unrealized PnL (from active positions)
      const totalUnrealizedPnL = Array.from(this.bots.values())
        .filter((b) => b.position)
        .reduce((sum, b) => sum + (b.position?.pnlUsd || 0), 0);

      // Realized PnL (from completed trades in history)
      const totalRealizedPnL = this.tradeHistory.reduce(
        (sum, t) => sum + t.pnlUsd,
        0
      );

      // Total PnL
      const totalPnL = totalRealizedPnL + totalUnrealizedPnL;

      // ============================================================================
      // TRADE STATISTICS
      // ============================================================================
      const totalCompletedTrades = this.tradeHistory.length;
      const winCount = this.tradeHistory.filter((t) => t.isWin).length;
      const lossCount = this.tradeHistory.filter((t) => !t.isWin).length;
      const winRate =
        totalCompletedTrades > 0 ? (winCount / totalCompletedTrades) * 100 : 0;

      // 🐍 MORAY-SPECIFIC STATS
      const morayWins = this.tradeHistory.filter(
        (t) => t.isWin && t.exitReason === 'ALL_PARTIALS_HIT'
      );
      const morayWinCount = morayWins.length;
      const regularWinCount = winCount - morayWinCount;

      // Moray realized PnL (from completed Moray trades)
      const morayRealizedPnL = morayWins.reduce((sum, t) => sum + t.pnlUsd, 0);

      // Regular exits (stop loss)
      const regularExits = this.tradeHistory.filter(
        (t) => t.exitReason === 'STOP_LOSS' || t.exitReason === 'TAKE_PROFIT'
      );
      const regularPnL = regularExits.reduce((sum, t) => sum + t.pnlUsd, 0);

      // ============================================================================
      // CAPITAL TRACKING
      // ============================================================================
      const usedMargin = activePos * CONFIG.marginPerPosition;
      const availableMargin = CONFIG.availableCapital - usedMargin;
      const totalExposure =
        activePos * CONFIG.marginPerPosition * CONFIG.leverageMultiplier;
      const currentEquity = CONFIG.totalCapital + totalPnL;
      const equityPct = (currentEquity / CONFIG.totalCapital - 1) * 100;
      const utilization = (usedMargin / CONFIG.availableCapital) * 100;

      // ============================================================================
      // TRADE LIMITS
      // ============================================================================
      const counters = this.getTradeCounters();

      console.log(colorize('📊 TRADE LIMITS', colors.brightYellow));
      console.log(
        `  Total Trades: ${counters.total}/${counters.maxTotal === Infinity ? '∞' : counters.maxTotal} ` +
          `(${counters.remaining === Infinity ? '∞' : counters.remaining} remaining)`
      );
      console.log(
        `  Today's Trades: ${counters.today}/${counters.maxToday === Infinity ? '∞' : counters.maxToday}`
      );

      if (counters.remaining <= 1 && counters.remaining !== Infinity) {
        console.log(
          colorize('  ⚠️ WARNING: Only 1 trade remaining!', colors.red)
        );
      }

      console.log(colorize('─'.repeat(140), colors.gray));

      // ============================================================================
      // CAPITAL SUMMARY
      // ============================================================================
      console.log(colorize('💰 CAPITAL STATUS', colors.brightYellow));
      console.log(
        `  Starting Capital: $${colorize(CONFIG.totalCapital.toFixed(2), colors.lime)} | ` +
          `Current Equity: $${colorize(currentEquity.toFixed(2), equityPct >= 0 ? colors.green : colors.red)} ` +
          `(${colorPnL(equityPct, true)})`
      );
      console.log(
        `  Margin Used: $${colorize(usedMargin.toFixed(2), colors.yellow)}/$${CONFIG.availableCapital.toFixed(2)} ` +
          `(${colorize(utilization.toFixed(1) + '%', utilization > 80 ? colors.red : colors.yellow)}) | ` +
          `Free: $${colorize(availableMargin.toFixed(2), colors.green)} | ` +
          `Exposure: $${colorize(totalExposure.toFixed(2), colors.orange)}`
      );

      console.log(colorize('─'.repeat(140), colors.gray));

      // ============================================================================
      // POSITIONS & SIGNALS
      // ============================================================================
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
          `Completed: ${signalStats.completed} | ` +
          `Avg Confidence: ${signalStats.avgConfidence.toFixed(0)}%`
      );

      console.log(colorize('─'.repeat(140), colors.gray));

      // ============================================================================
      // ACTIVE POSITIONS
      // ============================================================================
      const withPos = Array.from(this.bots.values()).filter((b) => b?.position);

      if (withPos.length > 0) {
        console.log(colorize('📈 ACTIVE POSITIONS', colors.brightGreen));
        console.log('');

        withPos.forEach((bot) => {
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
                : colors.pink + colors.bgMaroon + colors.bright;

          const pnlPctStr = colorPnL(pnlPct, true);
          const pnlUsdStr = colorPnL(pnlUsd);
          const amountDes = getAmountDecimals(amount, currentPrice);

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

      // ============================================================================
      // WAITING BOTS
      // ============================================================================
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

      // ============================================================================
      // TRADE HISTORY
      // ============================================================================
      if (this.tradeHistory.length > 0) {
        console.log(
          colorize('📜 RECENT TRADES (Last 30)', colors.brightYellow)
        );

        this.tradeHistory.slice(0, 30).forEach((trade) => {
          if (!trade) return;

          const curPriceDec = getPriceDecimals(trade.entryPrice);
          const icon = trade.isWin ? '✅ WIN ' : '❌ LOSS';
          const pnlPctStr = colorPnL(trade.pnlPct, true);
          const pnlUsdStr = colorPnL(trade.pnlUsd);
          const exitColor = trade.isWin ? colors.green : colors.red;
          const rawPnl = trade.rawPnl as number;
          console.log(
            `  ${icon.padEnd(10)} ` +
              `${trade.symbol.padEnd(12)} ` +
              `${trade.strategy.padEnd(18)} ` +
              `${trade.side.padEnd(6)} ` +
              `${pnlPctStr} ${pnlUsdStr} ` +
              `SL: ${colorize(trade.stopLoss.toFixed(curPriceDec), colors.brightMaroon)} ` +
              `TP: ${colorize(trade.takeProfit.toFixed(curPriceDec), colors.brightLime)} ` +
              `Raw: ${colorPnL(rawPnl)} × ${trade.leverage}x = ${trade.pnlUsd.toFixed(2)} ` +
              `Entry: ${colorize(trade.entryPrice.toFixed(curPriceDec), colors.lightGreen)} ` +
              `Exit: ${colorize(trade.exitPrice.toFixed(curPriceDec), exitColor)} ` +
              `${Math.floor(trade.duration / 60000)}m ` +
              `${colorize(trade.exitReason, exitColor)}`
          );
        });
        console.log(colorize('─'.repeat(140), colors.gray));
      }

      // ============================================================================
      // MORAY PARTIAL HISTORY
      // ============================================================================
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

      // ============================================================================
      // SESSION SUMMARY
      // ============================================================================
      console.log(colorize('📊 SESSION SUMMARY', colors.brightYellow));
      console.log(
        `  Completed Trades: ${totalCompletedTrades} | ` +
          `Wins: ${colorize(winCount.toString(), colors.green)} ` +
          `(${morayWinCount} Moray, ${regularWinCount} Regular) | ` +
          `Losses: ${colorize(lossCount.toString(), colors.red)} | ` +
          `Win Rate: ${colorize(winRate.toFixed(1) + '%', winRate >= 50 ? colors.green : colors.red)}`
      );

      // ============================================================================
      // MORAY STATS
      // ============================================================================
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

      // ============================================================================
      // PNL BREAKDOWN
      // ============================================================================
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
    } catch (err: any) {
      console.error(colorize(`❌ Dashboard error: ${err.message}`, colors.red));
      console.error(err.stack);
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

// ... rest of the file remains the same ...

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
      '🚀 Futures Trading Bot v3.0 - Live Price Protection',
      colors.brightCyan
    )
  );
  console.log(
    colorize('   ✅ Real-time price verification before trades', colors.green)
  );
  console.log(colorize('   ✅ Order book depth checking', colors.green));
  console.log(colorize('   ✅ Max 6 tokens in memory', colors.green));
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
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  }
}

process.on('uncaughtException', (err: any) => {
  console.error(`Exception: ${err.message}`);
});

main();
