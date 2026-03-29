import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as dotenv from 'dotenv';
import * as rfs from 'rotating-file-stream';
// import { CandleManager } from './candle-manager.js'
import { ATR, EMA, RSI } from 'technicalindicators';

import {
  formatNumber,
  getAmountDecimals,
  getPriceDecimals,
} from '../../lib/helpers.js';
import { detectRegime } from '../../lib/trading-utils.js';
import {
  LogLevel,
  type BotInstance,
  type CandleData,
  type EntrySignal,
  type HTFConfirmation,
  type Indicators,
  type LauncherConfig,
  type Position,
  type ScanResult,
  type StrategyId,
} from '../../lib/type.js';
import { CandleManager } from '../core/candles.js';
import { getConfigForSymbol, SYMBOL_CONFIGS } from '../spot/config-spot.js';

dotenv.config();

// ---------- TYPES ----------

const LOG_LEVEL = process.env.LOG_LEVEL
  ? parseInt(process.env.LOG_LEVEL)
  : LogLevel.INFO;

// 3. Smart filtering
function shouldLogMessage(message: string): boolean {
  // Always log errors
  if (message.includes('ERROR') || message.includes('❌')) {
    return true;
  }

  // Always log position changes
  if (
    message.includes('ENTRY') ||
    message.includes('EXIT') ||
    message.includes('POSITION') ||
    message.includes('PnL')
  ) {
    return true;
  }

  // Skip noise
  if (
    message.includes('heartbeat') ||
    message.includes('health check') ||
    message.includes('WebSocket tick')
  ) {
    return false;
  }

  return LOG_LEVEL <= LogLevel.INFO;
}

// ============================================================================
// CRITICAL MEMORY LEAK FIXES - Add these to launcher-spot.ts
// ============================================================================

// 1️⃣ ADD THESE CONSTANTS at the top (after imports)
const MEMORY_CONFIG = {
  MAX_CANDLES_PER_SYMBOL: 100, // ✅ Reduced from 150
  MAX_HTF_CANDLES: 100, // ✅ Reduced from 150
  MAX_CACHE_ENTRIES: 10, // ✅ Reduced from 30
  CACHE_CLEANUP_INTERVAL: 1 * 60 * 1000, // ✅ Every 1 min instead of 2
  MEMORY_CHECK_INTERVAL: 10 * 1000, // ✅ Every 10s instead of 20
  MAX_MEMORY_MB: 500, // ✅ Kill at 500MB instead of 800
  STALE_THRESHOLD_MS: 5 * 60 * 1000, // ✅ 5 min instead of 10
  AGGRESSIVE_THRESHOLD_MS: 2 * 60 * 1000, // ✅ 2 min instead of 3
};

const MEMORY_LIMITS = {
  MAX_SCAN_RESULTS: 60, // Only keep 60 symbols
  MAX_FIB_CACHE: 30, // Limit Fib entries
  MAX_HTF_CACHE: 30, // Limit HTF cache
  MAX_LOG_STREAMS: 10, // Close old log streams
  SCAN_RESULT_TTL: 20 * 60 * 1000, // 20 minutes
  CACHE_CLEANUP_INTERVAL: 3 * 60 * 1000, // Every 3 minutes
};

// 2️⃣ ADD CLEANUP FUNCTION for scan results
function cleanupScanResults() {
  if (scanResults.size <= MEMORY_LIMITS.MAX_SCAN_RESULTS) return;

  const now = Date.now();

  // Remove stale entries first
  const staleSymbols: string[] = [];
  scanResults.forEach((data, symbol) => {
    const age = now - data.lastScan.getTime();
    if (age > MEMORY_LIMITS.SCAN_RESULT_TTL) {
      staleSymbols.push(symbol);
    }
  });

  staleSymbols.forEach((s) => scanResults.delete(s));

  // If still too many, keep only top results by confidence
  if (scanResults.size > MEMORY_LIMITS.MAX_SCAN_RESULTS) {
    const sorted = Array.from(scanResults.entries())
      .filter(([, data]) => data.signal !== null)
      .sort(([, a], [, b]) => b.confidence - a.confidence);

    const toKeep = new Set(
      sorted.slice(0, MEMORY_LIMITS.MAX_SCAN_RESULTS).map(([sym]) => sym)
    );

    scanResults.forEach((_, symbol) => {
      if (!toKeep.has(symbol)) scanResults.delete(symbol);
    });
  }

  log(
    `🧹 Scan cleanup: ${staleSymbols.length} removed, ${scanResults.size} remaining`,
    'info'
  );
}

// 3️⃣ ADD CLEANUP for Fibonacci cache
function cleanupFibCache() {
  if (launcherFibMap.size <= MEMORY_LIMITS.MAX_FIB_CACHE) return;

  const now = Date.now();
  const sorted = Array.from(launcherFibMap.entries()).sort(
    ([, a], [, b]) => b.lockedAt.getTime() - a.lockedAt.getTime()
  );

  // Keep only most recent entries
  const toKeep = new Set(
    sorted.slice(0, MEMORY_LIMITS.MAX_FIB_CACHE).map(([sym]) => sym)
  );

  let removed = 0;
  launcherFibMap.forEach((_, symbol) => {
    if (!toKeep.has(symbol)) {
      launcherFibMap.delete(symbol);
      removed++;
    }
  });

  if (removed > 0) {
    log(
      `🧹 Fib cleanup: ${removed} removed, ${launcherFibMap.size} remaining`,
      'info'
    );
  }
}

// 4️⃣ ADD CLEANUP for HTF cache
function cleanupHTFCache() {
  if (launcherHTFCache.size <= MEMORY_LIMITS.MAX_HTF_CACHE) return;

  const now = Date.now();
  const sorted = Array.from(launcherHTFCache.entries()).sort(
    ([, a], [, b]) => b.fetchedAt.getTime() - a.fetchedAt.getTime()
  );

  const toKeep = new Set(
    sorted.slice(0, MEMORY_LIMITS.MAX_HTF_CACHE).map(([sym]) => sym)
  );

  let removed = 0;
  launcherHTFCache.forEach((_, key) => {
    if (!toKeep.has(key)) {
      launcherHTFCache.delete(key);
      removed++;
    }
  });

  if (removed > 0) {
    log(
      `🧹 HTF cleanup: ${removed} removed, ${launcherHTFCache.size} remaining`,
      'info'
    );
  }
}

// 5️⃣ ADD CLEANUP for old log streams
function cleanupOldLogStreams() {
  if (logStreams.size <= MEMORY_LIMITS.MAX_LOG_STREAMS) return;

  const activeBots = new Set(Array.from(botInstances.keys()));
  let closed = 0;

  logStreams.forEach((stream, symbol) => {
    if (!activeBots.has(symbol)) {
      try {
        stream.end();
        logStreams.delete(symbol);
        closed++;
      } catch (err: any) {
        log(`Failed to close stream for ${symbol}: ${err.message}`, 'error');
      }
    }
  });

  if (closed > 0) {
    log(`🧹 Closed ${closed} unused log streams`, 'info');
  }
}

// 6️⃣ MASTER CLEANUP FUNCTION
function runMemoryCleanup() {
  const before = process.memoryUsage();
  const beforeMB = Math.round(before.heapUsed / 1024 / 1024);

  log(`🧹 Running memory cleanup (Heap: ${beforeMB}MB)...`, 'info');

  cleanupScanResults();
  cleanupFibCache();
  cleanupHTFCache();
  cleanupOldLogStreams();

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  const after = process.memoryUsage();
  const afterMB = Math.round(after.heapUsed / 1024 / 1024);
  const freedMB = beforeMB - afterMB;

  log(`✅ Cleanup complete: ${afterMB}MB (freed ${freedMB}MB)`, 'success');
  log(
    `   Scan results: ${scanResults.size}, Fib: ${launcherFibMap.size}, HTF: ${launcherHTFCache.size}`,
    'info'
  );
}

// ---------- ANSI COLOR CODES ----------
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  orange: '\x1b[38;5;214m', // 256-color orange
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgOrange: '\x1b[48;5;214m', // Background orange
  brightGreen: '\x1b[1m\x1b[32m',
  brightRed: '\x1b[1m\x1b[31m',
  brightYellow: '\x1b[1m\x1b[33m',
  brightCyan: '\x1b[1m\x1b[36m',
  brightMagenta: '\x1b[1m\x1b[35m',
  brightOrange: '\x1b[1m\x1b[38;5;214m', // Bright orange
};

function colorize(text: string, color: string): string {
  return `${color}${text}${colors.reset}`;
}

