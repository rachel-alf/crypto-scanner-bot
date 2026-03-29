import crypto from 'crypto';
import fs from 'fs';

import ccxt, { type Order, type Ticker } from 'ccxt';
import * as dotenv from 'dotenv';

import {
  formatPrice,
  formatQuantity,
  generateId,
  generatePositionId,
} from '../../lib/helpers.js';
import { LoggerFactory } from '../../lib/logger.js';
import type {
  BotStats,
  CooldownState,
  EntrySignal,
  FibonacciLevels,
  HTFConfirmation,
  Indicators,
  MarketInfo,
  Position,
  Regime,
  ScanResult,
  StrategyId,
  TradeLog,
} from '../../lib/type.js';
import { getConfigForSymbol } from './config-spot.js';
import { positionCoordinator } from './position-coordinator.js';
import { sharedBalance } from './shared-balance.js';

dotenv.config();

// Check if running under launcher
const CONFIG = getConfigForSymbol(process.env.TRADING_SYMBOL || 'SOL/USDT');
const isLauncherManaged = !!process.send;
const logger = LoggerFactory.getSpotLogger(CONFIG.SYMBOL);

const SESSION_CONFIG = {
  MAX_DRAWDOWN_PCT: 0.9, // 0.05
  MAX_TRADES_PER_SESSION: 50,
};

const positionMap = new Map<string, Position>();

let sessionRealizedPnlUsd = 0;
let sessionStartBalance = 0;
let tradesThisSession = 0;
let isRunning = false;
let paperBalance = CONFIG.INITIAL_PAPER_BALANCE;
let cooldown: CooldownState = { until: null, reason: '', consecutiveLosses: 0 };
let htfCache: { data: HTFConfirmation; fetchedAt: Date } | null = null;
let marketInfo: MarketInfo | null = null;

const STATE_DIR = './data/states/spot';
const TRADING_SYMBOL = process.env.TRADING_SYMBOL || 'BTC/USDT';
const STATE_FILE =
  `${STATE_DIR}${process.env.BOT_STATE_FILE!}` || 'bot_state.json';
const TRADE_FILE =
  process.env.BOT_LOG_FILE?.replace('.log', '_trades.json') || 'trades.json';

console.log(`⚠️ TRADING SYMBOL: ${TRADING_SYMBOL} ⚠️`);
console.log(`📁 STATE FILE: ${STATE_FILE}`);
console.log(`📝 LOG FILE: ${TRADE_FILE}`);

const FIB_CACHE_LIMIT = 5; // Only keep 5 most recent
const FIB_CACHE_TTL = 20 * 60 * 1000; // 20 minutes

function sendToLauncher(type: string, data: any = {}) {
  if (isLauncherManaged && process.send) {
    try {
      process.send({ type, ...data });
    } catch (err) {
      logger.log(`Failed to send IPC message: ${err}`, 'warning');
    }
  }
}

function cleanupFibCache() {
  if (fibMap.size <= FIB_CACHE_LIMIT) return;

  // Get all entries sorted by lock time (oldest first)
  const entries = Array.from(fibMap.entries())
    .filter(([, fib]) => fib !== null)
    .sort(([, a], [, b]) => {
      if (!a || !b) return 0;
      return a.lockedAt.getTime() - b.lockedAt.getTime();
    });

  // Remove oldest entries beyond limit
  const toRemove = entries.slice(0, entries.length - FIB_CACHE_LIMIT);
  toRemove.forEach(([symbol]) => fibMap.delete(symbol));

  if (toRemove.length > 0) {
    logger.log(`🧹 Cleaned ${toRemove.length} old Fib entries`, 'info');
  }
}

// 3️⃣ ADD EXPIRATION for HTF cache
const HTF_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function isHTFCacheStale(): boolean {
  if (!htfCache) return true;
  const age = Date.now() - htfCache.fetchedAt.getTime();
  return age > HTF_CACHE_TTL;
}

// Clear stale HTF cache
function cleanupHTFCache() {
  if (isHTFCacheStale()) {
    htfCache = null;
    logger.log('🧹 Cleared stale HTF cache', 'info');
  }
}

// 4️⃣ FIX: Limit trade log file size
const MAX_TRADE_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TRADE_LOG_LINES = 10000; // Keep last 10k trades

function rotateTradeLogs() {
  try {
    if (!fs.existsSync(TRADE_FILE)) return;

    const stats = fs.statSync(TRADE_FILE);

    // If file is too large, rotate it
    if (stats.size > MAX_TRADE_LOG_SIZE) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = TRADE_FILE.replace('.json', `_${timestamp}.json.gz`);

      // Read last N lines only
      const content = fs.readFileSync(TRADE_FILE, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());

      if (lines.length > MAX_TRADE_LOG_LINES) {
        // Keep only recent trades
        const recentLines = lines.slice(-MAX_TRADE_LOG_LINES);
        fs.writeFileSync(TRADE_FILE, recentLines.join('\n') + '\n');
        logger.log(
          `🗜️ Rotated trade log: kept ${MAX_TRADE_LOG_LINES} recent entries`,
          'info'
        );
      }
    }
  } catch (err) {
    logger.log(`Failed to rotate trade log: ${err}`, 'warning');
  }
}

// 5️⃣ FIX: Clean up position map
function cleanupPositionMap() {
  // Remove positions that are null or very old
  const now = Date.now();
  const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

  let removed = 0;
  positionMap.forEach((pos, symbol) => {
    if (!pos || (pos.entryTime && now - pos.entryTime.getTime() > MAX_AGE)) {
      positionMap.delete(symbol);
      removed++;
    }
  });

  if (removed > 0) {
    logger.log(`🧹 Cleaned ${removed} stale positions from map`, 'info');
  }
}

// 6️⃣ MASTER CLEANUP FUNCTION for bot
function runBotMemoryCleanup() {
  const before = process.memoryUsage();
  const beforeMB = Math.round(before.heapUsed / 1024 / 1024);

  cleanupFibCache();
  cleanupHTFCache();
  cleanupPositionMap();
  rotateTradeLogs();

  // Force GC if available
  if (global.gc) {
    global.gc();
  }

  const after = process.memoryUsage();
  const afterMB = Math.round(after.heapUsed / 1024 / 1024);
  const freedMB = beforeMB - afterMB;

  if (freedMB > 0) {
    logger.log(
      `🧹 Bot cleanup: ${beforeMB}MB → ${afterMB}MB (freed ${freedMB}MB)`,
      'info'
    );
  }
}

// 7️⃣ UPDATE calculateAndLockFibonacci to use cleanup
export function calculateAndLockFibonacci(
  symbol: string,
  lows: number[],
  highs: number[]
): FibonacciLevels {
  let lockedFibLevels = getLockedFib(symbol);

  if (lockedFibLevels) {
    const age = Date.now() - lockedFibLevels.lockedAt.getTime();
    if (age < CONFIG.FIB_LOCK_DURATION_MS) {
      return lockedFibLevels;
    }
  }

  // Cleanup before adding new entry
  cleanupFibCache();

  const lookback = CONFIG.FIB_SWING_LOOKBACK;
  const recentLows = lows.slice(-lookback);
  const recentHighs = highs.slice(-lookback);

  const swingLow = Math.min(...recentLows);
  const swingHigh = Math.max(...recentHighs);
  const diff = swingHigh - swingLow;

  lockedFibLevels = {
    level0: swingLow,
    level236: swingLow + diff * 0.236,
    level382: swingLow + diff * 0.382,
    level500: swingLow + diff * 0.5,
    level618: swingLow + diff * 0.618,
    level786: swingLow + diff * 0.786,
    level100: swingHigh,
    lockedAt: new Date(),
    swingHigh,
    swingLow,
  };

  setLockedFib(symbol, lockedFibLevels);
  saveState();

  return lockedFibLevels;
}

// 8️⃣ UPDATE logTrade to prevent unbounded growth
function logTrade(
  action: 'BUY' | 'SELL' | 'PARTIAL_SELL',
  data: Partial<TradeLog> & {
    price: number;
    amount: number;
    strategy: StrategyId;
  }
) {
  console.log('🔵 BOT SENDING:', {
    entryPrice: data.entryPrice,
    strategy: data.strategy,
    reason: data.reason,
  });
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    positionId: data.positionId || generateId(),
    strategy: data.strategy,
    price: data.price,
    amount: data.amount,
    entryPrice: data.entryPrice,
    pnl: data.pnl ?? '',
    reason: data.reason ?? '',
    holdTime: data.holdTime,
    stopLoss: data.stopLoss,
    takeProfit: data.takeProfit,
  };

  try {
    fs.appendFileSync(TRADE_FILE, JSON.stringify(entry) + '\n');

    // ✅ Check if rotation needed after each write
    const stats = fs.statSync(TRADE_FILE);
    if (stats.size > MAX_TRADE_LOG_SIZE) {
      rotateTradeLogs();
    }
  } catch (err) {
    logger.log(`Failed to write trade log: ${err}`, 'error');
  }

  if (isLauncherManaged) {
    sendToLauncher('trade', {
      action,
      price: data.price,
      amount: data.amount,
      pnl: parseFloat(data.pnl || '0'),
      symbol: CONFIG.SYMBOL,
      strategy: data.strategy,
      entryPrice: data.entryPrice,
      exitPrice: data.price,
      stopLoss: data.stopLoss,
      takeProfit: data.takeProfit,
      reason: data.reason,
      holdTime: data.holdTime,
      entryTime: currentPosition?.entryTime?.toISOString(),
      exitTime: new Date().toISOString(),
    });
  }
}

