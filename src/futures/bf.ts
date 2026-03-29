// import { sharedBalance } from './shared-balance.js';
// import { getConfigForSymbol, type Timeframe } from './coin-config.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import ccxt, { type OHLCV } from 'ccxt';
import * as dotenv from 'dotenv';
import { ATR, EMA, RSI } from 'technicalindicators';
import WebSocket from 'ws';

import type {
  BotInstance,
  BotStats,
  CooldownState,
  EntryChecklist,
  EntrySignal,
  EntryType,
  FibonacciLevels,
  HTFConfirmation,
  Indicators,
  LauncherConfig,
  MarketInfo,
  Position,
  StrategyId,
  TokenData,
  TokenScore,
  TradeLog,
} from '../../lib/type.js';
import { getFuturesConfigForSymbol, type Timeframe } from './future-config.js';
import { futuresCoordinator } from './future-position-coordinator.js';
// import { positionCoordinator } from './position-coordinator.js'
import { futuresBalance } from './future-shared-balance.js';
import {
  calculateLiquidationPrice,
  checkLiquidationRisk,
  getMaintenanceMarginTier,
} from './liquidation-calculator.js';

dotenv.config();

type Regime = {
  trend:
    | 'UP'
    | 'DOWN'
    | 'CHOP'
    | 'UPTREND'
    | 'DOWNTREND'
    | 'DEAD_CHOP'
    | 'STRONG_UP'
    | 'STRONG_DOWN'
    | 'WEAK_UP'
    | 'WEAK_DOWN';
  volatility:
    | 'LOW'
    | 'DEAD'
    | 'MEDIUM'
    | 'HIGH'
    | 'HIGH_BULL'
    | 'HIGH_BEAR'
    | 'HIGH_NEUTRAL'
    | 'VERY_LOW'
    | 'EXTREME';
  trendStrength: number;
  volRatio: number;
  volumeRatio?: number;
  momentum?: number;
  shortTermMomentum?: number;
  mediumTermTrend?: number;
  emaAlignment?: string;
};

const isLauncherManaged = !!process.send;
const CONFIG = getFuturesConfigForSymbol(
  process.env.TRADING_SYMBOL_FUTURES || ''
);

// // const LEVERAGE = parseInt(process.env.LEVERAGE || '5');

// // if (CONFIG.FUTURES_CONFIG.ATR_STOP_MULTIPLIER < 0.1) {
// //   console.log('⚠️  WARNING: Quick test mode detected!');
// //   console.log('⚠️  Trades will close almost instantly');
// //   console.log('⚠️  Set QUICK_TEST=false for normal trading');
// // }

// // ---------- DYNAMIC CONFIG ----------
const TRADING_SYMBOL = process.env.TRADING_SYMBOL_FUTURES || '';
let TRADING_SYMBOL_FUTURES =
  process.env.ENABLED_FUTURE_SYMBOLS || TRADING_SYMBOL.replace(',', '');
const POSITION_TYPE =
  (process.env.POSITION_TYPE as 'LONG' | 'SHORT' | 'BOTH') || 'LONG';

console.log(`🎯 Bot Configuration:`);
console.log(`   Trading Symbol: ${TRADING_SYMBOL}`);
console.log(`   Futures Symbol: ${TRADING_SYMBOL_FUTURES}`);
console.log(`   Position Type: ${POSITION_TYPE}`);

// ---------- SYMBOL VALIDATION ----------
// const TRADING_SYMBOL = process.env.TRADING_SYMBOL || 'BTC/USDT';

// Handle corrupted futures symbol
// let TRADING_SYMBOL_FUTURES = process.env.TRADING_SYMBOL_FUTURES || '';
console.log(`🔧 Raw TRADING_SYMBOL_FUTURES env: "${TRADING_SYMBOL_FUTURES}"`);

// Fix if it contains multiple symbols
if (TRADING_SYMBOL_FUTURES.includes(',')) {
  console.log(
    `⚠️ WARNING: Multiple symbols detected in TRADING_SYMBOL_FUTURES!`,
    TRADING_SYMBOL_FUTURES
  );

  // Try to find the correct one
  const allSymbols = TRADING_SYMBOL_FUTURES.split(',');
  const baseSymbol = TRADING_SYMBOL.split('/')[0] as string;

  // Look for symbol containing our base
  const correctSymbol = allSymbols.find(
    (s) => s.includes(baseSymbol) && s.includes('USDT')
  );

  if (correctSymbol) {
    TRADING_SYMBOL_FUTURES = correctSymbol.replace('/', '');
    console.log(`   Fixed to: ${TRADING_SYMBOL_FUTURES}`);
  } else {
    // Fallback: convert from TRADING_SYMBOL
    TRADING_SYMBOL_FUTURES = TRADING_SYMBOL.replace('/', '');
    console.log(`   Using fallback: ${TRADING_SYMBOL_FUTURES}`);
  }
}

// If still empty or weird, use conversion
if (!TRADING_SYMBOL_FUTURES || TRADING_SYMBOL_FUTURES.length > 20) {
  console.log(`⚠️ Invalid futures symbol, converting from TRADING_SYMBOL`);
  TRADING_SYMBOL_FUTURES = TRADING_SYMBOL.replace('/', '');
}

console.log(`🎯 Final Configuration:`);
console.log(`   Trading Symbol: ${TRADING_SYMBOL}`);
console.log(`   Futures Symbol: ${TRADING_SYMBOL_FUTURES}`);
console.log(`   Position Type: ${process.env.POSITION_TYPE || 'LONG'}`);

// ---------- TYPES ----------

const SESSION_CONFIG = {
  MAX_DRAWDOWN_PCT: 0.8,
  MAX_TRADES_PER_SESSION: 100,
};

const positionMap = new Map<string, Position>();
const botInstances = new Map<string, BotInstance>();
const fibMap = new Map<string, FibonacciLevels | null>();
const htfCacheMap = new Map<
  string,
  { data: HTFConfirmation; fetchedAt: Date }
>();

// ---------- STATE ----------
let currentPosition: Position | null = null;
let sessionRealizedPnlUsd = 0;
let sessionStartBalance = 0;
let tradesThisSession = 0;
let isRunning = false;
let paperBalance = CONFIG.INITIAL_PAPER_BALANCE;
let lockedFibLevels: FibonacciLevels | null = null;
let cooldown: CooldownState = { until: null, reason: '', consecutiveLosses: 0 };
let htfCache: { data: HTFConfirmation; fetchedAt: Date } | null = null;
let marketInfo: MarketInfo | null = null;

// ---------- LAUNCHER CONFIG ----------
export const LAUNCHER_CONFIG: LauncherConfig = {
  enabledSymbols: process.env.ENABLED_FUTURE_SYMBOLS?.split(',') || [
    '2ZUSDT',
    'AAVEUSDT',
    'ADAUSDT',
    'ARBUSDT',
    'ASTERUSDT',
    'AVAXUSDT',
    'BCHUSDT',
    'BNBUSDT',
    'BONKUSDT',
    'BTCUSDT',
    'CAKEUSDT',
    'CRVUSDT',
    'DOGEUSDT',
    'ENAUSDT',
    'ETHFIUSDT',
    'ETHUSDT',
    'FETUSDT',
    'FLOKIUSDT',
    'GRTUSDT',
    'HBARUSDT',
    'IMXUSDT',
    'INJUSDT',
    'JUPUSDT',
    'KAIAUSDT',
    'LDOUSDT',
    'LINKUSDT',
    'LTCUSDT',
    'NEXOUSDT',
    'ONDOUSDT',
    'OPUSDT',
    'PAXGUSDT',
    'PENGUUSDT',
    'PEPEUSDT',
    'PHBUSDT',
    'PUMPUSDT',
    'QNTUSDT',
    'RENDERUSDT',
    'SEIUSDT',
    'SHIBUSDT',
    'SKYUSDT',
    'SOLUSDT',
    'SOMIUSDT',
    'STXUSDT',
    'SUIUSDT',
    'TIAUSDT',
    'TONUSDT',
    'TRXUSDT',
    'VETUSDT',
    'VIRTUALUSDT',
    'WLDUSDT',
    'WLFIUSDT',
    'XLMUSDT',
    'XPLUSDT',
    'XRPUSDT',
    'ZECUSDT',
    'ZENUSDT',
  ],
  maxBotsRunning: parseInt(process.env.MAX_BOTS || '56'),
  maxConcurrentPositions: parseInt(
    process.env.MAX_CONCURRENT_POSITIONS || '10'
  ),
  autoRestart: process.env.AUTO_RESTART !== 'false',
  maxRestarts: parseInt(process.env.MAX_RESTARTS || '3'),
  restartDelayMs: parseInt(process.env.RESTART_DELAY_MS || '30000'),
  healthCheckIntervalMs: parseInt(
    process.env.HEALTH_CHECK_INTERVAL_MS || '60000'
  ),
  dashboardRefreshMs: parseInt(process.env.DASHBOARD_REFRESH_MS || '3000'),
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '180000'), // 3 minutes
  minVolume24h: parseFloat(process.env.MIN_VOLUME_24H || '5000000'), // 5M USDT
  minScore: parseFloat(process.env.MIN_SCORE || '50'), // 0-100 scale
  drawdownLimitPct: parseFloat(process.env.DRAWDOWN_LIMIT_PCT || '25'),
  emergencyStopOnDrawdown: process.env.EMERGENCY_STOP_ON_DRAWDOWN !== 'false',
  drawdownCheckIntervalMs: parseInt(
    process.env.DRAWDOWN_CHECK_INTERVAL_MS || '30000'
  ),
  aggregateLogging: true,
};

// const STATES_DIR = './states/futures'
// const STATE_FILE = `${STATES_DIR}/bot_future_state_${CONFIG.SYMBOL.split('/')[0]}.json`;
// const TRADE_FILE = `${STATES_DIR}/future_trades_${CONFIG.SYMBOL.split('/')[0]}.json`;

const STATES_DIR = './states/futures';
const STATE_FILE =
  `${STATES_DIR}/${process.env.BOT_FUTURES_STATE_FILE}` ||
  'bot_futures_state.json';
const TRADE_FILE =
  `${STATES_DIR}/${process.env.BOT_FUTURES_LOG_FILE?.replace('.log', '_trades.json')}` ||
  'futures_trades.json';

function getLockedFib(symbol: string): FibonacciLevels | null {
  return fibMap.get(symbol) ?? null;
}

function setLockedFib(symbol: string, fib: FibonacciLevels) {
  fibMap.set(symbol, fib);
}

// ✅ Add these at the top of your file
let stats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  totalPnl: 0,
  totalRealizedPnl: 0,
  winRate: 0,
  bestTrade: 0,
  worstTrade: 0,
  avgWin: 0,
  avgLoss: 0,
  leverage: 1,
};

let tradeHistory: any[] = [];

// ---------- EXCHANGE INIT ----------
if (
  !process.env.BINANCE_FUTURE_API_KEY ||
  !process.env.BINANCE_FUTURE_API_SECRET
) {
  throw Error('Missing BINANCE_FUTURE_API_KEY or BINANCE_FUTURE_API_SECRET');
}

const binance = new ccxt.binance({
  apiKey: process.env.BINANCE_FUTURE_API_KEY,
  secret: process.env.BINANCE_FUTURE_API_SECRET,
  enableRateLimit: true,
  timeout: 60000,
  options: { defaultType: 'future' },
});

function sendToLauncher(type: string, data: any = {}) {
  if (isLauncherManaged && process.send) {
    try {
      process.send({ type, ...data });
    } catch (err) {
      log(`Failed to send IPC message: ${err}`, 'warning');
    }
  }
}

let sessionStartTime = Date.now();

function setupIPCHandlers() {
  if (!isLauncherManaged) return;

  process.on('message', (msg: any) => {
    switch (msg.type) {
      case 'health_check':
        sendToLauncher('health', {
          status: currentPosition ? 'in_position' : 'scanning',
          uptime: Date.now() - sessionStartTime,
          trades: tradesThisSession,
          pnl: sessionRealizedPnlUsd,
        });
        break;

      // ✅ NEW: Handle state request from launcher
      case 'request_state':
        log('📡 Launcher requested state report', 'info');

        const hasPosition = currentPosition !== null;

        if (hasPosition && currentPosition) {
          // ✅ Get current price for accurate PnL
          binance
            .fetchTicker(currentPosition.symbol)
            .then((ticker) => {
              const currentPrice =
                ticker.last || ticker.close || currentPosition!.entryPrice;
              const pnlUsd =
                (currentPrice - currentPosition!.entryPrice) *
                currentPosition!.remainingAmount;
              const pnlPct =
                ((currentPrice - currentPosition!.entryPrice) /
                  currentPosition!.entryPrice) *
                100;

              sendToLauncher('position_update', {
                hasPosition: true,
                position: {
                  entryPrice: currentPosition?.entryPrice,
                  currentPrice: currentPrice,
                  amount: currentPosition?.amount,
                  remainingAmount: currentPosition?.remainingAmount,
                  stopLoss: currentPosition?.stopLoss,
                  takeProfit: currentPosition?.takeProfit,
                  pnlUsd: pnlUsd,
                  pnlPct: pnlPct,
                  strategy: currentPosition?.strategy,
                  partialsSold: currentPosition?.partialsSold,
                  entryTime: currentPosition?.entryTime.toISOString(),
                  positionId: currentPosition?.positionId,
                  marginUsed: currentPosition?.marginUsed, // Add this if you have it
                  leverage: currentPosition?.leverage || 5,
                  side: currentPosition?.side || 'LONG',
                },
                // ✅ ADD THESE - Session stats for this bot
                sessionPnl: sessionRealizedPnlUsd,
                wins: stats.wins,
                losses: stats.losses,
                tradesCount: tradesThisSession,
              });

              log(
                `✅ Reported ACTIVE position: ${currentPosition!.remainingAmount} @ ${currentPosition!.entryPrice} | Session PnL: $${sessionRealizedPnlUsd.toFixed(2)}`,
                'success'
              );
            })
            .catch((err: any) => {
              // Fallback if ticker fetch fails
              sendToLauncher('position_update', {
                hasPosition: true,
                position: {
                  entryPrice: currentPosition?.entryPrice,
                  currentPrice: currentPosition?.entryPrice,
                  amount: currentPosition?.amount,
                  remainingAmount: currentPosition?.remainingAmount,
                  stopLoss: currentPosition?.stopLoss,
                  takeProfit: currentPosition?.takeProfit,
                  pnlUsd: 0,
                  pnlPct: 0,
                  strategy: currentPosition?.strategy,
                  partialsSold: currentPosition?.partialsSold,
                  entryTime: currentPosition?.entryTime.toISOString(),
                  positionId: currentPosition?.positionId,
                  marginUsed: currentPosition?.marginUsed,
                  leverage: currentPosition?.leverage || 5,
                  side: currentPosition?.side || 'LONG',
                },
                // ✅ ADD THESE
                sessionPnl: sessionRealizedPnlUsd,
                wins: stats.wins,
                losses: stats.losses,
                tradesCount: tradesThisSession,
              });

              log(
                `⚠️ Reported position (price fetch failed): ${currentPosition!.remainingAmount} @ ${currentPosition!.entryPrice}`,
                'warning'
              );
            });
        } else {
          // No position - still send session stats
          sendToLauncher('position_update', {
            hasPosition: false,
            position: null,
            // ✅ ADD THESE - Session stats even without position
            sessionPnl: sessionRealizedPnlUsd,
            wins: stats.wins,
            losses: stats.losses,
            tradesCount: tradesThisSession,
          });

          log(
            `✅ Reported NO position | Session PnL: $${sessionRealizedPnlUsd.toFixed(2)} | W/L: ${stats.wins}/${stats.losses}`,
            'success'
          );
        }
        break;

      case 'stop':
        log('Received stop command from launcher', 'warning');
        saveState();
        process.exit(0);

      case 'restart':
        log('Received restart command from launcher', 'warning');
        saveState();
        process.exit(0);
    }
  });
}

const symbols = process.env.ENABLED_SYMBOLS?.split(',') || [];
let latestTicker: Record<string, any> = {};

function setupIPCHandlersWS() {
  if (!isLauncherManaged) return;

  process.on('message', async (msg: any) => {
    switch (msg.type) {
      case 'health_check':
        sendToLauncher('health', {
          status: currentPosition ? 'in_position' : 'scanning',
          uptime: Date.now() - sessionStartTime,
          trades: tradesThisSession,
          pnl: sessionRealizedPnlUsd,
        });
        break;

      case 'request_state':
        log('📡 Launcher requested state report', 'info');

        if (currentPosition) {
          const ticker = latestTicker[currentPosition.symbol];
          const currentPrice = ticker
            ? parseFloat(ticker.c)
            : currentPosition.entryPrice;

          const pnlUsd =
            (currentPrice - currentPosition.entryPrice) *
            currentPosition.remainingAmount;
          const pnlPct =
            ((currentPrice - currentPosition.entryPrice) /
              currentPosition.entryPrice) *
            100;

          sendToLauncher('position_update', {
            hasPosition: true,
            position: {
              entryPrice: currentPosition.entryPrice,
              currentPrice,
              amount: currentPosition.amount,
              remainingAmount: currentPosition.remainingAmount,
              stopLoss: currentPosition.stopLoss,
              takeProfit: currentPosition.takeProfit,
              pnlUsd,
              pnlPct,
              strategy: currentPosition.strategy,
              partialsSold: currentPosition.partialsSold,
              entryTime: currentPosition.entryTime.toISOString(),
              positionId: currentPosition.positionId,
              marginUsed: currentPosition.marginUsed,
              leverage: currentPosition.leverage || 5,
              side: currentPosition.side || 'LONG',
            },
            sessionPnl: sessionRealizedPnlUsd,
            wins: stats.wins,
            losses: stats.losses,
            tradesCount: tradesThisSession,
          });

          log(
            `✅ Reported ACTIVE position via WS: ${currentPosition.remainingAmount} @ ${currentPosition.entryPrice}`,
            'success'
          );
        } else {
          sendToLauncher('position_update', {
            hasPosition: false,
            sessionPnl: sessionRealizedPnlUsd,
            wins: stats.wins,
            losses: stats.losses,
            tradesCount: tradesThisSession,
          });
          log('ℹ️ Reported NO active position', 'info');
        }
        break;

      case 'stop':
        log('Received stop command from launcher', 'warning');
        saveState();
        process.exit(0);

      case 'restart':
        log('Received restart command from launcher', 'warning');
        saveState();
        process.exit(0);
    }
  });
}

function initBinanceWS(symbols: string[]) {
  const ws = new WebSocket('wss://fstream.binance.com/ws');

  ws.on('open', () => {
    console.log('Connected to Binance WS');
    ws.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: symbols.map((s) => `${s.toLowerCase()}@ticker`),
        id: 1,
      })
    );
  });

  ws.on('message', (msg: string) => {
    const data = JSON.parse(msg);
    if (data.e === '24hrTicker') {
      latestTicker[data.s] = data; // cache by symbol
    }
  });

  ws.on('error', (err) => console.error('WS error:', err));
  ws.on('close', () => console.log('WS closed'));
}