function padColored(
  text: string,
  width: number,
  align: 'left' | 'right' = 'left'
): string {
  const visibleLength = text.replace(/\x1b\[[0-9;]+m/g, '').length;
  const padding = Math.max(0, width - visibleLength);
  return align === 'right'
    ? ' '.repeat(padding) + text
    : text + ' '.repeat(padding);
}

function colorPnL(value: number, isPercent: boolean = false): string {
  const formatted = isPercent
    ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
    : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

  if (value > 0) return colorize(formatted, colors.brightGreen);
  if (value < 0) return colorize(formatted, colors.brightRed);
  return colorize(formatted, colors.gray);
}
let globalCandleManager: CandleManager | null = null;
const SESSION_CONFIG = {
  logDir: './logs/test/multi-bot',
  stateDir: './states/test/multi-bot',
  aggregateLogFile: './logs/test/aggregate.log',
};

// ✅ FIXED: Filter invalid symbols and validate
const VALID_SYMBOLS = [
  'AAVE/USDT',
  'ADA/USDT',
  'ARB/USDT',
  'ASTER/USDT',
  'AVAX/USDT',
  'BCH/USDT',
  'BNB/USDT',
  'BONK/USDT',
  'BTC/USDT',
  'CAKE/USDT',
  'CRV/USDT',
  'DOGE/USDT',
  'ENA/USDT',
  'ETHFI/USDT',
  'ETH/USDT',
  'FET/USDT',
  'FLOKI/USDT',
  'GRT/USDT',
  'HBAR/USDT',
  'IMX/USDT',
  'INJ/USDT',
  'JUP/USDT',
  'KAIA/USDT',
  'LDO/USDT',
  'LINK/USDT',
  'LTC/USDT',
  'NEXO/USDT',
  'ONDO/USDT',
  'OP/USDT',
  'PAXG/USDT',
  'PENGU/USDT',
  'PEPE/USDT',
  'PHB/USDT',
  'PUMP/USDT',
  'QNT/USDT',
  'RENDER/USDT',
  'SEI/USDT',
  'SHIB/USDT',
  'SKY/USDT',
  'SOL/USDT',
  'SOMI/USDT',
  'STX/USDT',
  'SUI/USDT',
  'TIA/USDT',
  'TON/USDT',
  'TRX/USDT',
  'VET/USDT',
  'VIRTUAL/USDT',
  'WLD/USDT',
  'WLFI/USDT',
  'XLM/USDT',
  'XPL/USDT',
  'XRP/USDT',
  'ZEC/USDT',
  'ZEN/USDT',
];

// ---------- LAUNCHER CONFIG ----------
export const LAUNCHER_CONFIG: LauncherConfig = {
  enabledSymbols:
    process.env.ENABLED_SYMBOLS?.split(',').filter((s) => {
      const isValid = VALID_SYMBOLS.includes(s.trim());
      if (!isValid) {
        console.log(`⚠️ Skipping invalid symbol: ${s}`);
      }
      return isValid;
    }) || VALID_SYMBOLS,
  maxBotsRunning: parseInt(process.env.MAX_BOTS || '56'),
  maxConcurrentPositions: parseInt(
    process.env.MAX_CONCURRENT_POSITIONS || '10'
  ),
  autoRestart: true,
  maxRestarts: 3,
  restartDelayMs: 30_000,
  healthCheckIntervalMs: 60_000,
  aggregateLogging: true,
};

function initializeCandleManager(symbols: string[]) {
  if (globalCandleManager) {
    log('⚠️ CandleManager already exists, destroying old one', 'warning');
    globalCandleManager.destroy();
  }

  globalCandleManager = new CandleManager('15m');
  log(`✅ CandleManager initialized with ${symbols.length} symbols`, 'success');

  return globalCandleManager;
}

// In launcher-future.js
// function convertToFuturesSymbol(symbol: string): string {
//   // console.log(`🔄 Converting ${symbol} to futures format...`);

//   // Remove any existing /USDT and clean up
//   const cleanSymbol = symbol.replace('/USDT', '').replace('USDT', '');

//   // Handle 1000 multiplier tokens
//   const thousandMultiplierTokens = ['PEPE', 'FLOKI', 'BONK', 'SHIB', 'BTT'];

//   let result: string;

//   if (thousandMultiplierTokens.includes(cleanSymbol)) {
//     result = `1000${cleanSymbol}USDT`;
//   } else {
//     result = `${cleanSymbol}USDT`;
//   }

//   // console.log(`   Input: ${symbol} -> Output: ${result}`);
//   return result;
// }
const CONFIG = getConfigForSymbol(process.env.TRADING_SYMBOL || 'SOL/USDT');

// function createSymbolContext(symbol: string): SymbolContext {
//   const base = symbol.replace('/USDT', '').replace('USDT', '');
//   return {
//     display: `${base}/USDT`,
//     base,
//     futures: convertToFuturesSymbol(symbol),
//   };
// }
if (!process.env.TRADING_SYMBOL) {
  throw new Error('TRADING_SYMBOL not set in environment variables');
}
// const SYMBOL = createSymbolContext(process.env.TRADING_SYMBOL);

// 3️⃣ ADD HELPER FUNCTION to count active positions
function getActivePositionCount(): number {
  return Array.from(botInstances.values()).filter(
    (bot) => bot.position !== null
  ).length;
}

// Validate enabled symbols
LAUNCHER_CONFIG.enabledSymbols = LAUNCHER_CONFIG.enabledSymbols.filter(
  (symbol) => {
    // const binanceSymbol = symbol.replace('/', '');
    if (!Object.keys(SYMBOL_CONFIGS).includes(symbol)) {
      log(`⚠️ Symbol ${symbol} has no config, will use BASE_CONFIG`, 'warning');
    }
    return true;
  }
);

// Fib levels storage (launcher-specific)
const launcherFibMap = new Map<
  string,
  {
    level0: number;
    level236: number;
    level382: number;
    level500: number;
    level618: number;
    level786: number;
    level100: number;
    lockedAt: Date;
    swingHigh: number;
    swingLow: number;
  }
>();

// HTF cache storage (launcher-specific)
const launcherHTFCache = new Map<
  string,
  {
    data: {
      trend: 'UP' | 'DOWN' | 'NEUTRAL';
      ema50: number;
      ema200: number;
      rsi: number;
      aligned: boolean;
    };
    fetchedAt: Date;
  }
>();

const scanResults = new Map<
  string,
  {
    lastScan: Date;
    signal: EntrySignal | null;
    confidence: number;
    price: number;
    indicators: Indicators;
    regime?: string;
    htfTrend?: string;
    rsi?: number;
  }
>();

// Track last full scan time
let lastFullScan = 0;
const SCAN_INTERVAL = 20 * 60 * 1000;
let isScanning = false;
// ---------- STATE ----------
const botInstances = new Map<string, BotInstance>();
let currentPosition: Position | null = null;

function getCurrentPositionCount(): number {
  return Array.from(botInstances.values()).filter((b) => b.position !== null)
    .length;
}

// ---------- UTILITIES ----------
function log(
  msg: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info'
) {
  // ✅ Ensure directories before logging
  if (!log.directoriesEnsured) {
    ensureDirectories();
    log.directoriesEnsured = true;
  }

  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] [LAUNCHER] ${icons[type]} ${msg}`;

  console.log(logMsg);

  if (LAUNCHER_CONFIG.aggregateLogging) {
    fs.appendFileSync(SESSION_CONFIG.aggregateLogFile, logMsg + '\n');
  }
}

log.directoriesEnsured = false;

// ============================================================================
// LOCAL FUNCTION: getHTFConfirmation (launcher version)
// ============================================================================

async function getHTFConfirmation(
  symbol: string,
  timeframe: string
): Promise<{
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  ema50: number;
  ema200: number;
  rsi: number;
  aligned: boolean;
}> {
  const key = `${symbol}_${timeframe}`;
  const cached = launcherHTFCache.get(key);

  // Cache for 5 minutes
  if (cached && Date.now() - cached.fetchedAt.getTime() < 5 * 60 * 1000) {
    return cached.data;
  }

  try {
    // ✅ Use global instance, don't create new one
    if (!globalCandleManager) {
      throw new Error('CandleManager not initialized');
    }

    // Initialize if symbol not loaded yet
    if (!globalCandleManager.hasSymbol(symbol)) {
      await globalCandleManager.initializeHistoricalCandles(
        symbol,
        500,
        0,
        'FUTURES'
      );
    }

    const data = globalCandleManager.getCandles(symbol);

    if (!data || !data.closes || data.closes.length < 210) {
      log(
        `Not enough HTF data (${data?.closes.length || 0} candles)`,
        'warning'
      );
      return { trend: 'NEUTRAL', ema50: 0, ema200: 0, rsi: 50, aligned: false };
    }

    const { closes } = data;

    const ema50Vals = EMA.calculate({ period: 50, values: closes });
    const ema200Vals = EMA.calculate({ period: 200, values: closes });
    const rsiVals = RSI.calculate({ period: 14, values: closes });

    const ema50 = ema50Vals[ema50Vals.length - 1] as number;
    const ema200 = ema200Vals[ema200Vals.length - 1] as number;
    const rsi = rsiVals[rsiVals.length - 1] as number;

    let trend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (ema50 > ema200 * 1.002) trend = 'UP';
    else if (ema50 < ema200 * 0.998) trend = 'DOWN';

    const aligned = trend === 'UP' && rsi > 40 && rsi < 70;

    const result = { trend, ema50, ema200, rsi, aligned };
    launcherHTFCache.set(key, { data: result, fetchedAt: new Date() });

    return result;
  } catch (err: any) {
    log(`HTF fetch failed: ${err.message}`, 'warning');
    return { trend: 'NEUTRAL', ema50: 0, ema200: 0, rsi: 50, aligned: false };
  }
}

// ============================================================================
// LOCAL FUNCTION: calculateAndLockFibonacci (launcher version)
// ============================================================================

function calculateAndLockFibonacci(
  symbol: string,
  lows: number[],
  highs: number[]
): {
  level0: number;
  level236: number;
  level382: number;
  level500: number;
  level618: number;
  level786: number;
  level100: number;
  lockedAt: Date;
  swingHigh: number;
  swingLow: number;
} {
  let lockedFib = launcherFibMap.get(symbol);

  if (lockedFib) {
    const age = Date.now() - lockedFib.lockedAt.getTime();
    if (age < CONFIG.FIB_LOCK_DURATION_MS) {
      return lockedFib;
    }
  }

  const lookback = CONFIG.FIB_SWING_LOOKBACK;
  const recentLows = lows.slice(-lookback);
  const recentHighs = highs.slice(-lookback);

  const swingLow = Math.min(...recentLows);
  const swingHigh = Math.max(...recentHighs);
  const diff = swingHigh - swingLow;

  lockedFib = {
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

  launcherFibMap.set(symbol, lockedFib);
  return lockedFib;
}

// ============================================================================
// LOCAL FUNCTION: pickEntryStrategy (launcher version)
// ============================================================================

function pickEntryStrategy(
  ind: Indicators,
  fib: ReturnType<typeof calculateAndLockFibonacci>,
  regime: ReturnType<typeof detectRegime>,
  closes: number[],
  volumes: number[],
  htf: HTFConfirmation
): EntrySignal | null {
  // HTF FILTER
  if (htf.trend === 'DOWN') {
    const bearishGap = ((htf.ema200 - htf.ema50) / htf.ema200) * 100;
    if (bearishGap > 6) {
      return null;
    }
  }

  if (htf.rsi < 40) {
    return null;
  }

  // 15M LTF FILTERS
  if (regime.trend === 'CHOP' || regime.volatility === 'HIGH') {
    return null;
  }

  if (ind.ema50 <= ind.ema200 && regime.trend !== 'UP') {
    return null;
  }

  const riskPerUnit = ind.atr * CONFIG.ATR_STOP_MULTIPLIER;

  // STRATEGY 1: EMA PULLBACK
  const uptrend = ind.ema50 > ind.ema200;
  const nearEma = Math.abs(ind.currentPrice - ind.ema50) / ind.ema50 < 0.01;
  const aboveEma = ind.currentPrice > ind.ema50;
  const rsiOk = ind.rsi > 40 && ind.rsi < 60;

  if (uptrend && aboveEma && nearEma && rsiOk) {
    const sl = ind.currentPrice - riskPerUnit;
    return {
      symbol: 'TEMP', // Will be replaced
      strategy: 'EMA_PULLBACK',
      side: 'LONG',
      reason: `EMA50 bounce @ ${ind.ema50.toFixed(2)}, RSI=${ind.rsi.toFixed(1)}`,
      confidence: 0.7,
      stopLoss: sl,
      takeProfit: ind.currentPrice + riskPerUnit * 2.5,
    };
  }

  // STRATEGY 2: FIB RETRACEMENT
  if (closes.length >= 2) {
    const prev = closes[closes.length - 2] as number;
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

    if (uptrend && bounce && rsiLow) {
      const sl = ind.currentPrice - riskPerUnit * 1.3;
      return {
        symbol: 'TEMP',
        strategy: 'FIB_RETRACEMENT',
        side: 'LONG',
        reason: `Fib ${hitLevel} bounce, RSI=${ind.rsi.toFixed(1)}`,
        confidence: 0.75,
        stopLoss: sl,
        takeProfit: ind.currentPrice + riskPerUnit * 3.0,
      };
    }
  }

  // STRATEGY 3: BREAKOUT
  if (closes.length >= 20 && volumes.length >= 20 && regime.trend === 'UP') {
    const recent20High = Math.max(...closes.slice(-20, -1));
    const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
    const currentVol = volumes[volumes.length - 1] as number;
    const volConfirm = currentVol > avgVol * 1.5;
    const breaking = ind.currentPrice > recent20High;
    const rsiOkBreakout = ind.rsi > 50 && ind.rsi < 70;

    if (breaking && rsiOkBreakout && volConfirm) {
      const sl = ind.currentPrice - riskPerUnit * 0.8;
      return {
        symbol: 'TEMP',
        strategy: 'BREAKOUT',
        side: 'LONG',
        reason: `Breakout above ${recent20High.toFixed(0)} +vol`,
        confidence: 0.8,
        stopLoss: sl,
        takeProfit: ind.currentPrice + riskPerUnit * 3.0,
      };
    }
  }

  return null;
}

// Add this AFTER CAPITAL_CONFIG definition

// ---------- ROTATING LOG STREAM MANAGEMENT ----------
const logStreams = new Map<string, rfs.RotatingFileStream>();
let aggregateLogStream: fs.WriteStream | null = null;

function initializeAggregateLogStream() {
  if (!aggregateLogStream) {
    ensureDirectories();
    aggregateLogStream = fs.createWriteStream(SESSION_CONFIG.aggregateLogFile, {
      flags: 'a',
    });
  }
}

function createRotatingLogStream(symbol: string): rfs.RotatingFileStream {
  // Return existing stream if already created
  if (logStreams.has(symbol)) {
    return logStreams.get(symbol) as rfs.RotatingFileStream;
  }

  const stream = rfs.createStream(`${symbol.replace('/', '_')}.log`, {
    size: '5M', // ✅ REDUCED from 10M - more frequent rotation
    maxFiles: 2, // ✅ REDUCED from 3 - keep fewer files
    compress: 'gzip',
    path: SESSION_CONFIG.logDir, // ✅ USE CORRECT PATH (not ./logs/futures)
  });

  logStreams.set(symbol, stream);
  return stream;
}

function closeLogStream(symbol: string) {
  const stream = logStreams.get(symbol);
  if (stream) {
    stream.end();
    logStreams.delete(symbol);
  }
}

function closeAllLogStreams() {
  logStreams.forEach((stream, symbol) => {
    try {
      stream.end();
    } catch (err) {
      log(`Error closing stream for ${symbol}:  ${err}`, 'error');
    }
  });
  logStreams.clear();
}
// ---------- ROTATING LOG STREAM MANAGEMENT ----------

// Add this configuration near the top of your file (after LAUNCHER_CONFIG)
export const CAPITAL_CONFIG = {
  TOTAL_CAPITAL: parseFloat(process.env.TOTAL_CAPITAL || '250'),
  BACKUP_RESERVE_PCT: parseFloat(process.env.BACKUP_RESERVE_PCT || '0.10'),

  get BACKUP_RESERVE() {
    return this.TOTAL_CAPITAL * this.BACKUP_RESERVE_PCT;
  },

  get TRADING_CAPITAL() {
    return this.TOTAL_CAPITAL - this.BACKUP_RESERVE;
  },

  get PER_BOT_ALLOCATION() {
    return this.TRADING_CAPITAL / LAUNCHER_CONFIG.maxConcurrentPositions;
  },
};

function safeWrite(stream: fs.WriteStream, data: Buffer) {
  if (!stream.destroyed && stream.writable) {
    stream.write(data);
  }
}

function ensureDirectories() {
  const dirs = [
    SESSION_CONFIG.logDir,
    SESSION_CONFIG.stateDir,
    // Also ensure the directory for aggregate.log exists
    path.dirname(SESSION_CONFIG.aggregateLogFile),
  ];

  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log(`Created directory: ${dir}`, 'success');
    }
  });
}
function getStateFilePath(symbol: string): string {
  return path.join(
    SESSION_CONFIG.stateDir,
    `${symbol.replace('/', '_')}_state.json`
  );
}

function getLogFilePath(symbol: string): string {
  return path.join(SESSION_CONFIG.logDir, `${symbol.replace('/', '_')}.log`);
}
let stdoutEnded = false;
let stderrEnded = false;
function tryCloseLogStream(symbol: string) {
  if (stdoutEnded && stderrEnded) {
    closeLogStream(symbol); // ONLY here
  }
}

let latestTicker: Record<string, any> = {};

// ✅ FIXED: Enhanced sendCommandToBot with EPIPE protection
function sendCommandToBot(symbol: string, command: any): boolean {
  const instance = botInstances.get(symbol);

  if (!instance || !instance.process || !instance.process.stdin) {
    log(`Cannot send command to ${symbol}: process not ready`, 'warning');
    return false;
  }

  // ✅ Check if stdin is writable before attempting write
  if (!instance.process.stdin.writable) {
    log(`Cannot send command to ${symbol}: stdin not writable`, 'warning');
    return false;
  }

  try {
    const success = instance.process.stdin.write(
      JSON.stringify(command) + '\n',
      'utf8',
      (err) => {
        if (err) {
          log(`${symbol} stdin write error: ${err.message}`, 'error');
          // ✅ Handle EPIPE gracefully - process likely crashed
          if (err.message.includes('EPIPE')) {
            log(
              `${symbol} process pipe broken, marking for restart`,
              'warning'
            );
            instance.needsRestart = true;
          }
        }
      }
    );

    if (!success) {
      log(`${symbol} stdin buffer full, command queued`, 'warning');
    }

    return success;
  } catch (err: any) {
    log(`${symbol} process error: ${err.message}`, 'error');
    // ✅ Mark for restart on any write error
    instance.needsRestart = true;
    return false;
  }
}

// ✅ Add periodic check for bots that need restart
function checkForRestarts() {
  botInstances.forEach((instance, symbol) => {
    if (instance.needsRestart && !instance.restarting) {
      log(`Restarting ${symbol} due to pipe error`, 'warning');
      restartBot(symbol, 'Pipe error detected');
    }
  });
}

// ---------- BOT MANAGEMENT ----------
function startBot(symbol: string) {
  // ✅ Validate symbol before starting
  if (!VALID_SYMBOLS.includes(symbol)) {
    log(`❌ Cannot start invalid symbol: ${symbol}`, 'error');
    return;
  }

  if (botInstances.has(symbol)) {
    log(`Bot ${symbol} already running`, 'warning');
    return;
  }

  const config = getConfigForSymbol(symbol);
  const logStream = createRotatingLogStream(symbol);
  const stateFile = path.join(
    SESSION_CONFIG.stateDir,
    `${symbol.replace('/', '_')}.json`
  );

  try {
    log(`🚀 Starting bot for ${symbol}`, 'info');

    const childProcess = fork('./dist/src/bot-spot.js', [], {
      env: {
        ...process.env,
        TRADING_SYMBOL: symbol,
        STATE_FILE: stateFile,
        PAPER_TRADING: process.env.PAPER_TRADING || 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });

    const instance: BotInstance = {
      symbol,
      process: childProcess,
      logStream,
      config,
      restartCount: 0,
      startTime: new Date(),
      lastHeartbeat: new Date(),
      status: 'starting',
      position: null,
      pnl: 0,
      totalPnl: 0,
      trades: 0,
      lastError: null,
      needsRestart: false, // ✅ Add flag
      restarting: false, // ✅ Add flag
    };

    botInstances.set(symbol, instance);

    // ✅ FIXED: Better EPIPE error handling
    childProcess.stdin?.on('error', (err) => {
      if (err.message.includes('EPIPE')) {
        log(`${symbol} stdin EPIPE - process likely crashed`, 'error');
        instance.needsRestart = true;
      } else {
        log(`${symbol} stdin error: ${err.message}`, 'error');
      }
    });

    childProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (shouldLogMessage(output)) {
        logStream.write(`${output}\n`);
        if (LAUNCHER_CONFIG.aggregateLogging) {
          aggregateLogStream?.write(`[${symbol}] ${output}\n`);
        }
      }
      instance.lastHeartbeat = new Date();
    });

    childProcess.stderr?.on('data', (data) => {
      const error = data.toString().trim();
      logStream.write(`ERROR: ${error}\n`);
      log(`${symbol} error: ${error}`, 'error');
      instance.lastError = error;
    });

    childProcess.on('message', (message: any) => {
      handleBotMessage(symbol, message);
    });

    childProcess.on('exit', (code, signal) => {
      instance.status = 'stopped';
      log(`${symbol} exited with code ${code} (signal: ${signal})`, 'error');

      if (
        LAUNCHER_CONFIG.autoRestart &&
        instance.restartCount &&
        instance.restartCount < LAUNCHER_CONFIG.maxRestarts
      ) {
        log(
          `${symbol} crashed (${instance.restartCount + 1}/${LAUNCHER_CONFIG.maxRestarts}), restarting...`,
          'warning'
        );
        setTimeout(() => {
          restartBot(symbol, `Crash recovery (code ${code})`);
        }, LAUNCHER_CONFIG.restartDelayMs);
      } else {
        log(`${symbol} max restarts reached or auto-restart disabled`, 'error');
      }
    });

    childProcess.on('error', (err) => {
      log(`${symbol} process error: ${err.message}`, 'error');
      instance.lastError = err.message;
    });

    setTimeout(() => {
      if (instance.status === 'starting') {
        instance.status = 'running';
        log(`✅ ${symbol} bot started successfully`, 'success');
      }
    }, 5000);
  } catch (err: any) {
    log(`Failed to start ${symbol}: ${err.message}`, 'error');
  }
}

function stopBot(symbol: string, reason: string = 'Manual stop') {
  const instance = botInstances.get(symbol);
  if (!instance?.process) {
    log(`${symbol} not running`, 'warning');
    return;
  }

  log(`Stopping ${symbol}: ${reason}`, 'info');
  instance.process.kill('SIGTERM');

  setTimeout(() => {
    if (instance.process && !instance.process.killed) {
      log(`${symbol} didn't stop gracefully, forcing...`, 'warning');
      instance.process.kill('SIGKILL');
    }
  }, 5000);

  closeLogStream(symbol);
  instance.status = 'stopped';
  instance.process = null;
}