// 9️⃣ ADD MEMORY MONITORING to bot
let lastMemoryCheck = 0;
const MEMORY_CHECK_INTERVAL = 2 * 60 * 1000; // Every 2 minutes

function checkBotMemory() {
  const now = Date.now();
  if (now - lastMemoryCheck < MEMORY_CHECK_INTERVAL) return;

  lastMemoryCheck = now;

  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);

  // Warn if bot is using more than 200MB
  if (heapMB > 200) {
    logger.log(
      `⚠️ Bot memory HIGH: Heap ${heapMB}MB, RSS ${rssMB}MB`,
      'warning'
    );
    logger.log(`   Fib cache: ${fibMap.size} entries`, 'info');
    logger.log(`   Position map: ${positionMap.size} entries`, 'info');

    // Run cleanup
    runBotMemoryCleanup();
  }
}

function newId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

let fibMap = new Map<string, FibonacciLevels | null>();
function getLockedFib(symbol: string): FibonacciLevels | null {
  if (fibMap.has(symbol)) {
    return fibMap.get(symbol)!; // ✅ Use non-null assertion
  }
  return null; // ✅ Explicit return
}

function setLockedFib(symbol: string, fib: FibonacciLevels) {
  fibMap && fibMap.set(symbol, fib);
}

// ---------- STATE ----------
let currentPosition: Position | null = null;

// ---------- EXCHANGE INIT ----------
if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
  throw Error('Missing BINANCE_API_KEY or BINANCE_API_SECRET');
}

export const binance = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_API_SECRET,
  enableRateLimit: true,
  timeout: 60000,
  options: {
    defaultType: 'spot',
  },
});

export async function fetchCurrentPrice(symbol: string): Promise<number> {
  try {
    // Option A: Using fetchTicker (most common)
    const ticker = await binance.fetchTicker(symbol);
    return ticker.average || ticker.last || ticker.close || ticker.bid || 0;

    // Option B: Using fetchOrderBook (more precise but slower)
    // const orderbook = await binance.fetchOrderBook(symbol);
    // return (orderbook.bids[0][0] + orderbook.asks[0][0]) / 2;
  } catch (err: any) {
    logger.log(
      `❌ Failed to fetch price for ${symbol}: ${err.message}`,
      'error'
    );
    throw err;
  }
}

function roundToStepSize(amount: number, decimals: number): number {
  // Round to specified decimal places
  const multiplier = Math.pow(10, decimals);
  return Math.floor(amount * multiplier) / multiplier;
}

// Alternative: More robust version with step size
// function roundToStepSize(
//   amount: number,
//   stepSize: number = 0.000001
// ): number {
//   // Round down to nearest step size
//   return Math.floor(amount / stepSize) * stepSize;
// }

async function getSymbolPrecision(symbol: string): Promise<{
  amountDecimals: number;
  priceDecimals: number;
  minAmount: number;
  stepSize: number;
}> {
  try {
    const markets = await binance.loadMarkets();
    const market = markets[symbol];

    if (!market) {
      throw new Error(`Market ${symbol} not found`);
    }

    return {
      amountDecimals: market.precision.amount || 8,
      priceDecimals: market.precision.price || 8,
      minAmount: market.limits.amount?.min || 0.000001,
      stepSize: market.precision.amount || 0.000001,
    };
  } catch (err: any) {
    logger.log(
      `⚠️ Failed to load precision for ${symbol}, using defaults`,
      'warning'
    );
    return {
      amountDecimals: 8,
      priceDecimals: 8,
      minAmount: 0.000001,
      stepSize: 0.000001,
    };
  }
}

function setupIPCHandlers() {
  if (!isLauncherManaged) return;

  process.on('message', async (msg: any) => {
    if (msg.type === 'execute_entry') {
      const { signal, price, confidence, allocatedCapital, maxPositionValue } =
        msg;

      logger.log(`📨 Entry command received:`, 'info');
      logger.log(`   Signal: ${signal.strategyId}`, 'info');
      logger.log(`   Side: ${signal.side}`, 'info');
      logger.log(
        `   Allocated Capital: ${allocatedCapital?.toFixed(2)} USDT`,
        'info'
      ); // ✅ NEW
      logger.log(
        `   Max Position Value: ${maxPositionValue?.toFixed(2)} USDT`,
        'info'
      ); // ✅ NEW

      try {
        // ✅ Use allocated capital to calculate position size
        await executeEntry(
          signal,
          allocatedCapital || 76,
          maxPositionValue || 72
        );
      } catch (err: any) {
        logger.log(`❌ Entry failed: ${err.message}`, 'error');

        // ✅ Notify launcher of failure so it can release capital
        process.send?.({
          type: 'entry_failed',
          symbol: signal.symbol,
          reason: err.message,
        });
      }
    }
    switch (msg.type) {
      case 'health_check':
        sendToLauncher('health', {
          status: currentPosition ? 'in_position' : 'scanning',
          uptime: Date.now() - sessionStartTime,
          trades: tradesThisSession,
          pnl: sessionRealizedPnlUsd,
        });
        break;

      // ✅ NEW: Receive candle data from launcher
      case 'candle_data':
        // Store received candle data instead of fetching independently
        // This eliminates need for bot-level CandleManager
        break;

      case 'execute_entry':
        if (currentPosition) {
          logger.log(
            '⚠️ Already in position - ignoring entry command',
            'warning'
          );
          sendToLauncher('error', { error: 'Already in position' });
          break;
        }

        logger.log(`\n🎯 RECEIVED ENTRY COMMAND FROM LAUNCHER`, 'success');
        logger.log(`   Signal: ${msg.signal?.strategyId}`, 'info');
        logger.log(`   Price: ${msg.price}`, 'info');
        logger.log(
          `   Confidence: ${(msg.confidence * 100).toFixed(0)}%`,
          'info'
        );
        logger.log(
          `   Max Capital: $${msg.maxCapital?.toFixed(2) || 'N/A'}`,
          'info'
        ); // ✅ ADD THIS

        // Execute entry asynchronously
        (async () => {
          try {
            // ✅ Use the capital limit sent by launcher
            const maxCapital =
              msg.maxCapital || CAPITAL_CONFIG.PER_BOT_ALLOCATION;

            await placeMarketBuy(
              maxCapital, // ✅ Pass max capital instead of full balance
              CONFIG.SYMBOL,
              msg.price,
              msg.signal.stopLoss,
              msg.signal.takeProfit,
              msg.signal.strategy,
              msg.signal.reason
            );
          } catch (err: any) {
            logger.log(`❌ Entry execution failed: ${err.message}`, 'error');
            sendToLauncher('error', { error: err.message });
          }
        })();
        break;

      case 'stop':
      case 'restart':
        logger.log('Received stop/restart from launcher', 'warning');
        // ✅ Run final cleanup before exit
        runBotMemoryCleanup();
        saveState();
        process.exit(0);
    }
  });
}