// ---------- MODIFY logTrade FUNCTION ----------
// Replace existing logTrade with this enhanced version:
function logTrade(
  action: TradeLog['action'],
  data: Partial<TradeLog> & {
    price: number;
    amount: number;
    strategy: StrategyId;
    side: EntryType;
  }
) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    side: data.side,
    positionId: data.positionId || generateId(),
    strategy: data.strategy,
    currentPrice: data.price,
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
  } catch (err) {
    log(`Failed to write trade log: ${err}`, 'error');
  }

  // Send to launcher if managed
  if (isLauncherManaged) {
    sendToLauncher('trade', {
      action,
      price: data.price,
      pnl: parseFloat(data.pnl || '0'),
      realized: sessionRealizedPnlUsd,
      symbol: CONFIG.SYMBOL,
    });
  }
}

// // function logTrade(action: TradeLog['action'], data: Partial<TradeLog> & { price: number; amount: number; strategy: StrategyId; side: EntryType }) {
// //   const entry = {
// //     timestamp: new Date().toISOString(),
// //     action,
// //     side: data.side,
// //     positionId: data.positionId || generateId(),
// //     strategy: data.strategyId,
// //     currentPrice: data.price,
// //     amount: data.amount,
// //     entryPrice: data.entryPrice,
// //     pnl: data.pnl ?? '',
// //     reason: data.reason ?? '',
// //     holdTime: data.holdTime,
// //     stopLoss: data.stopLoss,
// //     takeProfit: data.takeProfit,
// //   };
// //   try {
// //     fs.appendFileSync(TRADE_FILE, JSON.stringify(entry) + '\n');
// //   } catch (err) {
// //     log(`Failed to write trade log: ${err}`, 'error');
// //   }
// // }

// Helper to get futures symbol format
function getFuturesSymbol(symbol: string): string {
  const [base, quote] = symbol.split('/');

  // Tokens with 1000 multiplier
  const thousandMultiplierTokens = [
    'PEPE',
    'FLOKI',
    'BONK',
    'SHIB',
    'BTT',
    'CAT',
    'CHEEMS',
  ];

  if (base && thousandMultiplierTokens.includes(base)) {
    return `1000${base}${quote}`;
  }

  // Regular tokens
  return `${base}${quote}`;
}

// ---------- LEVERAGE CONFIGURATION ----------
const DEFAULT_LEVERAGE = parseInt(process.env.DEFAULT_LEVERAGE || '5');
const MAX_LEVERAGE = parseInt(process.env.MAX_LEVERAGE_PER_POSITION || '10');

async function setLeverage(symbol: string, leverage: number): Promise<boolean> {
  try {
    await binance.setLeverage(leverage, symbol);
    log(`⚙️ Set leverage to ${leverage}x for ${symbol}`, 'success');
    return true;
  } catch (err: any) {
    log(`Failed to set leverage: ${err.message}`, 'error');
    return false;
  }
}

// ---------- MARKET INFO ----------
async function fetchMarketInfo(symbol: string): Promise<MarketInfo> {
  try {
    await binance.loadMarkets();
    const market = binance.market(symbol);
    if (!market) throw new Error(`Market ${symbol} not found`);

    const pricePrecision =
      market.precision.price && market.precision.price < 1
        ? Math.abs(Math.round(Math.log10(market.precision.price)))
        : market.precision.price;

    const quantityPrecision =
      market.precision.amount && market.precision.amount < 1
        ? Math.abs(Math.round(Math.log10(market.precision.amount)))
        : market.precision.amount;

    const info = {
      symbol: symbol,
      baseAsset: market.base,
      quoteAsset: market.quote,
      pricePrecision: pricePrecision,
      quantityPrecision: quantityPrecision,
      minNotional: market.limits.cost?.min || 5,
      minQty: market.limits.amount?.min || 0.000001,
      stepSize: market.precision.amount || 0.000001,
      tickSize: market.precision.price || 0.01,
    } as MarketInfo;

    log(
      `📊 Market Info: ${info.baseAsset}/${info.quoteAsset} | Price: ${info.pricePrecision.toFixed(6)}dp | Qty: ${info.quantityPrecision}dp`,
      'success'
    );
    return info;
  } catch (err) {
    log(`Failed to fetch market info: ${err}`, 'error');
    throw err;
  }
}

function roundPrice(price: number, precision: number): number {
  return Math.round(price * Math.pow(10, precision)) / Math.pow(10, precision);
}

function roundQuantity(qty: number, precision: number): number {
  return Math.floor(qty * Math.pow(10, precision)) / Math.pow(10, precision);
}

export function formatPrice(price: number): string {
  if (!marketInfo) return price.toFixed(2);
  return price.toFixed(marketInfo.pricePrecision);
}

export function formatQuantity(qty: number): string {
  if (!marketInfo) return qty.toFixed(6);
  return qty.toFixed(marketInfo.quantityPrecision);
}

// ---------- LOGGING ----------
function log(
  msg: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info'
) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  console.log(`[${new Date().toISOString()}] ${icons[type]} ${msg}`);
}

function logChecklist(
  checklist: EntryChecklist,
  side: EntryType,
  passed: number,
  total: number
) {
  log(
    `📋 Entry Checklist (${side}): ${passed}/${total} conditions met`,
    passed === total ? 'success' : 'warning'
  );
  const items = [
    { name: 'HTF Trend', ...checklist.htfTrend },
    { name: 'LTF Regime', ...checklist.ltfRegime },
    { name: 'Volatility', ...checklist.volatility },
    { name: 'RSI', ...checklist.rsi },
    { name: 'EMA Distance', ...checklist.emaDistance },
  ];

  for (const item of items) {
    const icon = item.ok ? '✅' : '❌';
    console.log(`   ${icon} ${item.name}: ${item.value} (need: ${item.need})`);
  }

  if (passed < total) {
    log(
      `💡 TIP: ${total - passed} condition(s) failing - adjust CONFIG for more signals`,
      'info'
    );
  }
}

// ---------- STATE PERSISTENCE ----------
function saveState() {
  const fib = currentPosition ? getLockedFib(currentPosition.symbol) : null;
  const state = {
    symbol: CONFIG.SYMBOL,
    currentPosition: currentPosition
      ? {
          ...currentPosition,
          entryTime: currentPosition.entryTime.toISOString(),
        }
      : null,
    sessionRealizedPnlUsd,
    sessionStartBalance,
    wins: stats.wins || 0,
    losses: stats.losses || 0,
    tradesThisSession,
    paperBalance,
    lockedFibLevels: fib
      ? {
          ...fib,
          lockedAt: fib.lockedAt.toISOString(),
        }
      : null,
    cooldown: { ...cooldown, until: cooldown.until?.toISOString() || null },
    savedAt: new Date().toISOString(),

    stats: {
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      totalTrades: stats.totalTrades || 0,
      // totalPnl: stats.totalPnl || 0,
      // totalRealizedPnl: stats.totalRealizedPnl || 0,
      winRate: stats.winRate || 0,
      // bestTrade: stats.bestTrade || 0,
      // worstTrade: stats.worstTrade || 0,
      avgWin: stats.avgWin || 0,
      avgLoss: stats.avgLoss || 0,
      leverage: CONFIG.LEVERAGE || 1,
    } as BotStats,
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    log(`💾 State saved to ${STATE_FILE}`, 'info');
  } catch (err) {
    log(`Failed to save state: ${err}`, 'error');
  }
}

// // function loadState() {
// //   try {
// //     if (fs.existsSync(STATE_FILE)) {
// //       const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));

// //       if (data.currentPosition) {
// //         currentPosition = { ...data.currentPosition, entryTime: new Date(data.currentPosition.entryTime) };
// //         log(`Restored ${currentPosition?.side} position: ${formatQuantity(currentPosition?.remainingAmount || 0)} @ ${formatPrice(currentPosition?.entryPrice || 0)}`, 'warning');
// //       }

// //       if (data.lockedFibLevels) {
// //         lockedFibLevels = { ...data.lockedFibLevels, lockedAt: new Date(data.lockedFibLevels.lockedAt) };
// //       }

// //       if (data.cooldown?.until) {
// //         cooldown = { ...data.cooldown, until: new Date(data.cooldown.until) };
// //       }

// //       sessionRealizedPnlUsd = data.sessionRealizedPnlUsd || 0;
// //       tradesThisSession = data.tradesThisSession || 0;
// //       paperBalance = data.paperBalance || CONFIG.INITIAL_PAPER_BALANCE;

// //       log('State restored from file', 'success');
// //     }
// //   } catch (err) {
// //     log(`Failed to load state: ${err}`, 'warning');
// //   }
// // }

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));

      // ✅ Validate symbol match
      if (data.currentPosition) {
        if (data.currentPosition.symbol !== CONFIG.SYMBOL) {
          log(
            `⚠️ State file contains position for ${data.currentPosition.symbol}, but we're trading ${CONFIG.SYMBOL}`,
            'warning'
          );
          log(`   Ignoring old state - starting fresh`, 'warning');

          // ✅ CRITICAL: Release capital from balance manager
          if (CONFIG.PAPER_TRADING) {
            futuresBalance.releaseCapital(data.currentPosition.symbol);
            log(
              `✅ Released ghost capital allocation for ${data.currentPosition.symbol}`,
              'success'
            );
          }

          // ✅ CRITICAL: Release coordinator slot
          if (typeof futuresCoordinator !== 'undefined') {
            futuresCoordinator.releasePosition(data.currentPosition.symbol);
            log(
              `✅ Released coordinator slot for ${data.currentPosition.symbol}`,
              'success'
            );
          }

          return; // Don't load mismatched state
        }

        // Valid position - restore it
        currentPosition = {
          ...data.currentPosition,
          entryTime: new Date(data.currentPosition.entryTime),
        };
        log(
          `✅ Restored position: ${currentPosition?.remainingAmount} ${CONFIG.SYMBOL.split('/')[0]} @ ${currentPosition?.entryPrice}`,
          'warning'
        );
      } else {
        // ✅ No position in state - ensure capital is released
        if (CONFIG.PAPER_TRADING) {
          futuresBalance.releaseCapital(CONFIG.SYMBOL);
          log(
            `✅ Ensured no ghost allocations for ${CONFIG.SYMBOL}`,
            'success'
          );
        }
      }

      // ... rest of state loading
    } else {
      log(`📄 No existing state file - starting fresh`, 'info');

      // ✅ Ensure clean slate
      if (CONFIG.PAPER_TRADING) {
        futuresBalance.releaseCapital(CONFIG.SYMBOL);
      }
    }
  } catch (err) {
    log(`Failed to load state: ${err}`, 'warning');
  }
}

function initializeTradeLog() {
  if (!fs.existsSync(TRADE_FILE)) {
    fs.writeFileSync(TRADE_FILE, '');
    log(`${STATE_FILE} initialized`, 'success');
  }
}

function generateId() {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

// ---------- COOLDOWN ----------
// function activateCooldown(reason: string, isLoss: boolean) {
//   const duration = isLoss
//     ? 10 * 60 * 1000  // 10 minutes on loss
//     : 3 * 60 * 1000;   // 3 minutes on win (prevents immediate re-entry)

//   cooldown.until = Date.now().toString() + duration as any;
//   cooldown.reason = reason;

//   const minutes = Math.ceil(duration / 60000);
//   log(`⏸️ Cooldown activated: ${minutes} min  until: ${cooldown.until} min (${reason})`, 'info');
// }

function activateCooldown(reason: string, isLoss: boolean) {
  if (isLoss) {
    cooldown.consecutiveLosses++;
    const duration =
      cooldown.consecutiveLosses >= 2
        ? CONFIG.COOLDOWN_AFTER_CONSECUTIVE_LOSSES_MS
        : CONFIG.COOLDOWN_AFTER_LOSS_MS;

    cooldown.until = new Date(Date.now() + duration);
    cooldown.reason = reason;

    log(
      `🧊 Cooldown activated: ${duration / 60000} min (${cooldown.consecutiveLosses} consecutive losses)`,
      'warning'
    );

    if (cooldown.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
      log(
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

// // function resetCooldownOnWin() {
// //   // Only reset LOSS-related cooldowns, not win cooldowns
// //   if (cooldown.reason?.includes('Stop Loss') || cooldown.reason?.includes('Trailing Stop')) {
// //     cooldown.until = 0 as any;
// //     cooldown.reason = '';
// //     log(`✅ Loss cooldown reset after win`, 'success');
// //   }
// //   // Keep win cooldowns active
// // }

function resetCooldownOnWin() {
  if (cooldown.consecutiveLosses > 0) {
    log(`🔥 Win streak started - resetting loss counter`, 'success');
  }
  cooldown.consecutiveLosses = 0;
  cooldown.until = null;
  cooldown.reason = '';
  saveState();
}

function isInCooldown(): boolean {
  if (!cooldown.until) return false;
  if (new Date() > cooldown.until) {
    log(`✅ Cooldown expired`, 'success');
    cooldown.until = null;
    cooldown.reason = '';
    saveState();
    return false;
  }
  const remaining = Math.ceil((cooldown.until.getTime() - Date.now()) / 60000);
  log(
    `🧊 Cooldown: ${remaining} - Until: ${cooldown.until} min remaining (${cooldown.reason})`,
    'warning'
  );
  return true;
}

function checkDrawdownLimit(): boolean {
  if (sessionStartBalance <= 0) return false;
  const drawdownPct =
    Math.abs(Math.min(0, sessionRealizedPnlUsd)) / sessionStartBalance;
  if (drawdownPct >= SESSION_CONFIG.MAX_DRAWDOWN_PCT) {
    log(`🛑 DRAWDOWN LIMIT: ${(drawdownPct * 100).toFixed(2)}%`, 'error');
    return true;
  }
  return false;
}

// ---------- DATA FETCHING ----------
// async function getCandles(
//   symbol: string,
//   timeframe: Timeframe = CONFIG.TIMEFRAME,
//   limit: number = CONFIG.CANDLE_LIMIT
// ) {
//   try {
//     const ohlcv = await binance.fetchOHLCV(symbol, timeframe, undefined, limit);
//     if (!ohlcv || ohlcv.length === 0) return null;

//     return {
//       closes: ohlcv.map(c => c[4] as number),
//       highs: ohlcv.map(c => c[2] as number),
//       lows: ohlcv.map(c => c[3] as number),
//       volumes: ohlcv.map(c => c[5] as number),
//     };
//   } catch (err: any) {
//     log(`fetchOHLCV failed [${timeframe}]: ${err.message}`, 'error');
//     return null;
//   }
// }

async function getCandles(
  symbols: string[],
  timeframe: Timeframe = '15m',
  limit: number = 100
): Promise<Map<string, any>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://fstream.binance.com/ws');
    const streamNames = symbols.map(
      (s) => `${s.toLowerCase()}@kline_${timeframe}`
    );
    const results = new Map();
    let timeoutId: NodeJS.Timeout;

    ws.on('open', () => {
      console.log(`📡 WS Connected for ${symbols.length} symbols`);

      ws.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: [...streamNames],
          id: 1,
        })
      );

      timeoutId = setTimeout(() => {
        ws.close();
        console.log(`⏱️  Got ${results.size}/${symbols.length} symbols`);
        resolve(results);
      }, 5000);
    });

    ws.on('message', (message: string) => {
      const data = JSON.parse(message);
      if (data.e === 'kline') {
        const symbol = data.s;
        const kline = data.k;

        if (!results.has(symbol)) {
          results.set(symbol, {
            closes: [parseFloat(kline.c)],
            highs: [parseFloat(kline.h)],
            lows: [parseFloat(kline.l)],
            volumes: [parseFloat(kline.v)],
          });
        } else {
          // Add to existing
          const existing = results.get(symbol);
          existing.closes.push(parseFloat(kline.c));
          existing.highs.push(parseFloat(kline.h));
          existing.lows.push(parseFloat(kline.l));
          existing.volumes.push(parseFloat(kline.v));

          // Keep only last N candles
          if (existing.closes.length > limit) {
            existing.closes.shift();
            existing.highs.shift();
            existing.lows.shift();
            existing.volumes.shift();
          }
        }
      }
    });

    ws.on('error', reject);
  });
}

async function getUsdtBalance(): Promise<number> {
  if (CONFIG.PAPER_TRADING) {
    // Check if we have an existing allocation
    const existing = futuresBalance.getAllocation(CONFIG.SYMBOL);

    if (existing) {
      // We have an open position, return the margin we're using
      log(
        `💰 Using allocated margin: ${existing.marginUsed.toFixed(2)} USDT`,
        'info'
      );
      return existing.marginUsed;
    }

    // No position yet, get what we can allocate for a new one
    const leverage = parseInt(process.env.DEFAULT_LEVERAGE || '5');
    const marginPerPosition = futuresBalance.getMarginPerPosition(leverage);
    const availableMargin = futuresBalance.getAvailableMargin();

    // Return the smaller of: what's available or what we're allowed per position
    const allocatable = Math.min(marginPerPosition, availableMargin);

    log(
      `💰 Available for new position: ${allocatable.toFixed(2)} USDT (margin) @ ${leverage}x`,
      'info'
    );
    log(
      `   Can control: ${(allocatable * leverage).toFixed(2)} USDT position`,
      'info'
    );

    return allocatable;
  }

  // Live trading
  try {
    const balances = await binance.fetchBalance();
    const usdt = balances['USDT'];
    const total = usdt?.free ?? 0;

    const allocated = total / CONFIG.MAX_CONCURRENT_POSITIONS;
    log(`💰 USDT Balance: ${total.toFixed(2)} | Available Margin`, 'info');
    return allocated;
  } catch (err) {
    log(`Failed to fetch balance: ${err}`, 'error');
    return 0;
  }
}

// ---------- HIGHER TIMEFRAME CONFIRMATION ----------
async function getHTFConfirmation(
  symbols: string[],
  timeframe: Timeframe
): Promise<Map<string, HTFConfirmation>> {
  // Get all candles at once (efficient!)
  const candleMap = await getCandles(symbols, timeframe, CONFIG.CANDLE_LIMIT);
  const results = new Map<string, HTFConfirmation>();

  // Process each symbol
  for (const [symbol, candleData] of candleMap) {
    // Check cache first
    const cacheKey = `${symbol}_${timeframe}`;
    const cached = htfCacheMap.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt.getTime() < 5 * 60 * 1000) {
      results.set(symbol, cached.data);
      continue; // Skip calculation, use cached
    }

    if (!candleData || !candleData.closes || candleData.closes.length < 210) {
      log(
        `${symbol}: Not enough HTF candles (${candleData?.closes?.length || 0} candles)`,
        'warning'
      );
      results.set(symbol, {
        trend: 'NEUTRAL',
        ema50: 0,
        ema200: 0,
        rsi: 50,
        alignedLong: false,
        alignedShort: false,
      });
      continue;
    }

    const { closes } = candleData;

    // Calculate indicators
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });
    const rsiValues = RSI.calculate({ period: 14, values: closes });

    const currentEma50 = ema50[ema50.length - 1] || 0;
    const currentEma200 = ema200[ema200.length - 1] || 0;
    const currentRsi = rsiValues[rsiValues.length - 1] || 50;
    const currentPrice = closes[closes.length - 1] || 0;

    // Determine trend
    let trend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (currentEma50 > currentEma200 && currentPrice > currentEma50) {
      trend = 'UP';
    } else if (currentEma50 < currentEma200 && currentPrice < currentEma50) {
      trend = 'DOWN';
    }

    // ✅ LONG Alignment: Bullish conditions
    const alignedLong =
      currentEma50 > currentEma200 && // Golden cross
      currentPrice > currentEma50 && // Price above short-term EMA
      currentRsi > 40 &&
      currentRsi < 70; // RSI not oversold/overbought

    // ✅ SHORT Alignment: Bearish conditions
    const alignedShort =
      currentEma50 < currentEma200 && // Death cross
      currentPrice < currentEma50 && // Price below short-term EMA
      currentRsi > 30 &&
      currentRsi < 60; // RSI not oversold/overbought

    // Create result
    const result: HTFConfirmation = {
      trend,
      ema50: currentEma50,
      ema200: currentEma200,
      rsi: currentRsi,
      alignedLong,
      alignedShort,
    };

    // Cache the result
    htfCacheMap.set(cacheKey, {
      data: result,
      fetchedAt: new Date(),
    });

    results.set(symbol, result);
  }

  return results;
}
// ---------- INDICATORS ----------
function calculateIndicators(
  closes: number[],
  highs: number[],
  lows: number[]
): Indicators | null {
  const minRequired = Math.max(CONFIG.RSI_PERIOD, CONFIG.EMA_LONG) + 1;
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
  const ema50Vals = EMA.calculate({ period: CONFIG.EMA_SHORT, values: closes });
  const ema200Vals = EMA.calculate({ period: CONFIG.EMA_LONG, values: closes });

  if (
    !atrVals.length ||
    !rsiVals.length ||
    !ema50Vals.length ||
    !ema200Vals.length
  ) {
    log('Indicator calculation failed', 'warning');
    return null;
  }

  const atr = atrVals[atrVals.length - 1]!;
  const rsi = rsiVals[rsiVals.length - 1]!;
  const ema50 = ema50Vals[ema50Vals.length - 1]!;
  const ema200 = ema200Vals[ema200Vals.length - 1]!;
  const currentPrice = closes[closes.length - 1]!;

  return {
    rsi,
    ema50,
    ema200,
    currentPrice,
    atr,
    stopLossPrice: currentPrice - atr * CONFIG.ATR_STOP_MULTIPLIER,
    takeProfitPrice: currentPrice + atr * CONFIG.ATR_TP_MULTIPLIER,
  };
}