function restartBot(symbol: string, reason: string = 'Manual restart') {
  log(`Restarting ${symbol}: ${reason}`, 'info');
  stopBot(symbol, reason);
  setTimeout(() => startBot(symbol), LAUNCHER_CONFIG.restartDelayMs);
}

function handleBotExit(symbol: string, exitCode: number) {
  const instance = botInstances.get(symbol);
  if (!instance) return;

  instance.process = null;
  instance.status = exitCode === 0 ? 'stopped' : 'error';

  if (exitCode !== 0 && LAUNCHER_CONFIG.autoRestart && instance.restartCount) {
    if (instance.restartCount < LAUNCHER_CONFIG.maxRestarts) {
      instance.restartCount++;
      log(
        `${symbol} crashed (${instance.restartCount}/${LAUNCHER_CONFIG.maxRestarts}), restarting...`,
        'warning'
      );
      setTimeout(() => startBot(symbol), LAUNCHER_CONFIG.restartDelayMs);
    } else {
      log(
        `${symbol} exceeded max restarts (${LAUNCHER_CONFIG.maxRestarts}), stopping`,
        'error'
      );
      instance.status = 'error';
    }
  }
}

function handleBotMessage(symbol: string, msg: any) {
  const instance = botInstances.get(symbol);
  if (!instance) return;

  instance.lastHeartbeat = new Date();

  // if (msg.type === 'position_update') {
  //   console.log(
  //     `[LAUNCHER] Received from ${symbol}:`,
  //     JSON.stringify(msg, null, 2)
  //   );
  // }

  switch (msg.type) {
    case 'trade':
      instance.trades++;
      instance.pnl += msg.pnl || 0;
      log(
        `${symbol} ${msg.action}: ${msg.amount?.toFixed(6) || '?'} @ ${msg.price} | PnL: ${msg.pnl?.toFixed(2) || '0'}`,
        'info'
      );
      break;

    case 'position_restored':
      // ✅ Bot loaded position from state file on startup
      instance.position = {
        symbol: msg.symbol,
        entryPrice: msg.entryPrice,
        currentPrice: msg.currentPrice || msg.entryPrice,
        amount: msg.amount,
        remainingAmount: msg.remainingAmount || msg.amount,
        stopLoss: msg.stopLoss,
        takeProfit: msg.takeProfit,
        pnlUsd: msg.pnlUsd || 0,
        pnlPct: msg.pnlPct || 0,
        strategy: msg.strategy,
        partialsSold: msg.partialsSold || 0,
        entryTime: msg.entryTime ? new Date(msg.entryTime) : new Date(),
        positionId: msg.positionId || 'unknown',
        side: 'LONG',
      };
      log(
        `${symbol} restored position from state: ${msg.amount?.toFixed(6)} @ ${msg.entryPrice}`,
        'info'
      );

      // ✅ CRITICAL: Broadcast updated count immediately
      broadcastPositionCount();
      break;

    case 'position_update':
      console.log(
        `[DEBUG] Position update for ${symbol}:`,
        JSON.stringify(msg, null, 2)
      );

      const bot = botInstances.get(symbol);
      if (!bot) {
        log(
          `⚠️ Received position_update for unknown bot: ${symbol}`,
          'warning'
        );
        return;
      }

      // ✅ Update session stats
      bot.sessionPnl = msg.sessionPnl || bot.sessionPnl || 0;
      bot.wins = msg.wins || bot.wins || 0;
      bot.losses = msg.losses || bot.losses || 0;
      bot.trades = msg.tradesCount || bot.trades || 0;

      // ✅ Check if this is a NEW position (bot had no position before)
      const wasNoPosition = bot.position === null;

      if (msg.hasPosition && msg.position) {
        // ✅ BLOCK new positions if limit reached
        const currentPositions = getActivePositionCount();

        if (
          wasNoPosition &&
          currentPositions >= LAUNCHER_CONFIG.maxConcurrentPositions
        ) {
          log(
            `🚫 ${symbol} BLOCKED: Position limit reached (${currentPositions}/${LAUNCHER_CONFIG.maxConcurrentPositions})`,
            'error'
          );

          // Notify the bot to reject the entry
          if (bot.process) {
            bot.process.send({
              type: 'reject_entry',
              reason: 'Global position limit reached',
              currentPositions: currentPositions,
              maxPositions: LAUNCHER_CONFIG.maxConcurrentPositions,
            });
          }
          return; // ❌ Don't allow position update
        }

        // ✅ SAFE: Extract position data with proper fallbacks
        const pos = msg.position;

        // Get current price with fallbacks
        const currentPrice =
          pos.currentPrice ||
          pos.price ||
          bot.position?.currentPrice ||
          pos.entryPrice ||
          0;

        // ✅ Update position data
        bot.position = {
          symbol: symbol,
          entryPrice: pos.entryPrice || bot.position?.entryPrice || 0,
          currentPrice: currentPrice,
          amount: pos.amount || bot.position?.amount || 0,
          remainingAmount:
            pos.remainingAmount ||
            bot.position?.remainingAmount ||
            pos.amount ||
            0,
          stopLoss: pos.stopLoss || bot.position?.stopLoss || 0,
          takeProfit: pos.takeProfit || bot.position?.takeProfit || 0,
          pnlUsd: pos.pnlUsd || 0,
          pnlPct: pos.pnlPct || 0,
          strategy:
            pos.strategy || bot.position?.strategy || ('UNKNOWN' as StrategyId),
          partialsSold: pos.partialsSold || 0,
          entryTime: pos.entryTime
            ? new Date(pos.entryTime)
            : bot.position?.entryTime || new Date(),
          positionId: pos.positionId || bot.position?.positionId || 'unknown',
          side: 'LONG',
        };

        bot.status = 'running';

        // ✅ Log new position entry
        if (wasNoPosition) {
          log(
            `${symbol} ENTRY: ${bot.position.amount.toFixed(6)} @ ${bot.position.entryPrice.toFixed(4)} | Strategy: ${bot.position.strategy}`,
            'success'
          );
        } else {
          // Just an update to existing position
          log(
            `${symbol} position update: PnL ${bot.position.pnlPct >= 0 ? '+' : ''}${bot.position.pnlPct.toFixed(2)}%`,
            'info'
          );
        }
      } else {
        // ✅ No position / position closed
        if (bot.position !== null) {
          log(`${symbol} position closed`, 'info');
        }
        bot.position = null;
        bot.status = 'idle';
      }

      // ✅ CRITICAL: Broadcast updated position count to ALL bots
      broadcastPositionCount();
      break;

    case 'position_closed':
      instance.position = null;
      instance.pnl += msg.pnl || 0;
      log(`${symbol} EXIT: PnL ${msg.pnl?.toFixed(2) || '0'} USDT`, 'info');

      // ✅ CRITICAL: Send updated position count to ALL bots
      broadcastPositionCount();
      break;

    case 'position_check_request':
      // ✅ Bot is asking if it can enter - respond immediately
      respondToPositionCheck(symbol);
      const thousandMultiplierTokens = ['PEPE', 'FLOKI', 'BONK', 'SHIB', 'BTT'];
      break;

    case 'cooldown':
      instance.status = 'cooldown';
      log(`${symbol} entered cooldown: ${msg.reason}`, 'warning');
      break;

    case 'health':
      // ✅ Don't change status to 'health_check' - it breaks the health check loop
      instance.lastHeartbeat = new Date();
      if (msg.balance !== undefined) {
        instance.balance = msg.balance;
      }
      break;

    case 'error':
      instance.lastError = msg.error;
      log(`${symbol} reported error: ${msg.error}`, 'error');
      break;

    case 'scanning':
      instance.status = 'running';
      break;

    case 'waiting':
      instance.status = 'waiting';
      if (msg.reason) {
        instance.lastError = null;
      }
      break;
  }
}