async function executeEntry(
  signal: EntrySignal,
  allocatedCapital: number,
  maxPositionValue: number
): Promise<void> {
  const currentPrice = signal && (await fetchCurrentPrice(signal.symbol));

  logger.log(`\n🚀 EXECUTING ENTRY`, 'success');
  logger.log(`   Symbol: ${signal?.symbol}`, 'info');
  logger.log(`   Price: ${currentPrice?.toFixed(4)}`, 'info');
  logger.log(
    `   Allocated Capital: ${allocatedCapital.toFixed(2)} USDT`,
    'info'
  );

  if (!currentPrice) {
    throw new Error('no current price');
  }
  // ✅ Calculate position size based on ALLOCATED CAPITAL
  const maxAmount = maxPositionValue / currentPrice;

  let stopLoss: number;
  let takeProfit: number;
  const LEVERAGE = 3;
  const RISK_PERCENT = 0.01; // 1% position risk
  const priceStopPercent = RISK_PERCENT / LEVERAGE; // 0.333%

  if (signal.side === 'LONG') {
    stopLoss = currentPrice * (1 - priceStopPercent); // 0.333% below
    takeProfit = currentPrice * (1 + priceStopPercent * 3); // 1% above
  } else {
    // SHORT
    stopLoss = currentPrice * (1 + priceStopPercent); // 0.333% above
    takeProfit = currentPrice * (1 - priceStopPercent * 3); // 1% below
  }
  // Calculate amount based on risk (optional)

  const riskPerUnit = Math.abs(currentPrice - stopLoss);
  const riskBasedAmount = (allocatedCapital * 0.02) / riskPerUnit; // 2% risk

  // ✅ Use the SMALLER of the two (more conservative)
  let amount = Math.min(maxAmount, riskBasedAmount);

  // Round to exchange precision
  // amount = roundToStepSize(amount, CONFIG.amountDecimals);

  const ratioTp1Tp2 = CONFIG.PARTIAL_TP1_R / CONFIG.PARTIAL_TP2_R;

  const totalCost = amount * currentPrice;

  logger.log(`📊 Position Sizing:`, 'info');
  logger.log(`   Max amount (capital limit): ${maxAmount.toFixed(6)}`, 'info');
  logger.log(`   Risk-based amount: ${riskBasedAmount.toFixed(6)}`, 'info');
  logger.log(`   Final amount: ${amount.toFixed(6)}`, 'info');
  logger.log(`   Total cost: ${totalCost.toFixed(2)} USDT`, 'info');
  logger.log(`   Capital limit: ${maxPositionValue.toFixed(2)} USDT`, 'info');

  // ✅ Validate against limit
  if (totalCost > maxPositionValue) {
    throw new Error(
      `Position size ${totalCost.toFixed(2)} exceeds limit ${maxPositionValue.toFixed(2)}`
    );
  }

  // ✅ Validate we have enough balance
  const balance = await binance.fetchBalance();
  const availableUSDT = balance.USDT?.free || 0;

  if (totalCost > availableUSDT) {
    throw new Error(
      `Insufficient balance: need ${totalCost.toFixed(2)}, have ${availableUSDT.toFixed(2)}`
    );
  }

  // Place order
  logger.log(`📤 Placing market BUY order...`, 'info');
  // const order =
  //   signal &&
  //   ((await binance.createMarketOrder(
  //     signal.symbol.replace('/', ''),
  //     'BUY',
  //     amount
  //   )) as Order);

  const order = await binance.fetchTicker(signal.symbol);

  logger.log(`✅ Order filled!`, 'success');
  logger.log(`   Amount: ${amount.toFixed(6)}`, 'success');
  logger.log(`   Avg Price: ${order.average?.toFixed(4)}`, 'success');
  logger.log(`   Total Cost: ${totalCost.toFixed(2)} USDT`, 'success');

  const entryPrice = order.average as number;

  const tokenAmount = allocatedCapital / entryPrice;
  const partSold = tokenAmount * ratioTp1Tp2;
  const remainingAmount = tokenAmount - partSold;
  // Set position
  currentPosition = {
    symbol: signal?.symbol,
    entryPrice: order.average || 0,
    amount: tokenAmount,
    remainingAmount: remainingAmount,
    takeProfit: takeProfit,
    entryTime: new Date(),
    strategy: signal.strategy,
    partialsSold: partSold,
    currentPrice: currentPrice,
    stopLoss: stopLoss,
    pnlUsd: (currentPrice - entryPrice) * remainingAmount,
    pnlPct: ((currentPrice - entryPrice) / entryPrice!) * 100,
    positionId: generateId(),
    allocatedCapital, // ✅ Store for reference
    side: 'SPOT',
  };

  saveState();
}

let sessionStartTime = Date.now();

// ---------- LOGGING ----------
function log(
  msg: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info'
) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  console.log(`[${new Date().toISOString()}] ${icons[type]} ${msg}`);
}

// Later in your code, after some trading logic
function checkCurrentPosition() {
  if (currentPosition) {
    return getLockedFib(currentPosition.symbol);
    // Use fib...
  }
  return null;
}

// ---------- STATE PERSISTENCE ----------
export function saveState() {
  const fib = currentPosition ? getLockedFib(currentPosition.symbol) : null;
  const state = {
    symbol: CONFIG.SYMBOL, // ✅ Add this for validation
    currentPosition: currentPosition
      ? {
          ...currentPosition,
          entryTime: currentPosition.entryTime.toISOString(),
        }
      : null,
    sessionRealizedPnlUsd,
    sessionStartBalance,
    tradesThisSession,
    paperBalance,
    lockedFibLevels: fib
      ? {
          ...fib,
          lockedAt: fib.lockedAt.toISOString(),
        }
      : null,
    cooldown: {
      ...cooldown,
      until: cooldown.until?.toISOString() || null,
    },
    savedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.log(`💾 State saved to ${STATE_FILE}`, 'info');
  } catch (err) {
    logger.log(`Failed to save state: ${err}`, 'error');
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));

      // ✅ CRITICAL: Validate that loaded state matches our current symbol
      if (data.currentPosition) {
        if (data.currentPosition.symbol !== CONFIG.SYMBOL) {
          logger.log(
            `⚠️ State file contains position for ${data.currentPosition.symbol}, but we're trading ${CONFIG.SYMBOL}`,
            'warning'
          );
          logger.log(`   Ignoring old state - starting fresh`, 'warning');
          return; // Don't load mismatched state
        }

        currentPosition = {
          ...data.currentPosition,
          entryTime: new Date(data.currentPosition.entryTime),
        };
        logger.log(
          `✅ Restored position: ${currentPosition?.remainingAmount} ${CONFIG.SYMBOL.split('/')[0]} @ ${currentPosition?.entryPrice}`,
          'warning'
        );
      }

      // ✅ Load fib levels only if they match our symbol
      if (data.lockedFibLevels) {
        const fib = {
          ...data.lockedFibLevels,
          lockedAt: new Date(data.lockedFibLevels.lockedAt),
        };
        setLockedFib(CONFIG.SYMBOL, fib); // Use CONFIG.SYMBOL explicitly
      }

      if (data.cooldown?.until) {
        cooldown = {
          ...data.cooldown,
          until: new Date(data.cooldown.until),
        };
      }

      sessionRealizedPnlUsd = data.sessionRealizedPnlUsd || 0;
      tradesThisSession = data.tradesThisSession || 0;
      paperBalance = data.paperBalance || CONFIG.INITIAL_PAPER_BALANCE;

      logger.log(`✅ State restored from ${STATE_FILE}`, 'success');
    } else {
      logger.log(
        `📝 No existing state file found at ${STATE_FILE} - starting fresh`,
        'info'
      );
    }
  } catch (err) {
    logger.log(`Failed to load state: ${err}`, 'warning');
    logger.log(`   Starting with clean state for ${CONFIG.SYMBOL}`, 'info');
  }
}

function initializeTradeLog() {
  if (!fs.existsSync(TRADE_FILE)) {
    fs.writeFileSync(TRADE_FILE, '');
    logger.log('trades.json initialized', 'success');
  }
}

let currentStrategy: 'EMA_PULLBACK' | 'FIB_RETRACEMENT' | 'HYBRID' =
  'EMA_PULLBACK';
let currentPositionId: string | null = null;

function activateCooldown(reason: string, isLoss: boolean) {
  if (isLoss) {
    cooldown.consecutiveLosses++;
    const duration =
      cooldown.consecutiveLosses >= 2
        ? CONFIG.COOLDOWN_AFTER_CONSECUTIVE_LOSSES_MS
        : CONFIG.COOLDOWN_AFTER_LOSS_MS;

    cooldown.until = new Date(Date.now() + duration);
    cooldown.reason = reason;

    logger.log(
      `🧊 Cooldown activated: ${duration / 60000} min (${cooldown.consecutiveLosses} consecutive losses)`,
      'warning'
    );

    if (cooldown.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
      logger.log(
        `🛑 Max consecutive losses (${CONFIG.MAX_CONSECUTIVE_LOSSES}) reached - extended cooldown`,
        'error'
      );
    }

    // ✅ ADD THIS: Notify launcher
    sendToLauncher('cooldown', {
      reason,
      duration: duration / 60000,
      consecutiveLosses: cooldown.consecutiveLosses,
    });
  }
  saveState();
}

function resetCooldownOnWin() {
  if (cooldown.consecutiveLosses > 0) {
    logger.log(`🔥 Win streak started - resetting loss counter`, 'success');
  }
  cooldown.consecutiveLosses = 0;
  cooldown.until = null;
  cooldown.reason = '';
  saveState();
}

function isInCooldown(): boolean {
  if (!cooldown.until) return false;
  if (new Date() > cooldown.until) {
    logger.log(`✅ Cooldown expired`, 'success');
    cooldown.until = null;
    cooldown.reason = '';
    saveState();
    return false;
  }
  const remaining = Math.ceil((cooldown.until.getTime() - Date.now()) / 60000);
  logger.log(
    `🧊 In cooldown: ${remaining} min remaining (${cooldown.reason})`,
    'warning'
  );
  return true;
}

// ---------- DRAWDOWN CHECK ----------
function checkDrawdownLimit(): boolean {
  if (sessionStartBalance <= 0) return false;
  const drawdownPct =
    Math.abs(Math.min(0, sessionRealizedPnlUsd)) / sessionStartBalance;
  if (drawdownPct >= SESSION_CONFIG.MAX_DRAWDOWN_PCT) {
    logger.log(
      `🛑 DRAWDOWN LIMIT: ${(drawdownPct * 100).toFixed(2)}% loss`,
      'error'
    );
    return true;
  }
  return false;
}