function detectRegime(ind: Indicators): Regime {
  const trendStrength = (ind.ema50 - ind.ema200) / ind.ema200;
  const volRatio = ind.atr / ind.currentPrice;
  const trend: Regime['trend'] =
    Math.abs(trendStrength) < 0.001
      ? 'CHOP'
      : trendStrength > 0
        ? 'UP'
        : 'DOWN';
  const volatility: Regime['volatility'] =
    volRatio < 0.005 ? 'LOW' : volRatio < 0.015 ? 'MEDIUM' : 'HIGH';
  return { trend, volatility, trendStrength, volRatio };
}

// ---------- FIBONACCI ----------
function calculateAndLockFibonacci(
  symbol: string,
  lows: number[],
  highs: number[]
): FibonacciLevels {
  let lockedFibLevels = getLockedFib(symbol);

  if (lockedFibLevels) {
    const age = Date.now() - lockedFibLevels.lockedAt.getTime();
    if (age < CONFIG.FIB_LOCK_DURATION_MS) {
      log(
        `📐 Using locked Fib levels (${Math.round(age / 60000)} min old)`,
        'info'
      );
      return lockedFibLevels;
    }
    log(`📐 Fib levels expired, recalculating...`, 'info');
  }

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

  log(
    `📐 Locked new Fib: Low=${swingLow.toFixed(0)} High=${swingHigh.toFixed(0)}`,
    'success'
  );
  saveState();

  return lockedFibLevels;
}

// ---------- ENTRY STRATEGIES ----------
function emaPullbackLong(
  ind: Indicators,
  regime: Regime
): { ok: boolean; reason: string; confidence: number } {
  const uptrend = ind.ema50 > ind.ema200;
  const nearEma = Math.abs(ind.currentPrice - ind.ema50) / ind.ema50 < 0.02;
  const aboveEma = ind.currentPrice > ind.ema50;
  const rsiOk =
    ind.rsi > CONFIG.RSI_ENTRY_MIN && ind.rsi < CONFIG.RSI_ENTRY_MAX;

  let confidence = 0;
  if (uptrend) confidence += 0.3;
  if (aboveEma && nearEma) confidence += 0.3;
  if (rsiOk) confidence += 0.2;
  if (regime.trend === 'UP') confidence += 0.2;

  const ok = uptrend && aboveEma && nearEma && rsiOk;
  return {
    ok,
    reason: ok
      ? `EMA50 bounce @ ${formatPrice(ind.ema50)}, RSI=${ind.rsi.toFixed(1)}`
      : '',
    confidence: ok ? confidence : 0,
  };
}

// function fibRetracementLong(ind: Indicators, fib: FibonacciLevels, closes: number[]): { ok: boolean; reason: string; confidence: number } {
//   if (closes.length < 2) return { ok: false, reason: '', confidence: 0 };

//   const prev = closes[closes.length - 2]!;
//   const uptrend = ind.ema50 > ind.ema200;
//   const levels = [
//     { name: '23.6%', value: fib.level236 },
//     { name: '38.2%', value: fib.level382 },
//     { name: '50%', value: fib.level500 },
//     { name: '61.8%', value: fib.level618 },
//     { name: '78.6%', value: fib.level786 },
//   ];

//   let hitLevel: string | null = null;
//   for (const lvl of levels) {
//     if (Math.abs(ind.currentPrice - lvl.value) / lvl.value < 0.01 && ind.currentPrice > prev) {
//       hitLevel = lvl.name;
//       break;
//     }
//   }

//   const bounce = hitLevel !== null;
//   const rsiLow = ind.rsi < 50;

//   let confidence = 0;
//   if (uptrend) confidence += 0.3;
//   if (bounce) confidence += 0.4;
//   if (rsiLow) confidence += 0.3;

//   const ok = (uptrend && bounce) || (uptrend && rsiLow && ind.rsi < 45);

//   log(`🔍 Fib Long Check:`, 'info');
// log(`   Uptrend (EMA50>EMA200): ${uptrend}`, 'info');
// log(`   Bounce at Fib: ${bounce} ${hitLevel ? `(${hitLevel})` : ''}`, 'info');
// log(`   RSI Low (<50): ${rsiLow} (RSI=${ind.rsi.toFixed(1)})`, 'info');
// log(`   Current: ${ind.currentPrice.toFixed(4)}, Prev: ${prev.toFixed(4)}`, 'info');
// log(`   Result: ${ok ? '✅ PASS' : '❌ FAIL'}`, ok ? 'success' : 'error');

//   return { ok, reason: ok ? `Fib ${hitLevel} bounce, RSI=${ind.rsi.toFixed(1)}` : '', confidence: ok ? confidence : 0 };
// }

function fibRetracementLong(
  ind: Indicators,
  fib: FibonacciLevels,
  closes: number[]
): { ok: boolean; reason: string; confidence: number } {
  if (closes.length < 2) return { ok: false, reason: '', confidence: 0 };

  const prev = closes[closes.length - 2]!;
  const uptrend = ind.ema50 > ind.ema200;
  const levels = [
    { name: '23.6%', value: fib.level236 }, // ADD MORE LEVELS
    { name: '38.2%', value: fib.level382 },
    { name: '50%', value: fib.level500 },
    { name: '61.8%', value: fib.level618 },
    { name: '78.6%', value: fib.level786 }, // ADD MORE LEVELS
  ];

  let hitLevel: string | null = null;
  for (const lvl of levels) {
    // CHANGED: Increased tolerance to 1.5% and removed bullish candle requirement
    if (Math.abs(ind.currentPrice - lvl.value) / lvl.value < 0.015) {
      hitLevel = lvl.name;
      break;
    }
  }

  const bounce = hitLevel !== null;
  const rsiOk = ind.rsi >= 40 && ind.rsi <= 70; // CHANGED: More flexible range

  let confidence = 0;
  if (uptrend) confidence += 0.3;
  if (bounce) confidence += 0.4;
  if (rsiOk) confidence += 0.3;

  const ok = uptrend && bounce && rsiOk; // CHANGED: rsiLow → rsiOk

  log(`🔍 Fib Long Check:`, 'info');
  log(`   Uptrend (EMA50>EMA200): ${uptrend}`, 'info');
  log(`   Bounce at Fib: ${bounce} ${hitLevel ? `(${hitLevel})` : ''}`, 'info');
  log(`   RSI OK (40-70): ${rsiOk} (RSI=${ind.rsi.toFixed(1)})`, 'info');
  log(
    `   Current: ${ind.currentPrice.toFixed(4)}, Prev: ${prev.toFixed(4)}`,
    'info'
  );
  log(`   Result: ${ok ? '✅ PASS' : '❌ FAIL'}`, ok ? 'success' : 'error');

  return {
    ok,
    reason: ok ? `Fib ${hitLevel} bounce, RSI=${ind.rsi.toFixed(1)}` : '',
    confidence: ok ? confidence : 0,
  };
}

function breakoutLong(
  ind: Indicators,
  closes: number[],
  volumes: number[]
): { ok: boolean; reason: string; confidence: number } {
  if (closes.length < 20 || volumes.length < 20)
    return { ok: false, reason: '', confidence: 0 };

  const recent20High = Math.max(...closes.slice(-20, -1));
  const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  const currentVol = volumes[volumes.length - 1]!;
  const volConfirm = currentVol > avgVol * 1.3;
  const breaking = ind.currentPrice > recent20High;
  const rsiOk = ind.rsi > 45 && ind.rsi < CONFIG.RSI_ENTRY_MAX;

  let confidence = 0;
  if (breaking) confidence += 0.4;
  if (rsiOk) confidence += 0.3;
  if (volConfirm) confidence += 0.3;

  const ok = breaking && rsiOk && volConfirm;
  return {
    ok,
    reason: ok ? `Breakout above ${formatPrice(recent20High)} +vol` : '',
    confidence: ok ? confidence : 0,
  };
}

function emaPullbackShort(
  ind: Indicators,
  regime: Regime
): { ok: boolean; reason: string; confidence: number } {
  const downtrend = ind.ema50 < ind.ema200;
  const nearEma = Math.abs(ind.currentPrice - ind.ema50) / ind.ema50 < 0.02;
  const belowEma = ind.currentPrice < ind.ema50;
  const rsiOk =
    ind.rsi > CONFIG.RSI_ENTRY_MIN && ind.rsi < CONFIG.RSI_ENTRY_MAX;

  let confidence = 0;
  if (downtrend) confidence += 0.3;
  if (belowEma && nearEma) confidence += 0.3;
  if (rsiOk) confidence += 0.2;
  if (regime.trend === 'DOWN') confidence += 0.2;

  const ok = downtrend && belowEma && nearEma && rsiOk;
  return {
    ok,
    reason: ok
      ? `EMA50 reject @ ${formatPrice(ind.ema50)}, RSI=${ind.rsi.toFixed(1)}`
      : '',
    confidence: ok ? confidence : 0,
  };
}

function fibRetracementShort(
  ind: Indicators,
  fib: FibonacciLevels,
  closes: number[]
): { ok: boolean; reason: string; confidence: number } {
  if (closes.length < 2) return { ok: false, reason: '', confidence: 0 };

  const prev = closes[closes.length - 2]!;
  const downtrend = ind.ema50 < ind.ema200;

  const levels = [
    { name: '23.6%', value: fib.level236 }, // ADD THIS
    { name: '38.2%', value: fib.level382 },
    { name: '50%', value: fib.level500 },
    { name: '61.8%', value: fib.level618 },
    { name: '78.6%', value: fib.level786 }, // ADD THIS
  ];

  let hitLevel: string | null = null;
  for (const lvl of levels) {
    if (
      Math.abs(ind.currentPrice - lvl.value) / lvl.value < 0.01 &&
      ind.currentPrice < prev
    ) {
      hitLevel = lvl.name;
      break;
    }
  }

  const rejection = hitLevel !== null;
  const rsiHigh = ind.rsi > 50;

  let confidence = 0;
  if (downtrend) confidence += 0.3;
  if (rejection) confidence += 0.4;
  if (rsiHigh) confidence += 0.3;

  const ok = downtrend && rejection && rsiHigh;
  return {
    ok,
    reason: ok ? `Fib ${hitLevel} reject, RSI=${ind.rsi.toFixed(1)}` : '',
    confidence: ok ? confidence : 0,
  };
}

function breakdownShort(
  ind: Indicators,
  closes: number[],
  volumes: number[]
): { ok: boolean; reason: string; confidence: number } {
  if (closes.length < 20 || volumes.length < 20)
    return { ok: false, reason: '', confidence: 0 };

  const recent20Low = Math.min(...closes.slice(-20, -1));
  const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  const currentVol = volumes[volumes.length - 1]!;
  const volConfirm = currentVol > avgVol * 1.3;
  const breaking = ind.currentPrice < recent20Low;
  const rsiOk = ind.rsi > CONFIG.RSI_ENTRY_MIN && ind.rsi < 55;

  let confidence = 0;
  if (breaking) confidence += 0.4;
  if (rsiOk) confidence += 0.3;
  if (volConfirm) confidence += 0.3;

  const ok = breaking && rsiOk && volConfirm;
  return {
    ok,
    reason: ok ? `Breakdown below ${formatPrice(recent20Low)} +vol` : '',
    confidence: ok ? confidence : 0,
  };
}

// // ---------- ENTRY CHECKLIST ----------
// // function buildChecklist(ind: Indicators, regime: Regime, htf: HTFConfirmation, side: EntryType): EntryChecklist {
// //   const isLong = side === 'LONG';

// //   return {
// //     htfTrend: {
// //       ok: CONFIG.REQUIRE_HTF_ALIGNMENT
// //         ? (isLong ? htf.alignedLong : htf.alignedShort)
// //         : (CONFIG.ENABLE_COUNTER_TREND_SCALPING || htf.trend === 'NEUTRAL' || (isLong ? htf.trend !== 'DOWN' : htf.trend !== 'UP')),
// //       value: htf.trend,
// //       need: CONFIG.REQUIRE_HTF_ALIGNMENT ? (isLong ? 'UP' : 'DOWN') : 'ANY (flexible)',
// //     },
// //     ltfRegime: {
// //       ok: isLong ? (regime.trend === 'UP' || regime.trend === 'CHOP') : (regime.trend === 'DOWN' || regime.trend === 'CHOP'),
// //       value: regime.trend,
// //       need: isLong ? 'UP or CHOP' : 'DOWN or CHOP',
// //     },
// //     volatility: {
// //       ok: CONFIG.ALLOW_HIGH_VOLATILITY ? true : regime.volatility !== 'HIGH',
// //       value: regime.volatility,
// //       need: CONFIG.ALLOW_HIGH_VOLATILITY ? 'ANY' : 'LOW or MEDIUM',
// //     },
// //     rsi: {
// //       ok: ind.rsi > CONFIG.RSI_ENTRY_MIN && ind.rsi < CONFIG.RSI_ENTRY_MAX,
// //       value: ind.rsi.toFixed(1),
// //       need: `${CONFIG.RSI_ENTRY_MIN}-${CONFIG.RSI_ENTRY_MAX}`,
// //     },
// //     emaDistance: {
// //       ok: Math.abs(ind.currentPrice - ind.ema50) / ind.ema50 < 0.02,
// //       value: `${((ind.currentPrice - ind.ema50) / ind.ema50 * 100).toFixed(2)}%`,
// //       need: 'within 2%',
// //     },
// //   };
// // }

function buildChecklist(
  ind: Indicators,
  regime: Regime,
  htf: HTFConfirmation,
  side: EntryType
): EntryChecklist {
  const isLong = side === 'LONG';

  // Volatility logic with clear messaging
  const isHighVol = regime.volatility === 'HIGH';
  const volatilityOk = CONFIG.ALLOW_HIGH_VOLATILITY ? true : !isHighVol;

  // Build need string to show what's happening
  let volatilityNeed: string;
  if (CONFIG.ALLOW_HIGH_VOLATILITY) {
    volatilityNeed = isHighVol ? 'ANY ⚠️ HIGH VOL' : 'ANY';
  } else {
    volatilityNeed = 'LOW/MEDIUM (HIGH blocked)';
  }

  return {
    htfTrend: {
      ok: CONFIG.REQUIRE_HTF_ALIGNMENT
        ? isLong
          ? htf.alignedLong
          : htf.alignedShort
        : CONFIG.ENABLE_COUNTER_TREND_SCALPING ||
          htf.trend === 'NEUTRAL' ||
          (isLong ? htf.trend !== 'DOWN' : htf.trend !== 'UP'),
      value: htf.trend,
      need: CONFIG.REQUIRE_HTF_ALIGNMENT
        ? isLong
          ? 'UP'
          : 'DOWN'
        : 'ANY (flexible)',
    },
    ltfRegime: {
      ok: isLong
        ? regime.trend === 'UP' || regime.trend === 'CHOP'
        : regime.trend === 'DOWN' || regime.trend === 'CHOP',
      value: regime.trend,
      need: isLong ? 'UP or CHOP' : 'DOWN or CHOP',
    },
    volatility: {
      ok: volatilityOk,
      value: `${regime.volatility}${isHighVol ? ' ⚠️' : ''}`, // Add warning emoji for HIGH
      need: volatilityNeed,
    },
    rsi: {
      ok: ind.rsi > CONFIG.RSI_ENTRY_MIN && ind.rsi < CONFIG.RSI_ENTRY_MAX,
      value: ind.rsi.toFixed(1),
      need: `${CONFIG.RSI_ENTRY_MIN}-${CONFIG.RSI_ENTRY_MAX}`,
    },
    emaDistance: {
      ok: Math.abs(ind.currentPrice - ind.ema50) / ind.ema50 < 0.05,
      value: `${(((ind.currentPrice - ind.ema50) / ind.ema50) * 100).toFixed(2)}%`,
      need: 'within 5%',
    },
  };
}

