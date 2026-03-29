import crypto from 'crypto';
import fs from 'fs';

import ccxt from 'ccxt';

import { getConfigForSymbol } from '../src/spot/config-spot.js';
import { LoggerFactory } from './logger.js';
import type { StealthNumbers } from './type.js';

// import type { Timeframe } from '../coin-config.js';
// import { CandleManager, htfManagers } from '../enh-bot.js';
type MarketInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  minNotional: number;
  minQty: number;
  stepSize: number;
  tickSize: number;
};

let marketInfo: MarketInfo | null = null;
export type MarketType = 'SPOT' | 'FUTURES';

const DEBUG_LOG = 'launcher_debug.log';

export function debugLog(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logEntry = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}\n`
    : `[${timestamp}] ${message}\n`;

  fs.appendFileSync(DEBUG_LOG, logEntry);
}
const CONFIG = getConfigForSymbol(process.env.TRADING_SYMBOL || 'BTC/USDT');
// lib/symbol-converter.ts
const logger = LoggerFactory.getSpotLogger(CONFIG.SYMBOL);
export interface SymbolContext {
  display: string; // "PEPE/USDT" (for display/config)
  spot: string; // "PEPEUSDT" (spot trading)
  futures: string; // "1000PEPEUSDT" (futures trading)
  base: string; // "PEPE"
  quote: string; // "USDT"
  multiplier: number; // 1000 or 1
}

// Tokens that use 1000x multiplier on Binance Futures
const FUTURES_1000X_TOKENS = [
  'PEPE',
  'FLOKI',
  'BONK',
  'CAT',
  'CHEEMS',
  'SHIB',
  'LUNC',
  'XEC',
  'WIN',
  'BIDR',
  'LADYS',
  'RATS',
  'SATS',
];

// Tokens not available on Binance Futures (spot only)
const SPOT_ONLY_TOKENS = [
  'NEXO',
  'DAI',
  'USDP',
  'TUSD',
  'BUSD',
  'PAX',
  'UST',
  'USDS',
  'USDSB',
  'XUSD',
  'EUR',
  'GBP',
  'AUD',
  'BFUSD',
  'FDUSD',
  'EURI',
  'AEUR',
];

// ---------- EXCHANGE INIT ----------
if (
  !process.env.BINANCE_FUTURE_API_KEY ||
  !process.env.BINANCE_FUTURE_API_SECRET
) {
  throw Error('Missing BINANCE_FUTURE_API_KEY or BINANCE_FUTURE_API_SECRET');
}

export const binanceF = new ccxt.binance({
  apiKey: process.env.BINANCE_FUTURE_API_KEY,
  secret: process.env.BINANCE_FUTURE_API_SECRET,
  enableRateLimit: true,
  timeout: 60000,
  options: {
    defaultType: 'future',
  },
});

// Tokens with different names on futures
const FUTURES_RENAMED: Record<string, string> = {
  // Add any renamed tokens here
  OLD_NAME: 'NEW_NAME',
};

export function createSymbolContext(symbol: string): SymbolContext {
  // Handle various input formats
  let cleanSymbol = symbol.toUpperCase().trim();

  // Remove /USDT or USDT suffix
  let base = cleanSymbol.replace('/USDT', '').replace('USDT', '');
  const quote = 'USDT';

  // Check if renamed on futures
  if (FUTURES_RENAMED[base]) {
    base = FUTURES_RENAMED[base]!;
  }

  // Determine if 1000x multiplier is needed
  const multiplier = FUTURES_1000X_TOKENS.includes(base) ? 1000 : 1;

  // Build formats
  const display = `${base}/${quote}`;
  const spot = `${base}${quote}`;
  const futures = multiplier === 1000 ? `1000${base}${quote}` : spot;

  return {
    display,
    spot,
    futures,
    base,
    quote,
    multiplier,
  };
}

export function isFuturesAvailable(symbol: string): boolean {
  const ctx = createSymbolContext(symbol);
  return !SPOT_ONLY_TOKENS.includes(ctx.base);
}

export function validateSymbol(symbol: string): {
  valid: boolean;
  reason?: string;
} {
  try {
    // Check format
    const upperSymbol = symbol.toUpperCase().trim();
    if (!/^[A-Z0-9]+(?:\/USDT|USDT)$/.test(upperSymbol)) {
      return {
        valid: false,
        reason:
          'Invalid symbol format. Expected format: BASE/USDT or BASEUSDT where BASE contains only uppercase letters and numbers',
      };
    }

    const ctx = createSymbolContext(symbol);

    if (SPOT_ONLY_TOKENS.includes(ctx.base)) {
      return {
        valid: false,
        reason: `${ctx.base} is not available on Binance Futures`,
      };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: err.message };
  }
}

// Helper to get the correct symbol for API calls
export function getApiSymbol(
  symbol: string,
  marketType: 'spot' | 'futures' = 'futures'
): string {
  const ctx = createSymbolContext(symbol);
  return marketType === 'futures' ? ctx.futures : ctx.spot;
}

export function formatPrice(price: number): string {
  if (!marketInfo) return price.toFixed(2);
  return price.toFixed(marketInfo.pricePrecision);
}

export function formatQuantity(qty: number): string {
  if (!marketInfo) return qty.toFixed(6);
  return qty.toFixed(marketInfo.quantityPrecision);
}

export function generatePositionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function formatNumber(num: number, decimals: number = 2): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(2) + 'K';
  } else {
    return num.toFixed(decimals);
  }
}

// ✅ Helper for price decimals
// export function getPriceDecimals(price:number) {
//   if (price >= 1000) return 2;
//   if (price >= 100) return 2;
//   if (price >= 10) return 3;
//   if (price >= 1) return 4;
//   return 6;
// }

// ✅ Smart decimal places for prices
// export const getPriceDecimals = (price: number): number => {
//   if (price >= 1000) return 2; // BTC: 92000.00
//   if (price >= 100) return 3; // ETH: 3500.000
//   if (price >= 1) return 4; // BNB: 650.0000
//   if (price >= 0.1) return 5; // XRP: 0.50000
//   if (price >= 0.001) return 6; // DOGE: 0.085000
//   if (price >= 0.00001) return 8; // SHIB: 0.00001234
//   return 10; // PEPE: 0.0000045900
// };

export const getPriceDecimals = (price: number): number => {
  if (!price || price <= 0) return 8; // Safety: fallback for invalid prices

  // Use string length of the integer part to determine scale
  const str = price.toString();

  // If scientific notation (very small numbers like 1e-8)
  if (str.includes('e-')) {
    const exponent = parseInt(str.split('e-')[1] ?? '0', 10);
    return Math.min(exponent + 4, 12);
  }

  // Normal cases
  if (price >= 100000) return 0; // Rare huge prices (e.g., some indices)
  if (price >= 1000) return 2; // BTC ~90,000
  if (price >= 100) return 3; // ETH ~3,500
  if (price >= 10) return 4; // SOL ~150
  if (price >= 1) return 5; // Most alts ~50.00000
  if (price >= 0.1) return 6; // XRP ~0.600000
  if (price >= 0.01) return 7; // Some meme coins
  if (price >= 0.001) return 8; // DOGE ~0.08500000
  if (price >= 0.0001) return 9; // SHIB territory
  if (price >= 0.00001) return 10; // SHIB/PEPE
  if (price >= 0.000001) return 11;
  return 12; // Ultra-low prices (PEPE, some 2024-2025 memes)
};

// ✅ Smart decimal places for amounts (showing owned quantity)
export const getAmountDecimals = (amount: number, price: number): number => {
  // For expensive coins (BTC, ETH), show more decimals for small amounts
  if (price >= 1000 && amount < 0.01) return 8; // BTC: 0.00005435
  if (price >= 100 && amount < 1) return 6; // ETH: 0.001500
  if (price >= 1 && amount < 10) return 4; // BNB: 5.4321
  if (amount >= 1000) return 2; // PEPE: 1234567.89
  if (amount >= 100) return 3; // DOGE: 523.456
  return 4; // Default: 12.3456
};

export const LEVERAGE = parseInt(process.env.LEVERAGE || '5');

// export function normalize(symbol: string) {
//   return symbol.replace('/', '').toUpperCase();
// }

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// export function getHTFManager(timeframe: Timeframe): CandleManager {
//   let manager = htfManagers.get(timeframe);

//   if (!manager) {
//     manager = new CandleManager([], timeframe);
//     htfManagers.set(timeframe, manager);
//   }

//   return manager;
// }

// In launcher-future.js
export function convertToFuturesSymbol() {
  // console.log(`🔄 Converting ${symbol} to futures format...`);

  // Remove any existing /USDT and clean up
  if (!process.env.ENABLED_FUTURE_SYMBOLS) {
    throw new Error('no token!!');
  }
  const cleanSymbol = process.env.ENABLED_FUTURE_SYMBOLS.replace(
    '/USDT',
    ''
  ).replace('USDT', '');

  // Handle 1000 multiplier tokens
  const thousandMultiplierTokens = [
    'PEPE',
    'FLOKI',
    'BONK',
    'SHIB',
    'BTT',
    'CAT',
    'CHEEMS',
  ];

  let result: string;

  if (thousandMultiplierTokens.includes(cleanSymbol)) {
    result = `1000${cleanSymbol}USDT`;
  } else {
    result = `${cleanSymbol}USDT`;
  }

  // console.log(`   Input: ${symbol} -> Output: ${result}`);
  return result;
}

// export function toFuturesSymbol(symbol: string): string {
//   // Remove /USDT if present
//   const cleanSymbol = symbol.replace('/USDT', '').replace('USDT', '');

//   // Check if it needs 1000 prefix
//   if (FUTURES_1000X_TOKENS.includes(cleanSymbol)) {
//     return `1000${cleanSymbol}USDT`;
//   }

//   return `${cleanSymbol}USDT`;
// }

export function toDisplaySymbol(futuresSymbol: string): string {
  // Remove USDT suffix
  let symbol = futuresSymbol.replace('USDT', '');

  // Remove 1000 prefix if present
  if (symbol.startsWith('1000')) {
    symbol = symbol.substring(4); // Remove '1000'
  }

  return `${symbol}/USDT`;
}

// export function normalize(symbol: string, marketType?: MarketType): string {
//   const binanceSymbol = symbol.includes('/') ? symbol.replace('/', '') : symbol;
//   return (marketType === 'FUTURES' && symbol !== 'NEXO/USDT') ||
//     (marketType === 'FUTURES' && symbol !== 'NEXOUSDT')
//     ? toFuturesSymbol(binanceSymbol)
//     : binanceSymbol;
// }

export function normalize(symbol: string, marketType?: MarketType): string {
  // Handle NEXO special case
  if (symbol === 'NEXO/USDT' || symbol === 'NEXOUSDT') {
    return 'NEXOUSDT';
  }

  // Remove any slashes and ensure USDT suffix
  let cleanSymbol = symbol.replace('/', '');

  // If it doesn't end with USDT, add it
  if (!cleanSymbol.endsWith('USDT')) {
    cleanSymbol = `${cleanSymbol}USDT`;
  }

  // For futures market, apply futures symbol rules
  if (marketType === 'FUTURES') {
    return toFuturesSymbol(cleanSymbol);
  }

  return cleanSymbol;
}

export function toFuturesSymbol(symbol: string): string {
  // Ensure we're working with a clean symbol
  let cleanSymbol = symbol.replace('/USDT', '').replace('USDT', '');

  // Remove any existing 1000 prefix to avoid double-prefixing
  if (cleanSymbol.startsWith('1000')) {
    cleanSymbol = cleanSymbol.substring(4);
  }

  // Check if it needs 1000 prefix
  if (FUTURES_1000X_TOKENS.includes(cleanSymbol)) {
    return `1000${cleanSymbol}USDT`;
  }

  return `${cleanSymbol}USDT`;
}

export function is1000xToken(symbol: string): boolean {
  const cleanSymbol = symbol
    .replace('/USDT', '')
    .replace('USDT', '')
    .replace('1000', '');
  return FUTURES_1000X_TOKENS.includes(cleanSymbol);
}

export function is1000xSymbol(symbol: string): boolean {
  return symbol.startsWith('1000');
}

export function getContractMultiplier(symbol: string): number {
  // How many tokens per contract
  return is1000xSymbol(symbol) ? 1000 : 1;
}

// export function calculatePositionSize(
//   symbol: string,
//   notionalUSD: number,
//   futuresPrice: number
// ): number {
//   // futuresPrice is ALREADY the correct price from Binance
//   // Whether it's BTC at $100,000 or 1000PEPE at $0.00659

//   // Calculate contracts needed
//   const contracts = notionalUSD / futuresPrice;

//   return contracts;
// }

export function getActualTokenQuantity(
  symbol: string,
  contracts: number
): number {
  // For display/logging purposes
  const multiplier = getContractMultiplier(symbol);
  return contracts * multiplier;
}

const SYMBOLS = [
  'BTC/USDT', // Will become BTCUSDT
  'ETH/USDT', // Will become ETHUSDT
  'PEPE/USDT', // Will become 1000PEPEUSDT ✅
  'FLOKI/USDT', // Will become 1000FLOKIUSDT ✅
  'SHIB/USDT', // Will become 1000SHIBUSDT ✅
  'BONK/USDT', // Will become 1000BONKUSDT ✅
  'SOL/USDT', // Will become SOLUSDT
];

SYMBOLS.forEach((symbol) => {
  const futuresSymbol = normalize(symbol);
  const displaySymbol = toDisplaySymbol(futuresSymbol);
  const multiplier = getContractMultiplier(futuresSymbol);

  // console.log(`${symbol.padEnd(12)} -> ${futuresSymbol.padEnd(15)} (${multiplier}x) -> ${displaySymbol}`);
});

// ---------- ANSI COLOR CODES ----------
export const colors = {
  // Reset
  reset: '\x1b[0m',

  // Text Styles
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',

  // Basic Colors (30-37)
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright Colors (90-97)
  brightBlack: '\x1b[90m',
  gray: '\x1b[90m', // Alias
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // 256-Color Extended Colors
  orange: '\x1b[38;5;214m',
  brightOrange: '\x1b[1m\x1b[38;5;214m',
  pink: '\x1b[38;5;213m',
  brightPink: '\x1b[1m\x1b[38;5;213m',
  purple: '\x1b[38;5;141m',
  brightPurple: '\x1b[1m\x1b[38;5;141m',
  indigo: '\x1b[38;5;63m',
  brightIndigo: '\x1b[1m\x1b[38;5;63m',
  teal: '\x1b[38;5;51m',
  brightTeal: '\x1b[1m\x1b[38;5;51m',
  lime: '\x1b[38;5;154m',
  brightLime: '\x1b[1m\x1b[38;5;154m',
  gold: '\x1b[38;5;220m',
  brightGold: '\x1b[1m\x1b[38;5;220m',
  bronze: '\x1b[38;5;172m',
  brightBronze: '\x1b[1m\x1b[38;5;172m',
  silver: '\x1b[38;5;250m',
  brightSilver: '\x1b[1m\x1b[38;5;250m',
  coral: '\x1b[38;5;209m',
  brightCoral: '\x1b[1m\x1b[38;5;209m',
  salmon: '\x1b[38;5;210m',
  brightSalmon: '\x1b[1m\x1b[38;5;210m',
  peach: '\x1b[38;5;217m',
  brightPeach: '\x1b[1m\x1b[38;5;217m',
  lavender: '\x1b[38;5;183m',
  brightLavender: '\x1b[1m\x1b[38;5;183m',
  mint: '\x1b[38;5;121m',
  brightMint: '\x1b[1m\x1b[38;5;121m',
  skyBlue: '\x1b[38;5;117m',
  brightSkyBlue: '\x1b[1m\x1b[38;5;117m',
  navy: '\x1b[38;5;17m',
  brightNavy: '\x1b[1m\x1b[38;5;17m',
  maroon: '\x1b[38;5;88m',
  brightMaroon: '\x1b[1m\x1b[38;5;88m',
  olive: '\x1b[38;5;100m',
  brightOlive: '\x1b[1m\x1b[38;5;100m',
  lightYellow: '\x1b[38;5;229m',
  brightLightYellow: '\x1b[1m\x1b[38;5;229m',
  lightBlue: '\x1b[38;5;153m',
  brightLightBlue: '\x1b[1m\x1b[38;5;153m',

  // Green spectrum
  darkGreen: '\x1b[38;5;22m', // Very dark green
  forestGreen: '\x1b[38;5;28m', // Dark forest green
  oliveGreen: '\x1b[38;5;64m', // Olive green
  mediumGreen: '\x1b[38;5;70m', // Medium green
  // brightGreen: '\x1b[38;5;46m',    // Bright green (lime)
  lightGreen: '\x1b[38;5;118m', // Light green

  // Grayscale (232-255)
  darkGray: '\x1b[38;5;238m',
  mediumGray: '\x1b[38;5;244m',
  lightGray: '\x1b[38;5;250m',

  // Background Colors (40-47)
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',

  // Bright Background Colors (100-107)
  bgBrightBlack: '\x1b[100m',
  bgGray: '\x1b[100m', // Alias
  bgBrightRed: '\x1b[101m',
  bgBrightGreen: '\x1b[102m',
  bgBrightYellow: '\x1b[103m',
  bgBrightBlue: '\x1b[104m',
  bgBrightMagenta: '\x1b[105m',
  bgBrightCyan: '\x1b[106m',
  bgBrightWhite: '\x1b[107m',

  // 256-Color Backgrounds
  bgOrange: '\x1b[48;5;214m',
  bgPink: '\x1b[48;5;213m',
  bgPurple: '\x1b[48;5;141m',
  bgIndigo: '\x1b[48;5;63m',
  bgTeal: '\x1b[48;5;51m',
  bgLime: '\x1b[48;5;154m',
  bgGold: '\x1b[48;5;220m',
  bgBronze: '\x1b[48;5;172m',
  bgSilver: '\x1b[48;5;250m',
  bgCoral: '\x1b[48;5;209m',
  bgSalmon: '\x1b[48;5;210m',
  bgPeach: '\x1b[48;5;217m',
  bgLavender: '\x1b[48;5;183m',
  bgMint: '\x1b[48;5;121m',
  bgSkyBlue: '\x1b[48;5;117m',
  bgNavy: '\x1b[48;5;17m',
  bgMaroon: '\x1b[48;5;88m',
  bgOlive: '\x1b[48;5;100m',
  bgDarkGray: '\x1b[48;5;238m',
  bgMediumGray: '\x1b[48;5;244m',
  bgLightGray: '\x1b[48;5;250m',
};

// Helper function to create custom RGB colors (true color - not all terminals support this)
export const rgb = (r: number, g: number, b: number): string => {
  return `\x1b[38;2;${r};${g};${b}m`;
};

// Helper function for custom RGB background colors
export const bgRgb = (r: number, g: number, b: number): string => {
  return `\x1b[48;2;${r};${g};${b}m`;
};

// Helper function to colorize text
export const colorize = (text: string, color: string): string => {
  return `${color}${text}${colors.reset}`;
};

// Pre-made color combinations for common use cases
export const colorThemes = {
  success: `${colors.bright}${colors.green}`,
  error: `${colors.bright}${colors.red}`,
  warning: `${colors.bright}${colors.yellow}`,
  info: `${colors.bright}${colors.cyan}`,
  debug: `${colors.dim}${colors.gray}`,
  profit: `${colors.bright}${colors.green}`,
  loss: `${colors.bright}${colors.red}`,
  neutral: `${colors.yellow}`,
  highlight: `${colors.bright}${colors.magenta}`,
  critical: `${colors.bright}${colors.bgRed}${colors.white}`,
  important: `${colors.bright}${colors.bgYellow}${colors.black}`,
  badge: `${colors.bgBlue}${colors.white}`,
};

export function generateId() {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

export function formatPriceUSD(price: number): string {
  const decimals = getPriceDecimals(price);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(price);
}

export function roundPrice(price: number, precision: number): number {
  return Math.round(price * Math.pow(10, precision)) / Math.pow(10, precision);
}

export function roundQuantity(qty: number, precision: number): number {
  return Math.floor(qty * Math.pow(10, precision)) / Math.pow(10, precision);
}

export const RISK_CONFIG = {
  // How much of your MARGIN you're willing to risk per trade
  riskPercentOfMargin: 0.025, // 2.5% = $2.50 loss on $100 margin

  // Your leverage multiplier
  leverageMultiplier: 3,

  // Calculated: How much price can move before stop loss hits
  get maxPriceMovementPercent(): number {
    return this.riskPercentOfMargin / this.leverageMultiplier;
    // 2.5% / 3 = 0.833% price movement = reasonable stop loss
  },

  // Your reward-to-risk ratio (how many R you want to make)
  rewardRiskRatio: 2.5, // Take profit at 2.5x your risk
};

// ============================================
// 2. HELPER FUNCTION: Calculate Stop Loss Price
// ============================================

interface StopLossCalculation {
  stopLossPrice: number;
  takeProfitPrice: number;
  stopLossDistance: number;
  takeProfitDistance: number;
  riskUSD: number;
  rewardUSD: number;
  riskPercent: number;
  rewardPercent: number;
}

export function calculateStopLossWithLeverage(
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  marginUsed: number,
  leverage: number = RISK_CONFIG.leverageMultiplier,
  riskPercentOfMargin: number = RISK_CONFIG.riskPercentOfMargin,
  rewardRiskRatio: number = RISK_CONFIG.rewardRiskRatio
): StopLossCalculation {
  // Step 1: Calculate how much USD we're willing to risk
  const riskUSD = marginUsed * riskPercentOfMargin;

  // Step 2: Calculate how much price can move (accounting for leverage)
  const maxPriceMovementPercent = riskPercentOfMargin / leverage;

  // Step 3: Calculate stop loss price
  let stopLossPrice: number;
  let takeProfitPrice: number;

  if (side === 'LONG') {
    // For LONG: stop loss BELOW entry
    stopLossPrice = entryPrice * (1 - maxPriceMovementPercent);

    // Take profit ABOVE entry (at rewardRiskRatio * risk distance)
    const takeProfitDistance = (entryPrice - stopLossPrice) * rewardRiskRatio;
    takeProfitPrice = entryPrice + takeProfitDistance;
  } else {
    // For SHORT: stop loss ABOVE entry
    stopLossPrice = entryPrice * (1 + maxPriceMovementPercent);

    // Take profit BELOW entry (at rewardRiskRatio * risk distance)
    const takeProfitDistance = (stopLossPrice - entryPrice) * rewardRiskRatio;
    takeProfitPrice = entryPrice - takeProfitDistance;
  }

  const stopLossDistance = Math.abs(entryPrice - stopLossPrice);
  const takeProfitDistance = Math.abs(takeProfitPrice - entryPrice);

  return {
    stopLossPrice,
    takeProfitPrice,
    stopLossDistance,
    takeProfitDistance,
    riskUSD,
    rewardUSD: riskUSD * rewardRiskRatio,
    riskPercent: maxPriceMovementPercent * 100,
    rewardPercent: (takeProfitDistance / entryPrice) * 100,
  };
}

// ✅ 2. FIXED POSITION SIZE CALCULATION
export async function calculatePositionSize(
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
    const markets = await binanceF.loadMarkets();
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

export function roundToWeirdDecimal(num: number): number {
  // Round to 4 decimals, but add random tiny offset
  const base = Math.round(num * 10000) / 10000;
  const offset = (Math.random() * 9 + 1) / 100000; // 0.00001 to 0.00009
  return base + offset;
}

export function roundToWeirdAmount(amount: number): number {
  // Never use round numbers
  const decimals = [3, 7, 9, 13, 17, 23, 27, 33, 37];
  const decimal = decimals[
    Math.floor(Math.random() * decimals.length)
  ] as number;

  // Round to weird decimal place
  const base = Math.floor(amount * 1000) / 1000;
  return base + decimal / 10000;
}

export function getRandomPrimeRatio(): number {
  const primeRatios = [
    1.13, 1.17, 1.23, 1.37, 1.47, 1.53, 1.67, 1.73, 1.83, 1.97, 2.13, 2.17,
    2.33, 2.47, 2.53, 2.67,
  ];
  return primeRatios[Math.floor(Math.random() * primeRatios.length)] as number;
}

export function generateStealthNumbers(
  basePrice: number,
  side: 'LONG' | 'SHORT'
): StealthNumbers {
  // Prime-ish numbers for extra weirdness
  const primes = [13, 17, 23, 37, 47, 53, 67, 73, 83, 97] as number[];
  const prime = primes[Math.floor(Math.random() * primes.length)] as number;

  // Random but within bounds
  const entryPercent = 1.5 + Math.random() * 1.5; // 1.5-3.0%
  const slPercent = 0.7 + Math.random() * 0.8; // 0.7-1.5%
  const rrRatio = 1.6 + Math.random() * 0.9; // 1.6-2.5

  if (side === 'SHORT') {
    return {
      entry: basePrice * (1 - entryPercent / 100) + prime / 10000,
      stopLoss: basePrice * (1 + slPercent / 100) - prime / 10000,
      // takeProfit: null,
      rrRatio: rrRatio,
      weirdOffset: prime / 10000,
    };
  } else {
    return {
      entry: basePrice * (1 + entryPercent / 100) - prime / 10000,
      stopLoss: basePrice * (1 - slPercent / 100) + prime / 10000,
      // takeProfit: null,
      rrRatio: rrRatio,
      weirdOffset: prime / 10000,
    };
  }
}
