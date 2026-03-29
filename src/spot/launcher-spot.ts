import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as dotenv from 'dotenv';
import * as rfs from 'rotating-file-stream';
import { ATR, EMA, RSI } from 'technicalindicators';

import {
  colors,
  formatQuantity,
  getAmountDecimals,
  getPriceDecimals,
} from '../../lib/helpers.js';
import { LoggerFactory, type BotLogger } from '../../lib/logger.js';
import { calculateIndicators, detectRegime } from '../../lib/trading-utils.js';
import {
  LogLevel,
  type BotInstance,
  type CandleData,
  type CompletedTrade,
  type EntrySignal,
  type FibonacciLevels,
  type HTFConfirmation,
  type Indicators,
  type LauncherConfig,
  type Position,
  type Regime,
  type ScanResult,
  type SignalQueueItem,
  type SpotBotInstance,
  type SpotPosition,
  type StrategyCandidate,
  type StrategyId,
} from '../../lib/type.js';
import { BaseTradingBotPersistence } from '../core/bot-persistence.js';
import { CandleManager } from '../core/candles.js';
import { fetchCurrentPrice } from './bot-spot.js';
import { getConfigForSymbol, SYMBOL_CONFIGS } from './config-spot.js';

dotenv.config();

const CONFIG = getConfigForSymbol(process.env.TRADING_SYMBOL || 'SOL/USDT');
const logger = LoggerFactory.getSpotLogger(CONFIG.SYMBOL);

class LightweightSignalReader {
  private logger: BotLogger;
  private signalQueue: SignalQueueItem[] = [];
  private outputFile = './data/signals/spot-signals.json'; // Scanner writes here
  private lastReadTime = 0;
  private readonly SIGNAL_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