// ---------- STRATEGY PICKER ----------
function pickEntryStrategy(
  symbol: string,
  ind: Indicators,
  fib: FibonacciLevels,
  regime: Regime,
  closes: number[],
  volumes: number[],
  htf: HTFConfirmation
): EntrySignal | null {
  const isCounterTrendLong = regime.trend === 'UP' && htf.trend === 'DOWN';
  const isCounterTrendShort = regime.trend === 'DOWN' && htf.trend === 'UP';
  const isCounterTrend = isCounterTrendLong || isCounterTrendShort;

  const stopMult =
    isCounterTrend && CONFIG.ENABLE_COUNTER_TREND_SCALPING
      ? CONFIG.SCALP_STOP_MULTIPLIER
      : CONFIG.ATR_STOP_MULTIPLIER;
  const tp1R =
    isCounterTrend && CONFIG.ENABLE_COUNTER_TREND_SCALPING
      ? CONFIG.SCALP_TP1_R
      : CONFIG.PARTIAL_TP1_R;
  const tp2R =
    isCounterTrend && CONFIG.ENABLE_COUNTER_TREND_SCALPING
      ? CONFIG.SCALP_TP2_R
      : CONFIG.PARTIAL_TP2_R;

  const minConfidence = isCounterTrend
    ? CONFIG.MIN_CONFIDENCE_COUNTER_TREND
    : CONFIG.ENABLE_LONGS
      ? CONFIG.MIN_CONFIDENCE_LONG
      : CONFIG.MIN_CONFIDENCE_SHORT;

  // LONG ENTRIES
  const htfAllowsLong = CONFIG.REQUIRE_HTF_ALIGNMENT
    ? htf.alignedLong
    : htf.trend !== 'DOWN' || CONFIG.ENABLE_COUNTER_TREND_SCALPING;

  if (CONFIG.ENABLE_LONGS && htfAllowsLong) {
    const regimeOk = regime.trend !== 'CHOP' || CONFIG.ALLOW_HIGH_VOLATILITY;
    const volOk = CONFIG.ALLOW_HIGH_VOLATILITY || regime.volatility !== 'HIGH';

    if (regimeOk && volOk && ind.ema50 > ind.ema200) {
      const ema = emaPullbackLong(ind, regime);
      if (ema.ok && ema.confidence >= minConfidence) {
        const sl = ind.currentPrice - ind.atr * stopMult;
        const tag = isCounterTrendLong ? ' [⚡COUNTER]' : '';
        log(
          `🎯 LONG: ${(ema.confidence * 100).toFixed(0)}% conf (min: ${(minConfidence * 100).toFixed(0)}%)`,
          'success'
        );
        return {
          symbol,
          strategy: 'EMA_PULLBACK',
          side: 'LONG',
          reason: ema.reason + ` [HTF: ${htf.trend}]${tag}`,
          confidence: ema.confidence * (isCounterTrendLong ? 0.7 : 1.0),
          stopLoss: sl,
          takeProfit: ind.currentPrice + ind.atr * stopMult * tp2R,
        };
      }

      const fibSig = fibRetracementLong(ind, fib, closes);
      if (fibSig.ok && fibSig.confidence >= minConfidence) {
        const sl = ind.currentPrice - ind.atr * stopMult * 1.3;
        const tag = isCounterTrendLong ? ' [⚡COUNTER]' : '';
        log(
          `🎯 LONG: ${(fibSig.confidence * 100).toFixed(0)}% conf`,
          'success'
        );
        return {
          symbol,
          strategy: 'FIB_RETRACEMENT',
          side: 'LONG',
          reason: fibSig.reason + ` [HTF: ${htf.trend}]${tag}`,
          confidence: fibSig.confidence * (isCounterTrendLong ? 0.7 : 1.0),
          stopLoss: sl,
          takeProfit: ind.currentPrice + ind.atr * stopMult * 3.0,
        };
      }

      if (
        regime.trend === 'UP' ||
        (regime.trend === 'CHOP' && ind.ema50 > ind.ema200)
      ) {
        const brk = breakoutLong(ind, closes, volumes);
        if (brk.ok && brk.confidence >= minConfidence) {
          const sl = ind.currentPrice - ind.atr * stopMult * 0.8;
          const tag = isCounterTrendLong ? ' [⚡COUNTER]' : '';
          log(`🎯 LONG: ${(brk.confidence * 100).toFixed(0)}% conf`, 'success');
          return {
            symbol,
            strategy: 'BREAKOUT',
            side: 'LONG',
            reason: brk.reason + ` [HTF: ${htf.trend}]${tag}`,
            confidence: brk.confidence * (isCounterTrendLong ? 0.7 : 1.0),
            stopLoss: sl,
            takeProfit: ind.currentPrice + ind.atr * stopMult * 3.0,
          };
        }
      }
    }
  }

  // SHORT ENTRIES
  const htfAllowsShort = CONFIG.REQUIRE_HTF_ALIGNMENT
    ? htf.alignedShort
    : htf.trend !== 'UP' || CONFIG.ENABLE_COUNTER_TREND_SCALPING;

  if (CONFIG.ENABLE_SHORTS && htfAllowsShort) {
    const regimeOk = regime.trend !== 'CHOP' || CONFIG.ALLOW_HIGH_VOLATILITY;
    const volOk = CONFIG.ALLOW_HIGH_VOLATILITY || regime.volatility !== 'HIGH';

    if (regimeOk && volOk && ind.ema50 < ind.ema200) {
      const ema = emaPullbackShort(ind, regime);
      if (ema.ok && ema.confidence >= minConfidence) {
        const sl = ind.currentPrice + ind.atr * stopMult;
        const tag = isCounterTrendShort ? ' [⚡COUNTER]' : '';
        log(`🎯 SHORT: ${(ema.confidence * 100).toFixed(0)}% conf`, 'success');
        return {
          symbol,
          strategy: 'EMA_PULLBACK_SHORT',
          side: 'SHORT',
          reason: ema.reason + ` [HTF: ${htf.trend}]${tag}`,
          confidence: ema.confidence * (isCounterTrendShort ? 0.7 : 1.0),
          stopLoss: sl,
          takeProfit: ind.currentPrice - ind.atr * stopMult * tp2R,
        };
      }

      const fibSig = fibRetracementShort(ind, fib, closes);
      if (fibSig.ok && fibSig.confidence >= minConfidence) {
        const sl = ind.currentPrice + ind.atr * stopMult * 1.3;
        const tag = isCounterTrendShort ? ' [⚡COUNTER]' : '';
        log(
          `🎯 SHORT: ${(fibSig.confidence * 100).toFixed(0)}% conf`,
          'success'
        );
        return {
          symbol,
          strategy: 'FIB_RETRACEMENT_SHORT',
          side: 'SHORT',
          reason: fibSig.reason + ` [HTF: ${htf.trend}]${tag}`,
          confidence: fibSig.confidence * (isCounterTrendShort ? 0.7 : 1.0),
          stopLoss: sl,
          takeProfit: ind.currentPrice - ind.atr * stopMult * 3.0,
        };
      }

      if (
        regime.trend === 'DOWN' ||
        (regime.trend === 'CHOP' && ind.ema50 < ind.ema200)
      ) {
        const brk = breakdownShort(ind, closes, volumes);
        if (brk.ok && brk.confidence >= minConfidence) {
          const sl = ind.currentPrice + ind.atr * stopMult * 0.8;
          const tag = isCounterTrendShort ? ' [⚡COUNTER]' : '';
          log(
            `🎯 SHORT: ${(brk.confidence * 100).toFixed(0)}% conf`,
            'success'
          );
          return {
            symbol,
            strategy: 'BREAKDOWN',
            side: 'SHORT',
            reason: brk.reason + ` [HTF: ${htf.trend}]${tag}`,
            confidence: brk.confidence * (isCounterTrendShort ? 0.7 : 1.0),
            stopLoss: sl,
            takeProfit: ind.currentPrice - ind.atr * stopMult * 3.0,
          };
        }
      }
    }
  }

  // Show checklist
  if (CONFIG.ENABLE_LONGS) {
    const longChecklist = buildChecklist(ind, regime, htf, 'LONG');
    const passed = Object.values(longChecklist).filter((c) => c.ok).length;
    logChecklist(longChecklist, 'LONG', passed, 5);
  }
  if (CONFIG.ENABLE_SHORTS) {
    const shortChecklist = buildChecklist(ind, regime, htf, 'SHORT');
    const passed = Object.values(shortChecklist).filter((c) => c.ok).length;
    logChecklist(shortChecklist, 'SHORT', passed, 5);
  }

  return null;
}

function recordClosedTrade(
  bot: any,
  position: any,
  exitPrice: number,
  pnlPct: number,
  pnlUsd: number
) {
  if (!process.send) return;

  process.send({
    type: 'trade_closed',
    trade: {
      timestamp: new Date(),
      symbol: bot.symbol || CONFIG.SYMBOL,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: exitPrice,
      quantity: position.remainingAmount,
      pnlPct: pnlPct,
      pnlUsd: pnlUsd,
      duration: Date.now() - position.entryTime,
      strategy: position.strategyId || 'UNKNOWN',
    },
  });
}

// ---------- POSITION SIZING ----------
function calculatePositionSize(
  balance: number,
  riskPct: number,
  entryPrice: number,
  sl: number,
  leverage: number = 5
): { size: number; adjustedSL: number } {
  if (!marketInfo || balance <= 0) return { size: 0, adjustedSL: sl };

  const riskAmt = balance * riskPct;
  let riskPerUnit = Math.abs(entryPrice - sl);
  let adjustedSL = sl;

  const minStopDistance = entryPrice * CONFIG.MIN_STOP_LOSS_PCT;
  if (riskPerUnit < minStopDistance) {
    riskPerUnit = minStopDistance;
    const isLong = sl < entryPrice;
    adjustedSL = isLong
      ? entryPrice - minStopDistance
      : entryPrice + minStopDistance;
    log(
      `⚙️ Stop loss adjusted to minimum distance: ${formatPrice(adjustedSL)}`,
      'info'
    );
  }

  if (riskPerUnit <= 0) {
    log(`❌ Invalid stop loss: risk per unit is ${riskPerUnit}`, 'error');
    return { size: 0, adjustedSL: sl };
  }

  // Calculate size based on risk
  let size = (riskAmt / riskPerUnit) * leverage;

  // Check against balance limits
  const marginRequired = (size * entryPrice) / leverage;
  const maxMargin = balance * 0.95; // Use max 95% of balance

  if (marginRequired > maxMargin) {
    log(
      `⚙️ Position size limited by balance (${marginRequired.toFixed(2)} > ${maxMargin.toFixed(2)})`,
      'info'
    );
    size = (maxMargin * leverage) / entryPrice;
  }

  // Round to precision
  size = roundQuantity(size, marketInfo.quantityPrecision);
  const notionalValue = size * entryPrice;

  // Verify minimum notional
  if (notionalValue < marketInfo.minNotional) {
    log(
      `❌ Position too small: ${notionalValue.toFixed(2)} USDT < ${marketInfo.minNotional} USDT minimum`,
      'error'
    );

    // Try to increase to minimum
    const minSize = marketInfo.minNotional / entryPrice;
    const roundedMinSize = roundQuantity(
      minSize * 1.01,
      marketInfo.quantityPrecision
    ); // Add 1% buffer
    const newNotional = roundedMinSize * entryPrice;

    if (newNotional <= balance * 0.95) {
      log(
        `⚙️ Adjusting to minimum size: ${roundedMinSize.toFixed(marketInfo.quantityPrecision)}`,
        'info'
      );
      return { size: roundedMinSize, adjustedSL };
    }

    return { size: 0, adjustedSL };
  }

  // Verify minimum quantity
  if (size < marketInfo.minQty) {
    log(
      `❌ Quantity too small: ${size.toFixed(marketInfo.quantityPrecision)} < ${marketInfo.minQty}`,
      'error'
    );
    return { size: 0, adjustedSL };
  }

  log(
    `✅ Position size: ${size.toFixed(marketInfo.quantityPrecision)} | Notional: ${notionalValue.toFixed(2)} USDT | Risk: ${riskAmt.toFixed(2)} USDT`,
    'info'
  );

  return { size, adjustedSL };
}

/**
 * Check if position is at risk of liquidation
 */
async function checkPositionLiquidationRisk(
  pos: Position,
  currentPrice: number
): Promise<void> {
  if (!pos.liquidationPrice) return;

  const risk = checkLiquidationRisk(
    currentPrice,
    pos.liquidationPrice,
    pos.side,
    10
  );

  if (risk.severity === 'danger') {
    log(
      `🚨 LIQUIDATION DANGER: ${risk.distancePercent.toFixed(2)}% to liquidation!`,
      'error'
    );
    log(
      `   Current: ${formatPrice(currentPrice)} | Liq: ${formatPrice(pos.liquidationPrice)}`,
      'error'
    );

    if (risk.distancePercent < 1.6) {
      log(`🚨 Emergency close due to liquidation risk!`, 'error');
      await closePosition(pos, currentPrice, 'Emergency: Near Liquidation');
    }
  } else if (risk.severity === 'critical') {
    log(
      `⚠️ LIQUIDATION CRITICAL: ${risk.distancePercent.toFixed(2)}% to liquidation`,
      'warning'
    );
  } else if (risk.severity === 'warning') {
    log(
      `⚠️ Liquidation warning: ${risk.distancePercent.toFixed(2)}% away`,
      'warning'
    );
  }
}

// ---------- ORDER EXECUTION ----------
export async function openPosition(
  balance: number,
  price: number,
  sl: number,
  tp: number,
  strategy: StrategyId,
  reason: string,
  side?: EntryType
) {
  if (!marketInfo) return;

  const isCounterTrend = reason.includes('[⚡COUNTER]');
  const leverage = isCounterTrend
    ? Math.min(DEFAULT_LEVERAGE, MAX_LEVERAGE)
    : DEFAULT_LEVERAGE;

  const riskPct =
    isCounterTrend && CONFIG.ENABLE_COUNTER_TREND_SCALPING
      ? CONFIG.SCALP_RISK_PER_TRADE
      : CONFIG.RISK_PER_TRADE;

  const roundedPrice = roundPrice(price, marketInfo.pricePrecision);
  const roundedSL = roundPrice(sl, marketInfo.pricePrecision);
  const roundedTP = roundPrice(tp, marketInfo.pricePrecision);

  const { size: amount, adjustedSL } = calculatePositionSize(
    balance,
    riskPct,
    roundedPrice,
    roundedSL,
    leverage
  );

  if (amount === 0 && side) {
    log(`Position sizing failed`, 'error');
    return;
  }

  const finalSL = roundPrice(adjustedSL, marketInfo.pricePrecision);

  // ✅ Calculate position value and required margin
  const positionValueUsdt = amount * roundedPrice;
  const requiredMargin = positionValueUsdt / leverage;

  // Calculate liquidation price
  const tier = getMaintenanceMarginTier(positionValueUsdt, marketInfo.symbol);
  const liquidationPrice =
    side && calculateLiquidationPrice(roundedPrice, leverage, side, tier.rate);

  const roundedLiqPrice = roundPrice(
    Number(liquidationPrice),
    marketInfo.pricePrecision
  );

  const liqDistance =
    side === 'LONG'
      ? ((roundedPrice - roundedLiqPrice) / roundedPrice) * 100
      : ((roundedLiqPrice - roundedPrice) / roundedPrice) * 100;

  log(`📊 Position Calculation:`, 'info');
  log(
    `   Size: ${amount.toFixed(marketInfo.quantityPrecision)} ${marketInfo.baseAsset}`,
    'info'
  );
  log(`   Value: ${positionValueUsdt.toFixed(2)} USDT`, 'info');
  log(`   Leverage: ${leverage}x`, 'info');
  log(`   Required Margin: ${requiredMargin.toFixed(2)} USDT`, 'info');
  log(`   Maintenance Rate: ${(tier.rate * 100).toFixed(2)}%`, 'info');
  log(
    `   Liquidation Price: ${formatPrice(roundedLiqPrice)} (${liqDistance.toFixed(2)}% away)`,
    'info'
  );

  if (liqDistance < 15) {
    log(
      `⚠️ WARNING: Liquidation price is close (${liqDistance.toFixed(2)}%)`,
      'warning'
    );
  }

  // Request capital allocation
  if (CONFIG.PAPER_TRADING) {
    const allocated = await futuresBalance.requestCapital(
      marketInfo.symbol,
      positionValueUsdt,
      leverage
    );

    if (allocated === 0) {
      log(`❌ Capital allocation denied by balance manager`, 'error');
      return;
    }
  }

  // Request position from coordinator
  if (typeof futuresCoordinator !== 'undefined' && side) {
    const granted = await futuresCoordinator.requestPosition(
      marketInfo.symbol,
      side,
      leverage,
      roundedPrice,
      amount,
      roundedLiqPrice
    );

    if (!granted) {
      log(`❌ Position denied by coordinator`, 'error');
      if (CONFIG.PAPER_TRADING) {
        await futuresBalance.releaseCapital(marketInfo.symbol);
      }
      return;
    }
  }

  // Set leverage on exchange
  if (!CONFIG.PAPER_TRADING) {
    const leverageSet = await setLeverage(marketInfo.symbol, leverage);
    if (!leverageSet) {
      await futuresBalance.releaseCapital(marketInfo.symbol);
      if (typeof futuresCoordinator !== 'undefined') {
        await futuresCoordinator.releasePosition(marketInfo.symbol);
      }
      return;
    }
  }

  // Calculate partial TPs
  const riskPerUnit = Math.abs(roundedPrice - finalSL);
  const tp1R =
    isCounterTrend && CONFIG.ENABLE_COUNTER_TREND_SCALPING
      ? CONFIG.SCALP_TP1_R
      : CONFIG.PARTIAL_TP1_R;
  const tp1 =
    side === 'LONG'
      ? roundPrice(roundedPrice + riskPerUnit * tp1R, marketInfo.pricePrecision)
      : roundPrice(
          roundedPrice - riskPerUnit * tp1R,
          marketInfo.pricePrecision
        );
  const tp2 = roundedTP;

  const icon = side === 'LONG' ? '📈' : '📉';
  const action = side === 'LONG' ? 'BUY' : 'SHORT';

  log(
    `${icon} ${action} [${strategy}] ${formatQuantity(amount)} @ ${formatPrice(roundedPrice)} [${leverage}x]`,
    'success'
  );
  log(
    `   Margin: ${requiredMargin.toFixed(2)} USDT | Position: ${positionValueUsdt.toFixed(2)} USDT`,
    'info'
  );
  log(
    `   SL: ${formatPrice(finalSL)} | Liq: ${formatPrice(roundedLiqPrice)} (${liqDistance.toFixed(1)}% away)`,
    'info'
  );
  log(`   TP1: ${formatPrice(tp1)} | TP2: ${formatPrice(tp2)}`, 'info');

  // Execute order (live trading)
  if (!CONFIG.PAPER_TRADING && side) {
    try {
      const order = await binance.createOrder(
        marketInfo.symbol,
        'market',
        side === 'LONG' ? 'buy' : 'sell',
        amount
      );

      log(`✅ Order executed: ${order.id}`, 'success');

      await binance.createOrder(
        marketInfo.symbol,
        'STOP_MARKET',
        side === 'LONG' ? 'sell' : 'buy',
        amount,
        undefined,
        { stopPrice: finalSL }
      );
    } catch (err: any) {
      log(`❌ ${marketInfo.symbol} order failed: ${err}`, 'error');
      await futuresBalance.releaseCapital(marketInfo.symbol);
      if (typeof futuresCoordinator !== 'undefined') {
        await futuresCoordinator.releasePosition(marketInfo.symbol);
      }
      return;
    }
  }

  if (!side) return;

  // ✅ Create position with all required fields
  currentPosition = {
    symbol: marketInfo.symbol,
    entryPrice: roundedPrice,
    amount,
    remainingAmount: amount,
    takeProfit: tp2,
    entryTime: new Date(),
    strategy: strategy,
    partialsSold: 0,
    currentPrice: price,
    stopLoss: finalSL,
    pnlUsd: 0,
    pnlPct: 0,
    positionId: generateId(),
    side,
    signalReason: reason,
    partialTakeProfit1: tp1,
    partialTakeProfit2: tp2,
    leverage,
    liquidationPrice: roundedLiqPrice,
    positionValue: positionValueUsdt, // ✅ Added
    marginUsed: requiredMargin, // ✅ Added
  };

  tradesThisSession++;
  logTrade(side === 'LONG' ? 'BUY' : 'SHORT', {
    price: roundedPrice,
    amount,
    stopLoss: finalSL,
    takeProfit: roundedTP,
    strategy: strategy,
    reason,
    positionId: currentPosition?.positionId,
    side,
  });
  saveState();
}

// // async function closePartial(pos: Position, price: number, portion: number, reason: string): Promise<boolean> {
// //   if (!marketInfo) return false;

// //   const sellAmount = roundQuantity(pos.remainingAmount * portion, marketInfo.quantityPrecision);
// //   if (sellAmount < marketInfo.minQty) return false;