// ✅ 1. CAPITAL CONFIG (should match launcher)
const CAPITAL_CONFIG = {
  TOTAL_CAPITAL: parseFloat(process.env.TOTAL_CAPITAL || '200'),
  BACKUP_RESERVE_PCT: parseFloat(process.env.BACKUP_RESERVE_PCT || '0.1'),
  MAX_POSITION_COUNT: parseFloat(process.env.MAX_CONCURRENT_POSITIONS || '2'),

  get TRADING_CAPITAL() {
    return this.TOTAL_CAPITAL * (1 - this.BACKUP_RESERVE_PCT);
  },

  get PER_BOT_ALLOCATION() {
    return this.TRADING_CAPITAL / this.MAX_POSITION_COUNT;
  },

  get MAX_POSITION_VALUE() {
    return this.PER_BOT_ALLOCATION * 0.95; // 95% max for safety
  },

  get MIN_POSITION_VALUE() {
    return this.PER_BOT_ALLOCATION * 0.1; // At least 10% of allocation
  },
};

// bot-spot.ts - Independent configuration
const BOT_CONFIG = {
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),
  totalCapital: parseFloat(process.env.TOTAL_CAPITAL || '200'),

  get perBotAllocation() {
    const tradingCapital = this.totalCapital * 0.9; // 10% reserve
    return tradingCapital / this.maxConcurrentPositions;
  },
};

async function getUsdtBalance(): Promise<number> {
  if (process.env.PAPER_TRADING === 'true') {
    logger.log(`Paper Balance: ${paperBalance.toFixed(2)} USDT`, 'info');
    return CAPITAL_CONFIG.TRADING_CAPITAL;
  }
  try {
    const balances = await binance.fetchBalance();
    const usdt = balances['USDT'];

    if (!usdt) {
      logger.log('USDT balance not found', 'warning');
      return 0;
    }

    const total = usdt?.total ?? usdt?.free ?? usdt?.used ?? 0;
    logger.log(`USDT Balance: ${total.toFixed(2)}`, 'info');
    return total;
  } catch (err) {
    logger.log(`Failed to fetch balance: ${err}`, 'error');
    return 0;
  }
}

// ---------- ENTRY STRATEGIES ----------
function emaPullbackEntry(
  ind: Indicators,
  regime: Regime
): { ok: boolean; reason: string; confidence: number } {
  const uptrend = ind.ema50 > ind.ema200;
  const nearEma = Math.abs(ind.currentPrice - ind.ema50) / ind.ema50 < 0.01;
  const aboveEma = ind.currentPrice > ind.ema50;
  const rsiOk = ind.rsi > 40 && ind.rsi < 60;

  let confidence = 0;
  if (uptrend) confidence += 0.3;
  if (aboveEma && nearEma) confidence += 0.3;
  if (rsiOk) confidence += 0.2;
  if (regime.trend === 'UP') confidence += 0.2;

  const ok = uptrend && aboveEma && nearEma && rsiOk;

  // FIX: Dynamic decimals based on price
  const decimals = ind.ema50 < 1 ? 4 : ind.ema50 < 100 ? 2 : 0;

  return {
    ok,
    reason: ok
      ? `EMA50 bounce @ ${ind.ema50.toFixed(decimals)}, RSI=${ind.rsi.toFixed(1)}`
      : 'Conditions not met',
    confidence: ok ? confidence : 0,
  };
}

function fibRetracementEntry(
  ind: Indicators,
  fib: FibonacciLevels,
  closes: number[]
): { ok: boolean; reason: string; confidence: number } {
  if (closes.length < 2)
    return { ok: false, reason: 'Insufficient data', confidence: 0 };

  const prev = closes[closes.length - 2]!;
  const uptrend = ind.ema50 > ind.ema200;
  const levels = [
    { name: '38.2%', value: fib.level382 },
    { name: '50%', value: fib.level500 },
    { name: '61.8%', value: fib.level618 },
  ];

  let hitLevel: string | null = null;
  for (const lvl of levels) {
    if (
      Math.abs(ind.currentPrice - lvl.value) / lvl.value < 0.005 &&
      ind.currentPrice > prev
    ) {
      hitLevel = lvl.name;
      break;
    }
  }

  const bounce = hitLevel !== null;
  const rsiLow = ind.rsi < 45;

  let confidence = 0;
  if (uptrend) confidence += 0.3;
  if (bounce) confidence += 0.4;
  if (rsiLow) confidence += 0.3;

  const ok = uptrend && bounce && rsiLow;
  return {
    ok,
    reason: ok
      ? `Fib ${hitLevel} bounce, RSI=${ind.rsi.toFixed(1)}`
      : 'No fib setup',
    confidence: ok ? confidence : 0,
  };
}

function breakoutEntry(
  ind: Indicators,
  closes: number[],
  volumes: number[]
): { ok: boolean; reason: string; confidence: number } {
  if (closes.length < 20 || volumes.length < 20)
    return { ok: false, reason: 'Insufficient data', confidence: 0 };

  const recent20High = Math.max(...closes.slice(-20, -1));
  const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  const currentVol = volumes[volumes.length - 1]!;
  const volConfirm = currentVol > avgVol * 1.5;
  const breaking = ind.currentPrice > recent20High;
  const rsiOk = ind.rsi > 50 && ind.rsi < 70;

  let confidence = 0;
  if (breaking) confidence += 0.4;
  if (rsiOk) confidence += 0.3;
  if (volConfirm) confidence += 0.3;

  const ok = breaking && rsiOk && volConfirm;
  return {
    ok,
    reason: ok
      ? `Breakout above ${recent20High.toFixed(0)} +vol`
      : 'No breakout',
    confidence: ok ? confidence : 0,
  };
}

function checkShortStrategies(
  ind: Indicators,
  fib: FibonacciLevels,
  regime: Regime,
  closes: number[],
  volumes: number[]
): EntrySignal | null {
  // Example short strategies:

  // 1. EMA Resistance Short
  const nearEmaResistance =
    Math.abs(ind.currentPrice - ind.ema50) / ind.ema50 < 0.01;
  const belowEma = ind.currentPrice < ind.ema50;
  const rsiOverbought = ind.rsi > 65;

  if (nearEmaResistance && belowEma && rsiOverbought) {
    const riskPerUnit = ind.atr * CONFIG.ATR_STOP_MULTIPLIER;
    return {
      symbol: CONFIG.SYMBOL,
      strategy: 'SHORT_EMA_RESISTANCE',
      reason: `Short at EMA50 resistance, RSI=${ind.rsi.toFixed(1)}`,
      side: 'SHORT',
      confidence: 0.6,
      stopLoss: ind.currentPrice + riskPerUnit,
      takeProfit: ind.currentPrice - riskPerUnit * 2.5,
    };
  }

  // 2. Fib Resistance Short
  const fibResistanceLevels = [fib.level618, fib.level500, fib.level382];
  let hitFibResistance: string | null = null;

  for (const [level, value] of [
    ['61.8%', fib.level618],
    ['50%', fib.level500],
    ['38.2%', fib.level382],
  ] as const) {
    if (Math.abs(ind.currentPrice - value) / value < 0.005) {
      hitFibResistance = level;
      break;
    }
  }

  if (hitFibResistance && ind.rsi > 60) {
    const riskPerUnit = ind.atr * CONFIG.ATR_STOP_MULTIPLIER;
    return {
      symbol: CONFIG.SYMBOL,
      strategy: 'SHORT_FIB_RESISTANCE',
      reason: `Short at Fib ${hitFibResistance} resistance, RSI=${ind.rsi.toFixed(1)}`,
      side: 'SHORT',
      confidence: 0.7,
      stopLoss: ind.currentPrice + riskPerUnit,
      takeProfit: ind.currentPrice - riskPerUnit * 2.0,
    };
  }

  return null;
}