// 4. Add function to broadcast position count to all bots
function broadcastPositionCount() {
  const currentPositions = getCurrentPositionCount(); // Or getActivePositionCount()
  const maxPositions = LAUNCHER_CONFIG.maxConcurrentPositions;

  log(
    `📡 Broadcasting position count: ${currentPositions}/${maxPositions}`,
    'info'
  );

  botInstances.forEach((instance, symbol) => {
    if (instance.process && !instance.process.killed) {
      try {
        instance.process.send({
          type: 'position_count_update',
          currentPositions,
          maxPositions,
          canEnter: currentPositions < maxPositions,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        log(
          `Failed to send position update to ${symbol}: ${err.message}`,
          'error'
        );
      }
    }
  });
}
// 5. Add function to respond to position check requests
function respondToPositionCheck(symbol: string) {
  const instance = botInstances.get(symbol);
  if (!instance?.process) return;

  const currentPositions = getCurrentPositionCount();
  const maxPositions = LAUNCHER_CONFIG.maxConcurrentPositions;
  const canEnter = currentPositions < maxPositions;

  try {
    instance.process.send({
      type: 'position_check_response',
      currentPositions,
      maxPositions,
      canEnter,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    log(
      `Failed to respond to position check from ${symbol}: ${err.message}`,
      'error'
    );
  }
}

// ---------- HEALTH MONITORING ----------
function checkBotHealth(symbol: string) {
  const instance = botInstances.get(symbol);
  if (!instance?.process) return;

  try {
    instance.process.send({
      type: 'health_check',
      balance: process.env.TOTAL_CAPITAL, // ✅ Use allocated capital, not exchange balance
      timestamp: Date.now(),
    });
  } catch (err: any) {
    log(`${symbol} health check failed: ${err.message}`, 'error');
    restartBot(symbol, 'Health check failed');
  }
}

function runHealthChecks() {
  const now = Date.now();

  botInstances.forEach((instance, symbol) => {
    // ✅ Check bots that should be running
    if (instance.status === 'running' || instance.status === 'waiting') {
      const timeSinceHeartbeat = instance.lastHeartbeat
        ? now - instance.lastHeartbeat.getTime()
        : Infinity;

      // If no heartbeat in 2 minutes, restart
      if (timeSinceHeartbeat > 120_000) {
        log(
          `${symbol} missed heartbeat (${Math.floor(timeSinceHeartbeat / 1000)}s), restarting`,
          'error'
        );
        restartBot(symbol, 'Heartbeat timeout');
      } else {
        // Send health check
        checkBotHealth(symbol);
      }
    }
  });
}

// 7. Broadcast position count every 10 seconds to keep bots in sync
setInterval(() => {
  broadcastPositionCount();
}, 10_000);

// ---------- STATISTICS ----------
// function getStats() {
//   const bots = Array.from(botInstances.values());

//   const totalBalance = bots.reduce((sum, b) => sum + b.balance, 0);
//   const unrealizedPnL = bots
//     .filter(b => b.position !== null)
//     .reduce((sum, b) => sum + b.position!.pnlUsd, 0);
//   const realizedPnL = bots.reduce((sum, b) => sum + b.pnl, 0);
//   const allocatedCapital = bots
//     .filter(b => b.position !== null)
//     .reduce((sum, b) => sum + (b.position!.remainingAmount * b.position!.currentPrice), 0);

//   return {
//     active: bots.filter(b => b.status === 'running').length,
//     positions: bots.filter(b => b.position !== null).length,
//     trades: bots.reduce((sum, b) => sum + b.trades, 0),
//     totalBalance,
//     allocatedCapital,
//     availableBalance: totalBalance - allocatedCapital,
//     unrealizedPnL,
//     realizedPnL,
//     totalEquity: totalBalance + realizedPnL + unrealizedPnL,
//   };
// }

function calculateIndicators(
  closes: number[],
  highs: number[],
  lows: number[]
): Indicators | null {
  const minRequired = Math.max(CONFIG.RSI_PERIOD, CONFIG.EMA_200) + 1;
  if (closes.length < minRequired) {
    log(`Need ${minRequired} candles, have ${closes.length}`, 'warning');
    return null;
  }

  const atrVals = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: CONFIG.ATR_PERIOD,
  });
  const rsiVals = RSI.calculate({ period: CONFIG.RSI_PERIOD, values: closes });
  const ema8Vals = EMA.calculate({ period: CONFIG.EMA_8, values: closes });
  const ema21Vals = EMA.calculate({ period: CONFIG.EMA_21, values: closes });
  const ema50Vals = EMA.calculate({ period: CONFIG.EMA_50, values: closes });
  const ema200Vals = EMA.calculate({ period: CONFIG.EMA_200, values: closes });

  if (
    !atrVals.length ||
    !rsiVals.length ||
    !ema50Vals.length ||
    !ema200Vals.length
  ) {
    log('Indicator calculation failed', 'warning');
    return null;
  }

  const atr = atrVals[atrVals.length - 1] as number;
  const rsi = rsiVals[rsiVals.length - 1] as number;
  const ema8 = ema8Vals[ema8Vals.length - 1] as number;
  const ema21 = ema21Vals[ema21Vals.length - 1] as number;
  const ema50 = ema50Vals[ema50Vals.length - 1] as number;
  const ema200 = ema200Vals[ema200Vals.length - 1] as number;
  const currentPrice = closes[closes.length - 1] as number;

  // Determine decimal places based on price
  const decimals = currentPrice < 1 ? 4 : currentPrice < 100 ? 2 : 0;

  return {
    rsi,
    ema8: Number(ema8.toFixed(decimals)),
    ema21: Number(ema21.toFixed(decimals)),
    ema50: Number(ema50.toFixed(decimals)),
    ema200: Number(ema200.toFixed(decimals)),
    currentPrice,
    atr,
    stopLossPrice: currentPrice - atr * CONFIG.ATR_STOP_MULTIPLIER,
    takeProfitPrice: currentPrice + atr * CONFIG.ATR_TP_MULTIPLIER,
  };
}

// Then update getStats() function
function getStats() {
  const bots = Array.from(botInstances.values());
  console.log('🥑 ~ getStats ~ bots:', JSON.stringify(bots.length, null, 2));
  const positionsWithData = Array.from(botInstances.values()).filter(
    (b) => b.position !== null
  );
  console.log(
    '🥑 ~ getStats ~ bots:',
    bots.map((b) => JSON.stringify(b.position?.symbol))
  );

  // ✅ FIXED: Use configured trading capital instead of summing bot balances
  const totalBalance = CAPITAL_CONFIG.TRADING_CAPITAL; // 450 USDT

  const unrealizedPnL = bots
    .filter((b) => b.position && typeof b.position === 'object')
    .reduce((sum, b) => {
      const pos = b.position as Position;
      const value = (pos.currentPrice || 0) * (pos.remainingAmount || 0);

      // ✅ SAFETY:  Validate numbers
      if (!Number.isFinite(value)) {
        log(`⚠️ Invalid position value for ${b.symbol}: ${value}`, 'warning');
        return sum;
      }

      const pnl = value - pos.entryPrice * pos.remainingAmount;
      return sum + (Number.isFinite(pnl) ? pnl : 0);
    }, 0);

  const realizedPnL = bots.reduce((sum, b) => {
    const val = b.pnl || 0;
    return sum + (Number.isFinite(val) ? val : 0);
  }, 0);

  const allocatedCapital = bots
    .filter((b) => b.position !== null)
    .reduce((sum, b) => {
      const pos = b.position;
      const allocated = (pos?.remainingAmount || 0) * (pos?.currentPrice || 0);

      // ✅ SAFETY: Clamp to reasonable values
      if (!Number.isFinite(allocated) || allocated < 0) {
        log(`⚠️ Invalid allocated for ${b.symbol}: ${allocated}`, 'warning');
        return sum;
      }

      return sum + allocated;
    }, 0);

  const availableBalance = Math.max(0, totalBalance - allocatedCapital); // ✅ Never negative

  return {
    active: bots.filter((b) => b.status === 'running').length,
    positions: positionsWithData.length,
    trades: bots.reduce((sum, b) => sum + b.trades, 0),
    totalBalance,
    allocatedCapital: Number.isFinite(allocatedCapital) ? allocatedCapital : 0,
    availableBalance,
    unrealizedPnL: Number.isFinite(unrealizedPnL) ? unrealizedPnL : 0,
    realizedPnL: Number.isFinite(realizedPnL) ? realizedPnL : 0,
    totalEquity:
      totalBalance +
      (Number.isFinite(realizedPnL) ? realizedPnL : 0) +
      (Number.isFinite(unrealizedPnL) ? unrealizedPnL : 0),
    backupReserve: CAPITAL_CONFIG.BACKUP_RESERVE,
    perBotAllocation: CAPITAL_CONFIG.PER_BOT_ALLOCATION,
  };
}

async function scanSingleSymbol(symbol: string): Promise<ScanResult | null> {
  // ✅ Use global instance, don't create new one
  if (!globalCandleManager) {
    throw new Error('CandleManager not initialized');
  }

  // Initialize symbol if needed
  if (!globalCandleManager.hasSymbol(symbol)) {
    const success = await globalCandleManager.initializeHistoricalCandles(
      symbol,
      500,
      0,
      'FUTURES'
    );
    if (!success) {
      updateScanResult(symbol, null);
      return null;
    }
  }

  const data = globalCandleManager.getCandles(symbol);

  try {
    // const success = await c.initializeHistoricalCandles(symbol, 500);
    if (!data) {
      updateScanResult(symbol, null);
      return null;
    }

    // const data = c.getCandles(symbol);
    if (!data || data.closes.length < 210) {
      updateScanResult(symbol, null);
      return null;
    }

    const { closes, highs, lows, volumes } = data;
    const ind = calculateIndicators(closes, highs, lows);
    if (!ind) {
      updateScanResult(symbol, null);
      return null;
    }

    const regime = detectRegime(ind, data);
    const binanceSymbol = symbol.replace('/', '');

    // ✅ Use LOCAL functions
    const htf = await getHTFConfirmation(binanceSymbol, CONFIG.TIMEFRAME);
    const fib = calculateAndLockFibonacci(symbol, lows, highs);
    const signal = pickEntryStrategy(ind, fib, regime, closes, volumes, htf);

    if (signal) {
      // ✅ Fix symbol in signal
      signal.symbol = symbol;

      const result: ScanResult = {
        symbol: symbol,
        signal,
        confidence: signal.confidence,
        price: ind.currentPrice,
        indicators: ind,
      };

      scanResults.set(symbol, {
        lastScan: new Date(),
        signal: signal,
        confidence: signal.confidence,
        price: ind.currentPrice,
        indicators: ind,
        regime: `${regime.trend}/${regime.volatility}`,
        htfTrend: htf.trend,
        rsi: ind.rsi,
      });

      log(
        `✅ ${symbol}: Valid signal (${(signal.confidence * 100).toFixed(0)}%)`,
        'success'
      );
      return result;
    } else {
      updateScanResult(symbol, null);
      return null;
    }
  } catch (err: any) {
    log(`❌ Error scanning ${symbol}: ${err.message}`, 'error');
    updateScanResult(symbol, null);
    return null;
  }
}

async function scanAllSymbols(symbols: string[]): Promise<ScanResult[]> {
  // ✅ LIMIT: Only scan symbols that don't have recent results
  const now = Date.now();
  const needsRescan = symbols.filter((symbol) => {
    const cached = scanResults.get(symbol);
    if (!cached) return true;
    const age = now - cached.lastScan.getTime();
    return age > 5 * 60 * 1000; // Re-scan after 5 minutes
  });

  // ✅ LIMIT: Only scan up to 30 symbols per run
  const toScan = needsRescan.slice(0, 30);

  if (toScan.length === 0) {
    log('📊 All symbols have recent scans, skipping', 'info');
    return Array.from(scanResults.values())
      .filter((r) => r.signal !== null)
      .map((r) => ({
        symbol: r.signal?.symbol,
        signal: r.signal,
        confidence: r.confidence,
        price: r.price,
        indicators: r.indicators,
      })) as ScanResult[];
  }

  console.log(
    `\n🔍 Scanning ${toScan.length} symbols (${needsRescan.length - toScan.length} deferred)...`
  );

  const results: ScanResult[] = [];
  const BATCH_SIZE = 5;
  const RATE_LIMIT_DELAY = 300; // 300ms between requests

  for (let i = 0; i < toScan.length; i += BATCH_SIZE) {
    const batch = toScan.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map((symbol) => scanSingleSymbol(symbol));
    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value !== null) {
        results.push(result.value);
      }
    }

    // Rate limit delay
    if (i + BATCH_SIZE < toScan.length) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
    }
  }

  log(
    `✅ Scan complete: ${results.length}/${toScan.length} signals`,
    'success'
  );

  // ✅ Cleanup after scan
  cleanupScanResults();

  return results;
}