// //   const pnlUsd = pos.side === 'LONG'
// //     ? (price - pos.entryPrice) * sellAmount
// //     : (pos.entryPrice - price) * sellAmount;
// //   const pnlPct = (pnlUsd / (pos.entryPrice * sellAmount)) * 100;

// //   sessionRealizedPnlUsd += pnlUsd;

// //   const action = pos.side === 'LONG' ? 'PARTIAL_SELL' : 'PARTIAL_COVER';
// //   log(`📊 ${action} ${formatQuantity(sellAmount)} @ ${formatPrice(price)} | PnL: ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`, 'success');

// //   if (CONFIG.PAPER_TRADING) {
// //     if (pos.side === 'LONG') {
// //       paperBalance += sellAmount * price;
// //     } else {
// //       paperBalance += pnlUsd;
// //     }
// //   }

// //   pos.remainingAmount -= sellAmount;
// //   pos.partialsSold++;

// //   logTrade(action, {
// //     price, amount: sellAmount, entryPrice: pos.entryPrice,
// //     pnl: pnlUsd.toFixed(2), reason, strategy: pos.strategyId,
// //     positionId: pos.positionId, side: pos.side,
// //   });

// //   saveState();
// //   return true;
// // }

// // Replace your closePartial function (around line ~1626) with this:

async function closePartial(
  pos: Position,
  price: number,
  portion: number,
  reason: string
): Promise<boolean> {
  if (!marketInfo) return false;

  const sellAmount = roundQuantity(
    pos.remainingAmount * portion,
    marketInfo.quantityPrecision
  );
  if (sellAmount < marketInfo.minQty) {
    log(
      `❌ Partial exit too small: ${sellAmount} < ${marketInfo.minQty}`,
      'warning'
    );
    return false;
  }

  const pnlUsd =
    pos.side === 'LONG'
      ? (price - pos.entryPrice) * sellAmount
      : (pos.entryPrice - price) * sellAmount;

  const leveragedPnL = pnlUsd * (pos.leverage || 5);
  const pnlPct =
    (leveragedPnL / ((pos.entryPrice * sellAmount) / (pos.leverage || 5))) *
    100;

  sessionRealizedPnlUsd += leveragedPnL;

  const action = pos.side === 'LONG' ? 'PARTIAL_SELL' : 'PARTIAL_COVER';
  const icon = leveragedPnL >= 0 ? '🟢' : '🔴';

  // ✅ Detailed logging
  log(
    `╔═══════════════════════════════════════════════════════════════`,
    'info'
  );
  log(
    `║ ${icon} ${action} [${reason}]`,
    leveragedPnL >= 0 ? 'success' : 'warning'
  );
  log(
    `╠═══════════════════════════════════════════════════════════════`,
    'info'
  );
  log(`║  Symbol: ${pos.symbol}`, 'info');
  log(`║  Side: ${pos.side} ${pos.leverage}x`, 'info');
  log(`║  Entry Price: ${formatPrice(pos.entryPrice)}`, 'info');
  log(`║  Exit Price: ${formatPrice(price)}`, 'info');
  log(
    `║  Amount Sold: ${formatQuantity(sellAmount)} (${(portion * 100).toFixed(0)}%)`,
    'info'
  );
  log(
    `║  Remaining: ${formatQuantity(pos.remainingAmount - sellAmount)} (${((1 - portion) * 100).toFixed(0)}%)`,
    'info'
  );
  log(
    `╠═══════════════════════════════════════════════════════════════`,
    'info'
  );
  log(
    `║  Realized PnL: ${leveragedPnL >= 0 ? '+' : ''}${leveragedPnL.toFixed(2)} USDT`,
    leveragedPnL >= 0 ? 'success' : 'error'
  );
  log(
    `║  PnL %: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`,
    leveragedPnL >= 0 ? 'success' : 'error'
  );
  log(
    `║  Session PnL: ${sessionRealizedPnlUsd >= 0 ? '+' : ''}${sessionRealizedPnlUsd.toFixed(2)} USDT`,
    'info'
  );
  log(
    `╚═══════════════════════════════════════════════════════════════`,
    'info'
  );

  if (CONFIG.PAPER_TRADING) {
    if (pos.side === 'LONG') {
      paperBalance += sellAmount * price;
    } else {
      paperBalance += leveragedPnL;
    }
  }

  // Execute order (live trading)
  if (!CONFIG.PAPER_TRADING) {
    try {
      await binance.createOrder(
        marketInfo.symbol,
        'market',
        pos.side === 'LONG' ? 'sell' : 'buy',
        sellAmount
      );
      log(`✅ Partial order executed`, 'success');
    } catch (err: any) {
      log(`❌ Partial order failed: ${err.message}`, 'error');
      return false;
    }
  }

  pos.remainingAmount -= sellAmount;
  pos.partialsSold++;

  // ✅ Send IPC update to launcher
  if (isLauncherManaged && process.send) {
    process.send({
      type: 'position_closed',
      symbol: pos.symbol,
      side: pos.side,
      exitPrice: price,
      amountSold: sellAmount,
      pnlUsd: leveragedPnL,
      pnlPct: pnlPct,
      remainingAmount: pos.remainingAmount,
      partialsSold: pos.partialsSold,
      reason: reason,
      realizedPnL: leveragedPnL,
    });
  }

  logTrade(action, {
    price,
    amount: sellAmount,
    entryPrice: pos.entryPrice,
    pnl: leveragedPnL.toFixed(2),
    reason,
    strategy: pos.strategy,
    positionId: pos.positionId,
    side: pos.side,
  });

  // ✅ Show what's next
  if (pos.partialsSold === 1) {
    const nextTP = pos.partialTakeProfit2 || pos.takeProfit;
    const distance =
      pos.side === 'LONG'
        ? ((nextTP - price) / price) * 100
        : ((price - nextTP) / price) * 100;

    log(
      `🎯 Next Target: TP2 @ ${formatPrice(nextTP)} (${distance >= 0 ? '+' : ''}${distance.toFixed(2)}% away)`,
      'info'
    );
    log(`🛡️ Stop Loss: ${formatPrice(pos.stopLoss)}`, 'info');
  }

  saveState();
  return true;
}

async function closePosition(
  pos: Position,
  price: number,
  reason: string
): Promise<boolean> {
  if (!marketInfo) return false;

  try {
    const pnlUsd =
      pos.side === 'LONG'
        ? (price - pos.entryPrice) * pos.remainingAmount
        : (pos.entryPrice - price) * pos.remainingAmount;

    if (!pos.leverage) {
      return pos.leverage === 1;
    }

    // Apply leverage to PnL
    const leveragedPnL = pnlUsd * pos.leverage;
    const pnlPct =
      (leveragedPnL / ((pos.entryPrice * pos.remainingAmount) / pos.leverage)) *
      100;

    sessionRealizedPnlUsd += leveragedPnL;
    const isLoss = leveragedPnL < 0;

    const action = pos.side === 'LONG' ? 'SELL' : 'COVER';
    const icon = isLoss ? '🔴' : '🟢';

    log(
      `${icon} ${action} ${formatQuantity(pos.remainingAmount)} @ ${formatPrice(price)}`,
      isLoss ? 'warning' : 'success'
    );
    log(
      `   PnL: ${leveragedPnL >= 0 ? '+' : ''}${leveragedPnL.toFixed(2)} USDT (${pnlPct.toFixed(2)}%) [${pos.leverage}x]`,
      isLoss ? 'warning' : 'success'
    );

    // Execute close order (live trading)
    if (!CONFIG.PAPER_TRADING) {
      try {
        await binance.createOrder(
          marketInfo.symbol,
          'market',
          pos.side === 'LONG' ? 'sell' : 'buy',
          pos.remainingAmount
        );
      } catch (err: any) {
        log(`❌ Close order failed: ${err.message}`, 'error');
      }
    }

    // ✅ Release capital from balance manager
    if (CONFIG.PAPER_TRADING) {
      await futuresBalance.releaseCapital(pos.symbol, leveragedPnL);
    }

    // ✅ Release from coordinator
    if (typeof futuresCoordinator !== 'undefined') {
      await futuresCoordinator.releasePosition(pos.symbol, leveragedPnL);
    }

    logTrade(action, {
      price,
      amount: pos.remainingAmount,
      entryPrice: pos.entryPrice,
      pnl: leveragedPnL.toFixed(2),
      reason,
      holdTime: Date.now() - pos.entryTime.getTime(),
      strategy: pos.strategy,
      positionId: pos.positionId,
      side: pos.side,
    });

    if (isLoss) {
      activateCooldown(reason, true);
    } else {
      activateCooldown(reason, false);
    }

    currentPosition = null;
    saveState();
    return true;
  } catch (err) {
    log(`Partial sell failed: ${err}`, 'error');
    return false;
  }
}

async function placeMarketSell(pos: Position, price: number, reason: string) {
  const baseCurrency = pos.symbol.split('/')[0] as string;
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlUsd = (price - pos.entryPrice) * pos.remainingAmount;

  const isLoss = pnlUsd < 0;

  log(
    `📉 SELL [${pos.strategy}] ${pos.remainingAmount.toFixed(6)} ${baseCurrency} @ ${price.toFixed(2)} | PnL: ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`,
    isLoss ? 'warning' : 'success'
  );

  if (CONFIG.PAPER_TRADING) {
    // ✅ Release capital with PnL
    await futuresBalance.releaseCapital(pos.symbol, pnlUsd);
    log(
      `💰 New total balance: ${futuresBalance.getTotalBalance().toFixed(2)} USDT`,
      'success'
    );
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
        await binance.createMarketSellOrder(pos.symbol, sellAmt);
      } else {
        log(`⚠️ Amount ${sellAmt} below minimum`, 'error');
      }
    } catch (err) {
      log(`Sell failed: ${err}`, 'error');
    }
  }

  logTrade('SELL', {
    symbol: pos.symbol, // Add symbol
    action: 'SELL', // Use 'SELL' as action
    side: pos.side, // Use the position's side (LONG or SHORT)
    strategy: pos.strategy,
    positionId: pos.positionId,
    price: price,
    amount: pos.remainingAmount,
    entryPrice: pos.entryPrice,
    pnl: pnlUsd.toFixed(2),
    pnlPct: (pnlUsd / (pos.entryPrice * pos.remainingAmount)) * 100, // Calculate percentage
    pnlUsd: pnlUsd,
    duration: Date.now() - pos.entryTime.getTime(),
    reason: reason,
    holdTime: Date.now() - pos.entryTime.getTime(),
  });

  // ✅ Release position slot
  await futuresCoordinator.releasePosition(pos.symbol);

  sendPositionClosed();

  if (isLoss) {
    activateCooldown(reason, true);
  } else {
    resetCooldownOnWin();
  }

  currentPosition = null;
  saveState();
}

// ---------- EXIT LOGIC ----------
// Replace your checkAndExecuteExits function with this:

async function checkAndExecuteExits(
  position: Position,
  ind: Indicators
): Promise<boolean> {
  const isLong = position.side === 'LONG';
  const price = ind.currentPrice;

  let exitReason = '';
  let shouldExit = false;
  let partialExitPortion: number | null = null;

  // ✅ 1. Check Stop Loss (always checked)
  if (isLong && price <= position.stopLoss) {
    exitReason = 'Stop Loss';
    shouldExit = true;
  } else if (!isLong && price >= position.stopLoss) {
    exitReason = 'Stop Loss';
    shouldExit = true;
  }

  // ✅ 2. Check Take Profit 1 (50% exit)
  else if (position.partialsSold === 0 && position.partialTakeProfit1) {
    if (
      (isLong && price >= position.partialTakeProfit1) ||
      (!isLong && price <= position.partialTakeProfit1)
    ) {
      exitReason = 'Take Profit 1 (50%)';
      partialExitPortion = 0.5;
      log(`🎯 TP1 Hit: ${formatPrice(position.partialTakeProfit1)}`, 'success');
    }
  }

  // ✅ 3. Check Take Profit 2 (close remaining 50%)
  else if (position.partialsSold === 1 && position.partialTakeProfit2) {
    if (
      (isLong && price >= position.partialTakeProfit2) ||
      (!isLong && price <= position.partialTakeProfit2)
    ) {
      exitReason = 'Take Profit 2 (Final)';
      shouldExit = true;
      log(`🎯 TP2 Hit: ${formatPrice(position.partialTakeProfit2)}`, 'success');
    }
  }

  // ✅ 4. Fallback: Close if price hits main takeProfit (for positions without partials)
  else if (position.partialsSold === 0 && !position.partialTakeProfit1) {
    if (
      (isLong && price >= position.takeProfit) ||
      (!isLong && price <= position.takeProfit)
    ) {
      exitReason = 'Take Profit (Full)';
      shouldExit = true;
    }
  }

  // Execute full exit
  if (shouldExit) {
    await closePosition(position, price, exitReason);
    return true;
  }

  // Execute partial exit
  if (partialExitPortion !== null) {
    const ok = await closePartial(
      position,
      price,
      partialExitPortion,
      exitReason
    );
    if (ok) {
      log(
        `✅ Partial exit complete. Remaining: ${formatQuantity(position.remainingAmount)}`,
        'success'
      );
      log(
        `🎯 Next target: TP2 @ ${formatPrice(position.partialTakeProfit2 || position.takeProfit)}`,
        'info'
      );
    }
    return ok;
  }

  return false;
}

// async function scanAllSymbols(): Promise<ScanResult | null> {
//   const symbol = CONFIG.SYMBOL; // e.g., 'SOL/USDT'

//   console.log(`\n🚶 Scanning ${symbol}...`);

//   try {
//     const data = await getCandles(symbol, CONFIG.TIMEFRAME, CONFIG.CANDLE_LIMIT);
//     if (!data || data.closes.length < 210) {
//       log(`Insufficient data for ${symbol} (${data?.closes.length || 0} candles)`, 'warning');
//       return null;
//     }

//     const { closes, highs, lows, volumes } = data;
//     const ind = calculateIndicators(closes, highs, lows);
//     if (!ind) {
//       log(`Failed to calculate indicators for ${symbol}`, 'warning');
//       return null;
//     }

//     const regime = detectRegime(ind);
//     const htf = await getHTFConfirmation(symbol, CONFIG.TIMEFRAME);
//     const fib = calculateAndLockFibonacci(symbol, lows, highs);

//     const signal = pickEntryStrategy(ind, fib, regime, closes, volumes, htf);

//     if (signal) {
//       log(`✅ ${symbol}: Valid signal (${(signal.confidence * 100).toFixed(0)}%)`, 'success');
//       return {
//         symbol,
//         signal,
//         confidence: signal.confidence,
//         price: ind.currentPrice,
//         indicators: ind
//       };
//     } else {
//       log(`⏭️  ${symbol}: No valid setup`, 'info');
//       return null;
//     }

//   } catch (err: any) {
//     log(`❌ Error scanning ${symbol}: ${err.message}`, 'error');
//     return null;
//   }
// }

let isScanning = false;
let activeScanner: WebSocket | null = null;

async function scanSymbolsViaWebSocket(
  symbols: string[]
): Promise<TokenData[]> {
  // Prevent multiple scans
  if (isScanning) {
    console.log('⚠️  Scan already in progress, skipping...');
    return Promise.reject('Scan already in progress');
  }

  isScanning = true;
  console.log(
    `🧪 DEBUG: Scanning ${symbols.length} tokens via single WebSocket...`
  );

  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://stream.testnet.binance.vision/ws');
    activeScanner = ws;

    const streams = symbols.map((s) => s.toLowerCase() + '@ticker');
    const scanResults = new Map<string, TokenData>();
    let scanCompleted = false;
    let scanTimeout: NodeJS.Timeout | null = null;

    ws.on('open', () => {
      console.log(`📡 Connected - Subscribing to ${streams.length} symbols...`);

      ws.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: [...streams],
          id: 1,
        })
      );

      scanTimeout = setTimeout(() => {
        if (!scanCompleted) {
          scanCompleted = true;
          console.log(
            `\n⏱️  Scan completed: Collected ${scanResults.size}/${symbols.length} symbols`
          );
          cleanup();
          resolve(Array.from(scanResults.values()));
        }
      }, 3000);
    });

    ws.on('message', (msg: string) => {
      try {
        const data: any = JSON.parse(msg);

        // Skip subscription confirmation
        if (data.result === null && data.id === 1) {
          console.log('✅ All symbols subscribed');
          return;
        }

        // Process ticker data
        if (data.e === '24hrTicker') {
          // Only process if we don't already have this symbol
          if (!scanResults.has(data.s)) {
            const tokenData = {
              symbol: data.s,
              price: parseFloat(data.c),
              change: parseFloat(data.P),
              volume: parseFloat(data.v),
              high: parseFloat(data.h),
              low: parseFloat(data.l),
              timestamp: Date.now(),
            };

            const tokenScore: TokenScore = {
              ...tokenData,
              score: calculateTokenScore(tokenData),
            };

            scanResults.set(data.s, tokenScore);

            // Show progress
            if (scanResults.size === 1) {
              console.log('📊 Receiving data...');
            }

            // Complete early if we have all symbols
            if (scanResults.size >= symbols.length && !scanCompleted) {
              scanCompleted = true;
              if (scanTimeout) clearTimeout(scanTimeout);
              console.log(`✅ All ${symbols.length} symbols received!`);
              cleanup();
              resolve(Array.from(scanResults.values()));
            }
          }
        }
      } catch (err) {
        console.error('Parse error:', err);
      }
    });

    ws.on('error', (err: Error) => {
      console.error('❌ WebSocket error:', err.message);
      cleanup();
      reject(err);
    });

    ws.on('close', () => {
      cleanup();
      if (!scanCompleted) {
        console.log(
          `\n📊 Scan partial results: ${scanResults.size}/${symbols.length} symbols`
        );
        resolve(Array.from(scanResults.values()));
      }
    });

    function cleanup() {
      isScanning = false;
      activeScanner = null;
      if (scanTimeout) clearTimeout(scanTimeout);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  });
}

// Function to convert TokenData to trading decisions
function analyzeForTrading(
  tokens: TokenData[],
  minVolume: number = 500000,
  minChange: number = 2
): TokenData[] {
  return tokens
    .filter(
      (token) =>
        token.volume >= minVolume && Math.abs(token.change) >= minChange
    )
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 10); // Top 10 most volatile with good volume
}

// Usage with your bot
async function initializeTradingBot() {
  try {
    // 1. Scan all symbols
    const allTokenData = await scanSymbolsViaWebSocket(symbols);

    // 2. Analyze for trading opportunities
    const tradingCandidates = analyzeForTrading(
      allTokenData,
      LAUNCHER_CONFIG.minVolume24h || 500000,
      2 // min 2% change
    );

    // 3. Log results
    console.log(`\n🎯 Top ${tradingCandidates.length} Trading Candidates:`);
    tradingCandidates.forEach((token, index) => {
      const direction = token.change >= 0 ? '📈  LONG' : '📉  SHORT';
      console.log(
        `${index + 1}. ${token.symbol}: $${token.price.toFixed(2)} | ` +
          `${token.change >= 0 ? '+' : ''}${token.change.toFixed(2)}% | ` +
          `${direction} | Vol: $${(token.volume / 1000000).toFixed(1)}M`
      );
    });

    // 4. Start bots for top candidates
    console.log(`\n🚀 Starting bots for top candidates...`);
    tradingCandidates
      .slice(0, LAUNCHER_CONFIG.maxBotsRunning || 5)
      .forEach((token) => {
        startTradeBot(token);
      });
  } catch (error) {
    console.error('❌ Failed to initialize trading bot:', error);
  }
}