  constructor() {
    // Check if file exists on initialization
    this.logger = LoggerFactory.getSpotLogger(CONFIG.SYMBOL);
    this.checkFileExists();
  }
  private checkFileExists(): void {
    if (!fs.existsSync(this.outputFile)) {
      console.log(`⚠️  Scanner output not found: ${this.outputFile}`);
      console.log('   Waiting for scanner to create file...');

      // Create signals directory if it doesn't exist
      const dir = path.dirname(this.outputFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created signals directory: ${dir}`);
      }
    } else {
      console.log(`✅ Found scanner output: ${this.outputFile}`);
    }
  }

  async readLatestSignals(): Promise<EntrySignal[]> {
    try {
      if (!fs.existsSync(this.outputFile)) {
        // File doesn't exist yet - scanner hasn't run
        return this.signalQueue;
      }

      const stats = fs.statSync(this.outputFile);
      const fileTime = stats.mtimeMs;

      // Skip if file hasn't been updated
      if (fileTime <= this.lastReadTime) {
        return this.signalQueue;
      }

      // Read and parse file
      const fileContent = fs.readFileSync(this.outputFile, 'utf-8');

      // Handle empty file
      if (!fileContent.trim()) {
        this.signalQueue = [];
        return this.signalQueue;
      }

      const data = JSON.parse(fileContent);

      // Handle empty array
      if (!Array.isArray(data) || data.length === 0) {
        this.signalQueue = [];
        return this.signalQueue;
      }

      // Extract signals with high confidence
      const filteredResults = data.filter(
        (result: ScanResult) => result.signal && result.confidence >= 60
      );

      // Process signals with async operations
      const processedSignals: SignalQueueItem[] = [];

      for (const result of filteredResults) {
        const resSignal = result.signal as EntrySignal;
        const curPrice = await fetchCurrentPrice(result.symbol);

        // Handle undefined timestamp by providing a default
        const timestamp = result.timestamp
          ? new Date(result.timestamp)
          : new Date();

        // Provide defaults for optional fields
        const signalItem: SignalQueueItem = {
          symbol: result.symbol,
          confidence: result.confidence,
          side: resSignal.side,
          strategy: resSignal.strategy,
          reason: resSignal.reason,
          price: result.price,
          // Provide default values if undefined, or adjust SignalQueueItem type
          stopLoss: resSignal.stopLoss ?? 0, // Or another appropriate default
          takeProfit: resSignal.takeProfit ?? 0, // Or another appropriate default
          scannedAt: timestamp,
        };

        processedSignals.push(signalItem);
      }

      // Sort by confidence
      this.signalQueue = processedSignals.sort(
        (a: SignalQueueItem, b: SignalQueueItem) => b.confidence - a.confidence
      );

      this.lastReadTime = fileTime;
      this.cleanupExpiredSignals();

      if (this.signalQueue.length > 0) {
        this.logger.log(
          `📊 Read ${this.signalQueue.length} signals from scanner`,
          'success'
        );
      }

      return this.signalQueue;
    } catch (err: any) {
      this.logger.log(
        `⚠️  Error reading scanner output: ${err.message}`,
        'warning'
      );
      return [];
    }
  }

  /**
   * ✅ Remove stale signals
   */
  private cleanupExpiredSignals(): void {
    const now = Date.now();
    const beforeCount = this.signalQueue.length;

    this.signalQueue = this.signalQueue.filter(
      (signal) => now - signal.scannedAt.getTime() < this.SIGNAL_EXPIRY_MS
    );

    const removed = beforeCount - this.signalQueue.length;
    if (removed > 0) {
      this.logger.log(`🧹 Removed ${removed} expired signals`, 'info');
    }
  }

  /**
   * ✅ Get best signal (not in position)
   */
  getBestSignal(excludeSymbols: Set<string>): SignalQueueItem | null {
    const available = this.signalQueue.filter(
      (s) => !excludeSymbols.has(s.symbol)
    );

    return available[0] || null;
  }

  /**
   * ✅ Remove signal after entry
   */
  removeSignal(symbol: string): void {
    this.signalQueue = this.signalQueue.filter((s) => s.symbol !== symbol);
  }

  /**
   * ✅ Get stats
   */
  getStats() {
    return {
      totalSignals: this.signalQueue.length,
      longSignals: this.signalQueue.filter((s) => s.side === 'LONG').length,
      shortSignals: this.signalQueue.filter((s) => s.side === 'SHORT').length,
      avgConfidence:
        this.signalQueue.length > 0
          ? this.signalQueue.reduce((sum, s) => sum + s.confidence, 0) /
            this.signalQueue.length
          : 0,
    };
  }
}

const signalReader = new LightweightSignalReader();

const botInstances = new Map<string, BotInstance>();
const tradeHistory: CompletedTrade[] = [];
const MAX_HISTORY_SIZE = 50; // Keep last 50 trades
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
// 3. STRICT MEMORY LIMITS
// ============================================================================
const MEMORY_CONFIG = {
  MAX_CANDLES_PER_SYMBOL: 100, // ✅ REDUCED from 100
  MAX_HTF_CANDLES: 50, // ✅ REDUCED from 100
  MAX_CACHE_ENTRIES: 10, // Keep only 10 symbols cached
  CACHE_CLEANUP_INTERVAL: 1 * 60 * 1000,
  MEMORY_CHECK_INTERVAL: 10 * 1000,
  MAX_MEMORY_MB: 300, // ✅ Kill at 300MB
  STALE_THRESHOLD_MS: 3 * 60 * 1000,
  AGGRESSIVE_THRESHOLD_MS: 1 * 60 * 1000,
};

const MEMORY_LIMITS = {
  MAX_SCAN_RESULTS: 56, // ✅ REDUCED from 60
  MAX_FIB_CACHE: 10, // ✅ REDUCED from 30
  MAX_HTF_CACHE: 10, // ✅ REDUCED from 30
  MAX_LOG_STREAMS: 5, // ✅ REDUCED from 10
  SCAN_RESULT_TTL: 10 * 60 * 1000,
  CACHE_CLEANUP_INTERVAL: 2 * 60 * 1000,
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

  logger.log(
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
    logger.log(
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
    logger.log(
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
        logger.log(
          `Failed to close stream for ${symbol}: ${err.message}`,
          'error'
        );
      }
    }
  });

  if (closed > 0) {
    logger.log(`🧹 Closed ${closed} unused log streams`, 'info');
  }
}

// 6️⃣ MASTER CLEANUP FUNCTION
function runMemoryCleanup() {
  const before = process.memoryUsage();
  const beforeMB = Math.round(before.heapUsed / 1024 / 1024);

  logger.log(`🧹 Running memory cleanup (Heap: ${beforeMB}MB)...`, 'info');

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

  logger.log(
    `✅ Cleanup complete: ${afterMB}MB (freed ${freedMB}MB)`,
    'success'
  );
  logger.log(
    `   Scan results: ${scanResults.size}, Fib: ${launcherFibMap.size}, HTF: ${launcherHTFCache.size}`,
    'info'
  );
}

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
  logDir: './data/logs/test/multi-bot',
  stateDir: './data/states/test/multi-bot',
  aggregateLogFile: './data/logs/test/aggregate.log',
};

// Add this configuration near the top of your file (after LAUNCHER_CONFIG)
export const CAPITAL_CONFIG = {
  TOTAL_CAPITAL: parseFloat(process.env.TOTAL_CAPITAL || '200'),
  BACKUP_RESERVE_PCT: parseFloat(process.env.BACKUP_RESERVE_PCT || '0.10'),
  MAX_POSITION_COUNT: parseFloat(process.env.MAX_CONCURRENT_POSITIONS || '2'), // ✅ HARD LIMIT: Only 5 positions for 90K

  get BACKUP_RESERVE() {
    return this.TOTAL_CAPITAL * this.BACKUP_RESERVE_PCT;
  },

  get TRADING_CAPITAL() {
    return this.TOTAL_CAPITAL - this.BACKUP_RESERVE;
  },

  get PER_BOT_ALLOCATION() {
    // ✅ CRITICAL: Divide by MAX_POSITION_COUNT, not maxConcurrentPositions
    return this.TRADING_CAPITAL / this.MAX_POSITION_COUNT;
  },

  get MAX_POSITION_VALUE() {
    // ✅ Max value per position (95% of allocation for safety)
    return this.PER_BOT_ALLOCATION * 0.95;
  },

  // ✅ ADD: Track allocated capital in real-time
  _allocatedCapital: 0,

  get ALLOCATED_CAPITAL() {
    return this._allocatedCapital;
  },

  get AVAILABLE_CAPITAL() {
    return this.TRADING_CAPITAL - this._allocatedCapital;
  },

  allocate(amount: number): boolean {
    if (this._allocatedCapital + amount > this.TRADING_CAPITAL) {
      console.log(
        `❌ Cannot allocate $${amount.toFixed(2)} - would exceed trading capital`
      );
      return false;
    }
    this._allocatedCapital += amount;
    console.log(
      `✅ Allocated $${amount.toFixed(2)} | Total allocated: $${this._allocatedCapital.toFixed(2)}/${this.TRADING_CAPITAL.toFixed(2)}`
    );
    return true;
  },

  release(amount: number): void {
    this._allocatedCapital = Math.max(0, this._allocatedCapital - amount);
    console.log(
      `🔓 Released $${amount.toFixed(2)} | Total allocated: $${this._allocatedCapital.toFixed(2)}/${this.TRADING_CAPITAL.toFixed(2)}`
    );
  },

  reset(): void {
    this._allocatedCapital = 0;
    console.log('🔄 Capital allocation reset');
  },
};

// ✅ FIXED: Filter invalid symbols and validate
// const VALID_SYMBOLS = [
//   'AAVE/USDT',
//   'ADA/USDT',
//   'ARB/USDT',
//   'ASTER/USDT',
//   'AVAX/USDT',
//   'BCH/USDT',
//   'BNB/USDT',
//   'BONK/USDT',
//   'BTC/USDT',
//   'CAKE/USDT',
//   'CRV/USDT',
//   'DOGE/USDT',
//   'ENA/USDT',
//   'ETHFI/USDT',
//   'ETH/USDT',
//   'FET/USDT',
//   'FLOKI/USDT',
//   'GRT/USDT',
//   'HBAR/USDT',
//   'IMX/USDT',
//   'INJ/USDT',
//   'JUP/USDT',
//   'KAIA/USDT',
//   'LDO/USDT',
//   'LINK/USDT',
//   'LTC/USDT',
//   'NEXO/USDT',
//   'ONDO/USDT',
//   'OP/USDT',
//   'PAXG/USDT',
//   'PENGU/USDT',
//   'PEPE/USDT',
//   'PHB/USDT',
//   'PUMP/USDT',
//   'QNT/USDT',
//   'RENDER/USDT',
//   'SEI/USDT',
//   'SHIB/USDT',
//   'SKY/USDT',
//   'SOL/USDT',
//   'SOMI/USDT',
//   'STX/USDT',
//   'SUI/USDT',
//   'TIA/USDT',
//   'TON/USDT',
//   'TRX/USDT',
//   'VET/USDT',
//   'VIRTUAL/USDT',
//   'WLD/USDT',
//   'WLFI/USDT',
//   'XLM/USDT',
//   'XPL/USDT',
//   'XRP/USDT',
//   'ZEC/USDT',
//   'ZEN/USDT',
// ];

// ============================================================================
// 2. FIXED LAUNCHER CONFIG
// ============================================================================

if (!process.env.TRADING_SYMBOL || !process.env.ENABLED_SYMBOLS) {
  throw new Error('TRADING_SYMBOL not set in environment variables');
}

export const LAUNCHER_CONFIG: LauncherConfig = {
  enabledSymbols: process.env.ENABLED_SYMBOLS.split(',').filter((s) => {
    const isValid = s.trim();
    if (!isValid) {
      console.log(`⚠️ Skipping invalid symbol: ${s}`);
    }
    return isValid;
  }),
  maxBotsRunning: 56,
  maxConcurrentPositions: CAPITAL_CONFIG.MAX_POSITION_COUNT, // ✅ Use hard limit
  autoRestart: true,
  maxRestarts: 3,
  restartDelayMs: 30_000,
  healthCheckIntervalMs: 60_000,
  aggregateLogging: true,
};

function initializeCandleManager(symbols: string[]) {
  if (globalCandleManager) {
    logger.log(
      '⚠️ CandleManager already exists, destroying old one',
      'warning'
    );
    globalCandleManager.destroy();
  }

  globalCandleManager = new CandleManager('15m');
  logger.log(
    `✅ CandleManager initialized with ${symbols.length} symbols`,
    'success'
  );

  return globalCandleManager;
}

// const CONFIG = getConfigForSymbol(process.env.TRADING_SYMBOL || 'SOL/USDT');

// ============================================================================
// 4. FIXED getActivePositionCount() with validation
// ============================================================================
function getActivePositionCount(): number {
  const count = Array.from(botInstances.values()).filter(
    (bot) => bot.position !== null && bot.position.remainingAmount > 0
  ).length;

  // ✅ Safety check
  if (count > CAPITAL_CONFIG.MAX_POSITION_COUNT) {
    logger.log(
      `🚨 CRITICAL: ${count} positions exceeds limit ${CAPITAL_CONFIG.MAX_POSITION_COUNT}`,
      'error'
    );
  }

  return count;
}

// ============================================================================
// 5. STRICT POSITION ENTRY VALIDATION
// ============================================================================
function canEnterNewPosition(symbol: string, requiredCapital: number): boolean {
  const currentPositions = getActivePositionCount();
  const stats = getStats();

  // Check 1: Position limit
  if (currentPositions >= CAPITAL_CONFIG.MAX_POSITION_COUNT) {
    logger.log(
      `❌ ${symbol} BLOCKED: Position limit reached (${currentPositions}/${CAPITAL_CONFIG.MAX_POSITION_COUNT})`,
      'error'
    );
    return false;
  }

  // Check 2: Available balance
  if (stats.availableBalance < requiredCapital) {
    logger.log(
      `❌ ${symbol} BLOCKED: Insufficient balance (${stats.availableBalance.toFixed(2)} < ${requiredCapital.toFixed(2)})`,
      'error'
    );
    return false;
  }

  // Check 3: Position size validation
  if (requiredCapital > CAPITAL_CONFIG.MAX_POSITION_VALUE) {
    logger.log(
      `❌ ${symbol} BLOCKED: Position too large (${requiredCapital.toFixed(2)} > ${CAPITAL_CONFIG.MAX_POSITION_VALUE.toFixed(2)})`,
      'error'
    );
    return false;
  }

  return true;
}

// Validate enabled symbols
LAUNCHER_CONFIG.enabledSymbols = LAUNCHER_CONFIG.enabledSymbols.filter(
  (symbol) => {
    // const binanceSymbol = symbol.replace('/', '');
    if (!Object.keys(SYMBOL_CONFIGS).includes(symbol)) {
      logger.log(
        `⚠️ Symbol ${symbol} has no config, will use BASE_CONFIG`,
        'warning'
      );
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
      alignedLong: boolean;
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
  alignedLong: boolean;
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
        'SPOT'
      );
    }

    const data = globalCandleManager.getCandles(symbol);

    if (!data || !data.closes || data.closes.length < 210) {
      logger.log(
        `Not enough HTF data (${data?.closes.length || 0} candles)`,
        'warning'
      );
      return {
        trend: 'NEUTRAL',
        ema50: 0,
        ema200: 0,
        rsi: 50,
        alignedLong: false,
      };
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

    const alignedLong = trend === 'UP' && rsi > 40 && rsi < 70;

    const result = { trend, ema50, ema200, rsi, alignedLong };
    launcherHTFCache.set(key, { data: result, fetchedAt: new Date() });

    return result;
  } catch (err: any) {
    logger.log(`HTF fetch failed: ${err.message}`, 'warning');
    return {
      trend: 'NEUTRAL',
      ema50: 0,
      ema200: 0,
      rsi: 50,
      alignedLong: false,
    };
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

/**
 * ✅ NEW APPROACH: Score ALL strategies, pick the BEST one
 * Instead of: if (condition) return strategy1; else if...
 * We do: Score all strategies → Pick highest confidence
 */
export function pickEntryStrategy(
  symbol: string,
  ind: Indicators,
  fib: FibonacciLevels | null,
  regime: Regime,
  closes: number[],
  volumes: number[],
  htf: HTFConfirmation
): EntrySignal | null {
  const candidates: StrategyCandidate[] = [];

  // ========================================
  // 1. SCORE: EMA PULLBACK
  // ========================================
  const emaPullbackScore = scoreEMAPullback(ind, regime, htf);
  if (emaPullbackScore) {
    candidates.push(emaPullbackScore);
  }

  // ========================================
  // 2. SCORE: BREAKOUT
  // ========================================
  const breakoutScore = scoreBreakout(ind, regime, closes, volumes, htf);
  if (breakoutScore) {
    candidates.push(breakoutScore);
  }

  // ========================================
  // 3. SCORE: MEAN REVERSION
  // ========================================
  const meanReversionScore = scoreMeanReversion(ind, regime, htf);
  if (meanReversionScore) {
    candidates.push(meanReversionScore);
  }

  // ========================================
  // 4. SCORE: FIBONACCI BOUNCE
  // ========================================
  if (fib) {
    const fibScore = scoreFibonacciBounce(ind, fib, regime, htf);
    if (fibScore) {
      candidates.push(fibScore);
    }
  }

  // ========================================
  // 5. SCORE: MOMENTUM
  // ========================================
  const momentumScore = scoreMomentum(ind, regime, volumes, htf);
  if (momentumScore) {
    candidates.push(momentumScore);
  }

  // ========================================
  // PICK BEST STRATEGY
  // ========================================
  if (candidates.length === 0) {
    return null;
  }

  // Sort by confidence (highest first)
  candidates.sort((a, b) => b.confidence - a.confidence);

  const best = candidates[0] as StrategyCandidate;

  // Log all candidates for debugging
  if (candidates.length > 1) {
    console.log(`📊 ${symbol} - Strategy Competition:`);
    candidates.forEach((c, i) => {
      const icon = i === 0 ? '🏆' : '  ';
      console.log(
        `${icon} ${c.strategy.padEnd(20)} Confidence: ${(c.confidence * 100).toFixed(1)}%`
      );
    });
  }

  return {
    symbol,
    strategy: best.strategy,
    side: determineSide(ind, regime),
    reason: best.reason,
    confidence: best.confidence,
    stopLoss: best.stopLoss,
    takeProfit: best.takeProfit,
  };
}

// ============================================
// STRATEGY SCORING FUNCTIONS
// ============================================

/**
 * Score EMA Pullback Strategy
 * ✅ STRICTER CONDITIONS than before
 */
function scoreEMAPullback(
  ind: Indicators,
  regime: Regime,
  htf: HTFConfirmation
): StrategyCandidate | null {
  const { rsi, ema8, ema21, ema50, ema200, currentPrice, atr } = ind;

  // ✅ REQUIREMENT 1: Price must be VERY close to EMA50
  const distanceToEMA50 = Math.abs(currentPrice - ema50) / currentPrice;
  const isNearEMA50 = distanceToEMA50 < 0.005; // Within 0.5%

  if (!isNearEMA50) return null;

  // ✅ REQUIREMENT 2: RSI must be in PULLBACK zone (not neutral)
  const isPullbackRSI = rsi >= 40 && rsi <= 55;
  if (!isPullbackRSI) return null;

  // ✅ REQUIREMENT 3: Trend must be clear
  const isTrendingUp =
    ema8 && ema21 && ema8 > ema21 && ema21 > ema50 && ema50 > ema200;
  const isTrendingDown =
    ema8 && ema21 && ema8 < ema21 && ema21 < ema50 && ema50 < ema200;

  if (!isTrendingUp && !isTrendingDown) return null;

  // ✅ REQUIREMENT 4: HTF confirmation
  if (htf.trend === 'NEUTRAL') return null;

  // Calculate confidence
  let confidence = 0.6; // Base confidence

  // Bonus: Perfect RSI range
  if (rsi >= 45 && rsi <= 50) confidence += 0.05;

  // Bonus: Very close to EMA50
  if (distanceToEMA50 < 0.003) confidence += 0.05;

  // Bonus: Strong trend alignment
  if (isTrendingUp && htf.trend === 'UP') confidence += 0.1;
  if (isTrendingDown && htf.trend === 'DOWN') confidence += 0.1;

  const side = isTrendingUp ? 'LONG' : 'SHORT';
  const stopLoss =
    side === 'LONG' ? currentPrice - atr * 2 : currentPrice + atr * 2;
  const takeProfit =
    side === 'LONG' ? currentPrice + atr * 6 : currentPrice - atr * 6;

  return {
    strategy: 'EMA_PULLBACK',
    confidence: Math.min(confidence, 0.9),
    reason: `EMA50 bounce @ ${ema50.toFixed(2)}, RSI=${rsi.toFixed(1)}`,
    stopLoss,
    takeProfit,
  };
}

/**
 * Score Breakout Strategy
 * ✅ Looks for price breaking resistance/support with volume
 */
function scoreBreakout(
  ind: Indicators,
  regime: Regime,
  closes: number[],
  volumes: number[],
  htf: HTFConfirmation
): StrategyCandidate | null {
  const { rsi, currentPrice, atr, ema200 } = ind;

  // Calculate recent high/low (last 20 candles)
  const recent = closes.slice(-20);
  const recentHigh = Math.max(...recent);
  const recentLow = Math.min(...recent);

  // ✅ REQUIREMENT 1: Price must be breaking out
  const isBreakingHigh = currentPrice > recentHigh * 1.002; // 0.2% above
  const isBreakingLow = currentPrice < recentLow * 0.998; // 0.2% below

  if (!isBreakingHigh && !isBreakingLow) return null;

  // ✅ REQUIREMENT 2: Volume confirmation
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1] as number;
  const volumeIncrease = currentVolume / avgVolume;

  if (volumeIncrease < 1.5) return null; // Need 50%+ volume increase

  // ✅ REQUIREMENT 3: RSI not overbought/oversold
  if (isBreakingHigh && rsi > 70) return null;
  if (isBreakingLow && rsi < 30) return null;

  // Calculate confidence
  let confidence = 0.65;

  // Bonus: Strong volume
  if (volumeIncrease > 2.0) confidence += 0.1;

  // Bonus: HTF alignment
  if (isBreakingHigh && htf.trend === 'UP') confidence += 0.1;
  if (isBreakingLow && htf.trend === 'DOWN') confidence += 0.1;

  // Bonus: Good RSI position
  if (isBreakingHigh && rsi >= 50 && rsi <= 65) confidence += 0.05;
  if (isBreakingLow && rsi >= 35 && rsi <= 50) confidence += 0.05;

  const side = isBreakingHigh ? 'LONG' : 'SHORT';
  const stopLoss = side === 'LONG' ? recentHigh * 0.99 : recentLow * 1.01;
  const takeProfit =
    side === 'LONG' ? currentPrice + atr * 8 : currentPrice - atr * 8;

  return {
    strategy: 'BREAKOUT',
    confidence: Math.min(confidence, 0.9),
    reason: `${side} breakout w/ ${volumeIncrease.toFixed(1)}x volume, RSI=${rsi.toFixed(1)}`,
    stopLoss,
    takeProfit,
  };
}

/**
 * Score Mean Reversion Strategy
 * ✅ Looks for oversold/overbought conditions
 */
function scoreMeanReversion(
  ind: Indicators,
  regime: Regime,
  htf: HTFConfirmation
): StrategyCandidate | null {
  const { rsi, ema50, ema200, currentPrice, atr } = ind;

  // ✅ REQUIREMENT 1: RSI must be extreme
  const isOversold = rsi < 35;
  const isOverbought = rsi > 65;

  if (!isOversold && !isOverbought) return null;

  // ✅ REQUIREMENT 2: Price far from mean (EMA50)
  const distanceFromMean = Math.abs(currentPrice - ema50) / ema50;
  if (distanceFromMean < 0.02) return null; // Must be >2% away

  // ✅ REQUIREMENT 3: Not in strong trend (mean reversion fails in trends)
  if (htf.strength && htf.trend !== 'NEUTRAL' && htf.strength > 0.7)
    return null;

  // Calculate confidence
  let confidence = 0.55;

  // Bonus: Very extreme RSI
  if (rsi < 30 || rsi > 70) confidence += 0.1;
  if (rsi < 25 || rsi > 75) confidence += 0.1;

  // Bonus: Far from mean
  if (distanceFromMean > 0.03) confidence += 0.05;

  // Bonus: Low volatility regime (better for mean reversion)
  if (regime.volatility === 'LOW') confidence += 0.1;

  const side = isOversold ? 'LONG' : 'SHORT';
  const stopLoss =
    side === 'LONG' ? currentPrice - atr * 2 : currentPrice + atr * 2;
  const takeProfit = side === 'LONG' ? ema50 : ema50; // Target: return to mean

  return {
    strategy: 'MEAN_REVERSION',
    confidence: Math.min(confidence, 0.85),
    reason: `${isOversold ? 'Oversold' : 'Overbought'} RSI=${rsi.toFixed(1)}, ${distanceFromMean.toFixed(1)}% from mean`,
    stopLoss,
    takeProfit,
  };
}

/**
 * Score Fibonacci Bounce Strategy
 */
function scoreFibonacciBounce(
  ind: Indicators,
  fib: FibonacciLevels,
  regime: Regime,
  htf: HTFConfirmation
): StrategyCandidate | null {
  const { currentPrice, rsi, atr } = ind;

  // Check if price is near a key Fib level
  const fibLevels = [fib.level382, fib.level500, fib.level618];
  let nearestLevel = null;
  let minDistance = Infinity;

  for (const level of fibLevels) {
    const distance = Math.abs(currentPrice - level) / currentPrice;
    if (distance < minDistance) {
      minDistance = distance;
      nearestLevel = level;
    }
  }

  // ✅ REQUIREMENT: Must be very close to Fib level
  if (minDistance > 0.005) return null; // Within 0.5%

  // ✅ REQUIREMENT: RSI in bounce zone
  if (rsi < 40 || rsi > 60) return null;

  // ✅ REQUIREMENT: HTF trend exists
  if (htf.trend === 'NEUTRAL') return null;

  let confidence = 0.65;

  // Bonus: Very close to Fib
  if (minDistance < 0.003) confidence += 0.1;

  // Bonus: HTF alignment
  if (htf.trend === 'UP') confidence += 0.1;

  const side = htf.trend === 'UP' ? 'LONG' : 'SHORT';
  const stopLoss =
    side === 'LONG' ? nearestLevel! - atr * 2 : nearestLevel! + atr * 2;
  const takeProfit =
    side === 'LONG' ? nearestLevel! + atr * 6 : nearestLevel! - atr * 6;

  return {
    strategy: 'FIB_BOUNCE',
    confidence: Math.min(confidence, 0.85),
    reason: `Fib ${nearestLevel!.toFixed(2)} bounce, RSI=${rsi.toFixed(1)}`,
    stopLoss,
    takeProfit,
  };
}

/**
 * Score Momentum Strategy
 */
function scoreMomentum(
  ind: Indicators,
  regime: Regime,
  volumes: number[],
  htf: HTFConfirmation
): StrategyCandidate | null {
  const { rsi, ema8, ema21, currentPrice, atr } = ind;

  // ✅ REQUIREMENT 1: Strong RSI momentum
  const hasStrongMomentum = (rsi > 60 && rsi < 75) || (rsi > 25 && rsi < 40);
  if (!hasStrongMomentum) return null;

  // ✅ REQUIREMENT 2: EMAs aligned
  const bullishAlignment = ema8 && ema21 && ema8 > ema21 && rsi > 60;
  const bearishAlignment = ema8 && ema21 && ema8 < ema21 && rsi < 40;

  if (!bullishAlignment && !bearishAlignment) return null;

  // ✅ REQUIREMENT 3: High volatility (momentum works best)
  if (regime.volatility === 'LOW') return null;

  // ✅ REQUIREMENT 4: Volume confirmation
  const avgVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const recentVolume = volumes[volumes.length - 1] as number;
  if (recentVolume < avgVolume * 1.2) return null;

  let confidence = 0.7;

  // Bonus: HTF alignment
  if (bullishAlignment && htf.trend === 'UP') confidence += 0.1;
  if (bearishAlignment && htf.trend === 'DOWN') confidence += 0.1;

  // Bonus: High volatility
  if (regime.volatility === 'HIGH') confidence += 0.05;

  const side = bullishAlignment ? 'LONG' : 'SHORT';
  const stopLoss =
    side === 'LONG' ? currentPrice - atr * 2.5 : currentPrice + atr * 2.5;
  const takeProfit =
    side === 'LONG' ? currentPrice + atr * 7.5 : currentPrice - atr * 7.5;

  return {
    strategy: 'MOMENTUM',
    confidence: Math.min(confidence, 0.9),
    reason: `${side} momentum, RSI=${rsi.toFixed(1)}, ${regime.volatility} vol`,
    stopLoss,
    takeProfit,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function determineSide(ind: Indicators, regime: Regime): 'LONG' | 'SHORT' {
  // Simple logic: if price above EMA50 and uptrend → LONG
  const { currentPrice, ema50, rsi } = ind;

  if (currentPrice > ema50 && rsi > 45) return 'LONG';
  if (currentPrice < ema50 && rsi < 55) return 'SHORT';

  return regime.trend === 'UP' ? 'LONG' : 'SHORT';
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
      logger.log(`Error closing stream for ${symbol}:  ${err}`, 'error');
    }
  });
  logStreams.clear();
}
// ---------- ROTATING LOG STREAM MANAGEMENT ----------

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
      logger.log(`Created directory: ${dir}`, 'success');
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
    logger.log(
      `Cannot send command to ${symbol}: process not ready`,
      'warning'
    );
    return false;
  }

  // ✅ Check if stdin is writable before attempting write
  if (!instance.process.stdin.writable) {
    logger.log(
      `Cannot send command to ${symbol}: stdin not writable`,
      'warning'
    );
    return false;
  }

  try {
    const success = instance.process.stdin.write(
      JSON.stringify(command) + '\n',
      'utf8',
      (err) => {
        if (err) {
          logger.log(`${symbol} stdin write error: ${err.message}`, 'error');
          // ✅ Handle EPIPE gracefully - process likely crashed
          if (err.message.includes('EPIPE')) {
            logger.log(
              `${symbol} process pipe broken, marking for restart`,
              'warning'
            );
            instance.needsRestart = true;
          }
        }
      }
    );

    if (!success) {
      logger.log(`${symbol} stdin buffer full, command queued`, 'warning');
    }

    return success;
  } catch (err: any) {
    logger.log(`${symbol} process error: ${err.message}`, 'error');
    // ✅ Mark for restart on any write error
    instance.needsRestart = true;
    return false;
  }
}

// ✅ Add periodic check for bots that need restart
function checkForRestarts() {
  botInstances.forEach((instance, symbol) => {
    if (instance.needsRestart && !instance.restarting) {
      logger.log(`Restarting ${symbol} due to pipe error`, 'warning');
      restartBot(symbol, 'Pipe error detected');
    }
  });
}

// ---------- BOT MANAGEMENT ----------
function startBot(symbol: string) {
  // ✅ Validate symbol before starting
  if (!LAUNCHER_CONFIG.enabledSymbols.includes(symbol)) {
    logger.log(`❌ Cannot start invalid symbol: ${symbol}`, 'error');
    return;
  }

  if (botInstances.has(symbol)) {
    logger.log(`Bot ${symbol} already running`, 'warning');
    return;
  }

  const config = getConfigForSymbol(symbol);
  const logStream = createRotatingLogStream(symbol);
  const stateFile = path.join(
    SESSION_CONFIG.stateDir,
    `${symbol.replace('/', '_')}.json`
  );

  try {
    // log(`🚀 Starting bot for ${symbol}`, 'info');

    const childProcess = fork('./dist/src/spot/bot-spot.js', [], {
      env: {
        ...process.env,
        TRADING_SYMBOL: symbol,
        STATE_FILE: stateFile,
        PAPER_TRADING: process.env.PAPER_TRADING || 'true',
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
        logger.log(`${symbol} stdin EPIPE - process likely crashed`, 'error');
        instance.needsRestart = true;
      } else {
        logger.log(`${symbol} stdin error: ${err.message}`, 'error');
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
      logger.log(`${symbol} error: ${error}`, 'error');
      instance.lastError = error;
    });

    childProcess.on('message', (message: any) => {
      handleBotMessage(symbol, message);
    });

    childProcess.on('exit', (code, signal) => {
      instance.status = 'stopped';
      logger.log(
        `${symbol} exited with code ${code} (signal: ${signal})`,
        'error'
      );

      if (
        LAUNCHER_CONFIG.autoRestart &&
        instance.restartCount &&
        instance.restartCount < LAUNCHER_CONFIG.maxRestarts
      ) {
        logger.log(
          `${symbol} crashed (${instance.restartCount + 1}/${LAUNCHER_CONFIG.maxRestarts}), restarting...`,
          'warning'
        );
        setTimeout(() => {
          restartBot(symbol, `Crash recovery (code ${code})`);
        }, LAUNCHER_CONFIG.restartDelayMs);
      } else {
        logger.log(
          `${symbol} max restarts reached or auto-restart disabled`,
          'error'
        );
      }
    });

    childProcess.on('error', (err) => {
      logger.log(`${symbol} process error: ${err.message}`, 'error');
      instance.lastError = err.message;
    });

    setTimeout(() => {
      if (instance.status === 'starting') {
        instance.status = 'running';
        logger.log(`✅ ${symbol} bot started successfully`, 'success');
      }
    }, 5000);
  } catch (err: any) {
    logger.log(`Failed to start ${symbol}: ${err.message}`, 'error');
  }
}

function stopBot(symbol: string, reason: string = 'Manual stop') {
  const instance = botInstances.get(symbol);
  if (!instance?.process) {
    logger.log(`${symbol} not running`, 'warning');
    return;
  }

  logger.log(`Stopping ${symbol}: ${reason}`, 'info');
  instance.process.kill('SIGTERM');

  setTimeout(() => {
    if (instance.process && !instance.process.killed) {
      logger.log(`${symbol} didn't stop gracefully, forcing...`, 'warning');
      instance.process.kill('SIGKILL');
    }
  }, 5000);