export function pickEntryStrategy(
  symbol: string,
  ind: Indicators,
  fib: FibonacciLevels,
  regime: Regime,
  closes: number[],
  volumes: number[],
  htf: HTFConfirmation
): EntrySignal | null {
  // ===== HTF FILTER (STRICT FOR SPOT) =====
  if (htf.trend === 'DOWN') {
    const bearishGap = ((htf.ema200 - htf.ema50) / htf.ema200) * 100;
    if (bearishGap > 6) {
      logger.log(
        `🛑 HTF strongly bearish (${bearishGap.toFixed(1)}% gap) - skip`,
        'warning'
      );
      return null;
    }
    logger.log(
      `⚠️ HTF bearish but weak (${bearishGap.toFixed(1)}% gap) - proceeding`,
      'warning'
    );
  }

  if (htf.rsi < 40) {
    logger.log(
      `🛑 HTF RSI too low (${htf.rsi.toFixed(1)}) - momentum weak`,
      'warning'
    );
    return null;
  }

  logger.log(
    `✅ HTF confirmed bullish (${htf.trend}, RSI: ${htf.rsi.toFixed(1)})`,
    'success'
  );

  // ===== 15M LTF FILTERS =====
  if (regime.trend === 'CHOP' || regime.volatility === 'HIGH') {
    logger.log(
      `🛑 Skip: ${regime.trend} trend, ${regime.volatility} vol on 15m`,
      'warning'
    );
    return null;
  }

  if (ind.ema50 <= ind.ema200 && regime.trend !== 'UP') {
    logger.log(
      `🛑 Skip: 15m not in uptrend (EMA50=${ind.ema50.toFixed(0)} <= EMA200=${ind.ema200.toFixed(0)})`,
      'warning'
    );
    return null;
  }

  const riskPerUnit = ind.atr * CONFIG.ATR_STOP_MULTIPLIER;

  // ===== STRATEGY 1: EMA PULLBACK =====
  const ema = emaPullbackEntry(ind, regime);
  if (ema.ok) {
    const sl = ind.currentPrice - riskPerUnit;
    return {
      symbol,
      strategy: 'EMA_PULLBACK',
      side: 'SPOT',
      reason: ema.reason + ` [HTF: ${htf.trend}]`,
      confidence: ema.confidence,
      stopLoss: sl,
      takeProfit: ind.currentPrice + riskPerUnit * CONFIG.PARTIAL_TP2_R,
    };
  }

  // ===== STRATEGY 2: FIB RETRACEMENT =====
  const fibSig = fibRetracementEntry(ind, fib, closes);
  if (fibSig.ok) {
    const sl = ind.currentPrice - riskPerUnit * 1.3;
    return {
      symbol,
      strategy: 'FIB_RETRACEMENT',
      reason: fibSig.reason + ` [HTF: ${htf.trend}]`,
      side: 'SPOT',
      confidence: fibSig.confidence,
      stopLoss: sl,
      takeProfit: ind.currentPrice + riskPerUnit * 3.0,
    };
  }

  // ===== STRATEGY 3: OVERSOLD BOUNCE (ONLY IN UPTRENDS) =====
  if (closes.length >= 3 && regime.trend === 'UP' && ind.rsi < 40) {
    const bouncing = ind.currentPrice > closes[closes.length - 2]!;
    const recentLow = Math.min(...closes.slice(-10));

    if (bouncing && ind.currentPrice > recentLow * 1.002) {
      logger.log(
        `🎯 Oversold bounce in uptrend: RSI=${ind.rsi.toFixed(1)}`,
        'success'
      );
      const sl = ind.currentPrice - riskPerUnit * 1.2;
      return {
        symbol,
        strategy: 'RSI_DIVERGENCE',
        side: 'SPOT',
        reason: `Oversold bounce RSI=${ind.rsi.toFixed(1)} [HTF: ${htf.trend}]`,
        confidence: 0.6,
        stopLoss: sl,
        takeProfit: ind.currentPrice + riskPerUnit * 2.0,
      };
    }
  }

  // ===== STRATEGY 4: BREAKOUT =====
  if (regime.trend === 'UP') {
    const brk = breakoutEntry(ind, closes, volumes);
    if (brk.ok) {
      const sl = ind.currentPrice - riskPerUnit * 0.8;
      return {
        symbol,
        strategy: 'BREAKOUT',
        side: 'SPOT',
        reason: brk.reason + ` [HTF: ${htf.trend}]`,
        confidence: brk.confidence,
        stopLoss: sl,
        takeProfit: ind.currentPrice + riskPerUnit * 3.0,
      };
    }
  }

  return null;
}

// ✅ 2. FIXED POSITION SIZE CALCULATION
async function calculatePositionSize(
  balance: number,
  symbol: string,
  riskPct: number,
  entry: number,
  sl: number
): Promise<number> {
  const MIN_COST_USDT = 5;

  if (balance <= 0) {
    logger.log(`❌ Invalid balance: ${balance}`, 'error');
    return 0;
  }

  const riskPerUnit = Math.abs(entry - sl);
  if (riskPerUnit <= 0) {
    logger.log(
      `❌ Invalid risk calculation: entry=${entry}, sl=${sl}`,
      'error'
    );
    return 0;
  }

  try {
    const markets = await binance.loadMarkets();
    const market = markets[symbol];
    if (!market) {
      logger.log(`❌ Market ${symbol} not found`, 'error');
      return 0;
    }

    const minAmount = market.limits?.amount?.min ?? 0.001;
    const baseCurrency = symbol.split('/')[0];

    let amountPrecision: number;
    if (market.precision?.amount && market.precision.amount < 1) {
      amountPrecision = Math.abs(Math.log10(market.precision.amount));
    } else {
      amountPrecision = market.precision?.amount ?? 8;
    }

    logger.log(
      `📊 Market limits: min=${minAmount} ${baseCurrency}, precision=${amountPrecision} decimals`,
      'info'
    );

    // ✅ NEW APPROACH: Use TARGET_ALLOCATION instead of just risk
    const TARGET_ALLOCATION = 0.9; // Use 90% of available balance
    const targetInvestment = balance * TARGET_ALLOCATION;

    // Calculate size based on target investment
    let size = targetInvestment / entry;

    logger.log(
      `💰 Target investment: ${targetInvestment.toFixed(2)} USDT (${TARGET_ALLOCATION * 100}% of ${balance.toFixed(2)})`,
      'info'
    );
    logger.log(`📐 Initial size: ${size.toFixed(8)} ${baseCurrency}`, 'info');

    // Validate against risk tolerance
    const riskAmount = size * riskPerUnit;
    const riskPctActual = (riskAmount / balance) * 100;

    logger.log(
      `⚠️  Risk check: ${riskAmount.toFixed(2)} USDT (${riskPctActual.toFixed(2)}%)`,
      'info'
    );

    // ✅ If risk is too high, scale down position
    const MAX_RISK_PCT = riskPct * 100; // e.g., 2%
    if (riskPctActual > MAX_RISK_PCT) {
      const scaleFactor = MAX_RISK_PCT / riskPctActual;
      size = size * scaleFactor;
      logger.log(
        `⚠️  Risk too high (${riskPctActual.toFixed(2)}% > ${MAX_RISK_PCT}%), scaling down by ${(scaleFactor * 100).toFixed(0)}%`,
        'warning'
      );
    }

    // Apply exchange precision
    const multiplier = Math.pow(10, amountPrecision);
    size = Math.floor(size * multiplier) / multiplier;

    logger.log(
      `🔧 After precision rounding: ${size.toFixed(amountPrecision)} ${baseCurrency}`,
      'info'
    );

    // Check exchange minimum
    if (size < minAmount) {
      logger.log(
        `❌ Size ${size.toFixed(amountPrecision)} < exchange minimum ${minAmount}`,
        'error'
      );
      return 0;
    }

    // Check minimum notional value
    const notionalValue = size * entry;
    if (notionalValue < MIN_COST_USDT) {
      logger.log(
        `❌ Notional value ${notionalValue.toFixed(2)} USDT < minimum ${MIN_COST_USDT} USDT`,
        'error'
      );
      return 0;
    }

    // Final sanity check
    if (notionalValue > balance * 0.95) {
      const maxSize = (balance * 0.95) / entry;
      const maxSizeRounded = Math.floor(maxSize * multiplier) / multiplier;
      logger.log(
        `⚠️  Position capped at 95% of balance: ${maxSizeRounded.toFixed(amountPrecision)} ${baseCurrency}`,
        'warning'
      );
      size = maxSizeRounded;
    }

    const finalNotional = size * entry;
    logger.log(
      `✅ Final position: ${size.toFixed(amountPrecision)} ${baseCurrency} = ${finalNotional.toFixed(2)} USDT (${((finalNotional / balance) * 100).toFixed(1)}% of balance)`,
      'success'
    );

    return size;
  } catch (err) {
    logger.log(`❌ Position sizing failed: ${err}`, 'error');
    return 0;
  }
}

// Initialize stats
let botStats: BotStats = {
  wins: 0,
  losses: 0,
  totalTrades: 0,
  winRate: 0,
  sessionPnl: 0,
  avgWin: 0,
  avgLoss: 0,
};

// Load stats from state
function loadStats() {
  try {
    const STATES_DIR = './data/states/spot';
    const statsFile = `${STATES_DIR}/${STATE_FILE.replace('_state.json', '_stats.json')}`;
    if (fs.existsSync(statsFile)) {
      const data = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
      botStats = data;
      logger.log(
        `📊 Loaded stats: ${botStats.wins}W/${botStats.losses}L (${botStats.winRate.toFixed(1)}% WR)`,
        'info'
      );
    }
  } catch (err) {
    logger.log(`Failed to load stats: ${err}`, 'warning');
  }
}

// Save stats
function saveStats() {
  try {
    const STATES_DIR = './data/states/spot';
    const statsFile = `${STATES_DIR}/${STATE_FILE.replace('_state.json', '_stats.json')}`;
    fs.writeFileSync(statsFile, JSON.stringify(botStats, null, 2));
  } catch (err) {
    logger.log(`Failed to save stats: ${err}`, 'error');
  }
}