// 8️⃣ FIX updateScanResult to prevent bloat
async function updateScanResult(symbol: string, result: ScanResult | null) {
  // ✅ Enforce limit BEFORE adding
  if (
    scanResults.size >= MEMORY_LIMITS.MAX_SCAN_RESULTS &&
    !scanResults.has(symbol)
  ) {
    // Remove oldest entry without signal
    const oldest = Array.from(scanResults.entries())
      .filter(([, data]) => data.signal === null)
      .sort(([, a], [, b]) => a.lastScan.getTime() - b.lastScan.getTime())[0];

    if (oldest) {
      scanResults.delete(oldest[0]);
    }
  }

  if (!globalCandleManager) {
    throw new Error('CandleManager not initialized');
  }

  // Initialize symbol if needed
  if (!globalCandleManager.hasSymbol(symbol)) {
    const success = await globalCandleManager.initializeHistoricalCandles(
      symbol,
      500,
      0,
      'FUTURES'
    );
    if (!success) {
      updateScanResult(symbol, null);
      return null;
    }
  }

  const data = globalCandleManager.getCandles(symbol) as CandleData;

  if (result && result.signal) {
    scanResults.set(symbol, {
      lastScan: new Date(),
      signal: result.signal,
      confidence: result.confidence,
      price: result.price,
      indicators: result.indicators,
      regime: `${detectRegime(result.indicators, data).trend}/${detectRegime(result.indicators, data).volatility}`,
      htfTrend: 'N/A',
      rsi: result.indicators.rsi,
    });
  } else {
    // Don't store failed scans - just delete old entry
    scanResults.delete(symbol);
  }
}

export function pickBestAdvanced(candidates: ScanResult[]): ScanResult | null {
  if (candidates.length === 0) return null;

  // Filter by minimum confidence
  const MIN_CONFIDENCE = 0.6; // 60%
  const qualified = candidates.filter((c) => c.confidence >= MIN_CONFIDENCE);

  if (qualified.length === 0) {
    log(
      `❌ No candidates meet ${MIN_CONFIDENCE * 100}% confidence threshold`,
      'warning'
    );
    return null;
  }

  // Score based on multiple factors
  const scored = qualified.map((candidate) => {
    let score = 0;

    // 1. Confidence (40% weight)
    score += candidate.confidence * 0.4;

    // 2. Strategy preference (20% weight)
    const strategyScores: Record<string, number> = {
      BREAKOUT: 0.2,
      FIB_RETRACEMENT: 0.15,
      EMA_PULLBACK: 0.1,
      BREAKDOWN: 0.2,
      FIB_RETRACEMENT_SHORT: 0.15,
      EMA_PULLBACK_SHORT: 0.1,
    };
    score +=
      (candidate.signal && strategyScores[candidate.signal.strategy]) || 0;

    // 3. RSI positioning (20% weight)
    const rsi = candidate.indicators.rsi;
    if (candidate.signal && candidate.signal.side === 'LONG') {
      // Prefer RSI between 30-50 for longs (oversold but not extreme)
      if (rsi >= 30 && rsi <= 50) score += 0.2;
      else if (rsi >= 25 && rsi <= 55) score += 0.1;
    } else {
      // Prefer RSI between 50-70 for shorts (overbought but not extreme)
      if (rsi >= 50 && rsi <= 70) score += 0.2;
      else if (rsi >= 45 && rsi <= 75) score += 0.1;
    }

    // 4. Trend alignment (20% weight)
    const ema50 = candidate.indicators.ema50;
    const ema200 = candidate.indicators.ema200;
    const priceAboveEma50 = candidate.price > ema50;
    const goldenCross = ema50 > ema200;

    if (
      candidate.signal &&
      candidate.signal.side === 'LONG' &&
      goldenCross &&
      priceAboveEma50
    ) {
      score += 0.2;
    } else if (
      candidate.signal &&
      candidate.signal.side === 'SHORT' &&
      !goldenCross &&
      !priceAboveEma50
    ) {
      score += 0.2;
    } else {
      score += 0.05; // Partial credit
    }

    return {
      ...candidate,
      finalScore: score,
    };
  });

  // Sort by final score
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Log top 5
  console.log('\n🏆 TOP CANDIDATES (Advanced Scoring):');
  scored.slice(0, 5).forEach((candidate, index) => {
    const icon = index === 0 ? '👑' : `${index + 1}.`;
    console.log(
      `${icon} ${candidate.symbol.padEnd(12)} | ` +
        `Score: ${(candidate.finalScore * 100).toFixed(1)}% | ` +
        `Conf: ${(candidate.confidence * 100).toFixed(0)}% | ` +
        `${candidate.signal && candidate.signal.side} ${candidate.signal && candidate.signal.strategy}`
    );
  });

  const winner = scored[0] as ScanResult;
  log(
    `\n🎯 WINNER: ${winner.symbol} (Score: ${(winner.finalScore || 0 * 100).toFixed(1)}%)`,
    'success'
  );

  return winner;
}

const scannedSymbols = Array.from(scanResults.entries());
// Separate into signals and no-signals
const withSignals = scannedSymbols.filter(([, data]) => data.signal !== null);
const withoutSignals = scannedSymbols.filter(
  ([, data]) => data.signal === null
);
function displayScanSummary() {
  const WIDTH = 180;

  console.log('\n' + colorize('═'.repeat(WIDTH), colors.brightYellow));
  console.log(colorize('🔍 SCAN RESULTS SUMMARY', colors.bright));

  if (scannedSymbols.length === 0) {
    console.log(
      colorize(
        '  No scan data available yet - waiting for first scan...',
        colors.gray
      )
    );
    console.log(colorize('═'.repeat(WIDTH), colors.brightYellow) + '\n');
    return;
  }

  // Display tokens WITH signals first
  if (withSignals.length > 0) {
    console.log(colorize('\n✅ TOKENS WITH SIGNALS:', colors.brightGreen));
    console.log(colorize('─'.repeat(WIDTH), colors.gray));

    const cols = {
      symbol: 14,
      strategy: 25,
      side: 8,
      confidence: 12,
      price: 12,
      rsi: 8,
      regime: 18,
      htf: 12,
      lastScan: 12,
      action: 10,
    };

    // Header
    const header = [
      padRight('Symbol', cols.symbol),
      padRight('Strategy', cols.strategy),
      padRight('Side', cols.side),
      padRight('Confidence', cols.confidence),
      padRight('Price', cols.price),
      padRight('RSI', cols.rsi),
      padRight('Regime', cols.regime),
      padRight('HTF', cols.htf),
      padRight('Last Scan', cols.lastScan),
      padRight('Action', cols.action),
    ]
      .map((col) => colorize(col, colors.gray))
      .join(' │ ');

    console.log(header);
    console.log(colorize('─'.repeat(WIDTH), colors.gray));

    // Sort by confidence (highest first)
    withSignals.sort(([, a], [, b]) => b.confidence - a.confidence);

    withSignals.forEach(([symbol, data], index) => {
      const signal = data.signal as EntrySignal;

      const sideIcon =
        signal?.side === 'LONG' ? '▲' : signal?.side === 'SHORT' ? '▼' : '●';
      const sideColor =
        signal?.side === 'LONG'
          ? colors.brightGreen
          : signal?.side === 'SHORT'
            ? colors.brightRed
            : colors.cyan;

      const confidenceColor =
        data.confidence >= 0.7
          ? colors.brightGreen
          : data.confidence >= 0.6
            ? colors.green
            : colors.yellow;

      const timeSince = Math.floor(
        (Date.now() - data.lastScan.getTime()) / 1000
      );
      const timeStr =
        timeSince < 60 ? `${timeSince}s` : `${Math.floor(timeSince / 60)}m`;

      // Check if bot exists and has position
      const botInstance = botInstances.get(symbol);
      const hasPosition = botInstance?.position !== null;
      const actionText = hasPosition
        ? '✓ IN POS'
        : index === 0
          ? '👉 READY'
          : 'queued';
      const actionColor = hasPosition
        ? colors.green
        : index === 0
          ? colors.brightCyan
          : colors.gray;

      const row = [
        colorize(padRight(symbol, cols.symbol), colors.brightCyan),
        colorize(
          padRight(signal?.strategy ?? 'UNKNOWN', cols.strategy),
          colors.magenta
        ),
        colorize(
          padRight(`${sideIcon} ${signal?.side || 'SPOT'}`, cols.side),
          sideColor
        ),
        colorize(
          padRight(`${(data.confidence * 100).toFixed(0)}%`, cols.confidence),
          confidenceColor
        ),
        colorize(padRight(data.price.toFixed(4), cols.price), colors.white),
        colorize(padRight((data.rsi || 0).toFixed(1), cols.rsi), colors.cyan),
        colorize(padRight(data.regime || 'N/A', cols.regime), colors.gray),
        colorize(padRight(data.htfTrend || 'N/A', cols.htf), colors.gray),
        colorize(padRight(timeStr, cols.lastScan), colors.dim),
        colorize(padRight(actionText, cols.action), actionColor),
      ].join(' │ ');

      console.log(row);
    });
  }

  // Display count of tokens WITHOUT signals
  if (withoutSignals.length > 0) {
    console.log(
      '\n' +
        colorize(
          `❌ ${withoutSignals.length} tokens with NO SIGNALS`,
          colors.gray
        )
    );

    // Show last 10 scanned without signals
    const recentNoSignals = withoutSignals
      .sort(([, a], [, b]) => b.lastScan.getTime() - a.lastScan.getTime())
      .slice(0, 10);

    console.log(
      colorize('   Recently scanned: ', colors.dim) +
        recentNoSignals
          .map(([symbol]) => colorize(symbol, colors.gray))
          .join(', ')
    );
  }

  // Summary stats
  const positionsActive = Array.from(botInstances.values()).filter(
    (b) => b.position !== null
  ).length;
  const signalsWaiting = withSignals.filter(
    ([symbol]) => !botInstances.get(symbol)?.position
  ).length;

  console.log('\n' + colorize('═'.repeat(WIDTH), colors.brightYellow));
  console.log(
    colorize(`📊 Scanned: ${scannedSymbols.length} | `, colors.white) +
      colorize(`Signals: ${withSignals.length} | `, colors.brightGreen) +
      colorize(`No Signal: ${withoutSignals.length} | `, colors.gray) +
      colorize(
        `Active Positions: ${positionsActive}/${LAUNCHER_CONFIG.maxConcurrentPositions} | `,
        colors.brightCyan
      ) +
      colorize(`Waiting: ${signalsWaiting}`, colors.yellow)
  );
  console.log(colorize('═'.repeat(WIDTH), colors.brightYellow) + '\n');
}