// Function to start a trade bot (you need to implement this)
function startTradeBot(tokenData: TokenData) {
  console.log(`🤖 Starting bot for ${tokenData.symbol}...`);
  // Your trading bot logic here
  // This should use your TradeLog type for logging trades
}

// Mock trade logging function using your TradeLog type
// function logTrade(trade: TradeLog) {
//   console.log(`📝 Trade logged: ${trade.symbol} ${trade.side} | ` +
//               `Entry: $${trade.entryPrice} | P&L: $${trade.pnlUsd.toFixed(2)} (${trade.pnlPct.toFixed(2)}%)`);
// }

// Your scoring function
function calculateTokenScore(token: Omit<TokenScore, 'score'>): number {
  // Your scoring logic here
  const volumeScore = Math.min(token.volume / 1000000, 100); // Max 100
  const momentumScore = Math.abs(token.change) * 10; // Reward volatility
  return volumeScore * 0.7 + momentumScore * 0.3;
}

export function calculateRSI(ohlcv: number[][], period = 14): number {
  if (ohlcv.length < period + 1) return 50; // Not enough data

  const closes = ohlcv.map((c) => c[4]);

  // ✅ ADD VALIDATION FOR CLOSE PRICES
  if (closes.some((close) => close === undefined || close === null)) {
    return 50; // Invalid data
  }

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const current = closes[i];
    const previous = closes[i - 1];

    // ✅ ADD NULL CHECKS
    if (current === undefined || previous === undefined) {
      continue; // Skip invalid pairs
    }

    changes.push(current - previous);
  }

  if (changes.length < period) return 50;

  // Calculate average gains and losses
  let gains = 0;
  let losses = 0;

  // Use the last 'period' changes
  const recentChanges = changes.slice(-period);

  for (const change of recentChanges) {
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return Math.round(rsi * 10) / 10; // Round to 1 decimal
}

// // NEW FUNCTION: Convert scanner data to trading candidates
// // async function scanAllSymbols(): Promise<TradingCandidate[]> {
// //   console.log("🔍 Scanning all symbols for trading opportunities...");

// //   // 1. Get raw market data
// //   const allTokenData = await scanSymbolsViaWebSocket(LAUNCHER_CONFIG.enabledSymbols);
// //   console.log(`📡 Received ${allTokenData.length} tokens`);

// //   // 2. Process each symbol
// //   const tradingCandidates: TradingCandidate[] = [];

// //   for (const token of allTokenData) {
// //     console.log(`   Analyzing ${token.symbol}...`);

// //     const candidate = await createTradingCandidate(token);
// //     if (candidate) {
// //       tradingCandidates.push(candidate);
// //       console.log(`   ✅ ${token.symbol}: ${(candidate.confidence * 100).toFixed(1)}% confidence`);
// //     } else {
// //       console.log(`   ⏭️ ${token.symbol}: No signal`);
// //     }
// //   }

// //   console.log(`📊 Generated ${tradingCandidates.length} trading candidates`);
// //   return tradingCandidates;
// // }

// // async function createTradingCandidate(token: TokenData): Promise<TradingCandidate | null> {
// //   const symbol = token.symbol;

// //   try {
// //     // ✅ Get candles for THIS symbol only
// //     const candleData = await getCandles(symbol, '15m', 100);

// //     // Check if we got valid data
// //     if (!candleData) {
// //       console.log(`   ⚠️ ${symbol}: No candle data returned`);
// //       return null;
// //     }

// //     if (candleData.closes.length < 50) {
// //       console.log(`   ⚠️ ${symbol}: Only ${candleData.closes.length} candles (need 50+)`);
// //       return null;
// //     }

// //     console.log(`   📊 ${symbol}: Got ${candleData.closes.length} candles`);

// //     // Calculate indicators
// //     const rsi = calculateRSI(candleData.closes);
// //     const ema50 = calculateEMA(candleData.closes, 50);
// //     const ema200 = calculateEMA(candleData.closes, 200);

// //     // Generate signal
// //     const signal = generateTradingSignal(symbol, token.price, { rsi, ema50, ema200 });
// //     if (!signal) return null;

// //     // Calculate confidence
// //     const confidence = calculateConfidenceScore(
// //       { rsi, ema50, ema200, volume: token.volume },
// //       signal
// //     );

// //     // Check minimum confidence
// //     if (confidence < (LAUNCHER_CONFIG.minScore / 100)) {
// //       return null;
// //     }

// //     // Return candidate
// //     return {
// //       symbol,
// //       price: token.price,
// //       change: token.change,
// //       volume: token.volume,
// //       confidence,
// //       signal,
// //       indicators: { rsi, ema50, ema200 }
// //     };

// //   } catch (error) {
// //     console.error(`   ❌ ${symbol}: Error - ${error.message}`);
// //     return null;
// //   }
// // }

function safeWriteStream(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  return fs.createWriteStream(filePath, { flags: 'a' });
}

const debugLog = safeWriteStream(
  `./logs/futures/debug/position_debug_${CONFIG.SYMBOL.replace('USDT', '')}.log`
);

function debugPosition(msg: string, data: any) {
  const line = `[${new Date().toISOString()}] ${msg} ${JSON.stringify(data)}\n`;
  debugLog.write(line);
  console.log(line); // Still show on screen too
}

// Send position update to launcher
function sendPositionUpdate(position: any, currentPrice: number) {
  if (!process.send) return;

  const isLong = position.side === 'LONG';
  const pnlUsd = isLong
    ? (currentPrice - position.entryPrice) * position.remainingAmount
    : (position.entryPrice - currentPrice) * position.remainingAmount;
  const pnlPct =
    (pnlUsd / (position.entryPrice * position.remainingAmount)) * 100;

  // ✅ CRITICAL: Send ALL fields the launcher expects
  process.send({
    type: 'position_update',
    position: {
      side: position.side,
      entryPrice: position.entryPrice,
      currentPrice: currentPrice,
      amount: position.remainingAmount,
      quantity: position.remainingAmount,
      remainingAmount: position.remainingAmount,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      pnlPct: pnlPct,
      pnlUsd: pnlUsd,
      entryTime: position.entryTime,
      partialsSold: position.partialsSold || 0,
      strategy: position.strategyId || position.strategy,
      positionId: position.positionId || 'unknown',
    },
  });
}
// Notify launcher when position closes
function sendPositionClosed() {
  if (!isLauncherManaged || !process.send) return;

  try {
    process.send({ type: 'position_closed' });
  } catch (err) {
    // Silently fail
  }
}