// Update stats after trade
function updateStats(pnlUsd: number) {
  botStats.totalTrades++;

  if (pnlUsd > 0) {
    botStats.wins++;
    botStats.avgWin =
      (botStats.avgWin * (botStats.wins - 1) + pnlUsd) / botStats.wins;
  } else {
    botStats.losses++;
    botStats.avgLoss =
      (botStats.avgLoss * (botStats.losses - 1) + Math.abs(pnlUsd)) /
      botStats.losses;
  }

  botStats.sessionPnl += pnlUsd;
  botStats.winRate =
    botStats.totalTrades > 0 ? (botStats.wins / botStats.totalTrades) * 100 : 0;

  saveStats();

  logger.log(
    `📊 Stats: ${botStats.wins}W/${botStats.losses}L (${botStats.winRate.toFixed(1)}% WR) | Avg W: +$${botStats.avgWin.toFixed(2)} | Avg L: -$${botStats.avgLoss.toFixed(2)}`,
    'info'
  );
}

// ✅ 3. ENTRY VALIDATION BEFORE EXECUTION
async function validateEntry(
  signal: EntrySignal,
  currentPrice: number
): Promise<{ valid: boolean; reason: string }> {
  // Check 1: Signal validity
  if (!signal || !signal.symbol) {
    return { valid: false, reason: 'Invalid signal' };
  }

  // Check 2: Price validity
  if (!currentPrice || currentPrice <= 0 || !Number.isFinite(currentPrice)) {
    return { valid: false, reason: `Invalid price: ${currentPrice}` };
  }

  // Check 3: Stop loss validity
  if (!signal.stopLoss || signal.stopLoss <= 0) {
    return { valid: false, reason: 'Invalid stop loss' };
  }

  const stopDistance = Math.abs(currentPrice - signal.stopLoss);
  const stopPct = (stopDistance / currentPrice) * 100;

  if (stopPct > 20) {
    return { valid: false, reason: `Stop too far: ${stopPct.toFixed(1)}%` };
  }

  if (stopPct < 0.5) {
    return { valid: false, reason: `Stop too tight: ${stopPct.toFixed(1)}%` };
  }

  // Check 4: Position count (ask launcher)
  const canEnter = await checkLauncherPositionLimit();
  if (!canEnter) {
    return { valid: false, reason: 'Position limit reached' };
  }

  return { valid: true, reason: 'All checks passed' };
}

// ✅ 4. ASK LAUNCHER FOR PERMISSION
async function checkLauncherPositionLimit(): Promise<boolean> {
  return new Promise((resolve) => {
    // Send request to launcher
    if (process.send) {
      process.send({
        type: 'position_check_request',
        symbol: CONFIG.SYMBOL,
        timestamp: Date.now(),
      });
    }

    // Set timeout (if no response in 5s, assume OK)
    const timeout = setTimeout(() => {
      logger.log('⚠️ No response from launcher, proceeding', 'warning');
      resolve(true);
    }, 5000);

    // Listen for response
    const handler = (msg: any) => {
      if (msg.type === 'position_check_response') {
        clearTimeout(timeout);
        process.off('message', handler);
        resolve(msg.canEnter || false);
      }
    };

    process.on('message', handler);
  });
}

// ✅ 6. VALIDATION LOGGING
function logPositionValidation() {
  logger.log('📊 Position Limits:', 'info');
  logger.log(
    `   Total Capital: $${CAPITAL_CONFIG.TOTAL_CAPITAL.toFixed(2)}`,
    'info'
  );
  logger.log(
    `   Trading Capital: $${CAPITAL_CONFIG.TRADING_CAPITAL.toFixed(2)}`,
    'info'
  );
  logger.log(`   Max Positions: ${CAPITAL_CONFIG.MAX_POSITION_COUNT}`, 'info');
  logger.log(
    `   Per Position: $${CAPITAL_CONFIG.PER_BOT_ALLOCATION.toFixed(2)}`,
    'info'
  );
  logger.log(
    `   Max Size: $${CAPITAL_CONFIG.MAX_POSITION_VALUE.toFixed(2)}`,
    'info'
  );
  logger.log(
    `   Min Size: $${CAPITAL_CONFIG.MIN_POSITION_VALUE.toFixed(2)}`,
    'info'
  );
}

// 3️⃣ UPDATE placeMarketBuy to track stats (find this function and update it)
async function placeMarketBuy(
  balance: number,
  symbol: string,
  price: number,
  sl: number,
  tp: number,
  strategy: StrategyId,
  reason: string,
  signal?: EntrySignal
) {
  logger.log(
    `DEBUG SIZE: Balance=${balance}, symbol=${symbol}, Price=${price}, SL=${sl}`,
    'warning'
  );

  // ✅ FIXED: Pass correct parameters to calculatePositionSize
  // Parameters: (balance, symbol, riskPct, entry, sl)
  const posSize = await calculatePositionSize(
    balance, // ✅ balance (number)
    symbol, // ✅ symbol (string)
    CONFIG.RISK_PER_TRADE || 0.02, // ✅ riskPct (number, e.g., 0.02 = 2%)
    price, // ✅ entry price
    sl // ✅ stop loss
  );

  console.log('🥑 ~ placeMarketBuy ~ posSize:===============>>', posSize);

  if (posSize === 0 || !posSize) {
    logger.log('Position size too small or below minimum', 'error');
    return;
  }

  // ✅ CRITICAL: Check these values!
  console.log(`[placeMarketBuy] Position details:`);
  console.log(`  Amount: ${posSize}`);
  console.log(`  Price: ${price}`);
  console.log(`  Value: ${posSize * price}`);

  const riskPerUnit = price - sl;
  const tp1 = price + riskPerUnit * CONFIG.PARTIAL_TP1_R;
  const tp2 = tp;

  const baseCurrency = symbol.split('/')[0];
  logger.log(
    `📈 BUY [${strategy}] ${posSize} ${baseCurrency} @ ${price.toFixed(4)}`,
    'success'
  );
  logger.log(
    `   SL: ${sl.toFixed(4)} | TP1: ${tp1.toFixed(4)} | TP2: ${tp2.toFixed(4)}`,
    'info'
  );
  logger.log(`   Value: $${(posSize * price).toFixed(2)}`, 'info');

  if (CONFIG.PAPER_TRADING) {
    paperBalance -= posSize * price;
    logger.log(`📝 Paper trade - balance: ${paperBalance.toFixed(2)}`, 'info');
  } else {
    try {
      logger.log(`📤 BUY order: ${posSize} ${baseCurrency}`, 'info');
      // const order = await binance.createMarketBuyOrder(symbol, posSize);
      const order = await binance.fetchTicker(symbol);
      logger.log(`✅ Order: ${order.info}`, 'success');
    } catch (err: any) {
      logger.log(`❌ Buy failed: ${err.message}`, 'error');
      return;
    }
  }

  currentPosition = {
    positionId: generateId(),
    symbol: symbol,
    entryPrice: price,
    currentPrice: price,
    amount: posSize,
    remainingAmount: posSize,
    stopLoss: sl,
    takeProfit: tp2,
    entryTime: new Date(),
    strategy: strategy,
    signalReason: reason,
    partialTakeProfit1: tp1,
    partialTakeProfit2: tp2,
    partialsSold: 0,
    pnlUsd: 0,
    pnlPct: 0,
    side: 'SPOT',
  };

  // ✅ Update stats
  tradesThisSession++;
  sessionStats.totalTrades++;

  logTrade('BUY', {
    price,
    amount: posSize,
    stopLoss: sl,
    takeProfit: tp,
    strategy,
    reason,
    positionId: currentPosition.positionId,
  });

  // ✅ Notify launcher with stats
  sendPositionUpdate(currentPosition, price);
  saveState();
}

async function placePartialSell(
  pos: Position,
  price: number,
  portion: number,
  reason: string
): Promise<boolean> {
  const baseCurrency = pos.symbol.split('/')[0] as string;

  try {
    // Get market precision
    const markets = await binance.loadMarkets();
    const market = markets[pos.symbol];
    const amountPrecision = market?.precision?.amount || 8;
    const minAmount = market?.limits?.amount?.min || 0;

    let sellAmount = pos.remainingAmount * portion;
    sellAmount =
      Math.floor(sellAmount * Math.pow(10, amountPrecision)) /
      Math.pow(10, amountPrecision);

    if (sellAmount < minAmount) {
      logger.log(
        `⚠️ Partial sell amount ${sellAmount} below minimum ${minAmount} - skipping`,
        'warning'
      );
      return false;
    }

    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlUsd = (price - pos.entryPrice) * sellAmount;
    sessionRealizedPnlUsd += pnlUsd;

    logger.log(
      `📉 PARTIAL SELL [${pos.strategy}] ${sellAmount} ${baseCurrency} @ ${price.toFixed(4)} | PnL: +${pnlUsd.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`,
      'success'
    );

    if (CONFIG.PAPER_TRADING) {
      paperBalance += sellAmount * price;
    } else {
      const bal = await binance.fetchBalance();
      const available = Math.min(sellAmount, bal[baseCurrency]?.free || 0);
      if (available >= minAmount) {
        await binance.createMarketSellOrder(pos.symbol, available);
      } else {
        logger.log(
          `⚠️ Insufficient balance: ${available} ${baseCurrency}`,
          'warning'
        );
        return false;
      }
    }

    pos.remainingAmount -= sellAmount;
    pos.partialsSold++;

    logTrade('PARTIAL_SELL', {
      price,
      amount: sellAmount,
      entryPrice: pos.entryPrice,
      pnl: pnlUsd.toFixed(2),
      reason,
      strategy: pos.strategy,
      positionId: pos.positionId,
    });

    saveState();
    return true;
  } catch (err) {
    logger.log(`Partial sell failed: ${err}`, 'error');
    return false;
  }
}