// Display count of tokens WITHOUT signals
if (withoutSignals.length > 0) {
  console.log(
    '\n' +
      colorize(
        `❌ ${withoutSignals.length} tokens with NO SIGNALS`,
        colors.gray
      )
  );

  // Show last 10 scanned without signals
  const recentNoSignals = withoutSignals
    .sort(([, a], [, b]) => b.lastScan.getTime() - a.lastScan.getTime())
    .slice(0, 10);

  console.log(
    colorize('   Recently scanned: ', colors.dim) +
      recentNoSignals
        .map(([symbol]) => colorize(symbol, colors.gray))
        .join(', ')
  );

  // Summary stats
  const positionsActive = Array.from(botInstances.values()).filter(
    (b) => b.position !== null
  ).length;
  const signalsWaiting = withSignals.filter(
    ([symbol]) => !botInstances.get(symbol)?.position
  ).length;

  console.log('\n' + colorize('═'.repeat(189), colors.brightYellow));
  console.log(
    colorize(`📊 Scanned: ${scannedSymbols.length} | `, colors.white) +
      colorize(`Signals: ${withSignals.length} | `, colors.brightGreen) +
      colorize(`No Signal: ${withoutSignals.length} | `, colors.gray) +
      colorize(
        `Active Positions: ${positionsActive}/${LAUNCHER_CONFIG.maxConcurrentPositions} | `,
        colors.brightCyan
      ) +
      colorize(`Waiting: ${signalsWaiting}`, colors.yellow)
  );
  console.log(colorize('═'.repeat(180), colors.brightYellow) + '\n');
}

function displayCompactPositions(activeBots: BotInstance[]) {
  const WIDTH = 180; // Fixed width

  console.log('\n' + colorize('═'.repeat(WIDTH), colors.brightCyan));
  console.log(colorize('📊 ACTIVE POSITIONS (Compact)', colors.bright));
  console.log(colorize('═'.repeat(WIDTH), colors.brightCyan));

  const validBots = activeBots.filter((bot) => {
    if (!bot.position) return false;
    if (!bot.position.entryPrice || bot.position.entryPrice === 0) return false;
    if (!bot.position.remainingAmount || bot.position.remainingAmount === 0)
      return false;
    if (
      bot.status === 'cooldown' ||
      bot.status === 'idle' ||
      bot.status === 'waiting'
    )
      return false;
    return true;
  });

  if (validBots.length === 0) {
    console.log(colorize('  No active positions', colors.gray));
    console.log(colorize('═'.repeat(WIDTH), colors.brightCyan) + '\n');
    return;
  }

  // ✅ FIXED COLUMN WIDTHS
  const cols = {
    symbol: 12,
    side: 10,
    amount: 16,
    partials: 10,
    entry: 12,
    current: 12,
    investment: 12,
    unrealizedPnl: 22,
    realizedPnl: 14,
    totalPnl: 14,
    slTp: 22,
    status: 12,
    wl: 8,
  };

  // ✅ ALIGNED HEADER
  const header = [
    padRight('Symbol', cols.symbol),
    padRight('Side', cols.side),
    padLeft('Amount', cols.amount),
    padCenter('Partials', cols.partials),
    padLeft('Entry', cols.entry),
    padLeft('Current', cols.current),
    padLeft('Investment', cols.investment),
    padLeft('Unrealized PnL', cols.unrealizedPnl),
    padLeft('Realized PnL', cols.realizedPnl),
    padLeft('Total PnL', cols.totalPnl),
    padLeft('SL / TP', cols.slTp),
    padRight('Status', cols.status),
    padRight('W/L', cols.wl),
  ]
    .map((col) => colorize(col, colors.gray))
    .join(' │ ');

  console.log(header);
  console.log(colorize('─'.repeat(WIDTH), colors.gray));

  // ✅ ALIGNED ROWS
  validBots.forEach((bot) => {
    const pos = bot.position as Position;
    const symbol = bot.symbol || 'UNKNOWN';
    const side = bot.side || undefined;
    // const leverage = pos.leverage || 5;

    const sideIcon = side === 'LONG' ? '▲' : '▼';
    const sideColor = side === 'LONG' ? colors.brightGreen : colors.brightRed;

    const remainingAmount = pos.remainingAmount || 0;
    const originalAmount = pos.amount || remainingAmount;
    const closedAmount = originalAmount - remainingAmount;
    const closedPct =
      originalAmount > 0 ? (closedAmount / originalAmount) * 100 : 0;

    const hasPartials = closedAmount > 0;
    const amountDisplay = hasPartials
      ? `${formatNumber(remainingAmount, 3)} (${(100 - closedPct).toFixed(0)}%)`
      : formatNumber(remainingAmount, 3);

    const partialsSold = pos.partialsSold || 0;
    const partialsDisplay = `${partialsSold}/2`;

    const entryPrice = pos.entryPrice || 0;
    const currentPrice = pos.currentPrice || entryPrice;
    const priceDecimals = getPriceDecimals(currentPrice);

    // const marginUsed = pos.marginUsed || (remainingAmount * entryPrice / leverage);
    const unrealizedPnlUsd = pos.pnlUsd || 0;
    const unrealizedPnlPct = pos.pnlPct || 0;
    const realizedPnlUsd = bot.sessionPnl || 0;
    const totalPnlUsd = unrealizedPnlUsd + realizedPnlUsd;

    const stopLoss = pos.stopLoss || 0;
    const takeProfit = pos.takeProfit || 0;

    const status = bot.status || 'running';
    const statusDisplay = status === 'running' ? '🟢 Active' : '🧊 Cooldown';

    const wins = bot.wins || 0;
    const losses = bot.losses || 0;
    const wlDisplay = `${wins}/${losses}`;

    // ✅ BUILD ROW WITH EXACT WIDTHS
    const row = [
      colorize(padRight(`${sideIcon} ${symbol}`, cols.symbol), colors.white),
      // colorize(padRight(`${side} ${leverage}x`, cols.side), sideColor),
      colorize(
        padLeft(amountDisplay, cols.amount),
        hasPartials ? colors.yellow : colors.white
      ),
      colorize(
        padCenter(partialsDisplay, cols.partials),
        partialsSold > 0 ? colors.brightCyan : colors.gray
      ),
      colorize(
        padLeft(entryPrice.toFixed(priceDecimals), cols.entry),
        colors.white
      ),
      colorize(
        padLeft(currentPrice.toFixed(priceDecimals), cols.current),
        colors.white
      ),
      // colorize(padLeft(formatNumber(marginUsed, 2), cols.investment), colors.cyan),
      colorize(
        padLeft(
          `${unrealizedPnlPct >= 0 ? '+' : ''}${unrealizedPnlPct.toFixed(2)}% ($${unrealizedPnlUsd.toFixed(2)})`,
          cols.unrealizedPnl
        ),
        unrealizedPnlUsd >= 0 ? colors.brightGreen : colors.brightRed
      ),
      colorize(
        padLeft(
          realizedPnlUsd !== 0
            ? `$${realizedPnlUsd >= 0 ? '+' : ''}${realizedPnlUsd.toFixed(2)}`
            : '--',
          cols.realizedPnl
        ),
        realizedPnlUsd >= 0
          ? colors.brightGreen
          : realizedPnlUsd < 0
            ? colors.brightRed
            : colors.gray
      ),
      colorize(
        padLeft(
          `$${totalPnlUsd >= 0 ? '+' : ''}${totalPnlUsd.toFixed(2)}`,
          cols.totalPnl
        ),
        totalPnlUsd >= 0 ? colors.brightGreen : colors.brightRed
      ),
      colorize(
        padLeft(
          `${stopLoss.toFixed(priceDecimals)} / ${takeProfit.toFixed(priceDecimals)}`,
          cols.slTp
        ),
        colors.gray
      ),
      colorize(padRight(statusDisplay, cols.status), colors.white),
      colorize(padRight(wlDisplay, cols.wl), colors.cyan),
    ].join(' │ ');

    console.log(row);
  });

  console.log(colorize('═'.repeat(WIDTH), colors.brightCyan) + '\n');
}

// Function to automatically enter best signal when position slot available
async function tryEnterBestSignal() {
  const currentPositions = getActivePositionCount();

  // Check if we can enter a new position
  if (currentPositions >= LAUNCHER_CONFIG.maxConcurrentPositions) {
    return; // Position limit reached
  }

  // Get all signals, sorted by confidence
  const withSignals = Array.from(scanResults.entries())
    .filter(([, data]) => data.signal !== null)
    .filter(([symbol]) => {
      const bot = botInstances.get(symbol);
      return !bot?.position; // Only consider bots without positions
    })
    .map(([symbol, data]) => ({ symbol, data }))
    .sort((a, b) => b.data.confidence - a.data.confidence);

  if (withSignals.length === 0) {
    log('📭 No signals available for entry', 'info');
    return;
  }

  // Get best signal
  const best = withSignals[0];
  const bot = best && botInstances.get(best.symbol);

  if (!bot || !bot.process) {
    log(`⚠️ Bot for ${best?.symbol} not running`, 'warning');
    return;
  }

  log(`\n🎯 AUTO-ENTRY: Sending signal to ${best.symbol}`, 'success');
  log(`   Strategy: ${best.data.signal?.strategy}`, 'info');
  log(`   Confidence: ${(best.data.confidence * 100).toFixed(0)}%`, 'info');
  log(`   Price: ${best.data.price.toFixed(4)}`, 'info');

  // Send entry command to bot
  try {
    bot.process?.send({
      type: 'execute_entry',
      signal: best.data.signal,
      price: best.data.price,
      confidence: best.data.confidence,
    });

    log(`✅ Entry command sent to ${best.symbol}`, 'success');

    // Remove from scan results to avoid re-entry
    scanResults.delete(best.symbol);
  } catch (err: any) {
    log(`❌ Failed to send entry command: ${err.message}`, 'error');
  }
}

// ============================================================================
// PART 6: Periodic Scanning System
// ============================================================================

async function periodicScanCheck() {
  if (isScanning) {
    log('⏭️  Scan already in progress, skipping', 'warning');
    return;
  }

  const now = Date.now();

  if (now - lastFullScan >= SCAN_INTERVAL) {
    log('🔄 Running periodic scan...', 'info');
    lastFullScan = now;
    isScanning = true;

    try {
      const results = await scanAllSymbols(LAUNCHER_CONFIG.enabledSymbols);
      log(`✅ Scan complete: ${results.length} signals`, 'success');
      await tryEnterBestSignal();
    } catch (err: any) {
      log(`❌ Scan error: ${err.message}`, 'error');
    } finally {
      isScanning = false;
    }
  }
}
// ✅ HELPER FUNCTIONS FOR ALIGNMENT
function padLeft(text: string, width: number): string {
  const visible = stripAnsi(text);
  const padding = Math.max(0, width - visible.length);
  return ' '.repeat(padding) + text;
}

function padRight(text: string, width: number): string {
  const visible = stripAnsi(text);
  const padding = Math.max(0, width - visible.length);
  return text + ' '.repeat(padding);
}