  closeLogStream(symbol);
  instance.status = 'stopped';
  instance.process = null;
}

function restartBot(symbol: string, reason: string = 'Manual restart') {
  logger.log(`Restarting ${symbol}: ${reason}`, 'info');
  stopBot(symbol, reason);
  setTimeout(() => startBot(symbol), LAUNCHER_CONFIG.restartDelayMs);
}

function handleBotExit(symbol: string, exitCode: number) {
  const instance = botInstances.get(symbol);
  if (!instance) return;

  instance.process = null;
  instance.status = exitCode === 0 ? 'stopped' : 'error';

  if (exitCode !== 0 && LAUNCHER_CONFIG.autoRestart) {
    if (
      instance.restartCount &&
      instance.restartCount < LAUNCHER_CONFIG.maxRestarts
    ) {
      instance.restartCount++;
      logger.log(
        `${symbol} crashed (${instance.restartCount}/${LAUNCHER_CONFIG.maxRestarts}), restarting...`,
        'warning'
      );
      setTimeout(() => startBot(symbol), LAUNCHER_CONFIG.restartDelayMs);
    } else {
      logger.log(
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
  //     Array.from(msg.length)
  //   );
  // }

  switch (msg.type) {
    case 'trade':
      instance.trades++;
      instance.pnl += msg.pnl || 0;
      logger.log(
        `${symbol} ${msg.action}: ${msg.amount?.toFixed(6) || '?'} @ ${msg.price} | PnL: ${msg.pnl?.toFixed(2) || '0'}`,
        'info'
      );

      // ✅ ADD: Capture completed trades (SELL actions only)
      if (msg.action === 'SELL' || msg.action === 'PARTIAL_SELL') {
        const trade: CompletedTrade = {
          symbol: symbol,
          strategy: msg.strategy || 'UNKNOWN', // ✅ From bot
          side: 'LONG',
          entryPrice: msg.entryPrice, // ✅ From bot
          exitPrice: msg.exitPrice || msg.price, // ✅ From bot
          amount: msg.amount,
          stopLoss: msg.stopLoss || 0, // ✅ From bot
          takeProfit: msg.takeProfit || 0, // ✅ From bot
          pnlUsd: msg.pnl,
          pnlPct: ((msg.price - msg.entryPrice) / msg.entryPrice) * 100,
          duration: msg.holdTime || 0,
          exitReason: msg.reason || 'MANUAL', // ✅ From bot
          marginUsed: msg.marginUsed,
          entryTime: msg.entryTime ? new Date(msg.entryTime) : new Date(),
          exitTime: msg.exitTime ? new Date(msg.exitTime) : new Date(),
          isWin: msg.pnl > 0,
        };

        // Add to history (newest first)
        tradeHistory.unshift(trade);

        // Keep only last N trades
        if (tradeHistory.length > MAX_HISTORY_SIZE) {
          tradeHistory.pop();
        }

        console.log('🟢 LAUNCHER GOT:', {
          entryPrice: msg.entryPrice,
          strategy: msg.strategy,
          reason: msg.reason,
        });

        // Update bot win/loss stats
        if (trade.isWin) {
          instance.wins = (instance.wins || 0) + 1;
        } else {
          instance.losses = (instance.losses || 0) + 1;
        }

        // Calculate win rate
        const totalTrades = (instance.wins || 0) + (instance.losses || 0);
        instance.winRate =
          totalTrades > 0 ? ((instance.wins || 0) / totalTrades) * 100 : 0;
      }

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
        side: 'SPOT',
      };
      logger.log(
        `${symbol} restored position from state: ${msg.amount?.toFixed(6)} @ ${msg.entryPrice}`,
        'info'
      );

      // ✅ CRITICAL: Broadcast updated count immediately
      broadcastPositionCount();
      break;

    case 'position_update':
      const bot = botInstances.get(symbol);
      if (!bot) return;

      // Check if this is a NEW position
      const wasNoPosition = bot.position === null;

      if (msg.hasPosition && msg.position) {
        const pos = msg.position;
        const currentPrice =
          pos.currentPrice || pos.price || pos.entryPrice || 0;
        const actualCost = (pos.amount || 0) * (pos.entryPrice || 0);

        // ✅ NEW POSITION: Adjust allocation to actual cost
        if (wasNoPosition && actualCost > 0) {
          const maxAllowed = CAPITAL_CONFIG.PER_BOT_ALLOCATION;

          if (actualCost > maxAllowed * 1.1) {
            logger.log(
              `⚠️ ${symbol} position too large: $${actualCost.toFixed(2)} > $${maxAllowed.toFixed(2)}`,
              'warning'
            );
          }

          logger.log(
            `💰 ${symbol} position opened: $${actualCost.toFixed(2)} invested`,
            'success'
          );
        }

        bot.position = {
          symbol: symbol,
          entryPrice: pos.entryPrice || 0,
          currentPrice: currentPrice,
          amount: pos.amount || 0,
          remainingAmount: pos.remainingAmount || pos.amount || 0,
          stopLoss: pos.stopLoss || 0,
          takeProfit: pos.takeProfit || 0,
          pnlUsd: pos.pnlUsd || 0,
          pnlPct: pos.pnlPct || 0,
          strategy: pos.strategy as StrategyId,
          partialsSold: pos.partialsSold || 0,
          entryTime: pos.entryTime ? new Date(pos.entryTime) : new Date(),
          positionId: pos.positionId,
          side: 'SPOT',
        };

        bot.status = 'running';
      } else {
        // ✅ POSITION CLOSED: Release capital
        if (bot.position !== null) {
          const releasedAmount =
            (bot.position.remainingAmount || 0) *
            (bot.position.entryPrice || 0);
          CAPITAL_CONFIG.release(releasedAmount);
          logger.log(
            `${symbol} position closed - released $${releasedAmount.toFixed(2)}`,
            'info'
          );
        }
        bot.position = null;
        bot.status = 'idle';
      }

      // Update stats
      bot.sessionPnl = msg.sessionPnl || bot.sessionPnl || 0;
      bot.wins = msg.wins || bot.wins || 0;
      bot.losses = msg.losses || bot.losses || 0;
      bot.trades = msg.tradesCount || bot.trades || 0;

      broadcastPositionCount();
      break;

    case 'position_closed':
      instance.position = null;
      instance.pnl += msg.pnl || 0;
      logger.log(
        `${symbol} EXIT: PnL ${msg.pnl?.toFixed(2) || '0'} USDT`,
        'info'
      );

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
      logger.log(`${symbol} entered cooldown: ${msg.reason}`, 'warning');
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
      logger.log(`${symbol} reported error: ${msg.error}`, 'error');
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

  logger.log(
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
        logger.log(
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
    logger.log(
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
    logger.log(`${symbol} health check failed: ${err.message}`, 'error');
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
        logger.log(
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
//     .reduce((sum, b) => sum + b.position?.pnlUsd, 0);
//   const realizedPnL = bots.reduce((sum, b) => sum + b.pnl, 0);
//   const allocatedCapital = bots
//     .filter(b => b.position !== null)
//     .reduce((sum, b) => sum + (b.position?.remainingAmount * b.position?.currentPrice), 0);

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

// function calculateIndicators(
//   closes: number[],
//   highs: number[],
//   lows: number[]
// ): Indicators | null {
//   const minRequired = Math.max(CONFIG.RSI_PERIOD, CONFIG.EMA_LONG) + 1;
//   if (closes.length < minRequired) {
//     logger.log(`Need ${minRequired} candles, have ${closes.length}`, 'warning');
//     return null;
//   }

//   const atrVals = ATR.calculate({
//     high: highs,
//     low: lows,
//     close: closes,
//     period: CONFIG.ATR_PERIOD,
//   });
//   const rsiVals = RSI.calculate({ period: CONFIG.RSI_PERIOD, values: closes });
//   const ema8Vals = EMA.calculate({ period: CONFIG.EMA_SHORT, values: closes });
//   const ema21Vals = EMA.calculate({ period: CONFIG.EMA_SHORT, values: closes });
//   const ema50Vals = EMA.calculate({ period: CONFIG.EMA_SHORT, values: closes });
//   const ema200Vals = EMA.calculate({ period: CONFIG.EMA_LONG, values: closes });

//   if (
//     !atrVals.length ||
//     !rsiVals.length ||
//     !ema50Vals.length ||
//     !ema200Vals.length
//   ) {
//     logger.log('Indicator calculation failed', 'warning');
//     return null;
//   }

//   const atr = atrVals[atrVals.length - 1] as number;
//   const rsi = rsiVals[rsiVals.length - 1] as number;
//   const ema8 = ema8Vals[ema8Vals.length - 1] as number;
//   const ema21 = ema21Vals[ema21Vals.length - 1] as number;
//   const ema50 = ema50Vals[ema50Vals.length - 1] as number;
//   const ema200 = ema200Vals[ema200Vals.length - 1] as number;
//   const currentPrice = closes[closes.length - 1] as number;

//   // Determine decimal places based on price
//   const decimals = currentPrice < 1 ? 4 : currentPrice < 100 ? 2 : 0;

//   return {
//     rsi,
//     ema8: Number(ema8.toFixed(decimals)),
//     ema21: Number(ema21.toFixed(decimals)),
//     ema50: Number(ema50.toFixed(decimals)),
//     ema200: Number(ema200.toFixed(decimals)),
//     currentPrice,
//     atr,
//     stopLossPrice: currentPrice - atr * CONFIG.ATR_STOP_MULTIPLIER,
//     takeProfitPrice: currentPrice + atr * CONFIG.ATR_TP_MULTIPLIER,
//   };
// }

// ============================================================================
// 6. FIXED getStats() for Spot Trading
// ============================================================================
function getStats() {
  const bots = Array.from(botInstances.values());

  const positionsWithData = bots.filter((b) => b.position !== null);

  // ✅ Use configured trading capital
  const totalBalance = CAPITAL_CONFIG.TRADING_CAPITAL;

  // ✅ Calculate actual allocated capital from positions
  const allocatedCapital = positionsWithData.reduce((sum, b) => {
    if (!b.position) return sum;
    const pos = b.position as Position;
    const allocated = (pos.remainingAmount || 0) * (pos.entryPrice || 0);
    return sum + (Number.isFinite(allocated) ? allocated : 0);
  }, 0);

  // ✅ Update global allocation tracker
  CAPITAL_CONFIG._allocatedCapital = allocatedCapital;

  const unrealizedPnL = positionsWithData.reduce((sum, b) => {
    const pos = b.position as Position;
    const currentValue = (pos.currentPrice || 0) * (pos.remainingAmount || 0);
    const entryValue = (pos.entryPrice || 0) * (pos.remainingAmount || 0);
    const pnl = currentValue - entryValue;
    return sum + (Number.isFinite(pnl) ? pnl : 0);
  }, 0);

  const realizedPnL = bots.reduce((sum, b) => {
    const val = b.sessionPnl || b.pnl || 0;
    return sum + (Number.isFinite(val) ? val : 0);
  }, 0);

  const availableBalance = Math.max(0, totalBalance - allocatedCapital);

  return {
    active: bots.filter((b) => b.status === 'running').length,
    positions: positionsWithData.length,
    trades: bots.reduce((sum, b) => sum + (b.trades || 0), 0),
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
    maxPositionValue: CAPITAL_CONFIG.PER_BOT_ALLOCATION,
  };
}

function canEnterPosition(symbol: string, estimatedCost: number): boolean {
  const currentPositions = getActivePositionCount();
  const maxPositions = LAUNCHER_CONFIG.maxConcurrentPositions;

  // Check position limit
  if (currentPositions >= maxPositions) {
    logger.log(
      `❌ ${symbol}: Position limit reached (${currentPositions}/${maxPositions})`,
      'error'
    );
    return false;
  }

  // Check available capital
  const availableCapital = CAPITAL_CONFIG.AVAILABLE_CAPITAL;
  const maxPerPosition = CAPITAL_CONFIG.PER_BOT_ALLOCATION;

  if (estimatedCost > availableCapital) {
    logger.log(
      `❌ ${symbol}: Insufficient capital ($${estimatedCost.toFixed(2)} needed, $${availableCapital.toFixed(2)} available)`,
      'error'
    );
    return false;
  }

  if (estimatedCost > maxPerPosition * 0.95) {
    // Allow 5% buffer
    logger.log(
      `❌ ${symbol}: Position too large ($${estimatedCost.toFixed(2)} > $${maxPerPosition.toFixed(2)} max)`,
      'error'
    );
    return false;
  }

  return true;
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
      'SPOT'
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
    const ind = calculateIndicators(data);
    if (!ind) {
      updateScanResult(symbol, null);
      return null;
    }

    const regime = detectRegime(ind, data);
    const binanceSymbol = symbol.replace('/', '');

    // ✅ Use LOCAL functions
    const htf = await getHTFConfirmation(binanceSymbol, CONFIG.TIMEFRAME);
    const fib = calculateAndLockFibonacci(symbol, lows, highs);
    const signal = pickEntryStrategy(
      symbol,
      ind,
      fib,
      regime,
      closes,
      volumes,
      htf
    );

    if (signal) {
      // ✅ Fix symbol in signal
      // signal.symbol = symbol;

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

      logger.log(
        `✅ ${symbol}: Valid signal (${(signal.confidence * 100).toFixed(0)}%)`,
        'success'
      );
      return result;
    } else {
      updateScanResult(symbol, null);
      return null;
    }
  } catch (err: any) {
    logger.log(`❌ Error scanning ${symbol}: ${err.message}`, 'error');
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
    logger.log('📊 All symbols have recent scans, skipping', 'info');
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

  logger.log(
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
      'SPOT'
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
    logger.log(
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

  const winner = scored[0]!;
  logger.log(
    `\n🎯 WINNER: ${winner.symbol} (Score: ${(winner.finalScore * 100).toFixed(1)}%)`,
    'success'
  );

  return winner;
}

function displayScanSummary() {
  const WIDTH = 150;

  console.log('\n' + colorize('═'.repeat(WIDTH), colors.brightYellow));
  console.log(colorize('🔍 SCAN RESULTS SUMMARY', colors.bright));

  const scannedSymbols = Array.from(scanResults.entries());
  const withSignals = scannedSymbols.filter(([, data]) => data.signal !== null);
  const withoutSignals = scannedSymbols.filter(
    ([, data]) => data.signal === null
  );

  // 🧪 DEBUG: Check if signals are being read
  const externalSignals = signalReader.readLatestSignals();
  // console.log(`[DEBUG] External signals: ${externalSignals.length}`);
  // console.log(`[DEBUG] Internal scans: ${scanResults.size}`);
  // console.log(`[DEBUG] : ${JSON.stringify(scannedSymbols, null, 2)}`);
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
      row: 4,
      symbol: 14,
      strategy: 18,
      side: 8,
      confidence: 6,
      price: 12,
      rsi: 14,
      regime: 12,
      htf: 8,
      lastScan: 12,
      action: 10,
    };

    // Header
    const header = [
      padCenter('#', cols.row),
      padRight('Symbol', cols.symbol),
      padRight('Strategy', cols.strategy),
      padRight('Side', cols.side),
      padRight('Conf', cols.confidence),
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
      const signal = data.signal!;

      const sideIcon =
        signal.side === 'LONG' ? '▲' : signal.side === 'SHORT' ? '▼' : '●';
      const sideColor =
        signal.side === 'LONG'
          ? colors.brightGreen
          : signal.side === 'SHORT'
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
          : '🚦QUEUED';
      const actionColor = hasPosition
        ? colors.green
        : index === 0
          ? colors.brightCyan
          : colors.gray;

      const row = [
        colorize(padCenter(`${index + 1}`, cols.row), colors.brightCyan),
        colorize(padRight(symbol, cols.symbol), colors.brightCyan),
        colorize(padRight(signal.strategy, cols.strategy), colors.magenta),
        colorize(
          padRight(`${sideIcon} ${signal.side || 'SPOT'}`, cols.side),
          sideColor
        ),
        colorize(
          padRight(`${(data.confidence * 100).toFixed(0)}%`, cols.confidence),
          confidenceColor
        ),
        colorize(
          padRight(
            data.price.toFixed(getPriceDecimals(data.price)),
            cols.price
          ),
          colors.white
        ),
        colorize(
          padRight(
            (data.rsi || 0).toFixed(getPriceDecimals(data.price)),
            cols.rsi
          ),
          colors.cyan
        ),
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
//   if (withoutSignals.length > 0) {
//     console.log('\n' + colorize(`❌ ${withoutSignals.length} tokens with NO SIGNALS`, colors.gray));

//     // Show last 10 scanned without signals
//     const recentNoSignals = withoutSignals
//       .sort(([, a], [, b]) => b.lastScan.getTime() - a.lastScan.getTime())
//       .slice(0, 10);

//     console.log(colorize('   Recently scanned: ', colors.dim) +
//       recentNoSignals.map(([symbol]) => colorize(symbol, colors.gray)).join(', '));

//   // Summary stats
//   const positionsActive = Array.from(botInstances.values()).filter(b => b.position !== null).length;
//   const signalsWaiting = withSignals.filter(([symbol]) => !botInstances.get(symbol)?.position).length;

//   console.log('\n' + colorize('═'.repeat(189), colors.brightYellow));
//   console.log(
//     colorize(`📊 Scanned: ${scannedSymbols.length} | `, colors.white) +
//     colorize(`Signals: ${withSignals.length} | `, colors.brightGreen) +
//     colorize(`No Signal: ${withoutSignals.length} | `, colors.gray) +
//     colorize(`Active Positions: ${positionsActive}/${LAUNCHER_CONFIG.maxConcurrentPositions} | `, colors.brightCyan) +
//     colorize(`Waiting: ${signalsWaiting}`, colors.yellow)
//   );
//   console.log(colorize('═'.repeat(150), colors.brightYellow) + '\n');
// }

// ============================================================================
// 7. ENHANCED POSITION DISPLAY WITH ROW NUMBERS
// ============================================================================
function displayCompactPositions(activeBots: BotInstance[]) {
  const WIDTH = 150;

  console.log('\n' + colorize('═'.repeat(WIDTH), colors.brightCyan));
  console.log(colorize('📊 ACTIVE POSITIONS', colors.bright));
  console.log(colorize('═'.repeat(WIDTH), colors.brightCyan));

  // ✅ DEBUG: Log what we received
  // console.log(
  //   `[DEBUG] displayCompactPositions called with ${activeBots.length} bots`
  // );

  // ✅ DEBUG: Check each bot
  // activeBots.forEach((bot, i) => {
  //   console.log(
  //     `[DEBUG] Bot ${i}: ${bot.symbol}, hasPosition: ${!!bot.position}, status: ${bot.status}`
  //   );
  //   if (bot.position) {
  //     console.log(
  //       `[DEBUG]   Position: entry=${bot.position.entryPrice}, remaining=${bot.position.remainingAmount}`
  //     );
  //   }
  // });

  // ✅ RELAXED VALIDATION: Don't be too strict
  const validBots = activeBots.filter((bot) => {
    if (!bot.position) {
      console.log(`[DEBUG] Filtered out ${bot.symbol}: no position`);
      return false;
    }

    // ✅ FIXED: Allow positions even if entryPrice is missing (use current price)
    const entryPrice =
      bot.position.entryPrice || bot.position.currentPrice || 0;
    const remainingAmount = bot.position.remainingAmount || 0;

    // if (entryPrice === 0) {
    //   console.log(`[DEBUG] Filtered out ${bot.symbol}: entryPrice is 0`);
    //   return false;
    // }

    // if (remainingAmount === 0) {
    //   console.log(`[DEBUG] Filtered out ${bot.symbol}: remainingAmount is 0`);
    //   return false;
    // }

    // console.log(`[DEBUG] ✅ ${bot.symbol} passed validation`);
    return true;
  });

  // console.log(`[DEBUG] Valid bots after filtering: ${validBots.length}`);

  if (validBots.length === 0) {
    console.log(
      colorize('  No active positions (all filtered out)', colors.gray)
    );
    console.log(colorize('═'.repeat(WIDTH), colors.brightCyan) + '\n');
    return;
  }

  // Column widths
  const cols = {
    row: 4,
    symbol: 12,
    amount: 14,
    entry: 10,
    current: 10,
    investment: 12,
    unrealizedPnl: 18,
    realizedPnl: 12,
    totalPnl: 12,
    slTp: 20,
    status: 10,
    wl: 6,
  };

  // Header
  const header = [
    padCenter('#', cols.row),
    padRight('Symbol', cols.symbol),
    padLeft('Amount', cols.amount),
    padLeft('Entry', cols.entry),
    padLeft('Current', cols.current),
    padLeft('Invested', cols.investment),
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

  // Sort by PnL
  validBots.sort((a, b) => {
    const aPnl = a.position?.pnlUsd || 0;
    const bPnl = b.position?.pnlUsd || 0;
    return bPnl - aPnl;
  });

  // Display rows
  validBots.forEach((bot, index) => {
    try {
      const pos = bot.position as Position;
      const symbol = bot.symbol;

      // ✅ SAFE: Use fallbacks for all values
      const remainingAmount = pos.remainingAmount || pos.amount || 0;
      const entryPrice = pos.entryPrice || pos.currentPrice || 0;
      const currentPrice = pos.currentPrice || pos.entryPrice || entryPrice;

      const priceDecimals = getPriceDecimals(currentPrice);

      const investment = remainingAmount * entryPrice;
      const unrealizedPnlUsd =
        pos.pnlUsd || (currentPrice - entryPrice) * remainingAmount;
      const unrealizedPnlPct =
        pos.pnlPct || ((currentPrice - entryPrice) / entryPrice) * 100;
      const realizedPnlUsd = bot.sessionPnl || bot.pnl || 0;
      const totalPnlUsd = unrealizedPnlUsd + realizedPnlUsd;

      const stopLoss = pos.stopLoss || 0;
      const takeProfit = pos.takeProfit || 0;

      const status = bot.status || 'running';
      const statusDisplay = status === 'running' ? '🟢 Run' : '🧊 Cool';

      const wins = bot.wins || 0;
      const losses = bot.losses || 0;
      const wlDisplay = `${wins}/${losses}`;

      // Color based on PnL
      const symbolColor =
        unrealizedPnlUsd >= 0 ? colors.brightGreen : colors.brightRed;

      const row = [
        colorize(padCenter(`${index + 1}`, cols.row), colors.brightCyan),
        colorize(padRight(symbol, cols.symbol), symbolColor),
        colorize(
          padLeft(formatQuantity(remainingAmount), cols.amount),
          colors.white
        ),
        colorize(
          padLeft(entryPrice.toFixed(priceDecimals), cols.entry),
          colors.white
        ),
        colorize(
          padLeft(currentPrice.toFixed(priceDecimals), cols.current),
          colors.yellow
        ),
        colorize(
          padLeft(`${investment.toFixed(4)}`, cols.investment),
          colors.cyan
        ),
        colorize(
          padLeft(
            `${unrealizedPnlPct >= 0 ? '+' : ''}${unrealizedPnlPct.toFixed(2)}% (${unrealizedPnlUsd.toFixed(2)})`,
            cols.unrealizedPnl
          ),
          unrealizedPnlUsd >= 0 ? colors.brightGreen : colors.brightRed
        ),
        colorize(
          padLeft(
            realizedPnlUsd !== 0
              ? `${realizedPnlUsd >= 0 ? '+' : ''}${realizedPnlUsd.toFixed(2)}`
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
            `${totalPnlUsd >= 0 ? '+' : ''}${totalPnlUsd.toFixed(getPriceDecimals(totalPnlUsd))}`,
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
    } catch (err: any) {
      console.log(
        colorize(
          `[ERROR] Failed to display ${bot.symbol}: ${err.message}`,
          colors.red
        )
      );
    }
  });
  // console.log("🥑 ~ displayCompactPositions ~ validBots:", (validBots.length))

  console.log(colorize('═'.repeat(WIDTH), colors.brightCyan));

  // Summary stats
  try {
    const totalInvested = validBots.reduce((sum, b) => {
      const entry = b.position?.entryPrice || 0;
      const amount = b.position?.remainingAmount || 0;
      return sum + entry * amount;
    }, 0);

    const totalUnrealized = validBots.reduce(
      (sum, b) => sum + (b.position?.pnlUsd || 0),
      0
    );
    const totalRealized = validBots.reduce(
      (sum, b) => sum + (b.sessionPnl || b.pnl || 0),
      0
    );

    console.log(
      colorize(
        `💰 Total Invested: ${totalInvested.toFixed(getPriceDecimals(totalInvested))} | `,
        colors.white
      ) +
        colorize(
          `Unrealized: ${totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(getPriceDecimals(totalUnrealized))} | `,
          totalUnrealized >= 0 ? colors.brightGreen : colors.brightRed
        ) +
        colorize(
          `Realized: ${totalRealized >= 0 ? '+' : ''}${totalRealized.toFixed(getPriceDecimals(totalRealized))}`,
          totalRealized >= 0 ? colors.brightGreen : colors.brightRed
        )
    );
  } catch (err: any) {
    console.log(
      colorize(
        `[ERROR] Failed to calculate summary: ${err.message}`,
        colors.red
      )
    );
  }

  console.log(colorize('═'.repeat(WIDTH), colors.brightCyan) + '\n');
}

// ============================================================================
// ALTERNATIVE: If positions still don't show, use this simpler version
// ============================================================================
function displayCompactPositionsSimple(activeBots: BotInstance[]) {
  console.log('\n' + colorize('═'.repeat(100), colors.brightCyan));
  console.log(colorize('📊 ACTIVE POSITIONS (SIMPLE)', colors.bright));
  console.log(colorize('═'.repeat(100), colors.brightCyan));

  if (activeBots.length === 0) {
    console.log(colorize('  No active positions', colors.gray));
    console.log(colorize('═'.repeat(100), colors.brightCyan) + '\n');
    return;
  }

  activeBots.forEach((bot, index) => {
    if (!bot.position) return;

    const pos = bot.position;
    const entry = pos.entryPrice || 0;
    const current = pos.currentPrice || entry;
    const amount = pos.remainingAmount || 0;
    const pnl = ((current - entry) / entry) * 100;

    console.log(
      colorize(`${index + 1}. ${bot.symbol}`, colors.brightCyan) +
        ` | Entry: ${entry.toFixed(4)}` +
        ` | Current: ${current.toFixed(4)}` +
        ` | Amount: ${amount.toFixed(6)}` +
        ` | PnL: ${colorPnL(pnl, true)}`
    );
  });

  console.log(colorize('═'.repeat(100), colors.brightCyan) + '\n');
}

// Add this function to launcher-spot.ts:

function displayTradeHistory() {
  if (tradeHistory.length === 0) {
    console.log(colorize('  No completed trades yet', colors.gray));
    return;
  }

  const WIDTH = 180;

  console.log('\n' + colorize('═'.repeat(WIDTH), colors.yellow));
  console.log(colorize('📜 TRADE HISTORY (Last 20)', colors.bright));
  console.log(colorize('═'.repeat(WIDTH), colors.yellow));

  // Column widths
  const cols = {
    num: 4,
    symbol: 12,
    strategy: 20,
    entry: 12,
    exit: 12,
    amount: 14,
    pnl: 18,
    duration: 12,
    reason: 20,
    time: 12,
    result: 8,
  };

  // Header
  const header = [
    padRight('#', cols.num),
    padRight('Symbol', cols.symbol),
    padRight('Strategy', cols.strategy),
    padRight('Entry', cols.entry),
    padRight('Exit', cols.exit),
    padRight('Amount', cols.amount),
    padRight('PnL', cols.pnl),
    padRight('Duration', cols.duration),
    padRight('Reason', cols.reason),
    padRight('Time', cols.time),
    padRight('Result', cols.result),
  ]
    .map((col) => colorize(col, colors.gray))
    .join(' │ ');

  console.log(header);
  console.log(colorize('─'.repeat(WIDTH), colors.gray));

  // Show last 20 trades
  const recentTrades = tradeHistory.slice(0, 20);

  recentTrades.forEach((trade, index) => {
    const num = (index + 1).toString();
    const priceDecimals =
      trade.exitPrice < 1 ? 6 : trade.exitPrice < 100 ? 4 : 2;
    const amountDecimals = getAmountDecimals(trade.amount, trade.exitPrice);

    // Format duration
    const durationMin = Math.floor(trade.duration / 60000);
    const durationStr =
      durationMin < 60
        ? `${durationMin}m`
        : `${Math.floor(durationMin / 60)}h${durationMin % 60}m`;

    // Format time
    const timeStr = new Date(trade.exitTime).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    // Result icon and color
    const resultIcon = trade.isWin ? '✅ WIN' : '❌ LOSS';
    const resultColor = trade.isWin ? colors.brightGreen : colors.brightRed;
    const rowColor = trade.isWin ? colors.green : colors.red;

    // PnL display
    const pnlDisplay = `${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}% ($${trade.pnlUsd >= 0 ? '+' : ''}${trade.pnlUsd.toFixed(2)})`;
    const pnlColor = trade.isWin ? colors.brightGreen : colors.brightRed;

    const row = [
      padRight(colorize(num, colors.white), cols.num),
      padRight(colorize(trade.symbol, colors.cyan), cols.symbol),
      padRight(colorize(trade.strategy, colors.magenta), cols.strategy),
      padRight(
        colorize(trade.entryPrice.toFixed(priceDecimals), colors.white),
        cols.entry
      ),
      padRight(
        colorize(trade.exitPrice.toFixed(priceDecimals), colors.white),
        cols.exit
      ),
      padRight(
        colorize(trade.amount.toFixed(amountDecimals), colors.white),
        cols.amount
      ),
      padRight(colorize(pnlDisplay, pnlColor), cols.pnl),
      padRight(colorize(durationStr, colors.gray), cols.duration),
      padRight(
        colorize(trade.exitReason.slice(0, 18), colors.yellow),
        cols.reason
      ),
      padRight(colorize(timeStr, colors.gray), cols.time),
      padRight(colorize(resultIcon, resultColor), cols.result),
    ].join(' │ ');

    console.log(row);
  });

  console.log(colorize('═'.repeat(WIDTH), colors.yellow));

  // Summary stats
  const totalTrades = tradeHistory.length;
  const wins = tradeHistory.filter((t) => t.isWin).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  const totalPnl = tradeHistory.reduce((sum, t) => sum + t.pnlUsd, 0);
  const avgWin =
    wins > 0
      ? tradeHistory
          .filter((t) => t.isWin)
          .reduce((sum, t) => sum + t.pnlUsd, 0) / wins
      : 0;
  const avgLoss =
    losses > 0
      ? Math.abs(
          tradeHistory
            .filter((t) => !t.isWin)
            .reduce((sum, t) => sum + t.pnlUsd, 0) / losses
        )
      : 0;

  const avgDuration =
    totalTrades > 0
      ? tradeHistory.reduce((sum, t) => sum + t.duration, 0) /
        totalTrades /
        60000
      : 0;

  console.log(
    colorize(`📊 Summary: `, colors.white) +
      colorize(
        `${wins}W/${losses}L `,
        wins > losses ? colors.brightGreen : colors.brightRed
      ) +
      colorize(`(${winRate.toFixed(1)}% WR) │ `, colors.white) +
      colorize(
        `Total PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} │ `,
        totalPnl >= 0 ? colors.brightGreen : colors.brightRed
      ) +
      colorize(`Avg Win: +$${avgWin.toFixed(2)} │ `, colors.green) +
      colorize(`Avg Loss: -$${avgLoss.toFixed(2)} │ `, colors.red) +
      colorize(`Avg Duration: ${avgDuration.toFixed(0)}m`, colors.gray)
  );

  console.log(colorize('═'.repeat(WIDTH), colors.yellow) + '\n');
}

// Function to automatically enter best signal when position slot available

async function tryEnterBestSignal() {
  const currentPositions = getActivePositionCount();

  // Check if we can enter a new position
  if (currentPositions >= LAUNCHER_CONFIG.maxConcurrentPositions) {
    logger.log(
      `⏸️  Position limit reached (${currentPositions}/${LAUNCHER_CONFIG.maxConcurrentPositions})`,
      'info'
    );
    return;
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
    logger.log('🔭 No signals available for entry', 'info');
    return;
  }

  // Get best signal
  const best = withSignals[0];
  if (!best || !best.data.signal) {
    return;
  }
  const bot = botInstances.get(best.symbol);

  if (!bot || !bot.process) {
    logger.log(`⚠️ Bot for ${best.symbol} not running`, 'warning');
    return;
  }

  // ✅ VALIDATE: Check capital availability
  const estimatedCost = CAPITAL_CONFIG.PER_BOT_ALLOCATION * 0.9; // 90% of allocation

  if (!canEnterPosition(best.symbol, estimatedCost)) {
    logger.log(
      `❌ Cannot enter ${best.symbol}: Capital validation failed`,
      'error'
    );
    return;
  }

  const priceDec = getPriceDecimals(best.data.price);

  logger.log(`\n🎯 AUTO-ENTRY: Sending signal to ${best.symbol}`, 'success');
  logger.log(`   Strategy: ${best.data.signal.strategy}`, 'info');
  logger.log(
    `   Confidence: ${(best.data.confidence * 100).toFixed(0)}%`,
    'info'
  );
  logger.log(`   Price: ${best.data.price.toFixed(priceDec)}`, 'info');
  logger.log(`   Estimated cost: $${estimatedCost.toFixed(2)}`, 'info');

  // ✅ Pre-allocate capital (will be confirmed when bot reports position)
  const allocated = CAPITAL_CONFIG.allocate(estimatedCost);

  if (!allocated) {
    logger.log(`❌ Failed to allocate capital for ${best.symbol}`, 'error');
    return;
  }

  // Send entry command to bot
  try {
    bot.process.send({
      type: 'execute_entry',
      signal: best.data.signal,
      price: best.data.price,
      confidence: best.data.confidence,
      maxCapital: CAPITAL_CONFIG.PER_BOT_ALLOCATION, // ✅ Send capital limit
    });

    logger.log(`✅ Entry command sent to ${best.symbol}`, 'success');

    // Remove from scan results to avoid re-entry
    scanResults.delete(best.symbol);
  } catch (err: any) {
    logger.log(`❌ Failed to send entry command: ${err.message}`, 'error');
    // Release pre-allocated capital on failure
    CAPITAL_CONFIG.release(estimatedCost);
  }
}
// ============================================================================
// PART 6: Periodic Scanning System
// ============================================================================

async function periodicScanCheck() {
  if (isScanning) {
    logger.log('⏭️  Scan already in progress, skipping', 'warning');
    return;
  }

  const now = Date.now();

  if (now - lastFullScan >= SCAN_INTERVAL) {
    logger.log('🔄 Running periodic scan...', 'info');
    lastFullScan = now;
    isScanning = true;

    try {
      const results = await scanAllSymbols(LAUNCHER_CONFIG.enabledSymbols);
      logger.log(`✅ Scan complete: ${results.length} signals`, 'success');
      await tryEnterBestSignal();
    } catch (err: any) {
      logger.log(`❌ Scan error: ${err.message}`, 'error');
    } finally {
      isScanning = false;
    }
  }
}

export class SpotPersistence extends BaseTradingBotPersistence<
  SpotBotInstance,
  SpotPosition
> {
  constructor(stateFile: string = './data/spot-bot-state.json') {
    super(stateFile);
  }

  /**
   * Serialize spot position (no leverage/margin fields)
   */
  protected serializePosition(pos: SpotPosition): SpotPosition {
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
      confidence: pos.confidence || 0,
    };
  }

  /**
   * Deserialize spot bot from storage
   */
  protected deserializeBot(state: SpotBotInstance): SpotBotInstance {
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
      confirmationTicks: state.confirmationTicks || 0,
      lastPriceDirection: state.lastPriceDirection || 0,
      signal: state.signal as EntrySignal,
    };
  }

  /**
   * Deserialize spot position from storage
   */
  protected deserializePosition(state: SpotPosition): SpotPosition {
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
      side: state.side,
      confidence: state.confidence || 0,
    };
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

// ============================================================================
// TESTING: Verify File Path
// ============================================================================

// Run this to test file creation:
// function testFileSetup() {
//   const testFile = './data/test/signals/scanner-output.json';
//   const testDir = './data/test/signals';

//   console.log('🧪 Testing file setup...');

//   // Create directory
//   if (!fs.existsSync(testDir)) {
//     fs.mkdirSync(testDir, { recursive: true });
//     console.log(`✅ Created: ${testDir}`);
//   }

//   // Create test file
//   const testData = [
//     {
//       symbol: 'BTC/USDT',
//       signal: { side: 'LONG', strategy: 'TEST' },
//       confidence: 75,
//       price: 100,
//       timestamp: new Date().toISOString(),
//     },
//   ];

//   fs.writeFileSync(testFile, JSON.stringify(testData, null, 2));
//   console.log(`✅ Created: ${testFile}`);

//   // Try to read it
//   const content = fs.readFileSync(testFile, 'utf-8');
//   console.log('✅ File readable:', content.length > 0);

//   // Cleanup
//   fs.unlinkSync(testFile);
//   console.log('✅ Test complete');
// }

// ============================================================================
// 8. ENHANCED DASHBOARD WITH WARNINGS
// ============================================================================
async function printDashboard() {
  console.clear();

  // At the start of printDashboard()
  // console.log('\n[DEBUG] Capital Configuration:');
  // console.log('  TOTAL_CAPITAL:', CAPITAL_CONFIG.TOTAL_CAPITAL);
  // console.log('  MAX_POSITION_COUNT:', CAPITAL_CONFIG.MAX_POSITION_COUNT);
  // console.log('  BACKUP_RESERVE:', CAPITAL_CONFIG.BACKUP_RESERVE.toFixed(2));
  // console.log('  TRADING_CAPITAL:', CAPITAL_CONFIG.TRADING_CAPITAL.toFixed(2));
  // console.log('  PER_BOT_ALLOCATION:', CAPITAL_CONFIG.PER_BOT_ALLOCATION.toFixed(2));
  // console.log('  MAX_POSITION_VALUE:', CAPITAL_CONFIG.MAX_POSITION_VALUE.toFixed(2));

  const now = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const stats = getStats();

  // ✅ ADD CAPITAL VALIDATION CHECK
  const overallocated = stats.allocatedCapital > stats.totalBalance * 1.05;

  if (overallocated) {
    console.log(colorize('🚨'.repeat(80), colors.brightRed));
    console.log(
      colorize('⚠️  CRITICAL: OVERALLOCATION DETECTED!', colors.brightRed)
    );
    console.log(
      colorize(
        `   Allocated: ${stats.allocatedCapital.toFixed(2)} | Balance: ${stats.totalBalance.toFixed(2)}`,
        colors.brightRed
      )
    );
    console.log(
      colorize(
        '   ACTION: Stop launcher and review positions immediately!',
        colors.brightRed
      )
    );
    console.log(colorize('🚨'.repeat(80), colors.brightRed));
  }

  // ✅ Enhanced capital display
  const posColor =
    stats.positions >= LAUNCHER_CONFIG.maxConcurrentPositions
      ? colors.brightRed
      : stats.positions >= LAUNCHER_CONFIG.maxConcurrentPositions - 1
        ? colors.brightYellow
        : colors.brightGreen;

  // Header
  // console.log(colorize('═'.repeat(145), colors.cyan));
  // console.log(
  //   colorize('🤖 MULTI-BOT SPOT TRADING DASHBOARD', colors.brightCyan) +
  //     ' '.repeat(76) +
  //     colorize(`Updated: ${now}`, colors.gray)
  // );
  // console.log(colorize('═'.repeat(145), colors.cyan));

  // console.log(
  //   `Active: ${colorize(stats.active.toString(), colors.brightGreen)}/${LAUNCHER_CONFIG.maxBotsRunning} | ` +
  //   `Positions: ${colorize(stats.positions.toString(), posColor)}/${LAUNCHER_CONFIG.maxConcurrentPositions} | ` +
  //   `Trades: ${colorize(stats.trades.toString(), colors.brightCyan)}`
  // );

  // console.log(
  //   `💰 Balance: ${colorize(stats.totalBalance.toFixed(2), colors.white)} USDT | ` +
  //   `🔒 Allocated: ${colorize(stats.allocatedCapital.toFixed(2), overallocated ? colors.brightRed : colors.yellow)} USDT | ` +
  //   `💵 Available: ${colorize(stats.availableBalance.toFixed(2), colors.green)} USDT | ` +
  //   `🦄 Total Equity: ${colorize(stats.totalEquity.toFixed(2), colors.brightCyan)} USDT`
  // );

  // console.log(
  //   `📊 Per Position: ${colorize(stats.perBotAllocation.toFixed(2), colors.cyan)} USDT | ` +
  //   `💎 Backup Reserve: ${colorize(stats.backupReserve.toFixed(2), colors.magenta)} USDT | ` +
  //   `Realized: ${colorPnL(stats.realizedPnL)} USDT | ` +
  //   `Unrealized: ${colorPnL(stats.unrealizedPnL)} USDT`
  // );

  // if (stats.positions >= LAUNCHER_CONFIG.maxConcurrentPositions) {
  //   console.log(colorize(`⚠️  POSITION LIMIT REACHED - No new entries allowed`, colors.brightRed));
  // } else if (stats.availableBalance < stats.perBotAllocation) {
  //   console.log(colorize(`⚠️  LOW BALANCE: Cannot enter new positions`, colors.brightYellow));
  // }

  // console.log(colorize('─'.repeat(145), colors.gray));

  // 🚨 CRITICAL WARNINGS
  if (stats.allocatedCapital > stats.totalBalance * 1.1) {
    console.log(colorize('🚨'.repeat(60), colors.brightRed));
    console.log(
      colorize('⚠️CRITICAL: OVERALLOCATION DETECTED!', colors.brightRed)
    );
    console.log(
      colorize(
        `Allocated: ${stats.allocatedCapital.toFixed(2)} | Balance: ${stats.totalBalance.toFixed(2)}`,
        colors.brightRed
      )
    );
    console.log(
      colorize(
        'ACTION: Stop launcher and review positions immediately!',
        colors.brightRed
      )
    );
    console.log(colorize('🚨'.repeat(60), colors.brightRed));
  }

  const posLimit = CAPITAL_CONFIG.MAX_POSITION_COUNT;

  // Header
  // ✅ ADD WIN RATE STATS TO HEADER
  const totalWins = Array.from(botInstances.values()).reduce(
    (sum, b) => sum + (b.wins || 0),
    0
  );
  const totalLosses = Array.from(botInstances.values()).reduce(
    (sum, b) => sum + (b.losses || 0),
    0
  );
  const totalTrades = totalWins + totalLosses;
  const globalWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  console.log(
    `📊 Performance: ${totalWins}W/${totalLosses}L (${globalWinRate.toFixed(1)}% WR) | ` +
      `Trades: ${totalTrades} | ` +
      `Realized: ${colorPnL(stats.realizedPnL)} USDT | ` +
      `Unrealized: ${colorPnL(stats.unrealizedPnL)} USDT`
  );

  console.log(colorize('═'.repeat(145), colors.cyan));
  console.log(
    colorize('🤖 MULTI-BOT SPOT TRADING DASHBOARD', colors.brightCyan) +
      ' '.repeat(76) +
      colorize(`Updated: ${now}`, colors.gray)
  );
  console.log(colorize('═'.repeat(145), colors.cyan));

  // Debug info
  console.log(colorize('🔍 DEBUG INFO:', colors.brightYellow));
  console.log(
    `Max Positions: ${colorize(CAPITAL_CONFIG.MAX_POSITION_COUNT.toString(), colors.brightCyan)} | ` +
      `Active: ${colorize(stats.positions.toString(), stats.positions >= posLimit ? colors.brightRed : colors.brightGreen)} | ` +
      `Per Bot: ${colorize(`${CAPITAL_CONFIG.PER_BOT_ALLOCATION.toFixed(2)}`, colors.yellow)} | ` +
      `Max Size: ${colorize(`${CAPITAL_CONFIG.MAX_POSITION_VALUE.toFixed(2)}`, colors.yellow)}`
  );

  // Stats
  // const posColor =
  //   stats.positions >= posLimit
  //     ? colors.brightRed
  //     : stats.positions >= posLimit - 1
  //       ? colors.brightYellow
  //       : colors.brightGreen;

  console.log(
    `Active: ${colorize(stats.active.toString(), colors.brightGreen)}/${LAUNCHER_CONFIG.enabledSymbols.length} | ` +
      `Positions: ${colorize(stats.positions.toString(), posColor)}/${posLimit} | ` +
      `Trades: ${colorize(stats.trades.toString(), colors.brightCyan)} | ` +
      `Realized: ${colorPnL(stats.realizedPnL)} USDT | ` +
      `Unrealized: ${colorPnL(stats.unrealizedPnL)} USDT`
  );

  console.log(
    `💰 Balance: ${colorize(stats.totalBalance.toFixed(2), colors.white)} USDT | ` +
      `🔒 Allocated: ${colorize(stats.allocatedCapital.toFixed(2), stats.allocatedCapital > stats.totalBalance ? colors.brightRed : colors.yellow)} USDT | ` +
      `💵 Available: ${colorize(stats.availableBalance.toFixed(2), colors.green)} USDT | ` +
      `🦄 Total Equity: ${colorize(stats.totalEquity.toFixed(2), colors.brightCyan)} USDT`
  );

  // Warnings
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

  if (stats.availableBalance < CAPITAL_CONFIG.PER_BOT_ALLOCATION) {
    console.log(
      colorize(
        `⚠️  LOW BALANCE: Cannot enter new positions`,
        colors.brightYellow
      )
    );
  }

  console.log(colorize('─'.repeat(145), colors.gray));

  // Show active positions with row numbers
  const botsWithPositions = Array.from(botInstances.values()).filter(
    (b) => b.position !== null
  );
  // console.log(`[DEBUG printDashboard] Total bots: ${botInstances.size}`);
  // console.log(
  //   `[DEBUG printDashboard] Bots with positions: ${botsWithPositions.length}`
  // );

  // if (botsWithPositions.length > 0) {
  //   botsWithPositions.forEach((bot, i) => {
  //     console.log(`[DEBUG printDashboard] Bot ${i}: ${bot.symbol}`);
  //     if (bot.position) {
  //       console.log(
  //         `[DEBUG printDashboard] Entry: ${bot.position.entryPrice}, Amount: ${bot.position.amount}`
  //       );
  //     }
  //   });
  // }

  // const validPositions = botsWithPositions.filter((bot) => {
  //   const amount = bot.position?.remainingAmount || bot.position?.amount || 0;
  //   return bot.position && bot.position.entryPrice > 0 && amount > 0;
  // });
  // displayCompactPositionsSimple(validPositions);

  // displayCompactPositions(botsWithPositions);

  // if (botsWithPositions.length > 0) {
  //   displayCompactPositions(botsWithPositions);
  // }
  displayScanSummary();

  displayCompactPositions(botsWithPositions);
  // Scan summary
  // displayCompactPositionsSimple(botsWithPositions)

  displayTradeHistory();

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
      colorize('[h]', colors.brightCyan) +
      ' History | ' + // ✅ ADD THIS
      colorize('[stats]', colors.white) +
      ' Detailed Stats | ' + // ✅ ADD THIS
      colorize('[scan]', colors.green) +
      ' Manual Scan'
  );
  console.log(colorize('═'.repeat(145), colors.cyan));
}

// ============================================================================
// 9. MEMORY MONITORING
// ============================================================================
function monitorMemory() {
  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);

  if (heapMB > MEMORY_CONFIG.MAX_MEMORY_MB) {
    logger.log(
      `⚠️ HIGH MEMORY: Heap ${heapMB}MB / ${MEMORY_CONFIG.MAX_MEMORY_MB}MB`,
      'warning'
    );
    logger.log(
      `   Scan: ${scanResults.size}, Fib: ${launcherFibMap.size}, HTF: ${launcherHTFCache.size}`,
      'warning'
    );

    // Aggressive cleanup
    runMemoryCleanup();

    // If still high, clear everything
    if (heapMB > MEMORY_CONFIG.MAX_MEMORY_MB * 1.5) {
      logger.log('🚨 CRITICAL MEMORY - Clearing all caches', 'error');
      scanResults.clear();
      launcherFibMap.clear();
      launcherHTFCache.clear();

      if (global.gc) global.gc();
    }
  }
}

function printPositionsOnly() {
  console.clear();
  console.log(colorize('═'.repeat(145), colors.cyan));
  console.log(colorize('📊 ACTIVE POSITIONS ONLY', colors.brightMagenta));
  console.log(colorize('═'.repeat(145), colors.cyan));

  const botsWithPositions = Array.from(botInstances.values()).filter(
    (b) => b.position !== null
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
        logger.log('Restarting all bots...', 'info');
        botInstances.forEach((_, symbol) => restartBot(symbol, 'User command'));
        break;

      case 's':
        logger.log('Stopping all bots...', 'info');
        botInstances.forEach((_, symbol) => stopBot(symbol, 'User command'));
        break;

      case 'q':
        logger.log('Shutting down launcher...', 'warning');
        shutdown();
        break;

      case 'd':
        printDashboard();
        break;

      case 'p':
        printPositionsOnly();
        break;

      // ✅ ADD: Show full trade history
      case 'h':
      case 'history':
        console.clear();
        displayTradeHistory();
        setTimeout(() => printDashboard(), 5000); // Return to dashboard after 5s
        break;

      case 'stats':
        // Show detailed statistics
        console.clear();
        displayTradeHistory();
        displayPerformanceStats();
        break;

      // 🆕 NEW: Manual scan command
      case 'scan':
        logger.log('🔍 Running manual scan...', 'info');
        scanAllSymbols(LAUNCHER_CONFIG.enabledSymbols)
          .then((results) => {
            logger.log(
              `✅ Scan complete: ${results.length} signals`,
              'success'
            );
            tryEnterBestSignal();
          })
          .catch((err) => log(`❌ Scan failed: ${err.message}`, 'error'));
        break;

      // 🆕 NEW: Force entry to best signal
      case 'enter':
      case 'e':
        logger.log('🎯 Attempting to enter best signal...', 'info');
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

// Add this optional function for detailed stats view:

function displayPerformanceStats() {
  console.log('\n' + colorize('═'.repeat(100), colors.cyan));
  console.log(colorize('📈 PERFORMANCE STATISTICS', colors.bright));
  console.log(colorize('═'.repeat(100), colors.cyan));

  if (tradeHistory.length === 0) {
    console.log(colorize('  No trades yet', colors.gray));
    return;
  }

  // Overall stats
  const totalTrades = tradeHistory.length;
  const wins = tradeHistory.filter((t) => t.isWin).length;
  const losses = totalTrades - wins;
  const winRate = (wins / totalTrades) * 100;

  // PnL stats
  const totalPnl = tradeHistory.reduce((sum, t) => sum + t.pnlUsd, 0);
  const winningTrades = tradeHistory.filter((t) => t.isWin);
  const losingTrades = tradeHistory.filter((t) => !t.isWin);

  const avgWin =
    wins > 0 ? winningTrades.reduce((sum, t) => sum + t.pnlUsd, 0) / wins : 0;
  const avgLoss =
    losses > 0
      ? losingTrades.reduce((sum, t) => sum + Math.abs(t.pnlUsd), 0) / losses
      : 0;
  const largestWin =
    wins > 0 ? Math.max(...winningTrades.map((t) => t.pnlUsd)) : 0;
  const largestLoss =
    losses > 0 ? Math.min(...losingTrades.map((t) => t.pnlUsd)) : 0;

  // Profit factor
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossLoss = Math.abs(
    losingTrades.reduce((sum, t) => sum + t.pnlUsd, 0)
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

  // Duration stats
  const avgDuration =
    tradeHistory.reduce((sum, t) => sum + t.duration, 0) / totalTrades / 60000;

  // Strategy breakdown
  const strategyStats = new Map<
    string,
    { wins: number; losses: number; pnl: number }
  >();
  tradeHistory.forEach((trade) => {
    const existing = strategyStats.get(trade.strategy) || {
      wins: 0,
      losses: 0,
      pnl: 0,
    };
    if (trade.isWin) existing.wins++;
    else existing.losses++;
    existing.pnl += trade.pnlUsd;
    strategyStats.set(trade.strategy, existing);
  });

  console.log(colorize('\n📊 Overall Performance:', colors.brightCyan));
  console.log(`  Total Trades: ${totalTrades}`);
  console.log(
    `  Win Rate: ${colorize(`${winRate.toFixed(1)}%`, winRate >= 50 ? colors.brightGreen : colors.brightRed)} (${wins}W / ${losses}L)`
  );
  console.log(`  Total PnL: ${colorPnL(totalPnl, false)} USDT`);
  console.log(
    `  Profit Factor: ${colorize(profitFactor.toFixed(2), profitFactor >= 1.5 ? colors.brightGreen : colors.yellow)}`
  );
  console.log(`  Avg Duration: ${avgDuration.toFixed(0)} minutes`);

  console.log(colorize('\n💰 PnL Statistics:', colors.brightCyan));
  console.log(
    `  Avg Win: ${colorize(`+$${avgWin.toFixed(2)}`, colors.brightGreen)} USDT`
  );
  console.log(
    `  Avg Loss: ${colorize(`-$${avgLoss.toFixed(2)}`, colors.brightRed)} USDT`
  );
  console.log(
    `  Largest Win: ${colorize(`+$${largestWin.toFixed(2)}`, colors.brightGreen)} USDT`
  );
  console.log(
    `  Largest Loss: ${colorize(`$${largestLoss.toFixed(2)}`, colors.brightRed)} USDT`
  );
  console.log(
    `  Expectancy: ${colorPnL((avgWin * winRate) / 100 - (avgLoss * (100 - winRate)) / 100, false)} USDT per trade`
  );

  console.log(colorize('\n🎯 Strategy Breakdown:', colors.brightCyan));
  strategyStats.forEach((stats, strategy) => {
    const statWinRate = (stats.wins / (stats.wins + stats.losses)) * 100;
    console.log(
      `  ${colorize(strategy.padEnd(20), colors.magenta)} | ` +
        `${stats.wins}W/${stats.losses}L (${statWinRate.toFixed(0)}% WR) | ` +
        `PnL: ${colorPnL(stats.pnl, false)} USDT`
    );
  });

  console.log(colorize('═'.repeat(100), colors.cyan) + '\n');
}

function killIfMemoryTooHigh() {
  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);

  // 🚨 HARD LIMIT: Kill process if over 2GB
  if (heapMB > 2000 || rssMB > 3000) {
    logger.log(
      `☠️ FATAL: Memory exceeded (Heap: ${heapMB}MB, RSS: ${rssMB}MB)`,
      'error'
    );
    logger.log('🚨 Forcing shutdown to prevent system crash', 'error');

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

  // Uncomment to test:
  // testFileSetup();

  // ✅ Initialize ONE candle manager for all symbols
  initializeCandleManager(LAUNCHER_CONFIG.enabledSymbols);

  logger.log('═'.repeat(50), 'info');
  logger.log('🚀 Multi-Bot Trading Launcher v2.0', 'success');
  logger.log(
    `🚀 Mem: ${globalCandleManager?.getMemoryStats().memoryMB} MB`,
    'info'
  );
  logger.log(
    `  Total Candles: ${globalCandleManager?.getMemoryStats().totalCandles}`
  );
  logger.log(`  RSS: ${globalCandleManager?.getMemoryStats().rssMB}MB`);

  // Check scan results size
  logger.log(`  Scan Results Cached: ${scanResults.size}`);
  logger.log(`  Bot Instances: ${botInstances.size}`);
  logger.log(`  Fib Map Size: ${launcherFibMap.size}`);
  logger.log(`  HTF Cache Size: ${launcherHTFCache.size}`);
  // log(
  //   `   Enabled symbols: ${LAUNCHER_CONFIG.enabledSymbols.join(', ')}`,
  //   'info'
  // );
  logger.log(`   Max concurrent: ${LAUNCHER_CONFIG.maxBotsRunning}`, 'info');
  logger.log(
    `   Max positions: ${LAUNCHER_CONFIG.maxConcurrentPositions}`,
    'info'
  );
  logger.log(`   Auto-restart: ${LAUNCHER_CONFIG.autoRestart}`, 'info');

  // ✅ Add capital info
  logger.log('─'.repeat(50), 'info');
  logger.log(`💰 CAPITAL ALLOCATION`, 'info');
  logger.log(`   Total Capital: ${CAPITAL_CONFIG.TOTAL_CAPITAL} USDT`, 'info');
  logger.log(
    `   Backup Reserve (${(CAPITAL_CONFIG.BACKUP_RESERVE_PCT * 100).toFixed(0)}%): ${CAPITAL_CONFIG.BACKUP_RESERVE} USDT`,
    'info'
  );
  logger.log(
    `   Trading Capital: ${CAPITAL_CONFIG.TRADING_CAPITAL} USDT`,
    'success'
  );
  logger.log(
    `   Per Bot Allocation: ${CAPITAL_CONFIG.PER_BOT_ALLOCATION.toFixed(2)} USDT`,
    'info'
  );

  if (process.env.ENABLED_SYMBOLS) {
    logger.log(`   ✅ Using symbols from .env`, 'success');
  }
  if (process.env.PAPER_TRADING === 'true') {
    logger.log(`   📝 PAPER TRADING MODE (from .env)`, 'warning');
  }

  logger.log('═'.repeat(50), 'info');

  LAUNCHER_CONFIG.enabledSymbols.forEach((symbol) => {
    // console.log('🥑 ~ main ~ symbol:=====>>', symbol);
    // const ctx = createSymbolContext(symbol);
    startBot(symbol);
  });

  setInterval(async () => {
    const signals = await signalReader.readLatestSignals();

    if (signals.length > 0) {
      const stats = signalReader.getStats();
      logger.log(
        `📊 ${signals.length} signals available (Avg: ${stats.avgConfidence.toFixed(0)}%)`,
        'info'
      );
    }
  }, 30_000);

  // Setup intervals
  // ✅ Check for new signals every 30 seconds
  // setInterval(() => {
  //   signalReader.readLatestSignals();

  //   const stats = signalReader.getStats();
  //   if (stats.totalSignals > 0) {
  //   logger.log(`📊 ${stats.totalSignals} signals available (Avg: ${stats.avgConfidence.toFixed(0)}%)`, 'info');
  //   }
  // }, 30_000);

  setInterval(() => {
    tryEnterBestSignal();
  }, 60_000);

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
      logger.log(
        `🚨 CRITICAL MEMORY: Heap ${heapMB}MB, RSS ${rssMB}MB`,
        'error'
      );
      logger.log(`   Scan results: ${scanResults.size}`, 'error');
      logger.log(`   Bot instances: ${botInstances.size}`, 'error');
      logger.log(`   Fib cache: ${launcherFibMap.size}`, 'error');
      logger.log(`   HTF cache: ${launcherHTFCache.size}`, 'error');
      logger.log(`   Log streams: ${logStreams.size}`, 'error');

      // Emergency cleanup
      runMemoryCleanup();

      // If still critical, clear all caches
      if (heapMB > 1500) {
        logger.log('🚨 EMERGENCY: Clearing all caches', 'error');
        scanResults.clear();
        launcherFibMap.clear();
        launcherHTFCache.clear();

        if (global.gc) {
          global.gc();
          logger.log('🚨 Forced garbage collection', 'warning');
        }
      }
    }
  }, 30 * 1000);
  // ✅ Memory monitoring
  // setInterval(() => {
  //   if (globalCandleManager) {
  //     const stats = globalCandleManager.getMemoryStats();
  //   logger.log(`📊 Memory: ${stats.symbolCount} symbols, ${stats.totalCandles} candles, ${stats.memoryMB}MB heap`, 'info');
  //   }
  // }, 5 * 60 * 1000);

  setInterval(() => {
    runMemoryCleanup();
  }, MEMORY_LIMITS.CACHE_CLEANUP_INTERVAL);

  setupCommandInterface();

  setTimeout(async () => {
    logger.log('🚀 Running initial scan...', 'info');
    try {
      const results = await scanAllSymbols(LAUNCHER_CONFIG.enabledSymbols);
      logger.log(`✅ Initial scan: ${results.length} signals found`, 'success');
      await tryEnterBestSignal();
    } catch (err: any) {
      logger.log(`❌ Initial scan failed: ${err.message}`, 'error');
    }
  }, 5000);

  setTimeout(printDashboard, 2000);
}

// ---------- SHUTDOWN ----------
export function shutdown() {
  logger.log('Graceful shutdown initiated...', 'warning');

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
    logger.log('All resources released. Goodbye! 👋', 'success');
    process.exit(0);
  }, 5000);
}

// ---------- SIGNAL HANDLERS ----------
process.on('SIGINT', async () => {
  logger.log('Received SIGINT, shutting down...', 'warning');
  shutdown();
});

process.on('SIGTERM', () => {
  logger.log('Received SIGTERM, shutting down...', 'warning');
  shutdown();
});

process.on('uncaughtException', (err) => {
  logger.log(`Uncaught exception: ${err.message}`, 'error');
  if (globalCandleManager) {
    globalCandleManager.destroy();
  }
  process.exit(1);
});

main().catch((err) => {
  logger.log(`Fatal error: ${err.message}`, 'error');
  if (globalCandleManager) {
    globalCandleManager.destroy();
  }
  process.exit(1);
});