// ---------- MAIN BOT LOOP ----------
async function botLoop() {
  if (isRunning) return;
  isRunning = true;

  try {
    console.log('\n' + '═'.repeat(60));
    log('Bot Tick');

    if (checkDrawdownLimit()) {
      log('Trading halted - drawdown limit', 'error');
      return;
    }

    if (isInCooldown() && !currentPosition) {
      return;
    }

    const symbolToFetch = currentPosition?.symbol || CONFIG.SYMBOL;

    const candleMap = await getCandles(
      LAUNCHER_CONFIG.enabledSymbols,
      CONFIG.TIMEFRAME,
      CONFIG.CANDLE_LIMIT
    );

    console.log(`📊 Got candle data for ${candleMap.size} symbols`);

    // 3. Access data for a specific symbol
    const btcCandles = candleMap.get('BTCUSDT');
    if (btcCandles) {
      console.log(`BTC: ${btcCandles.closes.length} candles`);
      console.log(
        `Latest close: $${btcCandles.closes[btcCandles.closes.length - 1]}`
      );
    }

    // 4. Loop through all symbols
    candleMap.forEach(async (candleData, symbol) => {
      const closes = candleData.closes;
      const rsi = calculateRSI(closes);
      console.log(`${symbol}: RSI = ${rsi.toFixed(1)}`);

      const ind = calculateIndicators(
        closes,
        candleData.highs,
        candleData.lows
      );
      if (!ind) {
        log('Invalid indicators - skipping', 'error');
        return;
      }

      const regime = detectRegime(ind);
      log(
        `💰 ${CONFIG.SYMBOL}: ${formatPrice(ind.currentPrice)} | RSI: ${ind.rsi.toFixed(1)} | ${regime.trend}/${regime.volatility}`
      );
      if (currentPosition) {
        const isLong = currentPosition.side === 'LONG';
        const pnlUsd = isLong
          ? (ind.currentPrice - currentPosition.entryPrice) *
            currentPosition.remainingAmount
          : (currentPosition.entryPrice - ind.currentPrice) *
            currentPosition.remainingAmount;

        const leveragedPnL = pnlUsd * (currentPosition.leverage || 5);
        const pnlPct =
          (leveragedPnL /
            ((currentPosition.entryPrice * currentPosition.remainingAmount) /
              (currentPosition.leverage || 5))) *
          100;

        const icon = currentPosition.side === 'LONG' ? '🟢' : '🔴';

        // ✅ Enhanced position status
        log(
          `╔═══════════════════════════════════════════════════════════════`,
          'info'
        );
        log(
          `║ ${icon} POSITION STATUS: ${currentPosition.side} ${currentPosition.leverage}x`,
          'info'
        );
        log(
          `╠═══════════════════════════════════════════════════════════════`,
          'info'
        );
        log(
          `║  Entry: ${formatPrice(currentPosition.entryPrice)} → Current: ${formatPrice(ind.currentPrice)}`,
          'info'
        );
        log(
          `║  Amount: ${formatQuantity(currentPosition.remainingAmount)} / ${formatQuantity(currentPosition.amount)}`,
          'info'
        );
        log(`║  Partials Sold: ${currentPosition.partialsSold}/2`, 'info');
        log(
          `╠═══════════════════════════════════════════════════════════════`,
          'info'
        );

        // Unrealized PnL
        log(
          `║ Unrealized PnL: ${leveragedPnL >= 0 ? '+' : ''}${leveragedPnL.toFixed(2)} USDT (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
          leveragedPnL >= 0 ? 'success' : 'error'
        );

        // Show realized PnL if any partials sold
        if (sessionRealizedPnlUsd !== 0) {
          log(
            `║ Realized PnL: ${sessionRealizedPnlUsd >= 0 ? '+' : ''}${sessionRealizedPnlUsd.toFixed(2)} USDT (Session)`,
            sessionRealizedPnlUsd >= 0 ? 'success' : 'error'
          );
        }

        log(
          `╠═══════════════════════════════════════════════════════════════`,
          'info'
        );

        // Show targets
        const slDistance = isLong
          ? ((ind.currentPrice - currentPosition.stopLoss) / ind.currentPrice) *
            100
          : ((currentPosition.stopLoss - ind.currentPrice) / ind.currentPrice) *
            100;

        log(
          `║  🛡️ Stop Loss: ${formatPrice(currentPosition.stopLoss)} (${slDistance >= 0 ? '+' : ''}${slDistance.toFixed(2)}% away)`,
          slDistance > 0 ? 'info' : 'warning'
        );

        // Show relevant TP based on partials sold
        if (currentPosition.partialsSold === 0) {
          const tp1Distance = isLong
            ? ((currentPosition.partialTakeProfit1! - ind.currentPrice) /
                ind.currentPrice) *
              100
            : ((ind.currentPrice - currentPosition.partialTakeProfit1!) /
                ind.currentPrice) *
              100;

          log(
            `║  🎯 TP1 (50%): ${formatPrice(currentPosition.partialTakeProfit1!)} (${tp1Distance >= 0 ? '+' : ''}${tp1Distance.toFixed(2)}% away)`,
            'info'
          );
        } else if (currentPosition.partialsSold === 1) {
          const tp2Distance = isLong
            ? ((currentPosition.partialTakeProfit2! - ind.currentPrice) /
                ind.currentPrice) *
              100
            : ((ind.currentPrice - currentPosition.partialTakeProfit2!) /
                ind.currentPrice) *
              100;

          log(
            `║  🎯 TP2 (Final): ${formatPrice(currentPosition.partialTakeProfit2!)} (${tp2Distance >= 0 ? '+' : ''}${tp2Distance.toFixed(2)}% away)`,
            'info'
          );
        }

        log(
          `╚═══════════════════════════════════════════════════════════════`,
          'info'
        );

        // Trailing stop info
        if (
          currentPosition.partialsSold > 0 &&
          Math.abs(pnlPct) > 1.5 &&
          pnlUsd > 0
        ) {
          const newSl = isLong
            ? ind.currentPrice - ind.atr * 0.8
            : ind.currentPrice + ind.atr * 0.8;
          const shouldUpdate = isLong
            ? newSl > currentPosition.stopLoss
            : newSl < currentPosition.stopLoss;

          if (shouldUpdate) {
            log(
              `📈 Trailing Stop: ${formatPrice(currentPosition.stopLoss)} → ${formatPrice(newSl)}`,
              'success'
            );
            currentPosition.stopLoss = newSl;
            currentPosition.trailingActive = true;
            saveState();
          }
        }

        // Check exits
        const exited = await checkAndExecuteExits(currentPosition, ind);
        if (!exited) {
          log('⏳ Holding position...', 'success');
          sendPositionUpdate(currentPosition, ind.currentPrice);
        }
        return;
      }
    });

    //       if (!data || data.closes.length < 210) {
    //   log(`Insufficient data for ${symbolToFetch} (${data?.closes.length || 0} candles)`, 'warning');
    //   return null;
    // }

    // const { closes, highs, lows, volumes } = data;

    debugPosition('data', futuresCoordinator.getAllPositions());

    // const ind = calculateIndicators(closes, highs, lows);
    //    if (!ind) {
    //     log('Invalid indicators - skipping', 'error');
    //     return;
    //   }

    const htf = await getHTFConfirmation(
      LAUNCHER_CONFIG.enabledSymbols,
      CONFIG.TIMEFRAME
    );

    // Add this to your botLoop() where you check positions (around line ~1869)

    if (isInCooldown()) return;

    if (tradesThisSession >= SESSION_CONFIG.MAX_TRADES_PER_SESSION) {
      log('Max trades reached', 'warning');
      return;
    }

    // ✅ No position - look for entry
    if (isInCooldown()) return;

    if (tradesThisSession >= SESSION_CONFIG.MAX_TRADES_PER_SESSION) {
      log('Max trades reached', 'warning');
      return;
    }

    const balance = await getUsdtBalance();
    if (sessionStartBalance === 0) sessionStartBalance = balance;

    const minNotional = marketInfo?.minNotional || 5;
    const minBalanceNeeded = minNotional * 1.1; // Add 10% buffer for fees/slippage

    if (balance < minBalanceNeeded) {
      log(
        `❌ Balance too low: ${balance.toFixed(2)} USDT (need at least ${minBalanceNeeded.toFixed(2)} USDT)`,
        'warning'
      );
      return;
    }

    const riskAmount = balance * CONFIG.RISK_PER_TRADE;
    if (riskAmount < 0.5) {
      log(
        `❌ Risk amount too small: ${riskAmount.toFixed(2)} USDT (need at least 0.50 USDT)`,
        'warning'
      );
      return;
    }

    // Check if coordinator allows new position (if using coordinator)
    if (typeof futuresCoordinator !== 'undefined') {
      const canEnter = futuresCoordinator.canEnterPosition(
        CONFIG.SYMBOL,
        DEFAULT_LEVERAGE || 5
      );

      if (!canEnter) {
        log('⏸️ Cannot enter - coordinator limits reached', 'warning');
        return;
      }
    }

    // await openPosition(balance, ind.currentPrice, signal.stopLoss, signal.takeProfit, signal.strategyId, signal.side, signal.reason);

    // const candidate = await scanAllSymbols(LAUNCHER_CONFIG.enabledSymbols);

    // if (!candidate || !candidate.signal) {
    //   log('⏭️ Waiting for better entry conditions', 'info');
    //   return;
    // }

    // ✅ ADD THIS: Request position slot BEFORE entering trade
    // if (!futuresCoordinator.requestPosition(CONFIG.SYMBOL, candidate.signal.side, DEFAULT_LEVERAGE, candidate.price)) {
    //   log(`🚫 Position slot denied - limit reached`, 'warning');
    //   return;
    // }

    // Open position with the signal
    // log(`🎯 Entry signal found: ${candidate.signal.strategy} ${candidate.signal.side}`, 'success');
    // await openPosition(
    //   balance,
    //   candidate.price,
    //   candidate.signal.stopLoss,
    //   candidate.signal.takeProfit,
    //   candidate.signal.strategyId,
    //   candidate.signal.reason,
    //   candidate.signal.side,
    // );
  } catch (err: any) {
    log(`Error: ${err.message}`, 'error');
  } finally {
    isRunning = false;
  }
}

// ---------- MAIN ----------

async function main() {
  initializeTradeLog();

  try {
    marketInfo = await fetchMarketInfo(CONFIG.SYMBOL);
    log(`Market info loaded: ${CONFIG.SYMBOL}`, 'success');
  } catch (err) {
    log(`Failed to init market info`, 'error');
    process.exit(1);
  }

  loadState();

  //   if (typeof futuresCoordinator !== 'undefined') {
  //   const botRegistered = await futuresCoordinator.registerBot(CONFIG.SYMBOL);

  //   if (!botRegistered) {
  //     log(`❌ Bot registration denied - max bots reached`, 'error');
  //     if (isLauncherManaged) {
  //       sendToLauncher('error', { error: 'Max bots limit reached' });
  //     }
  //     process.exit(1);
  //   }

  //   log(`✅ Bot registered: ${CONFIG.SYMBOL}`, 'success');
  // }

  // ✅ CHECK 1: Verify symbol matches
  if (currentPosition) {
    log(`🔄 Restoring position: ${currentPosition.symbol}`, 'info');

    const positionValue = (currentPosition.remainingAmount *
      currentPosition.entryPrice) as number;
    const positionSize =
      currentPosition.remainingAmount || (currentPosition.amount as number);
    const leverage = currentPosition.leverage || CONFIG.LEVERAGE || 5;

    // ✅ CHECK 2: Only register if NOT already registered
    const existingCoordPosition = futuresCoordinator.getPosition(CONFIG.SYMBOL);

    if (existingCoordPosition) {
      log(`ℹ️ Position already registered in coordinator`, 'info');
      log(
        `   Existing: ${existingCoordPosition.side} ${existingCoordPosition.leverage}x`,
        'info'
      );
    } else {
      // Register with coordinator
      try {
        await futuresCoordinator.forceRegister(
          CONFIG.SYMBOL,
          currentPosition.side,
          leverage,
          currentPosition.entryPrice,
          currentPosition.remainingAmount
        );
        log(`✅ Registered with coordinator: ${CONFIG.SYMBOL}`, 'success');
      } catch (err) {
        log(`⚠️ Coordinator registration failed: ${err}`, 'warning');
      }
    }

    // ✅ CHECK 3: Only allocate capital if NOT already allocated
    const existingAllocation = futuresBalance.getAllocation(CONFIG.SYMBOL);

    if (existingAllocation) {
      log(
        `ℹ️ Capital already allocated: ${existingAllocation.marginUsed.toFixed(2)} USDT`,
        'info'
      );
    } else {
      // Allocate capital
      const marginUsed = positionValue / leverage;

      try {
        await futuresBalance.forceAllocate(
          CONFIG.SYMBOL,
          marginUsed,
          positionValue,
          leverage
        );
        log(
          `✅ Capital allocated: ${marginUsed.toFixed(2)} USDT margin`,
          'success'
        );
      } catch (err) {
        log(`⚠️ Capital allocation failed: ${err}`, 'warning');
      }
    }

    // ✅ Fetch live price and update
    let livePrice: number = 0;

    try {
      // Try to get live price
      if (latestTicker && latestTicker.last) {
        livePrice = latestTicker.last;
        log(`📊 Using latest ticker price: $${livePrice}`, 'info');
      } else {
        throw new Error('No ticker data available');
      }
    } catch (err) {
      // Fallback to candles
      log(`⚠️ Ticker fetch failed - using candles`, 'warning');

      try {
        // Get candles for THIS specific symbol only
        const candleMap = await getCandles(
          [currentPosition.symbol],
          CONFIG.TIMEFRAME,
          CONFIG.CANDLE_LIMIT
        );
        const currentSymbolCandle = candleMap.get(currentPosition.symbol);

        if (currentSymbolCandle && currentSymbolCandle.closes.length > 0) {
          livePrice =
            currentSymbolCandle.closes[currentSymbolCandle.closes.length - 1];
          log(`📊 Using candle price: $${livePrice}`, 'info');
        } else {
          throw new Error('No candle data available');
        }
      } catch (candleErr) {
        log(`❌ Cannot get valid price for ${currentPosition.symbol}`, 'error');
        return; // Exit if we can't get price
      }
    }

    // Now we have livePrice, update the position
    if (!livePrice || livePrice <= 0) {
      log('❌ Invalid price - will retry in next cycle', 'error');
      return;
    }

    // Calculate P&L
    const pnl =
      currentPosition.side === 'LONG'
        ? (livePrice - currentPosition.entryPrice) *
          currentPosition.remainingAmount
        : (currentPosition.entryPrice - livePrice) *
          currentPosition.remainingAmount;

    const leveragedPnL = pnl * leverage;

    // Update coordinator
    try {
      await futuresCoordinator.updatePosition(
        CONFIG.SYMBOL,
        leveragedPnL,
        currentPosition.liquidationPrice
      );

      log(
        `📊 Position updated: PnL ${leveragedPnL >= 0 ? '+' : ''}${leveragedPnL.toFixed(2)} USDT`,
        'info'
      );

      // Send to launcher if managed
      if (isLauncherManaged) {
        sendPositionUpdate(currentPosition, livePrice);
      }
    } catch (updateErr) {
      log(`⚠️ Position update failed: ${updateErr}`, 'warning');
    }
  }
  // ... rest of your startup code ...

  console.log('');
  log('╔══════════════════════════════════════════════╗', 'info');
  log('║   🚀 AGGRESSIVE BOT v4.1 (LONG + SHORT)     ║', 'success');
  log('╠══════════════════════════════════════════════╣', 'info');
  log(
    `║  ${CONFIG.PAPER_TRADING ? '📝 PAPER' : '💰 LIVE'} | ${CONFIG.SYMBOL} | ${CONFIG.TIMEFRAME}/${CONFIG.HTF_TIMEFRAME}       ║`,
    'info'
  );
  log('╠══════════════════════════════════════════════╣', 'warning');
  log('║  ⚡ AGGRESSIVE FEATURES:                     ║', 'warning');
  log(
    `║  • HTF: ${CONFIG.REQUIRE_HTF_ALIGNMENT ? 'STRICT' : 'FLEXIBLE'}                              ║`,
    'info'
  );
  log(
    `║  • Counter-Trend: ${CONFIG.ENABLE_COUNTER_TREND_SCALPING ? 'ENABLED' : 'DISABLED'}                      ║`,
    'info'
  );
  log(
    `║  • High Vol: ${CONFIG.ALLOW_HIGH_VOLATILITY ? 'ALLOWED' : 'BLOCKED'}                          ║`,
    'info'
  );
  log(
    `║  • Min Conf: ${(CONFIG.MIN_CONFIDENCE_LONG * 100).toFixed(0)}% (was 80%+)                 ║`,
    'info'
  );
  log(
    `║  • Risk: ${(CONFIG.RISK_PER_TRADE * 100).toFixed(1)}% | Cooldown: ${CONFIG.COOLDOWN_AFTER_LOSS_MS / 60000}m          ║`,
    'info'
  );
  log('╠══════════════════════════════════════════════╣', 'info');
  log(
    `║  Precision: ${marketInfo.pricePrecision}dp price | ${marketInfo.quantityPrecision}dp qty         ║`,
    'info'
  );
  log(
    `║  Min Notional: ${marketInfo.minNotional.toFixed(1)} ${marketInfo.quoteAsset}                   ║`,
    'info'
  );
  log(
    `║  Max DD: ${(SESSION_CONFIG.MAX_DRAWDOWN_PCT * 100).toFixed(0)}% | Max Trades: ${SESSION_CONFIG.MAX_TRADES_PER_SESSION}            ║`,
    'info'
  );
  log('╠══════════════════════════════════════════════╣', 'warning');
  log('║  ⚠️  More signals = More risk! Monitor closely ║', 'warning');
  log('╚══════════════════════════════════════════════╝', 'info');
  console.log('');

  // Verify symbol
  try {
    // const ticker = await binance.fetchTicker(CONFIG.SYMBOL);
    log(
      `   ✅ Symbol verified: ${CONFIG.SYMBOL} @ ${latestTicker.last?.toFixed(4)}`,
      'success'
    );
  } catch (err) {
    log(`   ❌ INVALID SYMBOL: ${CONFIG.SYMBOL}`, 'error');
    console.log(err);
    if (isLauncherManaged) {
      sendToLauncher('error', { error: `Invalid symbol: ${CONFIG.SYMBOL}` });
    }
    process.exit(1);
  }

  log('═'.repeat(50), 'info');

  // Setup IPC if launcher-managed
  if (isLauncherManaged) {
    setupIPCHandlersWS();
    log('IPC handlers registered', 'success');
  }

  sessionStartBalance = await getUsdtBalance();

  if (tradesThisSession > 0) {
    const pnlPct =
      sessionStartBalance > 0
        ? (sessionRealizedPnlUsd / sessionStartBalance) * 100
        : 0;
    const pnlIcon = sessionRealizedPnlUsd >= 0 ? '🟢' : '🔴';
    log('📊 SESSION STATS:', 'info');
    log(
      `   ${pnlIcon} PnL: ${sessionRealizedPnlUsd >= 0 ? '+' : ''}${sessionRealizedPnlUsd.toFixed(2)} ${marketInfo.quoteAsset} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
      pnlPct >= 0 ? 'success' : 'error'
    );
    log(
      `   📈 Trades: ${tradesThisSession} / ${SESSION_CONFIG.MAX_TRADES_PER_SESSION}`,
      'info'
    );
    log(
      `   💰 Balance: ${paperBalance.toFixed(2)} ${marketInfo.quoteAsset}`,
      'info'
    );
    console.log('');
  }

  await botLoop();
  setInterval(botLoop, CONFIG.LOOP_INTERVAL_MS);
}

process.on('SIGINT', async () => {
  log('Shutting down...', 'warning');
  saveState();

  //   // ✅ Unregister bot
  //   // if (typeof futuresCoordinator !== 'undefined') {
  //   //   await futuresCoordinator.unregisterBot(CONFIG.SYMBOL);
  //   //   log(`🔓 Bot unregistered: ${CONFIG.SYMBOL}`, 'info');
  //   // }

  if (currentPosition && marketInfo) {
    log(
      `⚠️ Open ${currentPosition.side}: ${formatQuantity(currentPosition.remainingAmount)} @ ${formatPrice(currentPosition.entryPrice)}`,
      'error'
    );
  }
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  log(`Uncaught: ${err.message}`, 'error');
  saveState();

  // ✅ Unregister bot
  // if (typeof futuresCoordinator !== 'undefined') {
  //   await futuresCoordinator.unregisterBot(CONFIG.SYMBOL);
  // }

  process.exit(1);
});

main().catch((err) => {
  log(`Fatal: ${err}`, 'error');
  process.exit(1);
});
function getFutureConfigForSymbol(arg0: string) {
  throw new Error('Function not implemented.');
}

// /// import * as dotenv from 'dotenv';
// // dotenv.config();
// // import { RSI, EMA, ATR } from 'technicalindicators';
// // import fs from 'fs';
// // import WebSocket from "ws";
// // import crypto from 'crypto';
// // import path from 'path';
// // import { fileURLToPath } from 'url';
// // import { dirname } from 'path';
// // import {
// //   calculateLiquidationPrice,
// //   checkLiquidationRisk,
// //   getMaintenanceMarginTier
// // } from './liquidation-calculator.js';
// // import { futuresCoordinator } from './future-position-coordinator.js';
// // import { getFuturesConfigForSymbol, type Timeframe } from './future-config.js';
// // import { futuresBalance } from './future-shared-balance.js';
// // import type { StrategyId } from './enh-bot.js';

// // // ES Module __dirname equivalent
// // const __filename = fileURLToPath(import.meta.url);
// // const __dirname = dirname(__filename);

// // const isLauncherManaged = !!process.send;
// // const CONFIG = getFuturesConfigForSymbol(process.env.TRADING_SYMBOL_FUTURES || '');
//  export const LEVERAGE = parseInt(process.env.LEVERAGE || '5');

// // // ---------- SYMBOL CONFIGURATION ----------
// // const TRADING_SYMBOL = process.env.TRADING_SYMBOL_FUTURES || '';
// // let TRADING_SYMBOL_FUTURES = process.env.ENABLED_FUTURE_SYMBOLS || TRADING_SYMBOL.replace(',', '');
// // const POSITION_TYPE = (process.env.POSITION_TYPE as 'LONG' | 'SHORT' | 'BOTH') || 'LONG';

// // console.log(`🎯 Bot Configuration:`);
// // console.log(`   Trading Symbol: ${TRADING_SYMBOL}`);
// // console.log(`   Futures Symbol: ${TRADING_SYMBOL_FUTURES}`);
// // console.log(`   Position Type: ${POSITION_TYPE}`);

// // // Handle corrupted futures symbol
// // if (TRADING_SYMBOL_FUTURES.includes(',')) {
// //   const allSymbols = TRADING_SYMBOL_FUTURES.split(',');
// //   const baseSymbol = TRADING_SYMBOL.split('/')[0] as string;
// //   const correctSymbol = allSymbols.find(s => s.includes(baseSymbol) && s.includes('USDT'));

// //   if (correctSymbol) {
// //     TRADING_SYMBOL_FUTURES = correctSymbol.replace('/', '');
// //   } else {
// //     TRADING_SYMBOL_FUTURES = TRADING_SYMBOL.replace('/', '');
// //   }
// // }

// // if (!TRADING_SYMBOL_FUTURES || TRADING_SYMBOL_FUTURES.length > 20) {
// //   TRADING_SYMBOL_FUTURES = TRADING_SYMBOL.replace('/', '');
// // }

// // console.log(`🎯 Final Symbol: ${TRADING_SYMBOL_FUTURES}`);

// // // ---------- TYPES ----------
// // type EntryType = 'LONG' | 'SHORT';

// // export type EntrySignal = {
// //   strategy: StrategyId;
// //   side: EntryType;
// //   reason: string;
// //   confidence: number;
// //   stopLoss: number;
// //   takeProfit: number;
// // } | null;

// // export type TradeLog = {
// //   timestamp: Date;
// //   symbol: string;
// //   action: 'BUY' | 'SELL' | 'SHORT' | 'LONG' | 'COVER' | 'PARTIAL_SELL' | 'PARTIAL_COVER';
// //   side: EntryType;
// //   strategy: string;
// //   positionId: string;
// //   price: number;
// //   amount: number;
// //   entryPrice?: number;
// //   exitPrice?: number;
// //   quantity: number;
// //   pnl?: string;
// //   pnlPct: number;
// //   pnlUsd: number;
// //   duration: number;
// //   reason?: string;
// //   holdTime?: number;
// //   stopLoss?: number;
// //   takeProfit?: number;
// // };

// // export type Indicators = {
// //   rsi: number;
// //   ema50: number;
// //   ema200: number;
// //   currentPrice: number;
// //   atr: number;
// //   stopLossPrice: number;
// //   takeProfitPrice: number;
// // };

// // type Position = {
// //   positionId: string;
// //   symbol: string;
// //   side: EntryType;
// //   entryPrice: number;
// //   amount: number;
// //   remainingAmount: number;
// //   stopLoss: number;
// //   takeProfit: number;
// //   entryTime: Date;
// //   trailingActive?: boolean;
// //   strategy: StrategyId;
// //   signalReason?: string;
// //   partialTakeProfit1?: number;
// //   partialTakeProfit2?: number;
// //   partialsSold: number;
// //   leverage: number;
// //   liquidationPrice?: number;
// //   positionValue: number;
// //   marginUsed: number;
// // };

// // interface MarketInfo {
// //   pricePrecision: number;
// //   quantityPrecision: number;
// //   minNotional: number;
// //   quoteAsset: string;
// // }

// // type CandleData = {
// //   closes: number[];
// //   highs: number[];
// //   lows: number[];
// //   volumes: number[];
// //   timestamps: number[];
// // };

// // // ---------- WEBSOCKET MANAGER ----------
// // class BinanceFuturesWebSocket {
// //   private ws: WebSocket | null = null;
// //   private wsUrl: string;
// //   private reconnectAttempts = 0;
// //   private maxReconnectAttempts = 5;
// //   private reconnectDelay = 5000;
// //   private isConnecting = false;
// //   private subscribedStreams: Set<string> = new Set();
// //   private messageHandlers: Map<string, Function[]> = new Map();
// //   private pingInterval: NodeJS.Timeout | null = null;
// //   private klineBuffer: Map<string, CandleData> = new Map();

// //   constructor(symbol: string, isTestnet: boolean = false) {
// //     const baseUrl = isTestnet
// //       ? 'wss://stream.testnet.binance.vision'
// //       : 'wss://fstream.binance.com';

// //     const streams = [
// //       `${symbol.toLowerCase()}@ticker`,
// //       `${symbol.toLowerCase()}@kline_${CONFIG.TIMEFRAME}`,
// //       `${symbol.toLowerCase()}@aggTrade`
// //     ];

// //     this.wsUrl = `${baseUrl}/stream?streams=${streams.join('/')}`;
// //   }

// //   async connect(): Promise<boolean> {
// //     if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
// //       return true;
// //     }

// //     this.isConnecting = true;

// //     return new Promise((resolve, reject) => {
// //       try {
// //         this.ws = new WebSocket(this.wsUrl);

// //         this.ws.on('open', () => {
// //           log('✅ WebSocket connected', 'success');
// //           this.isConnecting = false;
// //           this.reconnectAttempts = 0;
// //           this.startPing();
// //           resolve(true);
// //         });

// //         this.ws.on('message', (data: Buffer) => {
// //           try {
// //             const message = JSON.parse(data.toString());
// //             this.handleMessage(message);
// //           } catch (err: any) {
// //             log(`WS Parse error: ${err.message}`, 'error');
// //           }
// //         });

// //         this.ws.on('error', (error) => {
// //           log(`WS Error: ${error.message}`, 'error');
// //           this.isConnecting = false;
// //         });

// //         this.ws.on('close', () => {
// //           log('WebSocket closed', 'warning');
// //           this.isConnecting = false;
// //           this.stopPing();
// //           this.handleReconnect();
// //         });

// //         this.ws.on('ping', () => {
// //           if (this.ws) this.ws.pong();
// //         });

// //       } catch (error: any) {
// //         log(`Failed to create WebSocket: ${error.message}`, 'error');
// //         this.isConnecting = false;
// //         reject(false);
// //       }
// //     });
// //   }

// //   private startPing() {
// //     this.pingInterval = setInterval(() => {
// //       if (this.ws && this.ws.readyState === WebSocket.OPEN) {
// //         this.ws.ping();
// //       }
// //     }, 30000);
// //   }

// //   private stopPing() {
// //     if (this.pingInterval) {
// //       clearInterval(this.pingInterval);
// //       this.pingInterval = null;
// //     }
// //   }

// //   private handleReconnect() {
// //     if (this.reconnectAttempts >= this.maxReconnectAttempts) {
// //       log('Max reconnection attempts reached', 'error');
// //       return;
// //     }

// //     this.reconnectAttempts++;
// //     const delay = this.reconnectDelay * this.reconnectAttempts;

// //     log(`Reconnecting in ${delay / 1000}s`, 'warning');

// //     setTimeout(() => {
// //       this.connect();
// //     }, delay);
// //   }

// //   private handleMessage(message: any) {
// //     if (!message.data) return;

// //     const data = message.data;
// //     const stream = message.stream;

// //     // Handle different stream types
// //     if (stream.includes('@ticker')) {
// //       this.handleTicker(data);
// //     } else if (stream.includes('@kline')) {
// //       this.handleKline(data);
// //     } else if (stream.includes('@aggTrade')) {
// //       this.handleTrade(data);
// //     }
// //   }

// //   private handleTicker(data: any) {
// //     const handlers = this.messageHandlers.get('ticker');
// //     if (handlers) {
// //       const tickerData = {
// //         symbol: data.s,
// //         price: parseFloat(data.c),
// //         priceChange: parseFloat(data.p),
// //         priceChangePercent: parseFloat(data.P),
// //         high: parseFloat(data.h),
// //         low: parseFloat(data.l),
// //         volume: parseFloat(data.v),
// //         quoteVolume: parseFloat(data.q),
// //         timestamp: data.E
// //       };
// //       handlers.forEach(handler => handler(tickerData));
// //     }
// //   }

// //   private handleKline(data: any) {
// //     const kline = data.k;
// //     const symbol = kline.s;

// //     // Initialize buffer if needed
// //     if (!this.klineBuffer.has(symbol)) {
// //       this.klineBuffer.set(symbol, {
// //         closes: [],
// //         highs: [],
// //         lows: [],
// //         volumes: [],
// //         timestamps: []
// //       });
// //     }

// //     const buffer = this.klineBuffer.get(symbol)!;

// //     // Only process closed candles
// //     if (kline.x) {
// //       buffer.closes.push(parseFloat(kline.c));
// //       buffer.highs.push(parseFloat(kline.h));
// //       buffer.lows.push(parseFloat(kline.l));
// //       buffer.volumes.push(parseFloat(kline.v));
// //       buffer.timestamps.push(kline.t);

// //       // Keep only last 500 candles
// //       if (buffer.closes.length > 500) {
// //         buffer.closes.shift();
// //         buffer.highs.shift();
// //         buffer.lows.shift();
// //         buffer.volumes.shift();
// //         buffer.timestamps.shift();
// //       }

// //       // Notify handlers
// //       const handlers = this.messageHandlers.get('kline');
// //       if (handlers) {
// //         const klineData = {
// //           symbol: kline.s,
// //           interval: kline.i,
// //           open: parseFloat(kline.o),
// //           high: parseFloat(kline.h),
// //           low: parseFloat(kline.l),
// //           close: parseFloat(kline.c),
// //           volume: parseFloat(kline.v),
// //           closeTime: kline.T,
// //           isClosed: kline.x
// //         };
// //         handlers.forEach(handler => handler(klineData));
// //       }
// //     }
// //   }

// //   private handleTrade(data: any) {
// //     const handlers = this.messageHandlers.get('trade');
// //     if (handlers) {
// //       const tradeData = {
// //         symbol: data.s,
// //         price: parseFloat(data.p),
// //         quantity: parseFloat(data.q),
// //         timestamp: data.T,
// //         isBuyerMaker: data.m
// //       };
// //       handlers.forEach(handler => handler(tradeData));
// //     }
// //   }

// //   on(event: string, callback: (data: any) => void) {
// //     if (!this.messageHandlers.has(event)) {
// //       this.messageHandlers.set(event, []);
// //     }
// //     this.messageHandlers.get(event)!.push(callback);
// //   }

// //   getCandles(symbol: string): CandleData | null {
// //     return this.klineBuffer.get(symbol) || null;
// //   }

// //   close() {
// //     this.stopPing();
// //     if (this.ws) {
// //       this.ws.close();
// //       this.ws = null;
// //     }
// //     this.subscribedStreams.clear();
// //     this.messageHandlers.clear();
// //     this.klineBuffer.clear();
// //   }

// //   isConnected(): boolean {
// //     return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
// //   }
// // }

// // // ---------- STATE ----------
// // let currentPosition: Position | null = null;
// // let marketInfo: MarketInfo;
// // let sessionStartBalance: number = 0;
// // let paperBalance: number = parseFloat(process.env.PAPER_BALANCE || '10000');
// // let sessionRealizedPnlUsd = 0;
// // let tradesThisSession = 0;
// // let isRunning = false;
// // let lastSignalTime = 0;
// // let wsManager: BinanceFuturesWebSocket;
// // let latestPrice: number = 0;
// // let latestIndicators: Indicators | null = null;

// // const SESSION_CONFIG = {
// //   MAX_DRAWDOWN_PCT: 0.15,
// //   MAX_TRADES_PER_SESSION: 50
// // };

// // // ---------- LOGGING ----------
// // const colors = {
// //   reset: '\x1b[0m',
// //   red: '\x1b[31m',
// //   green: '\x1b[32m',
// //   yellow: '\x1b[33m',
// //   cyan: '\x1b[36m',
// //   brightGreen: '\x1b[1m\x1b[32m',
// //   brightRed: '\x1b[1m\x1b[31m',
// // };

// // function log(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info') {
// //   const timestamp = new Date().toISOString();
// //   let color = colors.cyan;

// //   switch (level) {
// //     case 'success': color = colors.brightGreen; break;
// //     case 'warning': color = colors.yellow; break;
// //     case 'error': color = colors.brightRed; break;
// //   }

// //   const logMessage = `[${timestamp}] ${message}`;
// //   console.log(`${color}${logMessage}${colors.reset}`);
// // }

// // // ---------- UTILITIES ----------
// // export function formatPrice(price: number): string {
// //   return price.toFixed(marketInfo.pricePrecision);
// // }

// // export function formatQuantity(qty: number): string {
// //   return qty.toFixed(marketInfo.quantityPrecision);
// // }

export function generatePositionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// // // ---------- MARKET INFO ----------
// // async function fetchMarketInfo(symbol: string): Promise<MarketInfo> {
// //   // Mock market info - in production, fetch from exchange
// //   return {
// //     pricePrecision: 2,
// //     quantityPrecision: 6,
// //     minNotional: 5,
// //     quoteAsset: 'USDT'
// //   };
// // }

// // async function getUsdtBalance(): Promise<number> {
// //   if (CONFIG.PAPER_TRADING) {
// //     return paperBalance;
// //   }
// //   // In production, fetch from exchange
// //   return paperBalance;
// // }

// // // ---------- INDICATORS ----------
// // function calculateIndicators(candles: CandleData): Indicators | null {
// //   if (candles.closes.length < 200) {
// //     return null;
// //   }

// //   const closes = candles.closes;
// //   const highs = candles.highs;
// //   const lows = candles.lows;

// //   // RSI
// //   const rsiInput = { values: closes.slice(-50), period: 14 };
// //   const rsiValues = RSI.calculate(rsiInput);
// //   const rsi = (rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50) || 0;

// //   // EMAs
// //   const ema50Input = { values: closes.slice(-100), period: 50 };
// //   const ema50Values = EMA.calculate(ema50Input);
// //   const ema50 = (ema50Values.length > 0 ? ema50Values[ema50Values.length - 1] : closes[closes.length - 1]) || 0;

// //   const ema200Input = { values: closes, period: 200 };
// //   const ema200Values = EMA.calculate(ema200Input);
// //   const ema200 = (ema200Values.length > 0 ? ema200Values[ema200Values.length - 1] : closes[closes.length - 1])|| 0;

// //   // ATR
// //   const atrInput = {
// //     high: highs.slice(-14),
// //     low: lows.slice(-14),
// //     close: closes.slice(-14),
// //     period: 14
// //   };
// //   const atrValues = ATR.calculate(atrInput);
// //   const atr =( atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0) || 0;

// //   const currentPrice = closes[closes.length - 1] || 0;

// //   return {
// //     rsi,
// //     ema50,
// //     ema200,
// //     currentPrice,
// //     atr,
// //     stopLossPrice: currentPrice - (atr * 1.5),
// //     takeProfitPrice: currentPrice + (atr * 3)
// //   };
// // }

// // // ---------- SIGNAL DETECTION ----------
// // function detectEntrySignal(indicators: Indicators): EntrySignal {
// //   const { rsi, ema50, ema200, currentPrice, atr } = indicators;

// //   // LONG conditions
// //   if (rsi < 30 && currentPrice > ema50 && ema50 > ema200) {
// //     return {
// //       strategy: 'RSI_EMA',
// //       side: 'LONG',
// //       reason: 'RSI oversold + bullish EMAs',
// //       confidence: 0.8,
// //       stopLoss: currentPrice - (atr * 1.5),
// //       takeProfit: currentPrice + (atr * 3)
// //     };
// //   }

// //   // SHORT conditions
// //   if (rsi > 70 && currentPrice < ema50 && ema50 < ema200) {
// //     return {
// //       strategy: 'RSI_EMA',
// //       side: 'SHORT',
// //       reason: 'RSI overbought + bearish EMAs',
// //       confidence: 0.8,
// //       stopLoss: currentPrice + (atr * 1.5),
// //       takeProfit: currentPrice - (atr * 3)
// //     };
// //   }

// //   return null;
// // }

// // // ---------- POSITION MANAGEMENT ----------
// // export async function openPosition(signal: EntrySignal, price: number) {
// //   if (currentPosition) {
// //     log('Already in position', 'warning');
// //     return;
// //   }

// //   if(!signal) {
// //     log('No valid signal to open position', 'warning');
// //     return;
// //   }

// //   const balance = await getUsdtBalance();
// //   const riskAmount = balance * CONFIG.RISK_PER_TRADE;
// //   const positionSize = riskAmount * LEVERAGE;
// //   const amount = positionSize / price;

// //   const liquidationPrice = calculateLiquidationPrice(
// //     price,
// //     LEVERAGE,
// //     signal.side,
// //     getMaintenanceMarginTier(positionSize).rate
// //   );

// //   currentPosition = {
// //     positionId: generatePositionId(),
// //     symbol: CONFIG.SYMBOL,
// //     side: signal.side,
// //     entryPrice: price,
// //     amount,
// //     remainingAmount: amount,
// //     stopLoss: signal.stopLoss,
// //     takeProfit: signal.takeProfit,
// //     entryTime: new Date(),
// //     strategy: signal.strategyId,
// //     signalReason: signal.reason,
// //     partialsSold: 0,
// //     leverage: LEVERAGE,
// //     liquidationPrice,
// //     positionValue: positionSize,
// //     marginUsed: positionSize / LEVERAGE
// //   };

// //   // Register with coordinator
// //   await futuresCoordinator.forceRegister(
// //     CONFIG.SYMBOL,
// //     signal.side,
// //     LEVERAGE,
// //     price,
// //     amount
// //   );

// //   // Allocate capital
// //   await futuresBalance.forceAllocate(
// //     CONFIG.SYMBOL,
// //     currentPosition.marginUsed,
// //     positionSize,
// //     LEVERAGE
// //   );

// //   log(`🟢 ${signal?.side} opened @ ${formatPrice(price)} | Size: ${formatQuantity(amount)}`, 'success');
// //   log(`   SL: ${formatPrice(signal.stopLoss)} | TP: ${formatPrice(signal.takeProfit)}`, 'info');

// //   saveState();
// //   sendPositionUpdate(currentPosition, price);
// // }

// // async function closePosition(reason: string, exitPrice: number) {
// //   if (!currentPosition) return;

// //   const pnl = currentPosition.side === 'LONG'
// //     ? (exitPrice - currentPosition.entryPrice) * currentPosition.remainingAmount
// //     : (currentPosition.entryPrice - exitPrice) * currentPosition.remainingAmount;

// //   const leveragedPnL = pnl * currentPosition.leverage;
// //   const duration = Date.now() - currentPosition.entryTime.getTime();

// //   tradesThisSession++;
// //   sessionRealizedPnlUsd += leveragedPnL;

// //   if (CONFIG.PAPER_TRADING) {
// //     paperBalance += leveragedPnL;
// //   }

// //   // Unregister from coordinator
// //   await closePosition(CONFIG.SYMBOL, leveragedPnL);
// //   await futuresBalance.releaseCapital(CONFIG.SYMBOL, leveragedPnL);

// //   const pnlColor = leveragedPnL >= 0 ? 'success' : 'error';
// //   log(`🔴 ${currentPosition.side} closed @ ${formatPrice(exitPrice)}`, pnlColor);
// //   log(`   PnL: ${leveragedPnL >= 0 ? '+' : ''}${leveragedPnL.toFixed(2)} USDT (${reason})`, pnlColor);
// //   log(`   Duration: ${(duration / 60000).toFixed(1)}m`, 'info');

// //   // Log trade
// //   logTrade({
// //     timestamp: new Date(),
// //     symbol: CONFIG.SYMBOL,
// //     action: currentPosition.side === 'LONG' ? 'SELL' : 'COVER',
// //     side: currentPosition.side,
// //     strategy: currentPosition.strategyId,
// //     positionId: currentPosition.positionId,
// //     price: exitPrice,
// //     amount: currentPosition.remainingAmount,
// //     entryPrice: currentPosition.entryPrice,
// //     exitPrice,
// //     quantity: currentPosition.remainingAmount,
// //     pnl: leveragedPnL.toFixed(2),
// //     pnlPct: (pnl / (currentPosition.entryPrice * currentPosition.remainingAmount)) * 100,
// //     pnlUsd: leveragedPnL,
// //     duration,
// //     reason
// //   });

// //   currentPosition = null;
// //   saveState();
// //   sendPositionUpdate(null, exitPrice);
// // }

// // function checkExitConditions(price: number) {
// //   if (!currentPosition) return;

// //   const pos = currentPosition;

// //   // Check stop loss
// //   if (pos.side === 'LONG' && price <= pos.stopLoss) {
// //     closePosition('STOP_LOSS', price);
// //     return;
// //   }
// //   if (pos.side === 'SHORT' && price >= pos.stopLoss) {
// //     closePosition('STOP_LOSS', price);
// //     return;
// //   }

// //   // Check take profit
// //   if (pos.side === 'LONG' && price >= pos.takeProfit) {
// //     closePosition('TAKE_PROFIT', price);
// //     return;
// //   }
// //   if (pos.side === 'SHORT' && price <= pos.takeProfit) {
// //     closePosition('TAKE_PROFIT', price);
// //     return;
// //   }

// //   // Update position with coordinator
// //   const pnl = pos.side === 'LONG'
// //     ? (price - pos.entryPrice) * pos.remainingAmount
// //     : (pos.entryPrice - price) * pos.remainingAmount;

// //   const leveragedPnL = pnl * pos.leverage;

// //   futuresCoordinator.updatePosition(CONFIG.SYMBOL, leveragedPnL, pos.liquidationPrice);
// // }

// // // ---------- STATE PERSISTENCE ----------
// // function saveState() {
// //   const stateFile = path.join(__dirname, 'states', 'futures', `${CONFIG.SYMBOL}.json`);
// //   const state = {
// //     currentPosition,
// //     sessionRealizedPnlUsd,
// //     tradesThisSession,
// //     paperBalance,
// //     lastUpdate: new Date()
// //   };

// //   try {
// //     fs.mkdirSync(path.dirname(stateFile), { recursive: true });
// //     fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
// //   } catch (err: any) {
// //     log(`Failed to save state: ${err.message}`, 'error');
// //   }
// // }

// // function loadState() {
// //   const stateFile = path.join(__dirname, 'states', 'futures', `${CONFIG.SYMBOL}.json`);

// //   try {
// //     if (fs.existsSync(stateFile)) {
// //       const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
// //       currentPosition = state.currentPosition;
// //       sessionRealizedPnlUsd = state.sessionRealizedPnlUsd || 0;
// //       tradesThisSession = state.tradesThisSession || 0;
// //       paperBalance = state.paperBalance || paperBalance;
// //       log('State loaded', 'success');
// //     }
// //   } catch (err: any) {
// //     log(`Failed to load state: ${err.message}`, 'error');
// //   }
// // }

// // // ---------- TRADE LOGGING ----------
// // function initializeTradeLog() {
// //   const logDir = path.join(__dirname, 'logs', 'futures');
// //   fs.mkdirSync(logDir, { recursive: true });
// // }

// // function logTrade(trade: TradeLog) {
// //   const logFile = path.join(__dirname, 'logs', 'futures', `${CONFIG.SYMBOL}.json`);

// //   try {
// //     let trades: TradeLog[] = [];
// //     if (fs.existsSync(logFile)) {
// //       trades = JSON.parse(fs.readFileSync(logFile, 'utf8'));
// //     }
// //     trades.push(trade);
// //     fs.writeFileSync(logFile, JSON.stringify(trades, null, 2));
// //   } catch (err: any) {
// //     log(`Failed to log trade: ${err.message}`, 'error');
// //   }
// // }

// // // ---------- IPC ----------
// // function sendToLauncher(type: string, data: any) {
// //   if (isLauncherManaged && process.send) {
// //     process.send({ type, data, symbol: CONFIG.SYMBOL });
// //   }
// // }

// // function sendPositionUpdate(position: Position | null, currentPrice: number) {
// //   if (!isLauncherManaged) return;

// //   sendToLauncher('position_update', {
// //     position: position ? {
// //       ...position,
// //       currentPrice,
// //       pnlUsd: position.side === 'LONG'
// //         ? (currentPrice - position.entryPrice) * position.remainingAmount * position.leverage
// //         : (position.entryPrice - currentPrice) * position.remainingAmount * position.leverage,
// //       pnlPct: position.side === 'LONG'
// //         ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
// //         : ((position.entryPrice - currentPrice) / position.entryPrice) * 100
// //     } : null
// //   });
// // }

// // function setupIPCHandlers() {
// //   if (!process.send) return;

// //   process.on('message', async (message: any) => {
// //     if (message.type === 'health_check') {
// //       sendToLauncher('heartbeat', {
// //         status: currentPosition ? 'running' : 'waiting',
// //         balance: await getUsdtBalance(),
// //         timestamp: Date.now()
// //       });
// //     } else if (message.type === 'kline_update') {
// //       // Handle kline updates from launcher
// //     }
// //   });
// // }

// // // ---------- MAIN LOOP ----------
// // async function botLoop() {
// //   if (isRunning) return;
// //   isRunning = true;

// //   try {
// //     // Get candles from WebSocket buffer
// //     const candles = wsManager.getCandles(CONFIG.SYMBOL);

// //     if (!candles || candles.closes.length < 200) {
// //       log('Waiting for candle data...', 'info');
// //       return;
// //     }

// //     // Calculate indicators
// //     const indicators = calculateIndicators(candles);

// //     if (!indicators) {
// //       log('Waiting for indicators...', 'info');
// //       return;
// //     }

// //     latestIndicators = indicators;
// //     latestPrice = indicators.currentPrice;

// //     // Send heartbeat
// //     if (isLauncherManaged) {
// //       sendToLauncher('heartbeat', {
// //         status: currentPosition ? 'running' : 'waiting',
// //         indicators,
// //         price: latestPrice
// //       });
// //     }

// //     // Check existing position
// //     if (currentPosition) {
// //       checkExitConditions(latestPrice);
// //       sendPositionUpdate(currentPosition, latestPrice);
// //     } else {
// //       // Look for entry signals
// //       const signal = detectEntrySignal(indicators);

// //       if (signal && tradesThisSession < SESSION_CONFIG.MAX_TRADES_PER_SESSION) {
// //         const now = Date.now();
// //         if (now - lastSignalTime > CONFIG.COOLDOWN_AFTER_LOSS_MS) {
// //           await openPosition(signal, latestPrice);
// //           lastSignalTime = now;
// //         }
// //       }
// //     }

// //   } catch (err: any) {
// //     log(`Loop error: ${err.message}`, 'error');
// //   } finally {
// //     isRunning = false;
// //   }
// // }

// // // ---------- MAIN ----------
// // async function main() {
// //   initializeTradeLog();

// //   try {
// //     marketInfo = await fetchMarketInfo(CONFIG.SYMBOL);
// //     log(`Market info loaded: ${CONFIG.SYMBOL}`, 'success');
// //   } catch (err) {
// //     log(`Failed to init market info`, 'error');
// //     process.exit(1);
// //   }

// //   loadState();

// //   // Initialize WebSocket
// //   wsManager = new BinanceFuturesWebSocket(
// //     TRADING_SYMBOL_FUTURES,
// //     process.env.USE_TESTNET === 'true'
// //   );

// //   const connected = await wsManager.connect();
// //   if (!connected) {
// //     log('Failed to connect to WebSocket', 'error');
// //     process.exit(1);
// //   }

// //   // Setup WebSocket handlers
// //   wsManager.on('ticker', (data: any) => {
// //     latestPrice = data.price;
// //     if (currentPosition) {
// //       checkExitConditions(latestPrice);
// //     }
// //   });

// //   wsManager.on('kline', (data: any) => {
// //     if (data.isClosed) {
// //       // Trigger bot loop on closed candle
// //       botLoop();
// //     }
// //   });

// //   log('╔══════════════════════════════════════════════╗', 'info');
// //   log('║   🚀 WEBSOCKET BOT v5.0 (FUTURES)           ║', 'success');
// //   log('╠══════════════════════════════════════════════╣', 'info');
// //   log(`║  ${CONFIG.PAPER_TRADING ? '📝 PAPER' : '💰 LIVE'} | ${CONFIG.SYMBOL} | WS Mode       ║`, 'info');
// //   log('╚══════════════════════════════════════════════╝', 'info');

// //   // Setup IPC if launcher-managed
// //   if (isLauncherManaged) {
// //     setupIPCHandlers();
// //     log('IPC handlers registered', 'success');
// //   }

// //   sessionStartBalance = await getUsdtBalance();

// //   // Start bot loop
// //   await botLoop();
// //   setInterval(botLoop, CONFIG.LOOP_INTERVAL_MS);
// // }

// // // ---------- CLEANUP ----------
// // process.on('SIGINT', async () => {
// //   log('Shutting down...', 'warning');
// //   saveState();
// //   if (wsManager) wsManager.close();
// //   process.exit(0);
// // });

// // process.on('uncaughtException', async (err) => {
// //   log(`Uncaught: ${err.message}`, 'error');
// //   saveState();
// //   if (wsManager) wsManager.close();
// //   process.exit(1);
// // });

// // main().catch(err => {
// //   log(`Fatal: ${err.message}`, 'error');
// //   process.exit(1);
// // });/