const sessionStats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  realizedPnl: 0,
  startBalance: 0,
  startTime: Date.now(),
};

// 2️⃣ UPDATE placeMarketSell to track stats (find this function and update it)
async function placeMarketSell(pos: Position, price: number, reason: string) {
  const baseCurrency = pos.symbol.split('/')[0] as string;

  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlUsd = (price - pos.entryPrice) * pos.remainingAmount;

  // ✅ Update both old and new stats
  sessionRealizedPnlUsd += pnlUsd;
  sessionStats.realizedPnl += pnlUsd;

  const isLoss = pnlUsd < 0;
  if (isLoss) {
    sessionStats.losses++;
  } else {
    sessionStats.wins++;
  }

  logger.log(
    `📉 SELL [${pos.strategy}] ${pos.remainingAmount.toFixed(6)} ${baseCurrency} @ ${price.toFixed(2)} | PnL: ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`,
    isLoss ? 'warning' : 'success'
  );

  if (CONFIG.PAPER_TRADING) {
    paperBalance += pos.remainingAmount * price;
  } else {
    try {
      const bal = await binance.fetchBalance();
      let sellAmt = Math.min(pos.remainingAmount, bal[baseCurrency]?.free || 0);

      const markets = await binance.loadMarkets();
      const market = markets[pos.symbol];
      const minAmount = market?.limits?.amount?.min || 0.00001;
      const amountPrecision = market?.precision?.amount || 6;

      sellAmt =
        Math.floor(sellAmt * Math.pow(10, amountPrecision)) /
        Math.pow(10, amountPrecision);

      if (sellAmt >= minAmount) {
        logger.log(`Selling ${sellAmt} ${baseCurrency}`, 'info');
        await binance.createMarketSellOrder(pos.symbol, sellAmt);
      } else {
        logger.log(`⚠️ Amount ${sellAmt} below minimum ${minAmount}`, 'error');
      }
    } catch (err) {
      logger.log(`Sell failed: ${err}`, 'error');
    }
  }

  logTrade('SELL', {
    price,
    amount: pos.remainingAmount,
    entryPrice: pos.entryPrice,
    pnl: pnlUsd.toFixed(2),
    reason,
    holdTime: Date.now() - pos.entryTime.getTime(),
    strategy: pos.strategy,
    positionId: pos.positionId,
  });

  // ✅ UPDATE STATS
  updateStats(pnlUsd);

  if (isLoss) {
    activateCooldown(reason, true);
  } else {
    resetCooldownOnWin();
  }

  currentPosition = null;

  // ✅ Notify launcher with stats
  if (process.send) {
    process.send({
      type: 'position_update',
      hasPosition: false,
      position: null,
      sessionPnl: sessionStats.realizedPnl,
      wins: sessionStats.wins,
      losses: sessionStats.losses,
      tradesCount: sessionStats.totalTrades,
    });
  }

  saveState();
}

// ---------- EXIT LOGIC ----------
export async function checkAndExecuteExits(
  pos: Position,
  ind: Indicators
): Promise<boolean> {
  const { currentPrice } = ind;

  // Calculate position duration
  const positionDuration = Date.now() - pos.entryTime.getTime();
  const MIN_HOLD_TIME = 5 * 60 * 1000; // 5 minutes

  // ============================================================================
  // IMMEDIATE EXITS (No cooldown)
  // ============================================================================

  // 1. Stop Loss (always immediate)
  if (currentPrice <= pos.stopLoss) {
    await placeMarketSell(pos, currentPrice, 'Stop Loss');
    return true;
  }

  // 2. Take Profit (always immediate)
  if (currentPrice >= pos.takeProfit) {
    await placeMarketSell(pos, currentPrice, 'Take Profit (Full)');
    return true;
  }

  // 3. Partial TP1 (immediate)
  if (
    pos.partialsSold === 0 &&
    pos.partialTakeProfit1 &&
    currentPrice >= pos.partialTakeProfit1
  ) {
    const success = await placePartialSell(
      pos,
      currentPrice,
      CONFIG.PARTIAL_TP1_RATIO,
      'Partial TP1 (1.5R)'
    );
    if (success) {
      const newSl = pos.entryPrice + ind.atr * 0.1;
      logger.log(
        `🔒 Moving SL to breakeven: ${pos.stopLoss.toFixed(2)} → ${newSl.toFixed(2)}`,
        'success'
      );
      pos.stopLoss = newSl;
      saveState();
    }
    return false;
  }

  // ============================================================================
  // DELAYED EXITS (After cooldown)
  // ============================================================================

  // Only check these after minimum hold time
  if (positionDuration < MIN_HOLD_TIME) {
    // Too soon - give position a chance
    return false;
  }

  // 4. Death Cross (only if CHANGES from golden cross)
  // Store EMA values at entry in position object
  if (ind.ema50 && ind.ema200) {
    const wasGoldenCross = ind.ema50 > ind.ema200;
    const isDeathCross = ind.ema50 < ind.ema200;

    // Only exit if trend actually changed
    if (wasGoldenCross && isDeathCross) {
      await placeMarketSell(pos, currentPrice, 'Death Cross Detected');
      return true;
    }
  }

  // 5. Extreme Overbought (RSI > 75 for 2+ candles)
  if (ind.rsi > 75) {
    await placeMarketSell(pos, currentPrice, 'Extreme Overbought');
    return true;
  }

  return false;
}

export async function openPosition(signal: EntrySignal, price: number) {
  if (!marketInfo) return;
  if (currentPosition) {
    logger.log('Already in position', 'warning');
    console.log(
      '🥑 ~ openPosition ~ currentPosition:=============>>>',
      currentPosition
    );
    return;
  }

  if (!signal) {
    logger.log('No valid signal to open position', 'warning');
    return;
  }

  const curPrice = await fetchCurrentPrice(CONFIG.SYMBOL);
  if (!curPrice || curPrice <= 0) {
    logger.log('Failed to fetch current price', 'error');
    return;
  }
  const tick = (await binance.fetchTicker(CONFIG.SYMBOL)) as Ticker;

  const balance = await getUsdtBalance();
  const riskAmount = balance * CONFIG.RISK_PER_TRADE;
  // const positionSize = riskAmount * LEVERAGE;
  const amount = riskAmount / price;

  const currentPrice = tick.last || 0;
  const side = 'SPOT';

  // const liquidationPrice = calculateLiquidationPrice(
  //   price,
  //   LEVERAGE,
  //   side,
  //   getMaintenanceMarginTier(positionSize).rate
  // );

  let stopLoss: number;
  let takeProfit: number;

  if (signal.side === 'LONG') {
    stopLoss = curPrice * 0.99;
    takeProfit = curPrice * 1.03;
  } else {
    stopLoss = curPrice * 1.01;
    takeProfit = curPrice * 0.97;
  }

  currentPosition = {
    positionId: generatePositionId(),
    symbol: CONFIG.SYMBOL,
    side: signal.side,
    entryPrice: price || 0,
    currentPrice: currentPrice,
    amount: amount || 0,
    remainingAmount: amount || 0,
    stopLoss: stopLoss || 0,
    takeProfit: takeProfit || 0,
    entryTime: new Date(),
    strategy: signal.strategy,
    signalReason: signal.reason,
    partialsSold: 0,
    pnlUsd: 0,
    pnlPct: 0,
    // leverage: LEVERAGE,
    // liquidationPrice,
    positionValue: amount * price,
    // marginUsed: positionSize / LEVERAGE
  } as Position;

  // Register with coordinator
  await positionCoordinator.forceRegister(
    CONFIG.SYMBOL
    // signal.side,
    // LEVERAGE,
    // price,
    // amount
  );

  // Allocate capital
  (await sharedBalance.forceAllocate(
    CONFIG.SYMBOL,
    amount
    // currentPosition.marginUsed || 0,
    // positionSize,
    // LEVERAGE
  )) as never;

  logger.log(
    `🟢 ${signal?.side} opened @ ${formatPrice(price)} | Size: ${formatQuantity(amount)}`,
    'success'
  );
  logger.log(
    `   SL: ${formatPrice(stopLoss)} | TP: ${formatPrice(takeProfit)}`,
    'info'
  );

  sendPositionUpdate(currentPosition, price);
  saveState();
}

function pickBest(candidates: ScanResult[]): ScanResult | null {
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  const winner = candidates[0]!;
  logger.log(
    `🎯 WINNER: ${winner.symbol} (${(winner.confidence * 100).toFixed(0)}%)`,
    'success'
  );
  return winner;
}