function padCenter(text: string, width: number): string {
  const visible = stripAnsi(text);
  const totalPadding = Math.max(0, width - visible.length);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return ' '.repeat(leftPadding) + text + ' '.repeat(rightPadding);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------- DASHBOARD ----------
async function printDashboard() {
  console.clear();

  const now = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const stats = getStats();
  console.log('🥑 ~ printDashboard ~ stats:', JSON.stringify(stats, null, 2));
  const posLimit = LAUNCHER_CONFIG.maxConcurrentPositions;

  // Header
  console.log(colorize('═'.repeat(145), colors.cyan));
  console.log(
    colorize('🤖 MULTI-BOT TRADING DASHBOARD', colors.brightCyan) +
      ' '.repeat(76) +
      colorize(`Updated: ${now}`, colors.gray)
  );
  console.log(colorize('═'.repeat(145), colors.cyan));

  // Stats line
  const posColor =
    stats.positions >= posLimit
      ? colors.brightRed
      : stats.positions >= posLimit - 1
        ? colors.brightYellow
        : colors.brightGreen;

  console.log(
    `Active: ${colorize(stats.active.toString(), colors.brightGreen)}/${LAUNCHER_CONFIG.maxBotsRunning} | ` +
      `Positions: ${colorize(stats.positions.toString(), posColor)}/${posLimit} | ` +
      `Trades: ${colorize(stats.trades.toString(), colors.brightCyan)} | ` +
      `Realized: ${colorPnL(stats.realizedPnL)} USDT | ` +
      `Unrealized: ${colorPnL(stats.unrealizedPnL)} USDT`
  );

  console.log(
    `💰 Balance: ${colorize(stats.totalBalance.toFixed(2), colors.white)} USDT | ` +
      `🔒 Allocated: ${colorize(stats.allocatedCapital.toFixed(2), colors.yellow)} USDT | ` +
      `💵 Available: ${colorize(stats.availableBalance.toFixed(2), colors.green)} USDT | ` +
      `🦄 Total Equity: ${colorize(stats.totalEquity.toFixed(2), colors.brightCyan)} USDT`
  );

  if (stats.positions >= posLimit) {
    console.log(
      colorize(
        `⚠️  POSITION LIMIT REACHED - No new entries allowed`,
        colors.brightRed
      )
    );
  } else if (stats.positions === posLimit - 1) {
    console.log(colorize(`⚠️  1 position slot remaining`, colors.brightYellow));
  }

  console.log(colorize('─'.repeat(145), colors.gray));

  // 🆕 ADD SCAN SUMMARY HERE
  displayScanSummary();

  // // // ========== MANAGE EXISTING POSITION ==========
  // if (currentPosition) {
  //   log(`📊 Managing position: ${currentPosition.symbol}`, 'info');
  //   const c = new CandleManager([currentPosition.symbol], CONFIG.TIMEFRAME);
  //   // Get live price from ticker
  //   let livePrice: number;
  //   try {
  //     const ticker = latestTicker[currentPosition.symbol];
  //     livePrice = ticker?.last || ticker?.close || 0;

  //     if (!livePrice || livePrice <= 0) {
  //       log('⚠️ Invalid ticker, using candle data', 'warning');
  //       const data = await c.getCandles(currentPosition.symbol);
  //       if (!data) {
  //         log('❌ Cannot get price data', 'error');
  //         return;
  //       }
  //       livePrice = data.closes[data.closes.length - 1] || 0;
  //     }
  //   } catch (err) {
  //     log(`❌ Price fetch failed: ${err}`, 'error');
  //     const data = await c.getCandles(currentPosition.symbol);
  //     if (!data) return;
  //     livePrice = data.closes[data.closes.length - 1] || 0;
  //   }

  //   // Get candle data for indicators
  //   const data = await c.getCandles(currentPosition.symbol);

  //   if (!data) {
  //     log('❌ No candle data available', 'error');
  //     return;
  //   }

  //   log(`📊 Candles available: ${data.closes.length}`, 'info');

  //   const { closes, highs, lows } = data;
  //   const ind = calculateIndicators(closes, highs, lows);

  //   if (!ind) {
  //     log('❌ Indicator calculation failed', 'error');
  //     return;
  //   }

  //   // Use live price
  //   ind.currentPrice = livePrice;

  //   // Position status
  //   const pnl =
  //     ((livePrice - currentPosition.entryPrice) / currentPosition.entryPrice) *
  //     100;

  //   console.log('\n💼 POSITION STATUS:');
  //   log(
  //     `💰 Price: ${livePrice.toFixed(4)} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`,
  //     pnl >= 0 ? 'success' : 'error'
  //   );
  //   log(
  //     `   Entry: ${currentPosition.entryPrice.toFixed(4)} | SL: ${currentPosition.stopLoss.toFixed(4)} | TP: ${currentPosition.takeProfit.toFixed(4)}`,
  //     'info'
  //   );

  //   // Trailing stop logic
  //   if (currentPosition.partialsSold > 0 && pnl > 2.0) {
  //     const newSl = livePrice - ind.atr * 1.0;
  //     if (newSl > currentPosition.stopLoss) {
  //       log(
  //         `📈 Trailing SL: ${currentPosition.stopLoss.toFixed(4)} → ${newSl.toFixed(4)}`,
  //         'success'
  //       );
  //       currentPosition.stopLoss = newSl;
  //       currentPosition.trailingActive = true;
  //       const activeBots = Array.from(botInstances.values()).filter(
  //         (b) => b.position && b.position.symbol === currentPosition!.symbol
  //       );
  //               // Add compact positions display
  //       const botsWithPositions = Array.from(botInstances.values()).filter(
  //         (b) => b.position !== null
  //       );

  //         displayCompactPositions(activeBots);
  //       saveState();
  //     }
  //   }

  //   // Check exits
  //   const exited = await checkAndExecuteExits(currentPosition, ind);
  //   if (!exited) {
  //     log('✅ Holding position', 'success');
  //   }

  //   return;
  // }

  // Header
  console.log(colorize('═'.repeat(145), colors.cyan));
  console.log(
    colorize('🤖 MULTI-BOT TRADING DASHBOARD', colors.brightCyan) +
      ' '.repeat(76) +
      colorize(`Updated: ${now}`, colors.gray)
  );
  console.log(colorize('═'.repeat(145), colors.cyan));

  // Stats line
  // const posColor =
  //   stats.positions >= posLimit
  //     ? colors.brightRed
  //     : stats.positions >= posLimit - 1
  //       ? colors.brightYellow
  //       : colors.brightGreen;

  console.log(
    `Active: ${colorize(stats.active.toString(), colors.brightGreen)}/${LAUNCHER_CONFIG.maxBotsRunning} | ` +
      `Positions: ${colorize(stats.positions.toString(), posColor)}/${posLimit} | ` +
      `Trades: ${colorize(stats.trades.toString(), colors.brightCyan)} | ` +
      `Realized: ${colorPnL(stats.realizedPnL)} USDT | ` +
      `Unrealized: ${colorPnL(stats.unrealizedPnL)} USDT`
  );

  console.log(
    `💰 Balance: ${colorize(stats.totalBalance.toFixed(2), colors.white)} USDT | ` +
      `🔒 Allocated: ${colorize(stats.allocatedCapital.toFixed(2), colors.yellow)} USDT | ` +
      `💵 Available: ${colorize(stats.availableBalance.toFixed(2), colors.green)} USDT | ` +
      `🏦 Total Equity: ${colorize(stats.totalEquity.toFixed(2), colors.brightCyan)} USDT`
  );

  // Warning if at/near limit
  if (stats.positions >= posLimit) {
    console.log(
      colorize(
        `⚠️  POSITION LIMIT REACHED - No new entries allowed`,
        colors.brightRed
      )
    );
  } else if (stats.positions === posLimit - 1) {
    console.log(colorize(`⚠️  1 position slot remaining`, colors.brightYellow));
  }

  console.log(colorize('─'.repeat(145), colors.gray));

  // Column configuration
  const col = {
    symbol: 14,
    status: 12,
    entry: 11,
    current: 11,
    amount: 13,
    pnlPct: 10,
    pnlUsd: 11,
    sl: 11,
    tp: 11,
    strategy: 25,
  };

  // Header row
  console.log(
    colorize('Symbol'.padEnd(col.symbol), colors.bright) +
      colorize('Status'.padEnd(col.status), colors.bright) +
      colorize('Entry'.padEnd(col.entry), colors.bright) +
      colorize('Current'.padEnd(col.current), colors.bright) +
      colorize('Amount'.padEnd(col.amount), colors.bright) +
      colorize('PnL %'.padEnd(col.pnlPct), colors.bright) +
      colorize('PnL $'.padEnd(col.pnlUsd), colors.bright) +
      colorize('SL'.padEnd(col.sl), colors.bright) +
      colorize('TP'.padEnd(col.tp), colors.bright) +
      colorize('Strategy/Info', colors.bright)
  );
  console.log(colorize('─'.repeat(145), colors.gray));

  // Sort: positions first (by PnL), then by session PnL
  const sortedBots = Array.from(botInstances.entries()).sort(([, a], [, b]) => {
    if (a.position && !b.position) return -1;
    if (!a.position && b.position) return 1;
    if (a.position && b.position) return b.position.pnlUsd - a.position.pnlUsd;
    return b.pnl - a.pnl;
  });

  sortedBots.forEach(([symbol, instance]) => {
    if (instance.position) {
      const pos = instance.position;
      const current = pos.currentPrice || pos.entryPrice;
      const pnlPct = ((current - pos.entryPrice) / pos.entryPrice) * 100;
      const pnlUsd = (current - pos.entryPrice) * pos.remainingAmount;

      const priceDecimals = getPriceDecimals(current);
      const amountDecimals = getAmountDecimals(pos.remainingAmount, current);

      console.log(
        padColored(colorize(symbol, colors.brightCyan), col.symbol) +
          padColored(colorize('🟢 IN POS', colors.green), col.status) +
          padColored(
            colorize(
              pos.entryPrice.toFixed(priceDecimals),
              pos.entryPrice < current ? colors.bgGreen : colors.bgRed
            ),
            col.entry
          ) +
          current.toFixed(priceDecimals).padEnd(col.current) +
          pos.remainingAmount.toFixed(amountDecimals).padEnd(col.amount) +
          padColored(colorPnL(pnlPct, true), col.pnlPct) +
          padColored(colorPnL(pnlUsd, false), col.pnlUsd) +
          padColored(
            colorize(pos.stopLoss.toFixed(priceDecimals), colors.red),
            col.sl
          ) +
          padColored(
            colorize(pos.takeProfit.toFixed(priceDecimals), colors.green),
            col.tp
          ) +
          colorize(pos.strategy, colors.magenta)
      );
    } else {
      const statusIcon =
        instance.status === 'running'
          ? '🔍'
          : instance.status === 'cooldown'
            ? '🧊'
            : instance.status === 'waiting'
              ? '⏳'
              : instance.status === 'error'
                ? '❌'
                : '⚪';

      const statusColor =
        instance.status === 'running'
          ? colors.gray
          : instance.status === 'cooldown'
            ? colors.yellow
            : instance.status === 'error'
              ? colors.red
              : colors.cyan;

      // Check if trades > 0 and apply green color to entire row
      const hasTrades = instance.trades > 0;
      const rowColor = hasTrades ? colors.green : colors.white;
      const statusTextColor = hasTrades ? colors.green : statusColor;
      const detailsColor = hasTrades ? colors.green : colors.yellow;

      console.log(
        padColored(
          colorize(symbol, hasTrades ? colors.green : colors.gray),
          col.symbol
        ) +
          padColored(colorize(`${statusIcon} SCAN`, statusColor), col.status) +
          colorize('-', hasTrades ? colors.green : colors.dim).padEnd(
            col.entry
          ) +
          colorize('-', hasTrades ? colors.green : colors.dim).padEnd(
            col.current
          ) +
          colorize('-', hasTrades ? colors.green : colors.dim).padEnd(
            col.amount
          ) +
          colorize('-', hasTrades ? colors.green : colors.dim).padEnd(
            col.pnlPct
          ) +
          padColored(
            colorize(`$${instance.pnl?.toFixed(2) || '0.00'}`, colors.green),
            col.pnlUsd
          ) +
          colorize('-', hasTrades ? colors.green : colors.dim).padEnd(col.sl) +
          colorize('-', hasTrades ? colors.green : colors.dim).padEnd(col.tp) +
          colorize(
            `${instance.trades} trades | ${instance.status}`,
            detailsColor
          )
      );
    }

    if (instance.lastError) {
      console.log(colorize(`  └─ ⚠️  ${instance.lastError}`, colors.red));
    }
  });

  // Show active positions with row numbers
  const botsWithPositions = Array.from(botInstances.values()).filter(
    (b) => b.position !== null
  );
  console.log(`[DEBUG printDashboard] Total bots: ${botInstances.size}`);
  console.log(
    `[DEBUG printDashboard] Bots with positions: ${botsWithPositions.length}`
  );

  if (botsWithPositions.length > 0) {
    botsWithPositions.forEach((bot, i) => {
      console.log(`[DEBUG printDashboard] Bot ${i}: ${bot.symbol}`);
      if (bot.position) {
        console.log(
          `[DEBUG printDashboard]   Entry: ${bot.position.entryPrice}, Amount: ${bot.position.remainingAmount}`
        );
      }
    });
  }

  const validPositions = botsWithPositions.filter((bot) => {
    const amount = bot.position?.remainingAmount || bot.position?.amount || 0;
    return bot.position && bot.position.entryPrice > 0 && amount > 0;
  });

  // displayCompactPositions(botsWithPositions);

  // if (botsWithPositions.length > 0) {
  //   displayCompactPositions(botsWithPositions);
  // }

  displayCompactPositions(validPositions);

  console.log(colorize('═'.repeat(145), colors.cyan));
  console.log(
    colorize('[r]', colors.brightGreen) +
      ' Restart All | ' +
      colorize('[s]', colors.brightRed) +
      ' Stop All | ' +
      colorize('[q]', colors.brightYellow) +
      ' Quit | ' +
      colorize('[p]', colors.brightMagenta) +
      ' Positions Only | ' +
      colorize('[h]', colors.white) +
      ' Help'
  );
  console.log(colorize('═'.repeat(145), colors.cyan));
}

function printPositionsOnly() {
  console.clear();
  console.log(colorize('═'.repeat(145), colors.cyan));
  console.log(colorize('📊 ACTIVE POSITIONS ONLY', colors.brightMagenta));
  console.log(colorize('═'.repeat(145), colors.cyan));

  const botsWithPositions = Array.from(botInstances.values()).filter(
    (bot) => bot.position !== null
  );

  if (botsWithPositions.length === 0) {
    console.log(colorize('No active positions', colors.gray));
  } else {
    botsWithPositions.sort((a, b) => {
      const aPnl = a.position?.pnlUsd || 0;
      const bPnl = b.position?.pnlUsd || 0;
      return bPnl - aPnl;
    });

    console.log(
      colorize('Symbol'.padEnd(14), colors.bright) +
        colorize('Entry'.padEnd(11), colors.bright) +
        colorize('Current'.padEnd(11), colors.bright) +
        colorize('Amount'.padEnd(13), colors.bright) +
        colorize('PnL %'.padEnd(10), colors.bright) +
        colorize('PnL USD'.padEnd(11), colors.bright) +
        colorize('Hold Time', colors.bright)
    );
    console.log(colorize('─'.repeat(145), colors.gray));

    botsWithPositions.forEach((bot) => {
      const pos = bot.position as Position;
      const holdTime = Math.floor(
        (Date.now() - pos.entryTime.getTime()) / 60000
      );

      console.log(
        colorize(bot.symbol.padEnd(14), colors.brightCyan) +
          (pos?.entryPrice?.toFixed(4) || '0.0000').padEnd(11) +
          (pos?.currentPrice?.toFixed(4) || '0.0000').padEnd(11) +
          (pos?.remainingAmount?.toFixed(6) || '0.000000').padEnd(13) +
          padColored(colorPnL(pos.pnlPct, true), 10) +
          padColored(colorPnL(pos.pnlUsd, false), 11) +
          colorize(`${holdTime}m`, colors.gray)
      );
    });
  }

  console.log(colorize('═'.repeat(145), colors.cyan));
}

// ---------- COMMAND INTERFACE ----------
function setupCommandInterface() {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (input: string) => {
    const command = input.trim().toLowerCase();

    switch (command) {
      case 'r':
        log('Restarting all bots...', 'info');
        botInstances.forEach((_, symbol) => restartBot(symbol, 'User command'));
        break;

      case 's':
        log('Stopping all bots...', 'info');
        botInstances.forEach((_, symbol) => stopBot(symbol, 'User command'));
        break;

      case 'q':
        log('Shutting down launcher...', 'warning');
        shutdown();
        break;

      case 'd':
        printDashboard();
        break;

      case 'p':
        printPositionsOnly();
        break;

      // 🆕 NEW: Manual scan command
      case 'scan':
        log('🔍 Running manual scan...', 'info');
        scanAllSymbols(LAUNCHER_CONFIG.enabledSymbols)
          .then((results) => {
            log(`✅ Scan complete: ${results.length} signals`, 'success');
            tryEnterBestSignal();
          })
          .catch((err) => log(`❌ Scan failed: ${err.message}`, 'error'));
        break;

      // 🆕 NEW: Force entry to best signal
      case 'enter':
      case 'e':
        log('🎯 Attempting to enter best signal...', 'info');
        tryEnterBestSignal();
        break;

      default:
        if (command.startsWith('stop ')) {
          stopBot(command.replace('stop ', '').toUpperCase(), 'User command');
        } else if (command.startsWith('start ')) {
          startBot(command.replace('start ', '').toUpperCase());
        } else if (command.startsWith('restart ')) {
          restartBot(
            command.replace('restart ', '').toUpperCase(),
            'User command'
          );
        }
    }
  });
}

function killIfMemoryTooHigh() {
  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);

  // 🚨 HARD LIMIT: Kill process if over 2GB
  if (heapMB > 2000 || rssMB > 3000) {
    log(
      `☠️ FATAL: Memory exceeded (Heap: ${heapMB}MB, RSS: ${rssMB}MB)`,
      'error'
    );
    log('🚨 Forcing shutdown to prevent system crash', 'error');

    // Save state
    botInstances.forEach((instance) => {
      if (instance.process) {
        instance.process.kill('SIGKILL');
      }
    });

    // Destroy everything
    if (globalCandleManager) {
      globalCandleManager.destroy();
    }

    closeAllLogStreams();

    process.exit(1);
  }
}

// ---------- MAIN ----------
async function main() {
  ensureDirectories();
  initializeAggregateLogStream();

  // ✅ Initialize ONE candle manager for all symbols
  initializeCandleManager(LAUNCHER_CONFIG.enabledSymbols);

  log('═'.repeat(50), 'info');
  log('🚀 Multi-Bot Trading Launcher v2.0', 'success');
  log(`🚀 Mem:',${globalCandleManager?.getMemoryStats().memoryMB} MB`, 'info');
  log(`  Total Candles: ${globalCandleManager?.getMemoryStats().totalCandles}`);
  log(`  RSS: ${globalCandleManager?.getMemoryStats().rssMB}MB`);

  // Check scan results size
  log(`  Scan Results Cached: ${scanResults.size}`);
  log(`  Bot Instances: ${botInstances.size}`);
  log(`  Fib Map Size: ${launcherFibMap.size}`);
  log(`  HTF Cache Size: ${launcherHTFCache.size}`);
  // log(
  //   `   Enabled symbols: ${LAUNCHER_CONFIG.enabledSymbols.join(', ')}`,
  //   'info'
  // );
  log(`   Max concurrent: ${LAUNCHER_CONFIG.maxBotsRunning}`, 'info');
  log(`   Max positions: ${LAUNCHER_CONFIG.maxConcurrentPositions}`, 'info');
  log(`   Auto-restart: ${LAUNCHER_CONFIG.autoRestart}`, 'info');

  // ✅ Add capital info
  log('─'.repeat(50), 'info');
  log(`💰 CAPITAL ALLOCATION`, 'info');
  log(`   Total Capital: ${CAPITAL_CONFIG.TOTAL_CAPITAL} USDT`, 'info');
  log(
    `   Backup Reserve (${(CAPITAL_CONFIG.BACKUP_RESERVE_PCT * 100).toFixed(0)}%): ${CAPITAL_CONFIG.BACKUP_RESERVE} USDT`,
    'info'
  );
  log(`   Trading Capital: ${CAPITAL_CONFIG.TRADING_CAPITAL} USDT`, 'success');
  log(
    `   Per Bot Allocation: ${CAPITAL_CONFIG.PER_BOT_ALLOCATION.toFixed(2)} USDT`,
    'info'
  );

  if (process.env.ENABLED_SYMBOLS) {
    log(`   ✅ Using symbols from .env`, 'success');
  }
  if (process.env.PAPER_TRADING === 'true') {
    log(`   📝 PAPER TRADING MODE (from .env)`, 'warning');
  }

  log('═'.repeat(50), 'info');

  LAUNCHER_CONFIG.enabledSymbols.forEach((symbol) => {
    console.log('🥑 ~ main ~ symbol:=====>>', symbol);
    // const ctx = createSymbolContext(symbol);
    startBot(symbol);
  });

  // Setup intervals
  setInterval(periodicScanCheck, 5 * 60 * 1000); // Every 5 minutes
  setInterval(tryEnterBestSignal, 60 * 1000); // Every 1 minute
  setInterval(broadcastPositionCount, 30_000); // Every 30s is fine
  setInterval(runHealthChecks, 120_000); // Every 2 minutes
  setInterval(printDashboard, 10_000); // Every 10s is fine
  setInterval(checkForRestarts, 10_000); // Every 10s instead of 5s
  setInterval(killIfMemoryTooHigh, 10_000);
  setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);

    if (heapMB > 1024 || rssMB > 2048) {
      log(`🚨 CRITICAL MEMORY: Heap ${heapMB}MB, RSS ${rssMB}MB`, 'error');
      log(`   Scan results: ${scanResults.size}`, 'error');
      log(`   Bot instances: ${botInstances.size}`, 'error');
      log(`   Fib cache: ${launcherFibMap.size}`, 'error');
      log(`   HTF cache: ${launcherHTFCache.size}`, 'error');
      log(`   Log streams: ${logStreams.size}`, 'error');

      // Emergency cleanup
      runMemoryCleanup();

      // If still critical, clear all caches
      if (heapMB > 1500) {
        log('🚨 EMERGENCY: Clearing all caches', 'error');
        scanResults.clear();
        launcherFibMap.clear();
        launcherHTFCache.clear();

        if (global.gc) {
          global.gc();
          log('🚨 Forced garbage collection', 'warning');
        }
      }
    }
  }, 30 * 1000);
  // ✅ Memory monitoring
  // setInterval(() => {
  //   if (globalCandleManager) {
  //     const stats = globalCandleManager.getMemoryStats();
  //     log(`📊 Memory: ${stats.symbolCount} symbols, ${stats.totalCandles} candles, ${stats.memoryMB}MB heap`, 'info');
  //   }
  // }, 5 * 60 * 1000);

  setInterval(() => {
    runMemoryCleanup();
  }, MEMORY_LIMITS.CACHE_CLEANUP_INTERVAL);

  setupCommandInterface();

  setTimeout(async () => {
    log('🚀 Running initial scan...', 'info');
    try {
      const results = await scanAllSymbols(LAUNCHER_CONFIG.enabledSymbols);
      log(`✅ Initial scan: ${results.length} signals found`, 'success');
      await tryEnterBestSignal();
    } catch (err: any) {
      log(`❌ Initial scan failed: ${err.message}`, 'error');
    }
  }, 5000);

  setTimeout(printDashboard, 2000);
}

// ---------- SHUTDOWN ----------
function shutdown() {
  log('Graceful shutdown initiated...', 'warning');

  // Stop all bots
  botInstances.forEach((instance) => {
    if (instance.process) {
      instance.process.kill('SIGTERM');
    }
  });

  // ✅ Clear all caches
  scanResults.clear();
  launcherFibMap.clear();
  launcherHTFCache.clear();

  // Destroy candle manager
  if (globalCandleManager) {
    globalCandleManager.destroy();
    globalCandleManager = null;
  }

  closeAllLogStreams();

  setTimeout(() => {
    log('All resources released. Goodbye! 👋', 'success');
    process.exit(0);
  }, 5000);
}

// ---------- SIGNAL HANDLERS ----------
process.on('SIGINT', async () => {
  log('Received SIGINT, shutting down...', 'warning');
  shutdown();
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down...', 'warning');
  shutdown();
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`, 'error');
  if (globalCandleManager) {
    globalCandleManager.destroy();
  }
  process.exit(1);
});

main().catch((err) => {
  log(`Fatal error: ${err.message}`, 'error');
  if (globalCandleManager) {
    globalCandleManager.destroy();
  }
  process.exit(1);
});