// 4️⃣ UPDATE sendPositionUpdate to use sessionStats (find and replace)
function sendPositionUpdate(pos: Position, currentPrice: number) {
  if (!isLauncherManaged || !process.send) {
    return;
  }

  const pnlUsd = (currentPrice - pos.entryPrice) * pos.remainingAmount;
  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  const payload = {
    type: 'position_update',
    hasPosition: true,
    position: {
      entryPrice: pos.entryPrice,
      currentPrice: currentPrice,
      amount: pos.amount,
      remainingAmount: pos.remainingAmount,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      pnlUsd: pnlUsd,
      pnlPct: pnlPct,
      strategy: pos.strategy,
      partialsSold: pos.partialsSold,
      entryTime: pos.entryTime.toISOString(),
      positionId: pos.positionId,
      symbol: pos.symbol,
    },
    // ✅ ADD STATS
    sessionPnl: botStats.sessionPnl,
    wins: botStats.wins,
    losses: botStats.losses,
    tradesCount: botStats.totalTrades,
    winRate: botStats.winRate,
    avgWin: botStats.avgWin,
    avgLoss: botStats.avgLoss,
  };

  try {
    process.send(payload);
  } catch (err: any) {
    logger.log(`IPC send failed: ${err.message}`, 'warning');
  }
}
let lastPositionLogTime = 0;
let lastTickLogTime = 0;
const POSITION_LOG_INTERVAL = 2 * 60 * 1000; // 2 minutes
const TICK_LOG_INTERVAL = 5 * 60 * 1000; // 5 minutes for "Bot Tick"

// ---------- MAIN BOT LOOP ----------
async function botLoop() {
  if (isRunning) {
    logger.log('Loop already running, skipping', 'warning');
    return;
  }
  isRunning = true;

  try {
    const now = Date.now();

    // Log tick header less frequently
    if (now - lastTickLogTime > TICK_LOG_INTERVAL) {
      console.log('\n' + '='.repeat(60));
      logger.log('Bot Tick');
      lastTickLogTime = now;
    }

    if (checkDrawdownLimit()) {
      logger.log('Trading halted due to drawdown limit', 'error');
      return;
    }

    if (isInCooldown() && !currentPosition) {
      return;
    }

    // ========== IF WE HAVE A POSITION - MANAGE IT ==========
    // ✅ ONLY manage existing positions
    if (currentPosition) {
      // Only log position management periodically
      if (now - lastPositionLogTime > POSITION_LOG_INTERVAL) {
        logger.log(`📊 Managing position: ${currentPosition.symbol}`, 'info');
        lastPositionLogTime = now;
      }

      // Get current price from ticker instead of fetching candles
      try {
        const ticker = await binance.fetchTicker(CONFIG.SYMBOL);
        const currentPrice = ticker.last || 0;

        if (currentPrice > 0) {
          // Update position
          currentPosition.currentPrice = currentPrice;

          // Send update to launcher
          sendPositionUpdate(currentPosition, currentPrice);

          // Check exits using simple price checks
          if (currentPrice <= currentPosition.stopLoss) {
            await placeMarketSell(currentPosition, currentPrice, 'Stop Loss');
          } else if (currentPrice >= currentPosition.takeProfit) {
            await placeMarketSell(currentPosition, currentPrice, 'Take Profit');
          }
        }
      } catch (err: any) {
        logger.log(`Error fetching ticker: ${err.message}`, 'error');
      }

      return; // ✅ Don't scan for new positions
    }

    // ✅ NO SCANNING - wait for launcher to send entry signals
    logger.log('💤 Waiting for entry signal from launcher...', 'info');

    if (isInCooldown()) {
      logger.log('🧊 Still in cooldown - skipping scan', 'warning');
      return;
    }

    if (tradesThisSession >= SESSION_CONFIG.MAX_TRADES_PER_SESSION) {
      logger.log('📊 Max trades per session reached', 'warning');
      return;
    }

    // Check balance
    const balance = await getUsdtBalance();
    if (sessionStartBalance === 0) sessionStartBalance = balance;

    if (balance * CONFIG.RISK_PER_TRADE < CONFIG.MIN_TRADE_USDT) {
      logger.log(`💰 Balance too low: ${balance.toFixed(2)} USDT`, 'warning');
      return;
    }

    logger.log(
      `🧠 Position check: ${currentPosition ? 'BLOCKED' : 'OPEN'}`,
      'warning'
    );

    if (currentPosition) return;
  } catch (err: any) {
    logger.log(`❌ Error in botLoop: ${err.message}`, 'error');
    console.error(err.stack);
  } finally {
    isRunning = false;
  }
}

// ========== UPDATED MAIN FUNCTION ==========

async function main() {
  initializeTradeLog();
  loadState();
  loadStats();
  emergencyMemoryCheck();

  logger.log('═'.repeat(50), 'info');
  logger.log(`🚀 ${CONFIG.SYMBOL} Trading Bot v2.1 Enhanced`, 'success');
  logger.log(
    `   Mode: ${CONFIG.PAPER_TRADING ? '📝 PAPER' : '💰 LIVE'}`,
    'info'
  );
  logger.log(`   Market: 🏪 SPOT ONLY (no leverage/futures)`, 'success');
  logger.log(`   Launcher Managed: ${isLauncherManaged ? '✅' : '❌'}`, 'info');
  logger.log(
    `   Stats: ${botStats.wins}W/${botStats.losses}L (${botStats.winRate.toFixed(1)}% WR)`,
    'info'
  );
  logger.log(
    `   Symbol: ${CONFIG.SYMBOL} | TF: ${CONFIG.TIMEFRAME} | HTF: ${CONFIG.HTF_TIMEFRAME}`,
    'info'
  );
  logger.log(
    `   Risk: ${CONFIG.RISK_PER_TRADE * 100}% | Max DD: ${SESSION_CONFIG.MAX_DRAWDOWN_PCT * 100}%`,
    'info'
  );
  logger.log(
    `   Partial TP: ${CONFIG.PARTIAL_TP1_RATIO * 100}% @ ${CONFIG.PARTIAL_TP1_R}R, rest @ ${CONFIG.PARTIAL_TP2_R}R`,
    'info'
  );
  logger.log(
    `   Safety: Slippage ${CONFIG.SLIPPAGE_BUFFER * 100}%, Min R:R ${CONFIG.MIN_RISK_REWARD}:1, Vol check ON`,
    'info'
  );
  logger.log('═'.repeat(50), 'info');

  // ✅ Initialize session stats
  sessionStats.startBalance = await getUsdtBalance();
  sessionStats.startTime = Date.now();
  sessionStats.totalTrades = tradesThisSession;
  sessionStats.realizedPnl = sessionRealizedPnlUsd;

  logger.log('📊 Capital:', 'info');
  logger.log(`   Total: $${CAPITAL_CONFIG.TOTAL_CAPITAL.toFixed(2)}`, 'info');
  logger.log(
    `   Per Position: $${CAPITAL_CONFIG.PER_BOT_ALLOCATION.toFixed(2)}`,
    'info'
  );
  logger.log(
    `   Max Size: $${CAPITAL_CONFIG.MAX_POSITION_VALUE.toFixed(2)}`,
    'success'
  );
  logger.log('═'.repeat(50), 'info');

  // Setup IPC if launcher-managed
  if (isLauncherManaged) {
    setupIPCHandlers();
    logger.log('IPC handlers registered', 'success');
  }

  sessionStartBalance = await getUsdtBalance();
  sessionStartTime = Date.now();

  setInterval(runBotMemoryCleanup, 5 * 60 * 1000); // Every 5 minutes
  setInterval(checkBotMemory, MEMORY_CHECK_INTERVAL); // Every 2 minutes

  await botLoop();
  setInterval(botLoop, CONFIG.LOOP_INTERVAL_MS);

  // Periodic health report to launcher
  if (isLauncherManaged) {
    setInterval(() => {
      sendToLauncher('health', {
        status: currentPosition ? 'in_position' : 'scanning',
        uptime: Date.now() - sessionStartTime,
        trades: tradesThisSession,
        pnl: sessionRealizedPnlUsd,
        balance: paperBalance,
      });
    }, 60_000); // Every minute
  }
}

// ✅ Cleanup on shutdown
process.on('SIGINT', () => {
  logger.log('Shutting down...', 'warning');
  runBotMemoryCleanup();
  saveState();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.log('Received SIGTERM from launcher', 'warning');
  runBotMemoryCleanup();
  saveState();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.log(`Uncaught exception: ${err.message}`, 'error');
  runBotMemoryCleanup();
  saveState();
  process.exit(1);
});

main().catch((err) => {
  logger.log(`Fatal: ${err}`, 'error');
  process.exit(1);
});

async function emergencyMemoryCheck() {
  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);

  if (heapMB > 500) {
    logger.log(`🚨 CRITICAL: Bot using ${heapMB}MB at startup!`, 'error');
    logger.log('🧹 Running emergency cleanup...', 'warning');

    // Clear everything
    fibMap.clear();
    positionMap.clear();
    htfCache = null;

    if (global.gc) {
      global.gc();
      const afterGC = process.memoryUsage();
      const afterMB = Math.round(afterGC.heapUsed / 1024 / 1024);
      logger.log(`🧹 After GC: ${afterMB}MB`, 'info');
    }
  }
}
