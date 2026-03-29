// import fs from 'fs';

// import Table from 'cli-table3';
// import * as dotenv from 'dotenv';
// import { ADX, ATR, EMA, RSI } from 'technicalindicators';
// import type { ADXOutput } from 'technicalindicators/declarations/directionalmovement/ADX.js';

// import {
//   colors,
//   getPriceDecimals,
//   normalize,
//   type MarketType,
// } from '../../lib/helpers.js';
// import {
//   calculateIndicators,
//   checkMarketWeather,
//   detectRegime,
//   displayWeather,
//   type MarketWeather,
// } from '../../lib/trading-utils.js';
// import {
//   smcStrategies,
//   smcStrategy,
//   strategyId,
//   type BotType,
//   type CandleData,
//   type ConfidenceFactors,
//   type ConfidenceWeights,
//   type EntrySignal,
//   type ExtendedScanResult,
//   type FairValueGap,
//   type Indicators,
//   type LiquidityLevel,
//   type SMCAnalysis,
//   type StrategyId,
//   type TrendAnalysis,
// } from '../../lib/type.js';
// import { CandleManager, HTFCandleManager } from '../core/candles.js';
// import { WyckoffAnalyzer, type WyckoffPhase } from '../core/wyckoff.js';
// import {
//   COMPLETE_BLOCKLIST,
//   CONFIG,
//   filterPeskyTokens,
//   YOUR_SYMBOLS,
// } from '../futures/future-config.js';

// dotenv.config();

// // ============================================================================
// // SMC (SMART MONEY CONCEPTS) TYPES
// // ============================================================================

// interface OrderBookEntry {
//   price: number;
//   quantity: number;
//   total: number;
// }

// interface OrderBook {
//   bids: OrderBookEntry[];
//   asks: OrderBookEntry[];
//   lastUpdateId: number;
// }

// interface OrderBlock {
//   type: 'BULLISH' | 'BEARISH';
//   high: number;
//   low: number;
//   index: number;
//   strength: number;
//   mitigated: boolean;
// }

// // ============================================================================
// // CONFIGURATION
// // ============================================================================

// if (!process.env.ENABLED_SYMBOLS) {
//   throw new Error('no symbol token was found!');
// }

// export const RISK_REWARD_CONFIG = {
//   ratio: 2.1, // 1:3 risk/reward (change to 2 for 1:2)
//   maxRiskPercent: 1.0, // Never risk more than 1.5%
//   minRiskPercent: 0.5, // Never risk less than 0.5%
//   atrMultiplier: 1.5, // How many ATRs for stop loss
// };

// export const SCAN_CONFIG = {
//   ...CONFIG,
//   RISK_REWARD_CONFIG,
//   symbols: process.env.ENABLED_SYMBOLS.split(','),
//   scanInterval: 30_000,
//   minConfidence: 70,
//   timeframe: '1m',
//   displayLimit: 50,
//   enableContinuousMode: true,
//   showAllTokens: true,
//   tradingMode: (process.env.TRADING_MODE || 'BOTH') as
//     | 'SPOT'
//     | 'FUTURES'
//     | 'BOTH',
//   smcEnabled: true,
//   smcMinScore: 40,
//   outputFiles: {
//     spot: './data/signals/spot-signals.json',
//     futures: './data/signals/futures-signals.json',
//     futuresLegacy: './data/signals/futures-legacy-signals.json',
//     all: './data/signals/scanner-output.json',
//   },
//   marketType: 'FUTURES' as MarketType,
//   liquidity: {
//     enabled: true,
//     minDepth24h: 50_000_000,
//   },
//   maxSpreadPercent: 0.5,
// };

// // 1. Flatten all undesirable tokens into one single list
// const allPeskyTokens = Object.values(COMPLETE_BLOCKLIST).flat();

// // 2. Filter your symbols
// const symbols = YOUR_SYMBOLS.filter(
//   (symbol) => !allPeskyTokens.includes(symbol)
// );

// console.log(symbols);

// // ============================================================================
// // UTILITY FUNCTIONS
// // ============================================================================

// function colorize(text: string, color: string): string {
//   return `${color}${text}${colors.reset}`;
// }

// function log(
//   msg: string,
//   type: 'info' | 'success' | 'error' | 'warning' = 'info'
// ) {
//   const icons = {
//     info: 'â„¹ï¸',
//     success: 'âœ…',
//     error: 'âŒ',
//     warning: 'âš ï¸',
//   };
//   const timestamp = new Date().toISOString();
//   console.log(`[${timestamp}] ${icons[type]} ${msg}`);
// }

// /**
//  * Calculates the relative performance of a symbol vs BTC
//  * returns a ratio: > 1 means outperforming BTC, < 1 means underperforming
//  */
// function calculateRelativeStrength(
//   symbolCandles: CandleData,
//   btcCandles: CandleData,
//   lookback: number = 24 // e.g., 24 candles for a 1h timeframe = 1 day
// ): number {
//   const symbolStart = symbolCandles.closes[
//     symbolCandles.closes.length - lookback
//   ] as number;
//   const symbolEnd = symbolCandles.closes[
//     symbolCandles.closes.length - 1
//   ] as number;
//   const symbolPerf = (symbolEnd - symbolStart) / symbolStart;

//   const btcStart = btcCandles.closes[
//     btcCandles.closes.length - lookback
//   ] as number;
//   const btcEnd = btcCandles.closes[btcCandles.closes.length - 1] as number;
//   const btcPerf = (btcEnd - btcStart) / btcStart;

//   // We add 1 to avoid division by zero and get a clean ratio
//   return (1 + symbolPerf) / (1 + btcPerf);
// }

// // ============================================================================
// // SMC ANALYSIS FUNCTIONS
// // ============================================================================

// function detectOrderBlocks(candles: any, lookback: number = 20): OrderBlock[] {
//   const orderBlocks: OrderBlock[] = [];
//   const { highs, lows, closes, opens } = candles;
//   const len = closes.length;

//   for (let i = len - lookback; i < len - 3; i++) {
//     if (i < 2) continue;

//     const currentRange = highs[i] - lows[i];
//     const prevRange = highs[i - 1] - lows[i - 1];

//     // Bullish Order Block
//     if (
//       closes[i] < opens[i] &&
//       closes[i + 1] > opens[i + 1] &&
//       closes[i + 1] > highs[i] &&
//       currentRange > prevRange * 0.5
//     ) {
//       const strength = ((closes[i + 1] - opens[i + 1]) / currentRange) * 100;
//       orderBlocks.push({
//         type: 'BULLISH',
//         high: highs[i],
//         low: lows[i],
//         index: i,
//         strength: Math.min(100, strength),
//         mitigated: closes[len - 1] < lows[i],
//       });
//     }

//     // Bearish Order Block
//     if (
//       closes[i] > opens[i] &&
//       closes[i + 1] < opens[i + 1] &&
//       closes[i + 1] < lows[i] &&
//       currentRange > prevRange * 0.5
//     ) {
//       const strength = ((opens[i + 1] - closes[i + 1]) / currentRange) * 100;
//       orderBlocks.push({
//         type: 'BEARISH',
//         high: highs[i],
//         low: lows[i],
//         index: i,
//         strength: Math.min(100, strength),
//         mitigated: closes[len - 1] > highs[i],
//       });
//     }
//   }

//   return orderBlocks.slice(-5);
// }

// export function detectFairValueGaps(
//   candles: any,
//   lookback: number = 30
// ): FairValueGap[] {
//   const fvgs: FairValueGap[] = [];
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   for (let i = len - lookback; i < len - 2; i++) {
//     if (i < 1) continue;

//     // Bullish FVG
//     const bullishGap = lows[i + 2] - highs[i];
//     if (bullishGap > 0) {
//       const filled = closes[len - 1] >= lows[i + 2];
//       fvgs.push({
//         type: 'BULLISH',
//         top: lows[i + 2],
//         bottom: highs[i],
//         index: i,
//         filled,
//       });
//     }

//     // Bearish FVG
//     const bearishGap = lows[i] - highs[i + 2];
//     if (bearishGap > 0) {
//       const filled = closes[len - 1] <= highs[i + 2];
//       fvgs.push({
//         type: 'BEARISH',
//         top: lows[i],
//         bottom: highs[i + 2],
//         index: i,
//         filled,
//       });
//     }
//   }

//   return fvgs.filter((f) => !f.filled).slice(-5);
// }

// function detectLiquidityLevels(
//   candles: any,
//   lookback: number = 50
// ): LiquidityLevel[] {
//   const levels: LiquidityLevel[] = [];
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   // If we find two 'LOW' levels within 0.1% of each other,
//   // that is an "Equal Low" (EQL) - a very strong magnet.
//   const threshold = 0.001; // 0.1%

//   for (let i = len - lookback; i < len - 5; i++) {
//     if (i < 5) continue;

//     // Swing High
//     if (
//       highs[i] > highs[i - 1] &&
//       highs[i] > highs[i - 2] &&
//       highs[i] > highs[i + 1] &&
//       highs[i] > highs[i + 2]
//     ) {
//       const swept = highs[len - 1] >= highs[i] || highs[len - 2] >= highs[i];
//       const strength =
//         ((highs[i] - Math.min(lows[i - 2], lows[i - 1], lows[i])) / highs[i]) *
//         100;
//       levels.push({
//         type: 'HIGH',
//         price: highs[i],
//         strength: Math.min(100, strength * 10),
//         swept,
//       });
//     }

//     // Swing Low
//     if (
//       lows[i] < lows[i - 1] &&
//       lows[i] < lows[i - 2] &&
//       lows[i] < lows[i + 1] &&
//       lows[i] < lows[i + 2]
//     ) {
//       const swept = lows[len - 1] <= lows[i] || lows[len - 2] <= lows[i];
//       const strength =
//         ((Math.max(highs[i - 2], highs[i - 1], highs[i]) - lows[i]) / lows[i]) *
//         100;
//       levels.push({
//         type: 'LOW',
//         price: lows[i],
//         strength: Math.min(100, strength * 10),
//         swept,
//       });
//     }
//   }

//   return levels.slice(-10);
// }

// function getMarketSession():
//   | 'LONDON'
//   | 'NEW_YORK'
//   | 'ASIA'
//   | 'OVERLAP'
//   | 'QUIET' {
//   const hour = new Date().getUTCHours();

//   // London: 08:00 - 16:00 UTC
//   // New York: 13:00 - 21:00 UTC
//   const isLondon = hour >= 8 && hour < 16;
//   const isNY = hour >= 13 && hour < 21;

//   if (isLondon && isNY) return 'OVERLAP'; // High Volatility
//   if (isLondon) return 'LONDON';
//   if (isNY) return 'NEW_YORK';
//   if (hour >= 0 && hour < 7) return 'ASIA';

//   return 'QUIET';
// }

// function detectBOS(candles: any, lookback: number = 20) {
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   let swingHigh = -Infinity;
//   let swingLow = Infinity;
//   let swingHighIdx = -1;
//   let swingLowIdx = -1;

//   for (let i = len - lookback; i < len - 3; i++) {
//     if (highs[i] > swingHigh) {
//       swingHigh = highs[i];
//       swingHighIdx = i;
//     }
//     if (lows[i] < swingLow) {
//       swingLow = lows[i];
//       swingLowIdx = i;
//     }
//   }

//   if (closes[len - 1] > swingHigh && swingHighIdx > swingLowIdx) {
//     return { detected: true, type: 'BULLISH' as const, index: swingHighIdx };
//   }

//   if (closes[len - 1] < swingLow && swingLowIdx > swingHighIdx) {
//     return { detected: true, type: 'BEARISH' as const, index: swingLowIdx };
//   }

//   return { detected: false };
// }

// function detectCHoCH(candles: any, lookback: number = 30) {
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   const ema20 =
//     closes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
//   const ema50 =
//     closes.slice(-50).reduce((a: number, b: number) => a + b, 0) / 50;
//   const isUptrend = ema20 > ema50;

//   let recentHigh = -Infinity;
//   let recentLow = Infinity;
//   let recentHighIdx = -1;
//   let recentLowIdx = -1;

//   for (let i = len - lookback; i < len - 3; i++) {
//     if (highs[i] > recentHigh) {
//       recentHigh = highs[i];
//       recentHighIdx = i;
//     }
//     if (lows[i] < recentLow) {
//       recentLow = lows[i];
//       recentLowIdx = i;
//     }
//   }

//   if (!isUptrend && closes[len - 1] > recentHigh) {
//     return { detected: true, type: 'BULLISH' as const, index: recentHighIdx };
//   }

//   if (isUptrend && closes[len - 1] < recentLow) {
//     return { detected: true, type: 'BEARISH' as const, index: recentLowIdx };
//   }

//   return { detected: false };
// }

// function calculatePremiumDiscount(
//   currentPrice: number,
//   highs: number[],
//   lows: number[],
//   lookback: number = 50
// ): 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' {
//   const recentHighs = highs.slice(-lookback);
//   const recentLows = lows.slice(-lookback);

//   const highest = Math.max(...recentHighs);
//   const lowest = Math.min(...recentLows);
//   const range = highest - lowest;
//   const upperThreshold = lowest + range * 0.618;
//   const lowerThreshold = lowest + range * 0.382;

//   if (currentPrice >= upperThreshold) return 'PREMIUM';
//   if (currentPrice <= lowerThreshold) return 'DISCOUNT';
//   return 'EQUILIBRIUM';
// }

// function calculateSMCScore(smc: Omit<SMCAnalysis, 'smcScore'>): number {
//   let score = 0;

//   const activeOBs = smc.orderBlocks.filter((ob) => !ob.mitigated);
//   score += Math.min(30, activeOBs.length * 10);

//   const activeFVGs = smc.fvgs.filter((fvg) => !fvg.filled);
//   score += Math.min(20, activeFVGs.length * 7);

//   const recentSweeps = smc.liquidityLevels.filter((l) => l.swept);
//   score += Math.min(20, recentSweeps.length * 10);

//   if (smc.bos.detected) score += 15;
//   if (smc.choch.detected) score += 15;

//   return Math.min(100, score);
// }

// function analyzeSMC(candles: any): SMCAnalysis {
//   const orderBlocks = detectOrderBlocks(candles);
//   const fvgs = detectFairValueGaps(candles);
//   const liquidityLevels = detectLiquidityLevels(candles);
//   const bos = detectBOS(candles);
//   const choch = detectCHoCH(candles);
//   const currentPrice = candles.closes[candles.closes.length - 1];
//   const premiumDiscount = calculatePremiumDiscount(
//     currentPrice,
//     candles.highs,
//     candles.lows
//   );

//   const smcData = {
//     orderBlocks,
//     fvgs,
//     liquidityLevels,
//     bos,
//     choch,
//     premiumDiscount,
//   };

//   const smcScore = calculateSMCScore(smcData);

//   return { ...smcData, smcScore };
// }

// // ============================================================================
// // SIGNAL DETECTION WITH ENTRY PRICE VALIDATION
// // ============================================================================

// function isAtEntryZone(
//   currentPrice: number,
//   entryPrice: number,
//   tolerance: number = 0.003 // 0.3% tolerance
// ): boolean {
//   const diff = Math.abs(currentPrice - entryPrice) / entryPrice;
//   return diff <= tolerance;
// }

// /**
//  * Calculate dynamic confidence based on multiple factors
//  */
// function calculateDynamicConfidence(
//   indicators: Indicators,
//   candles: CandleData,
//   strategy: StrategyId,
//   side: 'LONG' | 'SHORT',
//   smc?: SMCAnalysis
// ): number {
//   let score = 50;

//   // --- LAYER 1: MARKET STRUCTURE (THE FOUNDATION) ---
//   if (smc) {
//     // Boost if price is in the correct zone
//     if (side === 'LONG' && smc.premiumDiscount === 'DISCOUNT') score += 15;
//     if (side === 'SHORT' && smc.premiumDiscount === 'PREMIUM') score += 15;

//     // High SMC Score acts as a direct multiplier
//     score += smc.smcScore / 10;
//   }

//   // --- LAYER 2: MOMENTUM CONFLUENCE ---
//   const { rsi, ema8, ema21, currentPrice } = indicators;

//   if (side === 'LONG') {
//     // Trend Alignment: Price > EMA8 > EMA21
//     if (ema8 && ema21 && currentPrice > ema8 && ema8 > ema21) score += 10;
//     // RSI "Room to grow": Not yet overbought but turning up
//     if (rsi > 45 && rsi < 65) score += 5;
//   } else {
//     if (ema8 && ema21 && currentPrice < ema8 && ema8 < ema21) score += 10;
//     if (rsi < 55 && rsi > 35) score += 5;
//   }

//   // --- LAYER 3: VOLATILITY & VOLUME ---
//   // Using ATR to ensure we aren't trading in a dead market
//   const inVol = indicators.volume as number;
//   const inVolAv = indicators.volumeAverage as number;
//   const volCheck = inVol > inVolAv * 1.2;
//   if (volCheck) score += 10;

//   const factors = calculateConfidenceFactors(indicators, candles, side, smc);
//   const weights = getStrategyWeights(strategy);

//   // Weighted sum of all factors
//   let confidence = factors.baseConfidence;
//   confidence += factors.rsiScore * weights.rsi;
//   confidence += factors.trendScore * weights.trend;
//   confidence += factors.volumeScore * weights.volume;
//   confidence += factors.volatilityScore * weights.volatility;
//   confidence += factors.momentumScore * weights.momentum;

//   if (smc && factors.smcScore && weights.smc) {
//     confidence += factors.smcScore * weights.smc;
//   }

//   // --- LAYER 4: RELATIVE STRENGTH (UNCONVENTIONAL) ---
//   // (Assuming you've integrated the RS logic from earlier)
//   const inRelStrength = indicators.relativeStrength as number;
//   if (inRelStrength > 1.05 && side === 'LONG') score += 15;
//   if (inRelStrength < 0.95 && side === 'SHORT') score += 15;

//   // --- LAYER 5: TIME SENSITIVITY ---
//   const session = getMarketSession();
//   if (session === 'OVERLAP' || session === 'NEW_YORK') score += 10;

//   // Cap between 0-100
//   return Math.max(0, Math.min(100, confidence));
// }

// function detectTrendWithADX(candles: CandleData): {
//   trend: 'UP' | 'DOWN' | 'SIDEWAYS';
//   strength: number;
//   adxValue: number;
// } {
//   // Calculate ADX
//   const adxResult = ADX.calculate({
//     high: candles.highs,
//     low: candles.lows,
//     close: candles.closes,
//     period: 14,
//   });

//   if (adxResult.length === 0) {
//     return { trend: 'SIDEWAYS', strength: 0, adxValue: 0 };
//   }

//   const latest = adxResult[adxResult.length - 1] as ADXOutput;
//   const adxValue = latest.adx;
//   const plusDI = latest.pdi;
//   const minusDI = latest.mdi;

//   // Determine trend direction
//   let trend: 'UP' | 'DOWN' | 'SIDEWAYS';

//   if (plusDI > minusDI) {
//     trend = 'UP';
//   } else if (minusDI > plusDI) {
//     trend = 'DOWN';
//   } else {
//     trend = 'SIDEWAYS';
//   }

//   // ADX interpretation:
//   // < 20: Weak/No trend
//   // 20-25: Emerging trend
//   // 25-50: Strong trend
//   // 50+: Very strong trend

//   let strength = 0;
//   if (adxValue < 20) {
//     trend = 'SIDEWAYS'; // Override - too weak to call a trend
//     strength = adxValue;
//   } else {
//     strength = Math.min(100, adxValue);
//   }

//   return { trend, strength, adxValue };
// }

// function detectTrend(
//   candles: CandleData,
//   lookback: number = 20
// ): TrendAnalysis {
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   if (len < lookback) {
//     return {
//       trend: 'SIDEWAYS',
//       strength: 0,
//       higherHighs: false,
//       higherLows: false,
//     };
//   }

//   // Find swing highs and lows
//   const swingHighs: number[] = [];
//   const swingLows: number[] = [];

//   for (let i = 2; i < len - 2; i++) {
//     // Swing High: Higher than 2 candles on each side
//     const highI = highs[i] as number;
//     const highIM1 = highs[i - 1] as number;
//     const highIP1 = highs[i + 1] as number;
//     const highIM2 = highs[i - 2] as number;
//     const highIP2 = highs[i + 2] as number;
//     const lowsI = lows[i] as number;
//     const lowsM1 = lows[i - 1] as number;
//     const lowsP1 = lows[i + 1] as number;
//     const lowsM2 = lows[i - 2] as number;
//     const lowsP2 = lows[i + 2] as number;
//     if (
//       highI > highIM1 &&
//       highI > highIM2 &&
//       highI > highIP1 &&
//       highI > highIP2
//     ) {
//       swingHighs.push(highI);
//     }

//     // Swing Low: Lower than 2 candles on each side
//     if (lowsI < lowsM1 && lowsI < lowsM2 && lowsI < lowsP1 && lowsI < lowsP2) {
//       swingLows.push(lowsI);
//     }
//   }

//   // Need at least 2 swing points to determine trend
//   if (swingHighs.length < 2 || swingLows.length < 2) {
//     return {
//       trend: 'SIDEWAYS',
//       strength: 0,
//       higherHighs: false,
//       higherLows: false,
//     };
//   }

//   // Check for Higher Highs (uptrend characteristic)
//   const recentHighs = swingHighs.slice(-3) as number[];

//   const higherHighs = recentHighs.every((high, i) => {
//     const recH1 = recentHighs[i - 1] as number;
//     return i === 0 || high > recH1;
//   });

//   // Check for Higher Lows (uptrend characteristic)
//   const recentLows = swingLows.slice(-3);
//   const higherLows = recentLows.every((low, i) => {
//     const recL1 = recentLows[i - 1] as number;
//     return i === 0 || low > recL1;
//   });

//   // Check for Lower Highs (downtrend characteristic)
//   const lowerHighs = recentHighs.every((high, i) => {
//     const recH1 = recentHighs[i - 1] as number;
//     i === 0 || high < recH1;
//   });

//   // Check for Lower Lows (downtrend characteristic)
//   const lowerLows = recentLows.every((low, i) => {
//     const recL1 = recentLows[i - 1] as number;
//     i === 0 || low < recL1;
//   });

//   // Determine trend
//   let trend: 'UP' | 'DOWN' | 'SIDEWAYS';
//   let strength = 0;

//   if (higherHighs && higherLows) {
//     trend = 'UP';
//     strength = 80;
//   } else if (lowerHighs && lowerLows) {
//     trend = 'DOWN';
//     strength = 80;
//   } else if (higherHighs || higherLows) {
//     trend = 'UP';
//     strength = 50; // Weak uptrend
//   } else if (lowerHighs || lowerLows) {
//     trend = 'DOWN';
//     strength = 50; // Weak downtrend
//   } else {
//     trend = 'SIDEWAYS';
//     strength = 0;
//   }

//   return { trend, strength, higherHighs, higherLows };
// }

// /**
//  * Calculate individual confidence factors (0-100 scale, then weighted)
//  */
// export function calculateConfidenceFactors(
//   indicators: Indicators,
//   candles: CandleData,
//   side: 'LONG' | 'SHORT',
//   smc?: SMCAnalysis
// ): ConfidenceFactors {
//   const { rsi, ema8, ema21, ema50, ema200, currentPrice } = indicators;

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // 1. RSI SCORE (0-20 points)
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   let rsiScore = 0;

//   if (side === 'LONG') {
//     // Perfect: RSI 20-35 (deeply oversold but not extreme)
//     // Good: RSI 35-45 (oversold)
//     // OK: RSI 45-50 (neutral-bullish)
//     if (rsi >= 20 && rsi <= 35) {
//       rsiScore = 20; // Maximum score for deep oversold
//     } else if (rsi > 35 && rsi <= 45) {
//       rsiScore = 15 + (45 - rsi) * 0.5; // 15-20 range
//     } else if (rsi > 45 && rsi <= 50) {
//       rsiScore = 10 + (50 - rsi); // 10-15 range
//     } else if (rsi > 50 && rsi <= 55) {
//       rsiScore = 5; // Weak signal
//     } else {
//       rsiScore = 0; // No confidence if RSI > 55
//     }
//   } else {
//     // SHORT: Mirror logic for overbought
//     if (rsi >= 65 && rsi <= 80) {
//       rsiScore = 20;
//     } else if (rsi >= 55 && rsi < 65) {
//       rsiScore = 15 + (rsi - 55) * 0.5;
//     } else if (rsi >= 50 && rsi < 55) {
//       rsiScore = 10 + (rsi - 50);
//     } else if (rsi >= 45 && rsi < 50) {
//       rsiScore = 5;
//     } else {
//       rsiScore = 0;
//     }
//   }

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // 2. TREND SCORE (0-20 points)
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   let trendScore = 0;

//   if (ema8 && ema21 && ema50 && ema200) {
//     if (side === 'LONG') {
//       // Perfect alignment: EMA8 > EMA21 > EMA50 > EMA200
//       const bullishAlignment = ema8 > ema21 && ema21 > ema50 && ema50 > ema200;

//       if (bullishAlignment) {
//         trendScore = 20;
//       } else if (ema8 > ema21 && ema21 > ema50) {
//         trendScore = 15; // Strong trend
//       } else if (ema8 > ema21) {
//         trendScore = 10; // Moderate trend
//       } else if (currentPrice > ema21) {
//         trendScore = 5; // Weak trend
//       }

//       // Bonus for strong separation
//       const separation = ((ema8 - ema21) / ema21) * 100;
//       if (separation > 2) trendScore += 5;
//       else if (separation > 1) trendScore += 3;
//     } else {
//       // SHORT: Bearish alignment
//       const bearishAlignment = ema8 < ema21 && ema21 < ema50 && ema50 < ema200;

//       if (bearishAlignment) {
//         trendScore = 20;
//       } else if (ema8 < ema21 && ema21 < ema50) {
//         trendScore = 15;
//       } else if (ema8 < ema21) {
//         trendScore = 10;
//       } else if (currentPrice < ema21) {
//         trendScore = 5;
//       }

//       const separation = ((ema21 - ema8) / ema21) * 100;
//       if (separation > 2) trendScore += 5;
//       else if (separation > 1) trendScore += 3;
//     }
//   }

//   trendScore = Math.min(25, trendScore); // Cap at 25

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // 3. VOLUME SCORE (0-15 points)
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   let volumeScore = 0;

//   if (candles.volumes && candles.volumes.length >= 20) {
//     const recentVolume = candles.volumes[candles.volumes.length - 1] as number;
//     const avgVolume =
//       candles.volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
//     const volumeRatio = recentVolume / avgVolume;

//     // High volume = more confidence
//     if (volumeRatio > 2.0) {
//       volumeScore = 15; // Exceptional volume
//     } else if (volumeRatio > 1.5) {
//       volumeScore = 12; // High volume
//     } else if (volumeRatio > 1.2) {
//       volumeScore = 8; // Above average
//     } else if (volumeRatio > 0.8) {
//       volumeScore = 5; // Normal
//     } else {
//       volumeScore = 0; // Low volume - reduce confidence
//     }
//   } else {
//     volumeScore = 5; // Default if no volume data
//   }

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // 4. VOLATILITY SCORE (0-10 points)
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   let volatilityScore = 0;

//   if (candles.highs.length >= 20) {
//     // Calculate ATR (Average True Range) as volatility proxy
//     const ranges = [];
//     for (let i = 1; i < Math.min(20, candles.closes.length); i++) {
//       const high = candles.highs[candles.highs.length - i] as number;
//       const low = candles.lows[candles.lows.length - i] as number;
//       const prevClose = candles.closes[candles.closes.length - i - 1] as number;

//       const tr = Math.max(
//         high - low,
//         Math.abs(high - prevClose),
//         Math.abs(low - prevClose)
//       ) as number;
//       ranges.push(tr);
//     }

//     const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
//     const atrPercent = (atr / currentPrice) * 100;

//     // Moderate volatility is good (1-3%)
//     if (atrPercent >= 1 && atrPercent <= 3) {
//       volatilityScore = 10; // Optimal volatility
//     } else if (atrPercent > 3 && atrPercent <= 5) {
//       volatilityScore = 7; // High volatility
//     } else if (atrPercent < 1) {
//       volatilityScore = 5; // Low volatility
//     } else {
//       volatilityScore = 3; // Extreme volatility
//     }
//   } else {
//     volatilityScore = 5; // Default
//   }

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // 5. MOMENTUM SCORE (0-15 points)
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   let momentumScore = 0;
//   const closes = candles?.closes ?? [];

//   if (closes?.length >= 5) {
//     const recentCloses = closes.slice(-5) as number[];
//     const firstClose = recentCloses[0];
//     const lastClose = recentCloses[4];

//     // Add type guard to ensure values exist
//     if (firstClose !== undefined && lastClose !== undefined) {
//       const priceChange = ((lastClose - firstClose) / firstClose) * 100;

//       if (side === 'LONG') {
//         // Positive momentum for LONG
//         if (priceChange > 2) {
//           momentumScore = 15;
//         } else if (priceChange > 1) {
//           momentumScore = 12;
//         } else if (priceChange > 0.5) {
//           momentumScore = 8;
//         } else if (priceChange > 0) {
//           momentumScore = 5;
//         } else {
//           momentumScore = 0; // Negative momentum
//         }
//       } else {
//         // Negative momentum for SHORT
//         if (priceChange < -2) {
//           momentumScore = 15;
//         } else if (priceChange < -1) {
//           momentumScore = 12;
//         } else if (priceChange < -0.5) {
//           momentumScore = 8;
//         } else if (priceChange < 0) {
//           momentumScore = 5;
//         } else {
//           momentumScore = 0;
//         }
//       }
//     } else {
//       momentumScore = 5; // Default if values are undefined
//     }
//   } else {
//     momentumScore = 5; // Default
//   }

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // 6. SMC SCORE (0-30 points if applicable)
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   let smcScore = 0;

//   if (smc) {
//     // Convert SMC score (0-100) to confidence contribution (0-30)
//     smcScore = (smc.smcScore / 100) * 30;

//     // Bonus for key SMC conditions
//     const activeOBs = smc.orderBlocks.filter((ob) => !ob.mitigated);
//     const activeFVGs = smc.fvgs.filter((fvg) => !fvg.filled);

//     if (side === 'LONG' && smc.premiumDiscount === 'DISCOUNT') {
//       smcScore += 5; // Buying in discount
//     } else if (side === 'SHORT' && smc.premiumDiscount === 'PREMIUM') {
//       smcScore += 5; // Selling in premium
//     }

//     if (side === 'LONG' && smc.bos.type === 'BULLISH') {
//       smcScore += 3;
//     } else if (side === 'SHORT' && smc.bos.type === 'BEARISH') {
//       smcScore += 3;
//     }

//     smcScore = Math.min(35, smcScore); // Cap at 35
//   }

//   return {
//     baseConfidence: 30, // Starting point
//     rsiScore,
//     trendScore,
//     volumeScore,
//     volatilityScore,
//     momentumScore,
//     smcScore,
//   };
// }

// // function calculateConfidence(
// //   indicators: Indicators,
// //   candles: CandleData,
// //   side: 'LONG' | 'SHORT',
// //   smc?: SMCAnalysis
// // ): number {
// //   // Calculate confidence factors
// //   const factors = calculateConfidenceFactors(
// //     indicators,
// //     candles,
// //     side,
// //     smc
// //   ) as ConfidenceFactors;

// //   // Sum all factors for total confidence
// //   let confidence = factors.baseConfidence as number;
// //   confidence += factors.rsiScore;
// //   confidence += factors.trendScore;
// //   confidence += factors.volumeScore;
// //   confidence += factors.volatilityScore;
// //   confidence += factors.momentumScore;
// //   confidence += factors.smcScore!;

// //   // Check for conflicting signals
// //   const conflicts = detectConflictingSignals(indicators, smc || null, side);

// //   if (conflicts.hasConflict) {
// //     console.log(
// //       `âš ï¸ Conflicting signals: ${conflicts.reason} - reducing confidence`,
// //       'warning'
// //     );
// //     confidence = Math.max(0, confidence - conflicts.penalty);
// //   }

// //   // Ensure confidence is within bounds (0-100)
// //   confidence = Math.min(100, Math.max(0, confidence));

// //   return confidence;
// // }

// // Helper function to detect conflicting signals
// function detectConflictingSignals(
//   indicators: Indicators,
//   smc: SMCAnalysis | null,
//   side: 'LONG' | 'SHORT'
// ): {
//   hasConflict: boolean;
//   reason: string;
//   penalty: number;
// } {
//   const { rsi, ema8, ema21 } = indicators;
//   const conflicts = [];
//   let penalty = 0;

//   // RSI conflict
//   if (side === 'LONG' && rsi > 70) {
//     conflicts.push('RSI overbought for LONG');
//     penalty += 20;
//   } else if (side === 'SHORT' && rsi < 30) {
//     conflicts.push('RSI oversold for SHORT');
//     penalty += 20;
//   }

//   // EMA conflict
//   if (ema8 && ema21) {
//     if (side === 'LONG' && ema8 < ema21) {
//       conflicts.push('EMA8 below EMA21 for LONG');
//       penalty += 15;
//     } else if (side === 'SHORT' && ema8 > ema21) {
//       conflicts.push('EMA8 above EMA21 for SHORT');
//       penalty += 15;
//     }
//   }

//   // SMC conflict
//   if (smc) {
//     if (side === 'LONG' && smc.premiumDiscount === 'PREMIUM') {
//       conflicts.push('Buying in PREMIUM zone');
//       penalty += 10;
//     } else if (side === 'SHORT' && smc.premiumDiscount === 'DISCOUNT') {
//       conflicts.push('Selling in DISCOUNT zone');
//       penalty += 10;
//     }
//   }

//   return {
//     hasConflict: conflicts.length > 0,
//     reason: conflicts.join(', '),
//     penalty: penalty,
//   };
// }

// /**
//  * Get weights for different strategies
//  */
// function getStrategyWeights(strategy: string): ConfidenceWeights {
//   const weights: Record<string, ConfidenceWeights> = {
//     // SMC strategies prioritize SMC factors
//     SMC_LONG: {
//       rsi: 0.5,
//       trend: 0.6,
//       volume: 0.4,
//       volatility: 0.3,
//       momentum: 0.5,
//       smc: 1.0, // Full weight to SMC
//     },
//     SMC_SHORT: {
//       rsi: 0.5,
//       trend: 0.6,
//       volume: 0.4,
//       volatility: 0.3,
//       momentum: 0.5,
//       smc: 1.0,
//     },

//     // RSI strategies prioritize RSI and momentum
//     RSI_DIVERGENCE: {
//       rsi: 1.2, // Extra weight on RSI
//       trend: 0.6,
//       volume: 0.5,
//       volatility: 0.4,
//       momentum: 0.8,
//       smc: 0.3,
//     },

//     // Breakout strategies prioritize momentum and volume
//     BREAKOUT: {
//       rsi: 0.4,
//       trend: 0.8,
//       volume: 1.0, // Volume is key for breakouts
//       volatility: 0.5,
//       momentum: 1.0, // Momentum is key
//       smc: 0.3,
//     },
//     BREAKDOWN: {
//       rsi: 0.4,
//       trend: 0.8,
//       volume: 1.0,
//       volatility: 0.5,
//       momentum: 1.0,
//       smc: 0.3,
//     },

//     // EMA strategies prioritize trend
//     EMA_PULLBACK: {
//       rsi: 0.6,
//       trend: 1.2, // Extra weight on trend
//       volume: 0.5,
//       volatility: 0.4,
//       momentum: 0.6,
//       smc: 0.3,
//     },

//     // Fibonacci strategies balanced
//     FIB_RETRACEMENT: {
//       rsi: 0.7,
//       trend: 0.8,
//       volume: 0.6,
//       volatility: 0.5,
//       momentum: 0.7,
//       smc: 0.4,
//     },

//     // FVG and Liquidity sweeps (SMC-based)
//     FVG_FILL: {
//       rsi: 0.5,
//       trend: 0.6,
//       volume: 0.5,
//       volatility: 0.4,
//       momentum: 0.6,
//       smc: 1.0,
//     },
//     LIQUIDITY_SWEEP: {
//       rsi: 0.5,
//       trend: 0.6,
//       volume: 0.7,
//       volatility: 0.5,
//       momentum: 0.7,
//       smc: 1.0,
//     },

//     // Default weights
//     DEFAULT: {
//       rsi: 0.8,
//       trend: 0.8,
//       volume: 0.6,
//       volatility: 0.4,
//       momentum: 0.7,
//       smc: 0.5,
//     },
//   };

//   return weights[strategy] || (weights['DEFAULT'] as ConfidenceWeights);
// }

// const MIN_CONFIDENCE = {
//   SMC_LONG: 70,
//   SMC_SHORT: 70,
//   FVG_FILL: 65,
//   LIQUIDITY_SWEEP: 70,
//   LIQUIDITY_RECLAIM: 75,
//   BREAKOUT: 65,
//   EMA_PULLBACK: 60,
//   FIB_RETRACEMENT: 70, // ðŸ”¥ Raise this if FIB is too common
//   RSI_DIVERGENCE: 55,
//   BREAKDOWN: 65,
// };

// function detectSignal(
//   symbol: string,
//   indicators: Indicators,
//   candles: CandleData,
//   smc?: SMCAnalysis
// ): EntrySignal[] {
//   const longSignals: EntrySignal[] = [];
//   const shortSignals: EntrySignal[] = [];
//   const { currentPrice, rsi, ema8, ema21, ema50, ema200 } = indicators;

//   // Default risk/reward for all strategies
//   const DEFAULT_STOP_LOSS_PERCENT = 0.01; // 1%
//   const DEFAULT_TAKE_PROFIT_PERCENT = 0.03; // 3%

//   // ============= SMC SIGNALS (CHECK FIRST - HIGHEST PRIORITY) =============

//   const currentZone = smc?.premiumDiscount || 'EQUILIBRIUM';

//   const inDelta = indicators.delta as number;
//   const inVol = indicators.volume as number;
//   const inVolPct = inVol * 0.1;

//   if (smc && SCAN_CONFIG.smcEnabled) {
//     // ðŸ”· SMC LONG SIGNALS
//     const bullishOB = smc.orderBlocks.find(
//       (ob) => ob.type === 'BULLISH' && !ob.mitigated
//     );

//     const bearishOB = smc.orderBlocks.find(
//       (ob) => ob.type === 'BEARISH' && !ob.mitigated
//     );

//     // Priority 1: Strong SMC Setup (OB + Discount + BOS/CHoCH)
//     if (
//       bullishOB &&
//       smc.premiumDiscount === 'DISCOUNT' &&
//       inDelta > 0 && // Positive Delta (Aggressive Buyers)
//       inDelta > inVolPct && // Increasing Volume
//       (smc.bos.type === 'BULLISH' || smc.choch.type === 'BULLISH')
//     ) {
//       const confidence = Math.min(98, 85 + (inDelta / inVol) * 100);
//       longSignals.push({
//         symbol,
//         strategy: 'SMC_LONG',
//         side: 'LONG',
//         reason: `SMC: Bullish OB in discount + ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)}`,
//         confidence,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 0.99,
//         // takeProfit: currentPrice * 1.03,
//         timestamp: new Date(),
//       });
//     }
//     // Priority 2: Moderate SMC Setup (OB + Discount)
//     else if (
//       bullishOB &&
//       smc.premiumDiscount === 'DISCOUNT' &&
//       smc.smcScore >= 40
//     ) {
//       const confidence = Math.min(85, 65 + smc.smcScore * 0.2);
//       longSignals.push({
//         symbol,
//         strategy: 'SMC_LONG',
//         side: 'LONG',
//         reason: `SMC: Bullish OB in discount zone. Score: ${smc.smcScore.toFixed(0)}`,
//         confidence,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 0.99,
//         // takeProfit: currentPrice * 1.03,
//         timestamp: new Date(),
//       });
//     }
//     // Priority 3: BOS/CHoCH alone (high score)
//     else if (
//       (smc.bos.type === 'BULLISH' || smc.choch.type === 'BULLISH') &&
//       smc.smcScore >= 50
//     ) {
//       const confidence = Math.min(80, 60 + smc.smcScore * 0.3);
//       longSignals.push({
//         symbol,
//         strategy: 'SMC_LONG',
//         side: 'LONG',
//         reason: `SMC: Bullish ${smc.bos.detected ? 'BOS' : 'CHoCH'} detected. Score: ${smc.smcScore.toFixed(0)}`,
//         confidence,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 0.99,
//         // takeProfit: currentPrice * 1.03,
//         timestamp: new Date(),
//       });
//     }

//     // ðŸ”· FVG Fill Signals (LONG)
//     const bullishFVG = smc.fvgs.find((fvg) => {
//       if (fvg.type !== 'BULLISH' || fvg.filled) return false;

//       // Calculate gap size
//       const gapSize = ((fvg.top - fvg.bottom) / fvg.bottom) * 100;

//       // Only trade gaps between 0.3% and 2%
//       return gapSize >= 0.3 && gapSize <= 2.0;
//     });
//     if (
//       bullishFVG &&
//       currentPrice >= bullishFVG.bottom &&
//       currentPrice <= bullishFVG.top
//     ) {
//       longSignals.push({
//         symbol,
//         strategy: 'FVG_FILL',
//         side: 'LONG',
//         reason: `Price in bullish FVG zone. Expected bounce from ${bullishFVG.bottom.toFixed(2)}`,
//         confidence: 72,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 0.99,
//         // takeProfit: currentPrice * 1.03,
//         timestamp: new Date(),
//       });
//     }

//     // ðŸ”· Liquidity Sweep Signals (LONG)
//     const sweptLow = smc.liquidityLevels.find(
//       (l) => l.type === 'LOW' && l.swept && l.strength > 60
//     );
//     // if (sweptLow && currentPrice > sweptLow.price * 1.001) {
//     //   longSignals.push({
//     //     symbol,
//     //     strategy: 'LIQUIDITY_SWEEP',
//     //     side: 'LONG',
//     //     reason: `Liquidity swept below ${sweptLow.price.toFixed(2)}. Reversal expected`,
//     //     confidence: 75,
//     //     // entryPrice: currentPrice,
//     //     // stopLoss: currentPrice * 0.99,
//     //     // takeProfit: currentPrice * 1.03,
//     //     timestamp: new Date(),
//     //   });
//     // }

//     if (sweptLow) {
//       const prevLow = candles.lows[candles.lows.length - 2] as number;
//       const currentClose = candles.closes[candles.closes.length - 1] as number;

//       // THE UNCONVENTIONAL CONDITION:
//       // Was the low broken (Liquidity Taken) AND did we close back above?
//       const didSweep = prevLow < sweptLow.price;
//       const didReclaim = currentClose > sweptLow.price;

//       if (didSweep && didReclaim) {
//         longSignals.push({
//           symbol,
//           strategy: 'LIQUIDITY_RECLAIM',
//           side: 'LONG',
//           reason: `V-Shape Reclaim: Swept ${sweptLow.price.toFixed(2)} and closed above.`,
//           confidence: calculateDynamicConfidence(
//             indicators,
//             candles,
//             'LIQUIDITY_RECLAIM',
//             'LONG',
//             smc
//           ),
//           timestamp: new Date(),
//         });
//       }
//     }

//     // ðŸ”· SMC SHORT SIGNALS
//     // const bearishOB = smc.orderBlocks.find(
//     //   (ob) => ob.type === 'BEARISH' && !ob.mitigated
//     // );

//     // Priority 1: Strong SMC Setup (OB + Premium + BOS/CHoCH)
//     if (
//       bearishOB &&
//       smc.premiumDiscount === 'PREMIUM' &&
//       (smc.bos.type === 'BEARISH' || smc.choch.type === 'BEARISH')
//     ) {
//       const confidence = Math.min(95, 75 + smc.smcScore * 0.2);
//       shortSignals.push({
//         symbol,
//         strategy: 'SMC_SHORT',
//         side: 'SHORT',
//         reason: `SMC: Bearish OB in premium + ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)}`,
//         confidence,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 1.01,
//         // takeProfit: currentPrice * 0.97,
//         timestamp: new Date(),
//       });
//     }
//     // Priority 2: Moderate SMC Setup (OB + Premium)
//     else if (
//       bearishOB &&
//       smc.premiumDiscount === 'PREMIUM' &&
//       smc.smcScore >= 40
//     ) {
//       const confidence = Math.min(85, 65 + smc.smcScore * 0.2);
//       shortSignals.push({
//         symbol,
//         strategy: 'SMC_SHORT',
//         side: 'SHORT',
//         reason: `SMC: Bearish OB in premium zone. Score: ${smc.smcScore.toFixed(0)}`,
//         confidence,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 1.01,
//         // takeProfit: currentPrice * 0.97,
//         timestamp: new Date(),
//       });
//     }
//     // Priority 3: BOS/CHoCH alone
//     else if (
//       (smc.bos.type === 'BEARISH' || smc.choch.type === 'BEARISH') &&
//       smc.smcScore >= 50
//     ) {
//       const confidence = Math.min(80, 60 + smc.smcScore * 0.3);
//       shortSignals.push({
//         symbol,
//         strategy: 'SMC_SHORT',
//         side: 'SHORT',
//         reason: `SMC: Bearish ${smc.bos.detected ? 'BOS' : 'CHoCH'} detected. Score: ${smc.smcScore.toFixed(0)}`,
//         confidence,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 1.01,
//         // takeProfit: currentPrice * 0.97,
//         timestamp: new Date(),
//       });
//     }

//     // ðŸ”· FVG Fill Signals (SHORT)
//     const bearishFVG = smc.fvgs.find((fvg) => {
//       if (fvg.type !== 'BULLISH' || fvg.filled) return false;

//       // Calculate gap size
//       const gapSize = ((fvg.top - fvg.bottom) / fvg.bottom) * 100;

//       // Only trade gaps between 0.3% and 2%
//       return gapSize >= 0.3 && gapSize <= 2.0;
//     });
//     if (
//       bearishFVG &&
//       currentPrice >= bearishFVG.bottom &&
//       currentPrice <= bearishFVG.top
//     ) {
//       shortSignals.push({
//         symbol,
//         strategy: 'FVG_FILL',
//         side: 'SHORT',
//         reason: `Price in bearish FVG zone. Expected drop from ${bearishFVG.top.toFixed(2)}`,
//         confidence: 72,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 1.01,
//         // takeProfit: currentPrice * 0.97,
//         timestamp: new Date(),
//       });
//     }

//     // ðŸ”· Liquidity Sweep Signals (SHORT)
//     const sweptHigh = smc.liquidityLevels.find(
//       (l) => l.type === 'HIGH' && l.swept && l.strength > 60
//     );
//     if (sweptHigh && currentPrice < sweptHigh.price * 0.999) {
//       shortSignals.push({
//         symbol,
//         strategy: 'LIQUIDITY_SWEEP',
//         side: 'SHORT',
//         reason: `Liquidity swept above ${sweptHigh.price.toFixed(2)}. Reversal expected`,
//         confidence: 75,
//         // entryPrice: currentPrice,
//         // stopLoss: currentPrice * 1.01,
//         // takeProfit: currentPrice * 0.97,
//         timestamp: new Date(),
//       });
//     }
//   }

//   // ============= TRADITIONAL LONG SIGNALS =============

//   const breakout = detectBreakout(indicators, candles);
//   if (breakout) {
//     longSignals.push({
//       symbol,
//       strategy: 'BREAKOUT',
//       side: 'LONG',
//       reason: breakout.reason,
//       confidence: breakout.confidence,
//       // entryPrice: currentPrice,
//       // stopLoss: currentPrice * 0.99,
//       // takeProfit: currentPrice * 1.03,
//       timestamp: new Date(),
//     });
//   }

//   const pullback = detectEmaPullback(indicators);
//   if (pullback) {
//     longSignals.push({
//       symbol,
//       strategy: 'EMA_PULLBACK',
//       side: 'LONG',
//       reason: pullback.reason,
//       confidence: pullback.confidence,
//       // entryPrice: currentPrice,
//       // stopLoss: currentPrice * 0.99,
//       // takeProfit: currentPrice * 1.03,
//       timestamp: new Date(),
//     });
//   }

//   const fib = detectFibRetracement(indicators);
//   if (fib && fib.confidence >= MIN_CONFIDENCE.FIB_RETRACEMENT) {
//     longSignals.push({
//       symbol,
//       strategy: 'FIB_RETRACEMENT',
//       side: 'LONG',
//       reason: fib.reason,
//       confidence: fib.confidence,
//       // entryPrice: currentPrice,
//       // stopLoss: currentPrice * 0.99,
//       // takeProfit: currentPrice * 1.03,
//       timestamp: new Date(),
//     });
//   }

//   // RSI Oversold
//   if (
//     rsi < 35 &&
//     (!smc ||
//       smc.premiumDiscount === 'DISCOUNT' ||
//       smc.premiumDiscount === 'EQUILIBRIUM')
//   ) {
//     const confidence = 55 + (35 - rsi) * 1.0;
//     longSignals.push({
//       symbol,
//       strategy: 'RSI_DIVERGENCE',
//       side: 'LONG',
//       reason: `Oversold RSI ${rsi.toFixed(1)} in ${smc?.premiumDiscount || 'neutral'} zone`,
//       confidence: Math.min(70, confidence),
//       timestamp: new Date(),
//     });
//   }

//   // ============= TRADITIONAL SHORT SIGNALS =============

//   const breakdown = detectBreakdown(indicators);
//   if (breakdown) {
//     shortSignals.push({
//       symbol,
//       strategy: 'BREAKDOWN',
//       side: 'SHORT',
//       reason: breakdown.reason,
//       confidence: breakdown.confidence,
//       // entryPrice: currentPrice,
//       // stopLoss: currentPrice * 1.01,
//       // takeProfit: currentPrice * 0.97,
//       timestamp: new Date(),
//     });
//   }

//   // RSI Overbought - ONLY in PREMIUM zone
//   // if (
//   //   rsi > 65 &&
//   //   (!smc ||
//   //     smc.premiumDiscount === 'PREMIUM' ||
//   //     smc.premiumDiscount === 'EQUILIBRIUM')
//   // ) {
//   //   const confidence = 55 + (rsi - 65) * 1.0;
//   //   shortSignals.push({
//   //     symbol,
//   //     strategy: 'RSI_DIVERGENCE',
//   //     side: 'SHORT',
//   //     reason: `Overbought RSI ${rsi.toFixed(2)} in ${smc?.premiumDiscount || 'neutral'} zone`,
//   //     confidence: Math.min(70, confidence),
//   //     timestamp: new Date(),
//   //   });
//   // }
//   const shouldShort = (
//     rsi: number,
//     smc?: { premiumDiscount: string }
//   ): { trade: boolean; confidence: number; reason: string } => {
//     // Rule 1: Must have SMC data
//     if (!smc) {
//       return { trade: false, confidence: 0, reason: 'No SMC data' };
//     }

//     // Rule 2: Different thresholds based on funding
//     let rsiThreshold = 68;
//     let confidenceMultiplier = 1.0;

//     switch (smc.premiumDiscount) {
//       case 'PREMIUM':
//         rsiThreshold = 65; // Lower threshold when premium (better for short)
//         confidenceMultiplier = 1.3;
//         break;
//       case 'EQUILIBRIUM':
//         rsiThreshold = 70; // Higher threshold when neutral
//         confidenceMultiplier = 1.0;
//         break;
//       case 'DISCOUNT':
//         rsiThreshold = 75; // Much higher threshold when discount (harder to short)
//         confidenceMultiplier = 0.7;
//         break;
//     }

//     // Rule 3: Check RSI
//     if (rsi <= rsiThreshold) {
//       return {
//         trade: false,
//         confidence: 0,
//         reason: `RSI ${rsi.toFixed(1)} below threshold ${rsiThreshold}`,
//       };
//     }

//     // Calculate dynamic confidence
//     const rsiExcess = rsi - rsiThreshold;
//     const baseConfidence = 55;
//     let confidence = baseConfidence + rsiExcess * 2 * confidenceMultiplier;

//     // Apply caps
//     confidence = Math.min(90, Math.max(60, confidence));

//     return {
//       trade: true,
//       confidence: Math.round(confidence),
//       reason: `RSI ${rsi.toFixed(1)} in ${smc.premiumDiscount} funding zone`,
//     };
//   };

//   // Usage
//   const signalCheck = shouldShort(rsi, smc);
//   if (signalCheck.trade) {
//     shortSignals.push({
//       symbol,
//       strategy: 'RSI_DIVERGENCE',
//       side: 'SHORT',
//       reason: signalCheck.reason,
//       confidence: signalCheck.confidence,
//       timestamp: new Date(),
//     });
//   }

//   const filteredLongSignals = longSignals.filter(
//     (s) =>
//       s.confidence >=
//       (MIN_CONFIDENCE[s.strategy as keyof typeof MIN_CONFIDENCE] || 60)
//   );
//   // console.log('ðŸ¥‘ ~ detectSignal ~ filteredLongSignals:', filteredLongSignals);

//   const filteredShortSignals = shortSignals.filter(
//     (s) =>
//       s.confidence >=
//       (MIN_CONFIDENCE[s.strategy as keyof typeof MIN_CONFIDENCE] || 60)
//   );
//   // console.log(
//   //   'ðŸ¥‘ ~ detectSignal ~ filteredShortSignals:',
//   //   filteredShortSignals
//   // );

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // CONFLICT RESOLUTION (Simplified)
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//   const signals: EntrySignal[] = [];

//   if (longSignals.length > 0 && shortSignals.length > 0) {
//     // Find best signals on each side
//     const bestLong = longSignals.reduce((a, b) =>
//       a.confidence > b.confidence ? a : b
//     );
//     const bestShort = shortSignals.reduce((a, b) =>
//       a.confidence > b.confidence ? a : b
//     );

//     // Only take a trade if there's a clear winner (15% difference)
//     if (bestLong.confidence > bestShort.confidence + 15) {
//       signals.push(bestLong);
//     } else if (bestShort.confidence > bestLong.confidence + 15) {
//       signals.push(bestShort);
//     }
//     // Otherwise skip - too ambiguous
//   } else if (longSignals.length > 0) {
//     signals.push(...longSignals);
//   } else if (shortSignals.length > 0) {
//     signals.push(...shortSignals);
//   }

//   return signals.filter((s) => s !== null && s !== undefined);
// }

// // ============================================================================
// // FIXED: detectBreakout - More Lenient
// // ============================================================================

// // function detectBreakout(
// //   indicators: Indicators
// // ): { confidence: number; reason: string } | null {
// //   const { currentPrice, ema8, ema21, ema50, ema200, rsi } = indicators;

// //   // âœ… RELAXED: Just need price > EMA21 and upward momentum
// //   if (
// //     ema8 &&
// //     ema21 &&
// //     currentPrice > ema21 &&
// //     ema8 > ema21 &&
// //     rsi > 45 &&
// //     rsi < 80 // âœ… Wider range
// //   ) {
// //     let confidence = 60;

// //     if (ema21 > ema50) confidence += 5;
// //     if (currentPrice > ema200) confidence += 5;
// //     if (rsi > 50 && rsi < 70) confidence += 5;
// //     if (ema8 > ema50 * 1.01) confidence += 5;
// //     if (currentPrice > ema21 * 1.02) confidence += 5;

// //     return {
// //       confidence: Math.min(95, confidence),
// //       reason: `Breakout above EMA21 with momentum`,
// //     };
// //   }
// //   return null;
// // }

// function detectBreakout(indicators: Indicators, candles: CandleData) {
//   const { currentPrice, ema8, ema21, rsi, volume, volumeAverage } = indicators;
//   const lastCandle = {
//     open: candles.opens[candles.opens.length - 1],
//     high: candles.highs[candles.highs.length - 1],
//     low: candles.lows[candles.lows.length - 1],
//     close: candles.closes[candles.closes.length - 1],
//   };

//   const inVol = indicators.volume as number;
//   const inVolAv = indicators.volumeAverage as number;
//   const inEma8 = indicators.ema8 as number;
//   const inEma21 = indicators.ema21 as number;
//   const lastCanHigh = lastCandle.high as number;
//   const lastCanLow = lastCandle.low as number;
//   const lastCanClose = lastCandle.close as number;
//   const lastCanOpen = lastCandle.open as number;

//   // 1. Calculate Relative Volume (RVOL)
//   const rvol = inVol / inVolAv;

//   // 2. Calculate "Body Intensity" (Body vs total candle range)
//   const candleRange = lastCanHigh - lastCanLow;
//   const bodySize = Math.abs(lastCanClose - lastCanOpen);
//   const bodyIntensity = bodySize / candleRange; // > 0.7 means a "full" solid candle

//   // ðŸ”´ ANTI-TRAP FILTER: Is it a "Blow-off Top"?
//   // If price is > 3% away from EMA8, it's overextended (The "Rubber Band" effect)
//   const extension = (currentPrice - inEma8) / inEma8;
//   if (extension > 0.03) return null; // Skip - too far from support

//   // âœ… VALIDATION LOGIC
//   if (currentPrice > inEma21 && inEma8 > inEma21 && rsi > 45 && rsi < 75) {
//     let confidence = 60;

//     // Confluence Boosts
//     if (rvol > 2.0) confidence += 20; // Massive participation
//     if (bodyIntensity > 0.7) confidence += 10; // High conviction (no long upper wick)

//     // The "Sweet Spot": Volume is high but price isn't overextended yet
//     if (rvol > 1.5 && extension < 0.015) confidence += 15;

//     return {
//       confidence: Math.min(99, confidence),
//       reason: `Breakout validated by RVOL(${rvol.toFixed(1)}x) and BodyIntensity`,
//     };
//   }
//   return null;
// }

// // ============================================================================
// // âœ… STEP 4: Relaxed detectBreakdown
// // ============================================================================

// function detectBreakdown(
//   indicators: Indicators
// ): { confidence: number; reason: string } | null {
//   const { currentPrice, ema8, ema21, ema50, ema200, rsi } = indicators;

//   // âœ… RELAXED: Just need price < EMA21 and downward momentum
//   if (
//     ema8 &&
//     ema21 &&
//     currentPrice < ema21 &&
//     ema8 < ema21 &&
//     rsi < 55 &&
//     rsi > 20 // âœ… Wider range
//   ) {
//     let confidence = 60;

//     if (ema21 < ema50) confidence += 5;
//     if (currentPrice < ema200) confidence += 5;
//     if (rsi < 50 && rsi > 30) confidence += 5;
//     if (ema8 < ema50 * 0.99) confidence += 5;
//     if (currentPrice < ema21 * 0.98) confidence += 5;

//     return {
//       confidence: Math.min(95, confidence),
//       reason: `Breakdown below EMA21 with bearish momentum`,
//     };
//   }
//   return null;
// }

// function detectEmaPullback(
//   indicators: Indicators
// ): { confidence: number; reason: string } | null {
//   const { currentPrice, ema8, ema21, ema50, rsi } = indicators;

//   if (
//     ema8 &&
//     ema21 &&
//     ema8 > ema21 &&
//     ema21 > ema50 &&
//     currentPrice >= ema21 * 0.995 &&
//     currentPrice <= ema21 * 1.005 &&
//     rsi > 40 &&
//     rsi < 60
//   ) {
//     let confidence = 65;
//     if (rsi > 45 && rsi < 55) confidence += 10;
//     if (ema8 > ema50 * 1.01) confidence += 5;

//     return {
//       confidence: Math.min(90, confidence),
//       reason: `Price pulling back to EMA21 support in uptrend`,
//     };
//   }
//   return null;
// }

// function detectFibRetracement(
//   indicators: Indicators
// ): { confidence: number; reason: string } | null {
//   const { currentPrice, ema21, ema50, rsi } = indicators;

//   // For Fibonacci retracement, we need swing high and swing low
//   // Assuming ema21 is the recent swing point and ema50 is the previous swing point
//   const swingHigh = ema21 && (Math.max(ema21, ema50) as number);
//   const swingLow = ema21 && (Math.min(ema21, ema50) as number);

//   if (!swingHigh || !swingLow) {
//     throw new Error('No data');
//   }
//   const diff = swingHigh - swingLow;

//   // Calculate Fibonacci retracement levels (for a pullback)
//   const fib236 = swingHigh - diff * 0.236; // 23.6%
//   const fib382 = swingHigh - diff * 0.382; // 38.2%
//   const fib500 = swingHigh - diff * 0.5; // 50.0%
//   const fib618 = swingHigh - diff * 0.618; // 61.8%
//   const fib786 = swingHigh - diff * 0.786; // 78.6%

//   // Define tolerance for price matching
//   const tolerance = 0.005; // 0.5%

//   // Check if price is near key Fibonacci levels during pullback
//   // For bullish retracement: price should be in pullback after an uptrend
//   if (ema21 > ema50) {
//     const isNearLevel = (level: number) =>
//       currentPrice >= level * (1 - tolerance) &&
//       currentPrice <= level * (1 + tolerance);

//     // Check 61.8% retracement (deep but common)
//     if (isNearLevel(fib618) && rsi > 30 && rsi < 70) {
//       return {
//         confidence: 75,
//         reason: `Price at 61.8% Fibonacci retracement in uptrend`,
//       };
//     }

//     // Check 38.2% retracement (shallow)
//     if (isNearLevel(fib382) && rsi > 40 && rsi < 65) {
//       return {
//         confidence: 70,
//         reason: `Price at 38.2% Fibonacci retracement in uptrend`,
//       };
//     }

//     // Check 50% retracement
//     if (isNearLevel(fib500) && rsi > 35 && rsi < 65) {
//       return {
//         confidence: 72,
//         reason: `Price at 50% Fibonacci retracement in uptrend`,
//       };
//     }
//   }

//   // For bearish retracement: price should be in pullback after a downtrend
//   if (ema21 && ema21 < ema50) {
//     // Downtrend
//     // For downtrend retracements, levels are measured from the low to high
//     const bearishFib618 = swingLow + diff * 0.618;
//     const bearishFib382 = swingLow + diff * 0.382;

//     const isNearLevel = (level: number) =>
//       currentPrice >= level * (1 - tolerance) &&
//       currentPrice <= level * (1 + tolerance);

//     // Check 61.8% retracement in downtrend
//     if (isNearLevel(bearishFib618) && rsi > 30 && rsi < 70) {
//       return {
//         confidence: 75,
//         reason: `Price at 61.8% Fibonacci retracement in downtrend`,
//       };
//     }

//     // Check 38.2% retracement in downtrend
//     if (isNearLevel(bearishFib382) && rsi > 35 && rsi < 60) {
//       return {
//         confidence: 70,
//         reason: `Price at 38.2% Fibonacci retracement in downtrend`,
//       };
//     }
//   }

//   return null;
// }

// // ============================================================================
// // SCANNER CLASS
// // ============================================================================

// const SIGNALS_DIR = './data/signals';

// export class TradingScanner {
//   private wyckoffAnalyzer = new WyckoffAnalyzer();
//   private candleManager: CandleManager;
//   private htfManager: HTFCandleManager;
//   private scanResults: Map<string, ExtendedScanResult> = new Map();
//   private scanCount = 0;

//   private successfulInitializations = 0;
//   private marketType: MarketType;
//   private signalsDir = './data/signals';
//   private outputFile = './data/signals/scanner-output.json';
//   private currentWeather: MarketWeather | null = null;
//   private weatherCheckFailures = 0; // Track consecutive failures

//   constructor(marketType: MarketType = (SCAN_CONFIG.marketType = 'FUTURES')) {
//     this.marketType = marketType;
//     this.candleManager = new CandleManager(SCAN_CONFIG.timeframe);
//     this.htfManager = new HTFCandleManager();
//     this.ensureSignalsDir();
//     this.outputFile =
//       marketType === 'SPOT'
//         ? SCAN_CONFIG.outputFiles.spot
//         : SCAN_CONFIG.outputFiles.futures;
//   }

//   async validateSignalWithWyckoff(
//     symbol: string,
//     side: 'LONG' | 'SHORT',
//     price: number
//   ): Promise<{
//     valid: boolean;
//     wyckoffPhase?: WyckoffPhase;
//     reason: string;
//     confidence: number;
//   }> {
//     try {
//       // Get candles for analysis
//       const candles = await this.candleManager.getCandles(symbol, 'FUTURES');

//       if (!candles) {
//         return {
//           valid: false,
//           reason: 'No candle data available',
//           confidence: 0,
//         };
//       }

//       // Perform Wyckoff analysis
//       const wyckoffPhase = this.wyckoffAnalyzer.analyze(candles);
//       const tradeSignal = this.wyckoffAnalyzer.getTradeSignal(wyckoffPhase);

//       console.log(`\nðŸ“Š ${symbol} Wyckoff Analysis:`);
//       console.log(`   Phase: ${wyckoffPhase.phase}`);
//       console.log(`   Stage: ${wyckoffPhase.stage || 'N/A'}`);
//       console.log(`   Signal: ${wyckoffPhase.signal}`);
//       console.log(`   Confidence: ${wyckoffPhase.confidence}%`);
//       console.log(`   Description: ${wyckoffPhase.description}`);

//       // Check if Wyckoff agrees with the signal
//       if (!tradeSignal.shouldTrade) {
//         return {
//           valid: false,
//           wyckoffPhase,
//           reason: `Wyckoff: ${tradeSignal.reason}`,
//           confidence: wyckoffPhase.confidence,
//         };
//       }

//       // Check if direction matches
//       if (tradeSignal.side !== side) {
//         return {
//           valid: false,
//           wyckoffPhase,
//           reason: `Wyckoff suggests ${tradeSignal.side} but signal is ${side}`,
//           confidence: wyckoffPhase.confidence,
//         };
//       }

//       // All checks passed
//       return {
//         valid: true,
//         wyckoffPhase,
//         reason: tradeSignal.reason,
//         confidence: wyckoffPhase.confidence,
//       };
//     } catch (error: any) {
//       console.error(`âŒ Wyckoff validation failed: ${error.message}`);
//       return {
//         valid: false,
//         reason: `Wyckoff analysis error: ${error.message}`,
//         confidence: 0,
//       };
//     }
//   }

//   // ADD this method
//   private checkPriceStability(candles: CandleData): {
//     stable: boolean;
//     reason: string;
//   } {
//     const { highs, lows, closes } = candles;
//     const len = closes.length;

//     if (len < 10) return { stable: true, reason: '' };

//     // Calculate candle ranges for last 10 candles
//     const ranges = [];
//     for (let i = len - 10; i < len; i++) {
//       const hi = highs[1] as number;
//       const lo = lows[1] as number;
//       const cl = closes[1] as number;
//       const hi1 = highs[1 - 1] as number;
//       ranges.push(((hi - lo) / cl) * 100);
//     }

//     const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;

//     // ðŸ If average range > 3%, market is too choppy
//     if (avgRange > 3.0) {
//       return {
//         stable: false,
//         reason: `High volatility: ${avgRange.toFixed(2)}% avg range`,
//       };
//     }

//     // ðŸ Check for whipsaws (rapid direction changes)
//     let directionChanges = 0;
//     for (let i = len - 9; i < len - 1; i++) {
//       const cl = closes[1] as number;
//       const cl1 = closes[1 - 1] as number;
//       const prev = cl > cl1;
//       const curr = cl1 > cl;
//       if (prev !== curr) directionChanges++;
//     }

//     // If changed direction >6 times in 10 candles, it's choppy
//     if (directionChanges > 6) {
//       return {
//         stable: false,
//         reason: `Choppy: ${directionChanges} direction changes`,
//       };
//     }

//     return { stable: true, reason: 'Price stable' };
//   }

//   // private async fetchOrderBook(
//   //   symbol: string,
//   //   limit: number = 20,
//   //   marketType: BotType = 'SPOT'
//   // ): Promise<OrderBook> {
//   //   try {
//   //     // Normalize symbol for API
//   //     const normalizedSymbol = normalize(symbol, marketType).replace('/', '');

//   //     // Choose the right API endpoint based on market type
//   //     const baseUrl =
//   //       marketType === 'FUTURES'
//   //         ? 'https://fapi.binance.com/fapi/v1'
//   //         : 'https://api.binance.com/api/v3';

//   //     const response = await fetch(
//   //       `${baseUrl}/depth?symbol=${normalizedSymbol}&limit=${limit}`
//   //     );

//   //     if (!response.ok) {
//   //       throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//   //     }

//   //     const data = await response.json();

//   //     // Parse the response
//   //     const bids = data.bids.map((bid: string[]) => ({
//   //       price: parseFloat(bid[0] as string),
//   //       quantity: parseFloat(bid[1] as string),
//   //       total: parseFloat(bid[0] as string) * parseFloat(bid[1] as string),
//   //     }));

//   //     const asks = data.asks.map((ask: string[]) => ({
//   //       price: parseFloat(ask[0] as string),
//   //       quantity: parseFloat(ask[1] as string),
//   //       total: parseFloat(ask[0] as string) * parseFloat(ask[1] as string),
//   //     }));

//   //     return {
//   //       bids,
//   //       asks,
//   //       lastUpdateId: data.lastUpdateId,
//   //     };
//   //   } catch (error: any) {
//   //     console.error(`Failed to fetch orderbook for ${symbol}:`, error.message);

//   //     // Return empty orderbook as fallback
//   //     return {
//   //       bids: [],
//   //       asks: [],
//   //       lastUpdateId: 0,
//   //     };
//   //   }
//   // }

//   private async fetchOrderBook(
//     symbol: string,
//     limit: number = 20,
//     marketType: BotType = 'SPOT'
//   ): Promise<OrderBook> {
//     try {
//       // Normalize symbol for API
//       const normalizedSymbol = normalize(symbol, marketType).replace('/', '');

//       // Choose the right API endpoint based on market type
//       const baseUrl =
//         marketType === 'FUTURES'
//           ? 'https://fapi.binance.com/fapi/v1'
//           : 'https://api.binance.com/api/v3';

//       const response = await fetch(
//         `${baseUrl}/depth?symbol=${normalizedSymbol}&limit=${limit}`
//       );

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//       }

//       const data = await response.json();

//       // Validate the response
//       if (!isBinanceOrderBookResponse(data)) {
//         throw new Error('Invalid order book response format');
//       }

//       // Parse the response
//       const bids: OrderBookLevel[] = data.bids.map((bid: string[]) => {
//         const price = parseFloat(bid[0] as string);
//         const quantity = parseFloat(bid[1] as string);
//         return {
//           price,
//           quantity,
//           total: price * quantity,
//         };
//       });

//       const asks: OrderBookLevel[] = data.asks.map((ask: string[]) => {
//         const price = parseFloat(ask[0] as string);
//         const quantity = parseFloat(ask[1] as string);
//         return {
//           price,
//           quantity,
//           total: price * quantity,
//         };
//       });

//       return {
//         bids,
//         asks,
//         lastUpdateId: data.lastUpdateId,
//       };
//     } catch (error: any) {
//       console.error(`Failed to fetch orderbook for ${symbol}:`, error.message);

//       // Return empty orderbook as fallback
//       return {
//         bids: [],
//         asks: [],
//         lastUpdateId: 0,
//       };
//     }
//   }

//   private detectTrend(candles: CandleData): 'UP' | 'DOWN' | 'SIDEWAYS' {
//     if (candles.closes.length < 50) {
//       return 'SIDEWAYS';
//     }

//     const ema20 = EMA.calculate({
//       values: candles.closes,
//       period: 20,
//     });

//     const ema50 = EMA.calculate({
//       values: candles.closes,
//       period: 50,
//     });

//     if (ema20.length === 0 || ema50.length === 0) {
//       return 'SIDEWAYS';
//     }

//     const currentPrice = candles.closes[candles.closes.length - 1] as number;
//     const ema20Val = ema20[ema20.length - 1] as number;
//     const ema50Val = ema50[ema50.length - 1] as number;

//     // Uptrend: Price > EMA20 > EMA50
//     if (currentPrice > ema20Val && ema20Val > ema50Val) {
//       return 'UP';
//     }

//     // Downtrend: Price < EMA20 < EMA50
//     if (currentPrice < ema20Val && ema20Val < ema50Val) {
//       return 'DOWN';
//     }

//     return 'SIDEWAYS';
//   }

//   // ADD this method (you'll need to fetch orderbook from exchange)
//   private async checkSpread(symbol: string): Promise<{
//     acceptable: boolean;
//     spreadPercent: number;
//   }> {
//     try {
//       // Determine market type - you might need to pass this or detect it
//       // For now, default to FUTURES if scanner is running in futures mode
//       const marketType: BotType =
//         this.marketType === 'FUTURES' ? 'FUTURES' : 'SPOT';

//       const orderbook = (await this.fetchOrderBook(
//         symbol,
//         5,
//         marketType
//       )) as OrderBook;

//       if (!orderbook.bids.length || !orderbook.asks.length) {
//         return { acceptable: false, spreadPercent: 100 };
//       }

//       const bestBid = orderbook.bids[0]!.price;
//       const bestAsk = orderbook.asks[0]!.price;
//       const spread = ((bestAsk - bestBid) / bestBid) * 100;

//       // ðŸ Reject if spread > 0.5%
//       const maxSpread = SCAN_CONFIG.maxSpreadPercent || 0.5;
//       return {
//         acceptable: spread <= maxSpread,
//         spreadPercent: spread,
//       };
//     } catch (error) {
//       // If can't fetch, assume it's bad
//       console.error(`Spread check failed for ${symbol}:`, error);
//       return { acceptable: false, spreadPercent: 100 };
//     }

//     // ... rest of the class ...
//   }
//   // ADD this new method
//   private async checkVolumeQuality(
//     symbol: string,
//     candles: CandleData
//   ): Promise<{ isHealthy: boolean; reason: string }> {
//     const { volumes, closes } = candles;
//     const len = volumes.length;

//     if (len < 20) {
//       return { isHealthy: false, reason: 'Insufficient volume data' };
//     }

//     // Calculate average volume (last 20 candles)
//     const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
//     const currentVolume = volumes[len - 1] as number;

//     // ðŸ Current volume should be at least 30% of average
//     if (currentVolume < avgVolume * 0.3) {
//       return {
//         isHealthy: false,
//         reason: `Low volume: ${((currentVolume / avgVolume) * 100).toFixed(0)}% of avg`,
//       };
//     }

//     // ðŸ Detect volume spike (possible manipulation)
//     if (currentVolume > avgVolume * 5) {
//       return {
//         isHealthy: false,
//         reason: `Abnormal volume spike: ${(currentVolume / avgVolume).toFixed(1)}x average`,
//       };
//     }

//     // ðŸ Check for declining volume trend (dying interest)
//     const recent5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
//     const previous5 = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;

//     if (recent5 < previous5 * 0.5) {
//       return {
//         isHealthy: false,
//         reason: 'Declining volume trend (-50%)',
//       };
//     }

//     return { isHealthy: true, reason: 'Volume healthy' };
//   }

//   // ADD this new method
//   private detectVolatilitySpike(candles: CandleData): {
//     isPumping: boolean;
//     spikePercent: number;
//   } {
//     const { closes } = candles;
//     const len = closes.length as number;

//     // Check last 5 candles for abnormal moves
//     for (let i = len - 5; i < len - 1; i++) {
//       const cls = closes[i] as number;
//       const cls1 = closes[i + 1] as number;

//       const change = Math.abs(((cls1 - cls) / cls) * 100);

//       // ðŸ If ANY candle moved >8% in 15min, it's suspicious
//       if (change > 8) {
//         return {
//           isPumping: true,
//           spikePercent: change,
//         };
//       }
//     }

//     // Check cumulative move in last hour (4 candles of 15m)
//     if (len >= 4) {
//       const hourAgoPrice = closes[len - 4] as number;
//       const currentPrice = closes[len - 1] as number;
//       const hourChange = Math.abs(
//         ((currentPrice - hourAgoPrice) / hourAgoPrice) * 100
//       );

//       // ðŸ If moved >15% in last hour, suspicious
//       if (hourChange > 15) {
//         return {
//           isPumping: true,
//           spikePercent: hourChange,
//         };
//       }
//     }

//     return { isPumping: false, spikePercent: 0 };
//   }

//   private ensureSignalsDir(): void {
//     if (!fs.existsSync(this.signalsDir)) {
//       fs.mkdirSync(this.signalsDir, { recursive: true });
//       console.log(`âœ… Created signals directory: ${this.signalsDir}`);
//     }
//   }

//   async initialize(): Promise<void> {
//     log('ðŸš€ Initializing Trading Scanner...', 'info');
//     log(
//       `   Market Type: ${colorize(this.marketType, colors.brightCyan)}`,
//       'info'
//     );
//     log(`   Symbols: ${symbols.length}`, 'info');
//     log(`   Output File: ${this.outputFile}`, 'info');
//     log('â•'.repeat(60), 'info');

//     if (!fs.existsSync(SIGNALS_DIR)) {
//       fs.mkdirSync(SIGNALS_DIR, { recursive: true });
//       log(`ðŸ“ Created directory: ${SIGNALS_DIR}`, 'info');
//     }

//     let passed = 0;
//     let failed = 0;

//     for (let i = 0; i < symbols.length; i++) {
//       const symbol = symbols[i];
//       if (!symbol) continue;

//       const normalizedSymbol = normalize(symbol, this.marketType);

//       if (normalizedSymbol === 'NEXOUSDT' || normalizedSymbol === 'NEXO/USDT') {
//         continue;
//       }

//       const success = await this.candleManager.initializeHistoricalCandles(
//         normalizedSymbol,
//         500,
//         0,
//         this.marketType
//       );

//       if (success) {
//         passed++;
//         this.successfulInitializations++;
//       } else {
//         failed++;
//         log(`âŒ ${symbol} failed`, 'error');
//       }

//       if ((i + 1) % 10 === 0 || i === symbols.length - 1) {
//         log(
//           `ðŸ“Š Progress: ${i + 1}/${symbols.length} | Passed: ${passed} | Failed: ${failed}`,
//           'info'
//         );
//       }

//       if (i < symbols.length - 1) {
//         await new Promise((resolve) => setTimeout(resolve, 500));
//       }
//     }

//     log('â•'.repeat(60), 'info');
//     log(
//       `âœ… Initialization complete: ${passed} passed, ${failed} failed`,
//       passed > 0 ? 'success' : 'error'
//     );

//     if (this.successfulInitializations === 0) {
//       log('âŒ No symbols initialized! Scanner cannot run.', 'error');
//       process.exit(1);
//     }
//   }

//   // async scanSymbol(symbol: string): Promise<ExtendedScanResult | null> {
//   //   try {
//   //     const normalizedSpot = normalize(symbol, 'SPOT');
//   //     const normalizedFutures = normalize(symbol, 'FUTURES');

//   //     const candlesSpot = this.candleManager.getCandles(
//   //       normalizedSpot,
//   //       'SPOT'
//   //     ) as CandleData;
//   //     // console.log(
//   //     //   'ðŸ¥‘ ~ TradingScanner ~ scanSymbol ~ candlesSpot:',
//   //     //   candlesSpot
//   //     // );
//   //     const candlesFutures = this.candleManager.getCandles(
//   //       normalizedFutures,
//   //       'FUTURES'
//   //     ) as CandleData;
//   //     // console.log(
//   //     //   'ðŸ¥‘ ~ TradingScanner ~ scanSymbol ~ candlesFutures:',
//   //     //   candlesFutures
//   //     // );

//   //     // Inside scanSymbol(), after getting candlesFutures/Spot
//   //     const btcCandles = this.candleManager.getCandles('BTCUSDT', 'FUTURES');

//   //     let candles: CandleData;
//   //     let marketType: BotType;

//   //     const spotValid = candlesSpot && candlesSpot.closes.length >= 210;
//   //     const futuresValid =
//   //       candlesFutures && candlesFutures.closes.length >= 210;

//   //     if (futuresValid) {
//   //       candles = candlesFutures;
//   //       marketType = 'FUTURES';
//   //     } else if (spotValid) {
//   //       candles = candlesSpot;
//   //       marketType = 'SPOT';
//   //     } else {
//   //       return null;
//   //     }

//   //     if (SCAN_CONFIG.liquidity.enabled) {
//   //       const vol24h = await this.check24hVolume(symbol, marketType);
//   //       if (vol24h < SCAN_CONFIG.liquidity.minDepth24h) {
//   //         // console.log(
//   //         //   `   âŒ ${symbol}: 24h volume ${vol24h} below minimum ${SCAN_CONFIG.liquidity.minDepth24h}`
//   //         // );
//   //         return null;
//   //       }
//   //     }

//   //     console.log(
//   //       `   âœ… ${symbol} (${marketType}): ${candles.closes.length} candles loaded`
//   //     );

//   //     const indicators = calculateIndicators(candles);
//   //     if (!indicators) {
//   //       console.log(`   âŒ ${symbol}: Failed to calculate indicators`);
//   //       return null;
//   //     }

//   //     const regime = detectRegime(indicators);
//   //     const smc = SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;
//   //     const allSignals = detectSignal(symbol, indicators, candles, smc);
//   //     console.log(
//   //       'ðŸ¥‘ ~ TradingScanner ~ scanSymbol ~ allSignals:',
//   //       JSON.stringify(allSignals, null, 2)
//   //     );
//   //     // console.log(
//   //     //   'ðŸ¥‘ ~ TradingScanner ~ scanSymbol ~ candles==============>>>>:',
//   //     //   candles
//   //     // );

//   //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   //     // âœ… ADD: WYCKOFF ANALYSIS (After getting candles, before signals)
//   //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//   //     let wyckoffPhase: WyckoffPhase | null = null;

//   //     if (SCAN_CONFIG.wyckoffEnabled) {
//   //       wyckoffPhase = this.wyckoffAnalyzer.analyze(candles);

//   //       console.log(`\nðŸ“Š ${symbol} Wyckoff Analysis:`);
//   //       console.log(`   Phase: ${wyckoffPhase.phase}`);
//   //       console.log(`   Stage: ${wyckoffPhase.stage || 'N/A'}`);
//   //       console.log(`   Confidence: ${wyckoffPhase.confidence}%`);
//   //       console.log(`   Signal: ${wyckoffPhase.signal}`);

//   //       // âŒ BLOCK if Wyckoff says NO TRADE
//   //       if (wyckoffPhase.confidence < SCAN_CONFIG.minConfidence) {
//   //         console.log(`   âŒ Wyckoff confidence too low - skipping ${symbol}`);
//   //         return null;
//   //       }

//   //       // âŒ BLOCK if in wrong phase
//   //       if (
//   //         wyckoffPhase.phase === 'MARKDOWN' ||
//   //         (wyckoffPhase.phase === 'DISTRIBUTION' &&
//   //           wyckoffPhase.confidence > 75)
//   //       ) {
//   //         console.log(`   âŒ ${symbol} in ${wyckoffPhase.phase} - avoiding`);
//   //         return null;
//   //       }
//   //     }

//   //     const validSignals = allSignals.filter((signal) => {
//   //       if (SCAN_CONFIG.tradingMode === 'SPOT' && signal?.side !== 'LONG') {
//   //         return false;
//   //       }

//   //       // âœ… When SMC is enabled, ALL signals must meet minimum SMC score
//   //       if (SCAN_CONFIG.smcEnabled && smc) {
//   //         if (smc.smcScore < SCAN_CONFIG.smcMinScore) {
//   //           // console.log(
//   //           //   `   âŒ ${symbol}: SMC score ${smc.smcScore} < ${SCAN_CONFIG.smcMinScore} (strategy: ${signal.strategy})`
//   //           // );
//   //           return false;
//   //         }
//   //       }

//   //       // ðŸŽ¯ NEW: Zone-based filtering
//   //       if (smc?.premiumDiscount) {
//   //         // Block LONG in PREMIUM (unless exceptionally strong)
//   //         if (signal.side === 'LONG' && smc.premiumDiscount === 'PREMIUM') {
//   //           if (smc.smcScore < 55 || signal.confidence < 85) {
//   //             // console.log(
//   //             //   `   âŒ ${symbol}: LONG in PREMIUM - need SMC 55+ & confidence 85+`
//   //             // );
//   //             return false;
//   //           }
//   //         }

//   //         // Block SHORT in DISCOUNT (unless exceptionally strong)
//   //         if (signal.side === 'SHORT' && smc.premiumDiscount === 'DISCOUNT') {
//   //           if (smc.smcScore < 55 || signal.confidence < 85) {
//   //             // console.log(
//   //             //   `   âŒ ${symbol}: SHORT in DISCOUNT - need SMC 55+ & confidence 85+`
//   //             // );
//   //             return false;
//   //           }
//   //         }

//   //         // âœ… BOOST signals in correct zones
//   //         if (signal.side === 'LONG' && smc.premiumDiscount === 'DISCOUNT') {
//   //           signal.confidence += 10;
//   //           signal.reason += ' | âœ… DISCOUNT zone';
//   //         }

//   //         if (signal.side === 'SHORT' && smc.premiumDiscount === 'PREMIUM') {
//   //           signal.confidence += 10;
//   //           signal.reason += ' | âœ… PREMIUM zone';
//   //         }
//   //       }

//   //       if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//   //         console.log(
//   //           `   ðŸ” ${symbol}: Checking SMC strategy ${signal.strategy}, score: ${smc.smcScore}, min: ${SCAN_CONFIG.smcMinScore}`
//   //         );
//   //         if (smc.smcScore < SCAN_CONFIG.smcMinScore) {
//   //           return false;
//   //         }
//   //       } else if (smc && signal?.strategy) {
//   //         console.log(
//   //           `   âš ï¸ ${symbol}: Strategy ${signal.strategy} not in smcStrategy array!`
//   //         );
//   //       }

//   //       const stabilityCheck = this.checkPriceStability(candles);
//   //       if (!stabilityCheck.stable) {
//   //         return {
//   //           symbol,
//   //           confidence: Math.max(0, signal.confidence - 30), // Heavily penalize
//   //           signal,
//   //           reason: `âš ï¸ Choppy market: ${stabilityCheck.reason}`,
//   //           // ... rest
//   //         };
//   //       }

//   //       const session = getMarketSession();

//   //       if (signal.strategy === 'LIQUIDITY_SWEEP') {
//   //         if (session === 'OVERLAP' || session === 'NEW_YORK') {
//   //           signal.confidence += 15; // Boost confidence during high-volume hours
//   //           signal.reason += ` (Session: ${session})`;
//   //         } else if (session === 'ASIA') {
//   //           signal.confidence -= 10; // Be careful with sweeps during low-vol Asian hours
//   //         }
//   //       }

//   //       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   //       // âœ… ADD: WYCKOFF SIGNAL VALIDATION
//   //       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//   //       // let wyckoffPhase: WyckoffPhase | undefined;

//   //       if (SCAN_CONFIG.wyckoffEnabled && wyckoffPhase) {
//   //         const wyckoffTradeSignal =
//   //           this.wyckoffAnalyzer.getTradeSignal(wyckoffPhase);

//   //         if (wyckoffTradeSignal.shouldTrade) {
//   //           if (wyckoffTradeSignal.side !== signal.side) {
//   //             console.log(
//   //               `   âŒ ${symbol}: Wyckoff wants ${wyckoffTradeSignal.side} but signal is ${signal.side}`
//   //             );
//   //             return false;
//   //           }

//   //           // âœ… BOOST confidence if Wyckoff strongly agrees
//   //           if (wyckoffPhase.confidence >= 80) {
//   //             signal.confidence = Math.min(95, signal.confidence + 15);
//   //             signal.reason += ` | ðŸŽ¯ Wyckoff ${wyckoffPhase.phase}`;
//   //             console.log(
//   //               `   âœ… ${symbol}: Wyckoff boost +15% (${wyckoffPhase.phase})`
//   //             );
//   //           } else if (wyckoffPhase.confidence >= 70) {
//   //             signal.confidence = Math.min(95, signal.confidence + 10);
//   //             signal.reason += ` | ðŸ“Š Wyckoff ${wyckoffPhase.phase}`;
//   //           }
//   //         } else {
//   //           console.log(
//   //             `   âŒ ${symbol}: Wyckoff says no trade - ${wyckoffTradeSignal.reason}`
//   //           );
//   //           return false;
//   //         }
//   //       }
//   //       return true;
//   //     });

//   //     if (validSignals.length === 0) {
//   //       return null;
//   //     }

//   //     // ADD to analyzeSymbol()
//   //     const spreadCheck = await this.checkSpread(symbol);
//   //     if (!spreadCheck.acceptable) {
//   //       return {
//   //         symbol,
//   //         confidence: 0,
//   //         signal: null,
//   //         reason: `ðŸš« High spread: ${spreadCheck.spreadPercent.toFixed(2)}%`,
//   //         // ... rest
//   //       };
//   //     }

//   //     // 2. âœ… ADD: Recent volatility check
//   //     const volatilitySpike = this.detectVolatilitySpike(candles);
//   //     if (volatilitySpike.isPumping) {
//   //       console.log(
//   //         `ðŸš« ${symbol}: Recent ${volatilitySpike.spikePercent.toFixed(1)}% spike - trap risk`
//   //       );
//   //       return null;
//   //     }

//   //     // ADD to analyzeSymbol()
//   //     const volumeCheck = await this.checkVolumeQuality(symbol, candles);
//   //     if (!volumeCheck.isHealthy) {
//   //       return {
//   //         symbol,
//   //         confidence: 0,
//   //         signal: null,
//   //         reason: `ðŸš« ${volumeCheck.reason}`,
//   //         // ... rest
//   //       };
//   //     }

//   //     // ðŸš¨ ADD: Detect recent pump/dump
//   //     const volatilityCheck = this.detectVolatilitySpike(candles);
//   //     if (volatilityCheck.isPumping) {
//   //       return {
//   //         symbol,
//   //         confidence: 0, // Block the signal
//   //         signal: null,
//   //         reason: `ðŸš« Recent ${volatilityCheck.spikePercent.toFixed(1)}% spike detected - likely trap`,
//   //         // ... rest of fields
//   //       };
//   //     }

//   //     const scoredSignals = validSignals.map((signal: EntrySignal) => {
//   //       let finalConfidence = signal?.confidence;

//   //       // 1. SMC strategy boost
//   //       if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//   //         const smcContribution = (smc.smcScore / 100) * 30;
//   //         finalConfidence = Math.min(95, signal.confidence + smcContribution);
//   //       }

//   //       // 2. Relative Strength boost (FIXED)
//   //       if (btcCandles && btcCandles.closes.length >= 24) {
//   //         const rsRatio = calculateRelativeStrength(candles, btcCandles, 24);

//   //         if (signal.side === 'LONG') {
//   //           if (rsRatio > 1.02) {
//   //             finalConfidence += 10;
//   //             signal.reason += ` | ðŸ’ª High RS (${rsRatio.toFixed(2)})`;
//   //           } else if (rsRatio < 0.95) {
//   //             finalConfidence -= 20;
//   //             signal.reason += ` | âš ï¸ Low RS (${rsRatio.toFixed(2)})`;
//   //           }
//   //         }

//   //         if (signal.side === 'SHORT') {
//   //           if (rsRatio < 0.98) {
//   //             finalConfidence += 10;
//   //             signal.reason += ` | ðŸ“‰ High Relative Weakness`;
//   //           }
//   //         }
//   //       }

//   //       // 5. Cap at 100%
//   //       finalConfidence = Math.min(100, finalConfidence);

//   //       return {
//   //         signal,
//   //         finalConfidence,
//   //         smcScore: smc?.smcScore || 0,
//   //       };
//   //     });

//   //     const bestScoredSignal = scoredSignals.reduce((best, current) => {
//   //       const curFinalCon = current.finalConfidence as number;
//   //       const bestFinalCon = best.finalConfidence as number;
//   //       return curFinalCon > bestFinalCon ? current : best;
//   //     });

//   //     console.log(
//   //       `   âœ… ${symbol}: Best signal: ${bestScoredSignal.signal?.strategy} (${bestScoredSignal.finalConfidence?.toFixed(0)}%)`
//   //     );

//   //     const currentPrice = indicators.currentPrice; // Fresh from candles

//   //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   //     // âœ… MULTI-TIMEFRAME TREND ANALYSIS (FIXED)
//   //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//   //     // Get 1h candles for higher timeframe confirmation
//   //     let trend15m: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';
//   //     let trend1h: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';

//   //     try {
//   //       // Detect trend on current timeframe (15m)
//   //       trend15m = this.detectTrend(candles);
//   //       console.log(`   ðŸ“Š ${symbol} - 15m trend: ${trend15m}`);

//   //       // Get and detect 1h trend
//   //       const htfCandles = await this.htfManager.getHTFCandles(symbol, '1h'); // âœ… FIXED: Use 1h not 1m

//   //       if (htfCandles && htfCandles.closes.length >= 50) {
//   //         trend1h = this.detectTrend(htfCandles);
//   //         console.log(`   ðŸ“Š ${symbol} - 1h trend: ${trend1h}`);
//   //       } else {
//   //         console.log(
//   //           `   âš ï¸ ${symbol}: Insufficient 1h candles, skipping HTF check`
//   //         );
//   //       }
//   //     } catch (error: any) {
//   //       console.log(
//   //         `   âš ï¸ ${symbol}: Could not get HTF trend - ${error.message}`
//   //       );
//   //     }

//   //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   //     // âœ… FILTER SIGNALS BASED ON TREND
//   //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//   //     if (bestScoredSignal.signal.side === 'LONG') {
//   //       // Don't LONG if 1h trend is DOWN
//   //       if (trend1h === 'DOWN') {
//   //         console.log(
//   //           `   âŒ ${symbol}: LONG signal rejected - 1h trend is DOWN`
//   //         );
//   //         return null;
//   //       }

//   //       // Boost confidence if all timeframes align
//   //       if (trend15m === 'UP' && trend1h === 'UP') {
//   //         bestScoredSignal.finalConfidence = Math.min(
//   //           95,
//   //           (bestScoredSignal.finalConfidence as number) + 12
//   //         );
//   //         bestScoredSignal.signal.reason += ' | ðŸš€ TF aligned UP';
//   //         console.log(`   âœ… ${symbol}: LONG boosted - all trends bullish`);
//   //       }

//   //       // Reduce confidence if 15m is UP but 1h is SIDEWAYS
//   //       if (trend15m === 'UP' && trend1h === 'SIDEWAYS') {
//   //         bestScoredSignal.finalConfidence =
//   //           (bestScoredSignal.finalConfidence as number) * 0.9;
//   //         bestScoredSignal.signal.reason += ' | âš ï¸ 1h sideways';
//   //         console.log(`   âš ï¸ ${symbol}: LONG reduced - 1h trend unclear`);
//   //       }
//   //     }

//   //     if (bestScoredSignal.signal.side === 'SHORT') {
//   //       // Don't SHORT if 1h trend is UP
//   //       if (trend1h === 'UP') {
//   //         console.log(
//   //           `   âŒ ${symbol}: SHORT signal rejected - 1h trend is UP`
//   //         );
//   //         return null;
//   //       }

//   //       // Boost confidence if all timeframes align
//   //       if (trend15m === 'DOWN' && trend1h === 'DOWN') {
//   //         bestScoredSignal.finalConfidence = Math.min(
//   //           95,
//   //           (bestScoredSignal.finalConfidence as number) + 12
//   //         );
//   //         bestScoredSignal.signal.reason += ' | ðŸ“‰ TF aligned DOWN';
//   //         console.log(`   âœ… ${symbol}: SHORT boosted - all trends bearish`);
//   //       }

//   //       // Reduce confidence if 15m is DOWN but 1h is SIDEWAYS
//   //       if (trend15m === 'DOWN' && trend1h === 'SIDEWAYS') {
//   //         bestScoredSignal.finalConfidence =
//   //           (bestScoredSignal.finalConfidence as number) * 0.9;
//   //         bestScoredSignal.signal.reason += ' | âš ï¸ 1h sideways';
//   //         console.log(`   âš ï¸ ${symbol}: SHORT reduced - 1h trend unclear`);
//   //       }
//   //     }

//   //     // 4. âœ… ADD: Higher timeframe alignment
//   //     // const htfCandles = await this.htfManager.getHTFCandles(symbol, '1h');
//   //     // if (!htfCandles) return null;
//   //     // const htfTrend = this.detectTrend(htfCandles);

//   //     // if (bestScoredSignal.signal.side === 'LONG' && htfTrend === 'DOWN') {
//   //     //   console.log(
//   //     //     `âš ï¸ ${symbol}: 15m LONG but 1h trend is DOWN - reducing confidence`
//   //     //   );
//   //     //   bestScoredSignal.finalConfidence *= 0.7;
//   //     // }

//   //     let stopLoss: number;
//   //     let takeProfit: number;

//   //     console.log(`   ðŸ“Š ${symbol} - ALL SIGNALS BEFORE FILTERING:`);
//   //     allSignals.forEach((s) => {
//   //       console.log(`      ${s.strategy}: ${s.confidence}% (${s.side})`);
//   //     });

//   //     console.log(`   âœ… ${symbol} - VALID SIGNALS AFTER FILTERING:`);
//   //     validSignals.forEach((s) => {
//   //       console.log(`      ${s.strategy}: ${s.confidence}% (${s.side})`);
//   //     });

//   //     console.log(`   ðŸŽ¯ ${symbol} - SCORED SIGNALS:`);
//   //     scoredSignals.forEach((s) => {
//   //       console.log(`      ${s.signal.strategy}: ${s.finalConfidence}%`);
//   //     });
//   //     try {
//   //       const atrArray = ATR.calculate({
//   //         high: candles.highs,
//   //         low: candles.lows,
//   //         close: candles.closes,
//   //         period: 14,
//   //       });
//   //       const atr = atrArray[atrArray.length - 1];

//   //       if (!atr || atr <= 0) {
//   //         throw new Error('Invalid ATR');
//   //       }

//   //       // Calculate risk from ATR
//   //       let riskDistance = atr * RISK_REWARD_CONFIG.atrMultiplier;

//   //       // Apply limits
//   //       const maxRisk =
//   //         currentPrice * (RISK_REWARD_CONFIG.maxRiskPercent / 100);
//   //       const minRisk =
//   //         currentPrice * (RISK_REWARD_CONFIG.minRiskPercent / 100);

//   //       riskDistance = Math.max(minRisk, Math.min(riskDistance, maxRisk));

//   //       // ðŸŽ¯ SIMPLE: Reward = Risk Ã— Ratio
//   //       const rewardDistance = riskDistance * RISK_REWARD_CONFIG.ratio;

//   //       // Set levels
//   //       if (bestScoredSignal.signal.side === 'LONG') {
//   //         stopLoss = currentPrice - riskDistance;
//   //         takeProfit = currentPrice + rewardDistance;
//   //       } else {
//   //         stopLoss = currentPrice + riskDistance;
//   //         takeProfit = currentPrice - rewardDistance;
//   //       }

//   //       // Verify and log
//   //       const riskPct = (riskDistance / currentPrice) * 100;
//   //       const rewardPct = (rewardDistance / currentPrice) * 100;
//   //       const actualRR = rewardPct / riskPct;

//   //       console.log(
//   //         `   âœ… ${symbol} | Risk: ${riskPct.toFixed(2)}% | Reward: ${rewardPct.toFixed(2)}% | R:R = 1:${actualRR.toFixed(1)}`
//   //       );
//   //     } catch (e) {
//   //       // Fallback
//   //       const risk = RISK_REWARD_CONFIG.maxRiskPercent / 100;
//   //       const reward = risk * RISK_REWARD_CONFIG.ratio;

//   //       if (bestScoredSignal.signal.side === 'LONG') {
//   //         stopLoss = currentPrice * (1 - risk);
//   //         takeProfit = currentPrice * (1 + reward);
//   //       } else {
//   //         stopLoss = currentPrice * (1 + risk);
//   //         takeProfit = currentPrice * (1 - reward);
//   //       }

//   //       console.log(`   âš ï¸ Fallback R:R - 1:${RISK_REWARD_CONFIG.ratio}`);
//   //     }

//   //     // Round to appropriate precision
//   //     // stopLoss = parseFloat(stopLoss.toFixed(8));
//   //     // console.log('ðŸ¥‘ ~ TradingScanner ~ scanSymbol ~ stopLoss:', stopLoss);
//   //     // takeProfit = parseFloat(takeProfit.toFixed(8));
//   //     // console.log('ðŸ¥‘ ~ TradingScanner ~ scanSymbol ~ takeProfit:', takeProfit);

//   //     // Attach to signal
//   //     bestScoredSignal.signal.stopLoss = stopLoss;
//   //     bestScoredSignal.signal.takeProfit = takeProfit;
//   //     bestScoredSignal.signal.entryPrice = currentPrice;

//   //     const result: ExtendedScanResult = {
//   //       symbol,
//   //       signal: bestScoredSignal.signal,
//   //       confidence: bestScoredSignal.finalConfidence as number,
//   //       price: indicators.currentPrice,
//   //       indicators,
//   //       regime,
//   //       rsi: indicators.rsi,
//   //       timestamp: new Date(),
//   //       marketType: marketType as BotType,
//   //       wyckoff: wyckoffPhase, // Can be null if wyckoffEnabled is false
//   //     };

//   //     if (smc) {
//   //       result.smc = smc;
//   //     }

//   //     return result;
//   //   } catch (err: any) {
//   //     // console.error(`âŒ Error scanning ${symbol}:`, err.message);
//   //     return null;
//   //   }
//   // }

//   // detectTrend(candles: CandleData): 'UP' | 'DOWN' | 'SIDEWAYS' {
//   //   // Calculate EMAs
//   //   const ema20 = EMA.calculate({
//   //     values: candles.closes,
//   //     period: 20,
//   //   });

//   //   const ema50 = EMA.calculate({
//   //     values: candles.closes,
//   //     period: 50,
//   //   });

//   //   const currentPrice = candles.closes[candles.closes.length - 1] as number;
//   //   const ema20Current = ema20[ema20.length - 1] as number;
//   //   const ema50Current = ema50[ema50.length - 1] as number;

//   //   // Uptrend: Price > EMA20 > EMA50
//   //   if (currentPrice > ema20Current && ema20Current > ema50Current) {
//   //     return 'UP';
//   //   }

//   //   // Downtrend: Price < EMA20 < EMA50
//   //   if (currentPrice < ema20Current && ema20Current < ema50Current) {
//   //     return 'DOWN';
//   //   }

//   //   // Otherwise sideways
//   //   return 'SIDEWAYS';
//   // }

//   async scanSymbol(symbol: string): Promise<ExtendedScanResult | null> {
//     try {
//       const normalizedSpot = normalize(symbol, 'SPOT');
//       const normalizedFutures = normalize(symbol, 'FUTURES');

//       const candlesSpot = this.candleManager.getCandles(
//         normalizedSpot,
//         'SPOT'
//       ) as CandleData;

//       const candlesFutures = this.candleManager.getCandles(
//         normalizedFutures,
//         'FUTURES'
//       ) as CandleData;

//       // Inside scanSymbol(), after getting candlesFutures/Spot
//       const btcCandles = this.candleManager.getCandles('BTCUSDT', 'FUTURES');

//       let candles: CandleData;
//       let marketType: BotType;

//       const spotValid = candlesSpot && candlesSpot.closes.length >= 210;
//       const futuresValid =
//         candlesFutures && candlesFutures.closes.length >= 210;

//       if (futuresValid) {
//         candles = candlesFutures;
//         marketType = 'FUTURES';
//       } else if (spotValid) {
//         candles = candlesSpot;
//         marketType = 'SPOT';
//       } else {
//         return null;
//       }

//       if (SCAN_CONFIG.liquidity.enabled) {
//         const vol24h = await this.check24hVolume(symbol, marketType);
//         if (vol24h < SCAN_CONFIG.liquidity.minDepth24h) {
//           return null;
//         }
//       }

//       console.log(
//         `   âœ… ${symbol} (${marketType}): ${candles.closes.length} candles loaded`
//       );

//       const indicators = calculateIndicators(candles);
//       if (!indicators) {
//         console.log(`   âŒ ${symbol}: Failed to calculate indicators`);
//         return null;
//       }

//       const regime = detectRegime(indicators, candles);
//       const smc = SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;
//       const allSignals = detectSignal(symbol, indicators, candles, smc);
//       // console.log(
//       //   'ðŸ¥‘ ~ TradingScanner ~ scanSymbol ~ allSignals:',
//       //   JSON.stringify(allSignals, null, 2)
//       // );

//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//       // âœ… WYCKOFF ANALYSIS - Advisory Mode (Not Mandatory)
//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//       let wyckoffPhase: WyckoffPhase | null = null;

//       if (SCAN_CONFIG.wyckoffEnabled) {
//         wyckoffPhase = this.wyckoffAnalyzer.analyze(candles);

//         console.log(`\nðŸ“Š ${symbol} Wyckoff Analysis:`);
//         console.log(`   Phase: ${wyckoffPhase.phase}`);
//         console.log(`   Stage: ${wyckoffPhase.stage || 'N/A'}`);
//         console.log(`   Confidence: ${wyckoffPhase.confidence}%`);
//         console.log(`   Signal: ${wyckoffPhase.signal}`);

//         // âŒ HARD BLOCK only for VERY STRONG bearish phases
//         // This prevents trading in clearly dangerous markets
//         if (wyckoffPhase.phase === 'MARKDOWN' && wyckoffPhase.confidence > 80) {
//           console.log(
//             `   âŒ ${symbol} in strong MARKDOWN (${wyckoffPhase.confidence}%) - avoiding`
//           );
//           return null;
//         }

//         if (
//           wyckoffPhase.phase === 'DISTRIBUTION' &&
//           wyckoffPhase.confidence > 85
//         ) {
//           console.log(
//             `   âŒ ${symbol} in strong DISTRIBUTION (${wyckoffPhase.confidence}%) - avoiding`
//           );
//           return null;
//         }

//         // â„¹ï¸ Log neutral/unclear markets but LET THEM PASS
//         if (wyckoffPhase.phase === 'NEUTRAL' || wyckoffPhase.confidence < 40) {
//           console.log(
//             `   â„¹ï¸ ${symbol}: Neutral/unclear Wyckoff (${wyckoffPhase.confidence}%) - relying on other signals`
//           );
//         }

//         // âœ… Log bullish phases
//         if (
//           wyckoffPhase.phase === 'ACCUMULATION' &&
//           wyckoffPhase.confidence > 60
//         ) {
//           console.log(
//             `   âœ… ${symbol}: Potential ACCUMULATION phase (${wyckoffPhase.confidence}%)`
//           );
//         }

//         if (wyckoffPhase.phase === 'MARKUP' && wyckoffPhase.confidence > 60) {
//           console.log(
//             `   âœ… ${symbol}: Strong MARKUP phase (${wyckoffPhase.confidence}%)`
//           );
//         }
//       }

//       const validSignals = allSignals.filter((signal) => {
//         if (SCAN_CONFIG.tradingMode === 'SPOT' && signal?.side !== 'LONG') {
//           return false;
//         }

//         // âœ… When SMC is enabled, ALL signals must meet minimum SMC score
//         if (SCAN_CONFIG.smcEnabled && smc) {
//           if (smc.smcScore < SCAN_CONFIG.smcMinScore) {
//             return false;
//           }
//         }

//         // ðŸŽ¯ NEW: Zone-based filtering
//         if (smc?.premiumDiscount) {
//           // Block LONG in PREMIUM (unless exceptionally strong)
//           if (signal.side === 'LONG' && smc.premiumDiscount === 'PREMIUM') {
//             if (smc.smcScore < 55 || signal.confidence < 85) {
//               return false;
//             }
//           }

//           // Block SHORT in DISCOUNT (unless exceptionally strong)
//           if (signal.side === 'SHORT' && smc.premiumDiscount === 'DISCOUNT') {
//             if (smc.smcScore < 55 || signal.confidence < 85) {
//               return false;
//             }
//           }

//           // âœ… BOOST signals in correct zones
//           if (signal.side === 'LONG' && smc.premiumDiscount === 'DISCOUNT') {
//             signal.confidence += 10;
//             signal.reason += ' | âœ… DISCOUNT zone';
//           }

//           if (signal.side === 'SHORT' && smc.premiumDiscount === 'PREMIUM') {
//             signal.confidence += 10;
//             signal.reason += ' | âœ… PREMIUM zone';
//           }
//         }

//         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//           console.log(
//             `   ðŸ” ${symbol}: Checking SMC strategy ${signal.strategy}, score: ${smc.smcScore}, min: ${SCAN_CONFIG.smcMinScore}`
//           );
//           if (smc.smcScore < SCAN_CONFIG.smcMinScore) {
//             return false;
//           }
//         } else if (smc && signal?.strategy) {
//           console.log(
//             `   âš ï¸ ${symbol}: Strategy ${signal.strategy} not in smcStrategy array!`
//           );
//         }

//         const stabilityCheck = this.checkPriceStability(candles);
//         if (!stabilityCheck.stable) {
//           return {
//             symbol,
//             confidence: Math.max(0, signal.confidence - 30),
//             signal,
//             reason: `âš ï¸ Choppy market: ${stabilityCheck.reason}`,
//           };
//         }

//         const session = getMarketSession();

//         if (signal.strategy === 'LIQUIDITY_SWEEP') {
//           if (session === 'OVERLAP' || session === 'NEW_YORK') {
//             signal.confidence += 15;
//             signal.reason += ` (Session: ${session})`;
//           } else if (session === 'ASIA') {
//             signal.confidence -= 10;
//           }
//         }

//         // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//         // âœ… WYCKOFF SIGNAL VALIDATION - Advisory Mode
//         // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//         if (SCAN_CONFIG.wyckoffEnabled && wyckoffPhase) {
//           // Only apply Wyckoff filtering if confidence is meaningful (>40%)
//           if (wyckoffPhase.confidence > 40) {
//             const wyckoffTradeSignal =
//               this.wyckoffAnalyzer.getTradeSignal(wyckoffPhase);

//             if (wyckoffTradeSignal.shouldTrade) {
//               // Check directional alignment
//               if (wyckoffTradeSignal.side !== signal.side) {
//                 console.log(
//                   `   âŒ ${symbol}: Wyckoff wants ${wyckoffTradeSignal.side} but signal is ${signal.side} (conf: ${wyckoffPhase.confidence}%)`
//                 );
//                 return false;
//               }

//               // âœ… BOOST confidence if Wyckoff strongly agrees
//               if (wyckoffPhase.confidence >= 80) {
//                 signal.confidence = Math.min(95, signal.confidence + 15);
//                 signal.reason += ` | ðŸŽ¯ Wyckoff ${wyckoffPhase.phase} (${wyckoffPhase.confidence}%)`;
//                 console.log(
//                   `   âœ… ${symbol}: Wyckoff boost +15% (${wyckoffPhase.phase}, conf: ${wyckoffPhase.confidence}%)`
//                 );
//               } else if (wyckoffPhase.confidence >= 70) {
//                 signal.confidence = Math.min(95, signal.confidence + 10);
//                 signal.reason += ` | ðŸ“Š Wyckoff ${wyckoffPhase.phase} (${wyckoffPhase.confidence}%)`;
//                 console.log(
//                   `   âœ… ${symbol}: Wyckoff boost +10% (${wyckoffPhase.phase}, conf: ${wyckoffPhase.confidence}%)`
//                 );
//               } else if (wyckoffPhase.confidence >= 50) {
//                 signal.confidence = Math.min(95, signal.confidence + 5);
//                 signal.reason += ` | ðŸ“ˆ Wyckoff ${wyckoffPhase.phase} (${wyckoffPhase.confidence}%)`;
//                 console.log(
//                   `   âœ… ${symbol}: Wyckoff boost +5% (${wyckoffPhase.phase}, conf: ${wyckoffPhase.confidence}%)`
//                 );
//               }
//             } else {
//               // Wyckoff says no trade with meaningful confidence
//               console.log(
//                 `   âš ï¸ ${symbol}: Wyckoff advises against trade (${wyckoffTradeSignal.reason}, conf: ${wyckoffPhase.confidence}%)`
//               );
//               // Reduce confidence instead of blocking
//               signal.confidence = Math.max(0, signal.confidence - 15);
//               signal.reason += ` | âš ï¸ Wyckoff caution`;
//             }
//           } else {
//             // Low Wyckoff confidence - ignore it, don't penalize
//             console.log(
//               `   â„¹ï¸ ${symbol}: Wyckoff confidence too low (${wyckoffPhase.confidence}%) - not using for signal validation`
//             );
//           }
//         }

//         return true;
//       });

//       if (validSignals.length === 0) {
//         return null;
//       }

//       // ADD to analyzeSymbol()
//       const spreadCheck = await this.checkSpread(symbol);
//       if (!spreadCheck.acceptable) {
//         return {
//           symbol,
//           confidence: 0,
//           signal: null,
//           reason: `ðŸš« High spread: ${spreadCheck.spreadPercent.toFixed(2)}%`,
//         };
//       }

//       // 2. âœ… ADD: Recent volatility check
//       const volatilitySpike = this.detectVolatilitySpike(candles);
//       if (volatilitySpike.isPumping) {
//         console.log(
//           `ðŸš« ${symbol}: Recent ${volatilitySpike.spikePercent.toFixed(1)}% spike - trap risk`
//         );
//         return null;
//       }

//       // ADD to analyzeSymbol()
//       const volumeCheck = await this.checkVolumeQuality(symbol, candles);
//       if (!volumeCheck.isHealthy) {
//         return {
//           symbol,
//           confidence: 0,
//           signal: null,
//           reason: `ðŸš« ${volumeCheck.reason}`,
//         };
//       }

//       // ðŸš¨ ADD: Detect recent pump/dump
//       const volatilityCheck = this.detectVolatilitySpike(candles);
//       if (volatilityCheck.isPumping) {
//         return {
//           symbol,
//           confidence: 0,
//           signal: null,
//           reason: `ðŸš« Recent ${volatilityCheck.spikePercent.toFixed(1)}% spike detected - likely trap`,
//         };
//       }

//       const scoredSignals = validSignals.map((signal: EntrySignal) => {
//         let finalConfidence = signal?.confidence;

//         // 1. SMC strategy boost
//         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//           const smcContribution = (smc.smcScore / 100) * 30;
//           finalConfidence = Math.min(95, signal.confidence + smcContribution);
//         }

//         // 2. Relative Strength boost (FIXED)
//         if (btcCandles && btcCandles.closes.length >= 24) {
//           const rsRatio = calculateRelativeStrength(candles, btcCandles, 24);

//           if (signal.side === 'LONG') {
//             if (rsRatio > 1.02) {
//               finalConfidence += 10;
//               signal.reason += ` | ðŸ’ª High RS (${rsRatio.toFixed(2)})`;
//             } else if (rsRatio < 0.95) {
//               finalConfidence -= 20;
//               signal.reason += ` | âš ï¸ Low RS (${rsRatio.toFixed(2)})`;
//             }
//           }

//           if (signal.side === 'SHORT') {
//             if (rsRatio < 0.98) {
//               finalConfidence += 10;
//               signal.reason += ` | ðŸ“‰ High Relative Weakness`;
//             }
//           }
//         }

//         // 5. Cap at 100%
//         finalConfidence = Math.min(100, finalConfidence);

//         return {
//           signal,
//           finalConfidence,
//           smcScore: smc?.smcScore || 0,
//         };
//       });

//       const bestScoredSignal = scoredSignals.reduce((best, current) => {
//         const curFinalCon = current.finalConfidence as number;
//         const bestFinalCon = best.finalConfidence as number;
//         return curFinalCon > bestFinalCon ? current : best;
//       });

//       console.log(
//         `   âœ… ${symbol}: Best signal: ${bestScoredSignal.signal?.strategy} (${bestScoredSignal.finalConfidence?.toFixed(0)}%)`
//       );

//       const currentPrice = indicators.currentPrice;

//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//       // âœ… MULTI-TIMEFRAME TREND ANALYSIS (FIXED)
//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//       let trend15m: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';
//       let trend1h: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';

//       try {
//         trend15m = this.detectTrend(candles);
//         console.log(`   ðŸ“Š ${symbol} - 15m trend: ${trend15m}`);

//         const htfCandles = await this.htfManager.getHTFCandles(symbol, '1h');

//         if (htfCandles && htfCandles.closes.length >= 50) {
//           trend1h = this.detectTrend(htfCandles);
//           console.log(`   ðŸ“Š ${symbol} - 1h trend: ${trend1h}`);
//         } else {
//           console.log(
//             `   âš ï¸ ${symbol}: Insufficient 1h candles, skipping HTF check`
//           );
//         }
//       } catch (error: any) {
//         console.log(
//           `   âš ï¸ ${symbol}: Could not get HTF trend - ${error.message}`
//         );
//       }

//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//       // âœ… FILTER SIGNALS BASED ON TREND
//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//       if (bestScoredSignal.signal.side === 'LONG') {
//         if (trend1h === 'DOWN') {
//           console.log(
//             `   âŒ ${symbol}: LONG signal rejected - 1h trend is DOWN`
//           );
//           return null;
//         }

//         if (trend15m === 'UP' && trend1h === 'UP') {
//           bestScoredSignal.finalConfidence = Math.min(
//             95,
//             (bestScoredSignal.finalConfidence as number) + 12
//           );
//           bestScoredSignal.signal.reason += ' | ðŸš€ TF aligned UP';
//           console.log(`   âœ… ${symbol}: LONG boosted - all trends bullish`);
//         }

//         if (trend15m === 'UP' && trend1h === 'SIDEWAYS') {
//           bestScoredSignal.finalConfidence =
//             (bestScoredSignal.finalConfidence as number) * 0.9;
//           bestScoredSignal.signal.reason += ' | âš ï¸ 1h sideways';
//           console.log(`   âš ï¸ ${symbol}: LONG reduced - 1h trend unclear`);
//         }
//       }

//       if (bestScoredSignal.signal.side === 'SHORT') {
//         if (trend1h === 'UP') {
//           console.log(
//             `   âŒ ${symbol}: SHORT signal rejected - 1h trend is UP`
//           );
//           return null;
//         }

//         if (trend15m === 'DOWN' && trend1h === 'DOWN') {
//           bestScoredSignal.finalConfidence = Math.min(
//             95,
//             (bestScoredSignal.finalConfidence as number) + 12
//           );
//           bestScoredSignal.signal.reason += ' | ðŸ“‰ TF aligned DOWN';
//           console.log(`   âœ… ${symbol}: SHORT boosted - all trends bearish`);
//         }

//         if (trend15m === 'DOWN' && trend1h === 'SIDEWAYS') {
//           bestScoredSignal.finalConfidence =
//             (bestScoredSignal.finalConfidence as number) * 0.9;
//           bestScoredSignal.signal.reason += ' | âš ï¸ 1h sideways';
//           console.log(`   âš ï¸ ${symbol}: SHORT reduced - 1h trend unclear`);
//         }
//       }

//       let stopLoss: number;
//       let takeProfit: number;

//       console.log(`   ðŸ“Š ${symbol} - ALL SIGNALS BEFORE FILTERING:`);
//       allSignals.forEach((s) => {
//         console.log(`      ${s.strategy}: ${s.confidence}% (${s.side})`);
//       });

//       console.log(`   âœ… ${symbol} - VALID SIGNALS AFTER FILTERING:`);
//       validSignals.forEach((s) => {
//         console.log(`      ${s.strategy}: ${s.confidence}% (${s.side})`);
//       });

//       console.log(`   ðŸŽ¯ ${symbol} - SCORED SIGNALS:`);
//       scoredSignals.forEach((s) => {
//         console.log(`      ${s.signal.strategy}: ${s.finalConfidence}%`);
//       });

//       try {
//         const atrArray = ATR.calculate({
//           high: candles.highs,
//           low: candles.lows,
//           close: candles.closes,
//           period: 14,
//         });
//         const atr = atrArray[atrArray.length - 1];

//         if (!atr || atr <= 0) {
//           throw new Error('Invalid ATR');
//         }

//         let riskDistance = atr * RISK_REWARD_CONFIG.atrMultiplier;

//         const maxRisk =
//           currentPrice * (RISK_REWARD_CONFIG.maxRiskPercent / 100);
//         const minRisk =
//           currentPrice * (RISK_REWARD_CONFIG.minRiskPercent / 100);

//         riskDistance = Math.max(minRisk, Math.min(riskDistance, maxRisk));

//         const rewardDistance = riskDistance * RISK_REWARD_CONFIG.ratio;

//         if (bestScoredSignal.signal.side === 'LONG') {
//           stopLoss = currentPrice - riskDistance;
//           takeProfit = currentPrice + rewardDistance;
//         } else {
//           stopLoss = currentPrice + riskDistance;
//           takeProfit = currentPrice - rewardDistance;
//         }

//         const riskPct = (riskDistance / currentPrice) * 100;
//         const rewardPct = (rewardDistance / currentPrice) * 100;
//         const actualRR = rewardPct / riskPct;

//         console.log(
//           `   âœ… ${symbol} | Risk: ${riskPct.toFixed(2)}% | Reward: ${rewardPct.toFixed(2)}% | R:R = 1:${actualRR.toFixed(1)}`
//         );
//       } catch (e) {
//         const risk = RISK_REWARD_CONFIG.maxRiskPercent / 100;
//         const reward = risk * RISK_REWARD_CONFIG.ratio;

//         if (bestScoredSignal.signal.side === 'LONG') {
//           stopLoss = currentPrice * (1 - risk);
//           takeProfit = currentPrice * (1 + reward);
//         } else {
//           stopLoss = currentPrice * (1 + risk);
//           takeProfit = currentPrice * (1 - reward);
//         }

//         console.log(`   âš ï¸ Fallback R:R - 1:${RISK_REWARD_CONFIG.ratio}`);
//       }

//       bestScoredSignal.signal.stopLoss = stopLoss;
//       bestScoredSignal.signal.takeProfit = takeProfit;
//       bestScoredSignal.signal.entryPrice = currentPrice;

//       const result: ExtendedScanResult = {
//         symbol,
//         signal: bestScoredSignal.signal,
//         confidence: bestScoredSignal.finalConfidence as number,
//         price: indicators.currentPrice,
//         indicators,
//         regime,
//         rsi: indicators.rsi,
//         timestamp: new Date(),
//         marketType: marketType as BotType,
//         wyckoff: wyckoffPhase,
//       };

//       if (smc) {
//         result.smc = smc;
//       }

//       return result;
//     } catch (err: any) {
//       return null;
//     }
//   }

//   async scanAll(): Promise<ExtendedScanResult[]> {
//     this.scanCount++;

//     console.log('\n' + 'â•'.repeat(80));
//     console.log(`ðŸ”„ SCAN #${this.scanCount} - Starting...`);
//     console.log('â•'.repeat(80));

//     try {
//       console.log('\nðŸŽ§ Checking what DJ Trump (BTC) is playing...\n');

//       // Get BTC candles for weather check
//       const btcCandles = this.candleManager.getCandles('BTCUSDT', 'FUTURES');

//       if (!btcCandles || btcCandles.closes.length < 25) {
//         console.log('âš ï¸ Cannot check weather - BTC data insufficient');
//         console.log('   Proceeding with caution (reduced positions)...\n');

//         // Set conservative weather if we can't check
//         this.currentWeather = {
//           condition: 'CLAUDE',
//           shouldTrade: true,
//           reason: 'Cannot verify market conditions - trading cautiously',
//           metrics: {
//             volatility: 0,
//             btcChange24h: 0,
//             volume: 0,
//             trendStrength: 0,
//           },
//           tradingRules: {
//             maxPositions: 2,
//             minConfidence: 85,
//             riskMultiplier: 0.7,
//           },
//         };

//         this.weatherCheckFailures++;

//         // If weather check fails 3 times in a row, something's wrong
//         if (this.weatherCheckFailures >= 3) {
//           console.log('âŒ Weather check failed 3 times - possible API issues');
//           console.log('   Skipping this scan for safety...\n');
//           return [];
//         }
//       } else {
//         // Reset failure counter on success
//         this.weatherCheckFailures = 0;

//         // Check weather!
//         this.currentWeather = await checkMarketWeather(btcCandles, {});
//         displayWeather(this.currentWeather);
//       }

//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//       // ðŸ STEP 2: DECIDE WHETHER TO FISH TODAY
//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//       if (!this.currentWeather.shouldTrade) {
//         console.log('\nðŸ MORAY DECISION: Staying in hole!');
//         console.log(`   ${this.currentWeather.reason}`);
//         console.log('   ðŸ’¤ Saving resources - skipping token scan');
//         console.log('   â° Checking again next interval...\n');
//         console.log('â•'.repeat(80));

//         // Return empty array - don't scan anything!
//         // This saves: 100 API calls, 2 minutes, CPU, memory
//         return [];
//       }

//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//       // âœ… STEP 3: WEATHER IS GOOD - ADJUST STRATEGY
//       // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//       console.log('\nðŸ MORAY DECISION: Good weather for hunting!');
//       console.log('   Adjusting strategy based on conditions...\n');

//       // Store original config
//       const originalConfig = {
//         minConfidence: SCAN_CONFIG.minConfidence,
//         maxConcurrentPositions: SCAN_CONFIG.maxConcurrentPositions || 4,
//       };

//       // Temporarily adjust based on weather
//       SCAN_CONFIG.minConfidence =
//         this.currentWeather.tradingRules.minConfidence;

//       console.log('ðŸ“Š Weather-Adjusted Trading Rules:');
//       console.log(
//         `   Weather: ${this.getWeatherEmoji()} ${this.currentWeather.condition}`
//       );
//       console.log(`   Min Confidence: ${SCAN_CONFIG.minConfidence}%`);
//       console.log(
//         `   Max Positions: ${this.currentWeather.tradingRules.maxPositions}`
//       );
//       console.log(
//         `   Risk Multiplier: ${this.currentWeather.tradingRules.riskMultiplier}x`
//       );
//       console.log('');
//     } catch (error) {
//       console.error('âŒ Weather check error:', error);
//       console.log('   Proceeding with default settings...\n');

//       // Set safe defaults on error
//       this.currentWeather = {
//         condition: 'CLAUDE',
//         shouldTrade: true,
//         reason: 'Weather check failed - using defaults',
//         metrics: {
//           volatility: 0,
//           btcChange24h: 0,
//           volume: 0,
//           trendStrength: 0,
//         },
//         tradingRules: {
//           maxPositions: 2,
//           minConfidence: 85,
//           riskMultiplier: 0.7,
//         },
//       };
//     }

//     await this.updateAllCandles();

//     const allResults: ExtendedScanResult[] = [];
//     let symbolsScanned = 0;
//     let symbolsWithSignals = 0;

//     for (const symbol of symbols) {
//       symbolsScanned++;
//       const symbolResults = await this.scanSymbol(symbol);

//       if (symbolResults) {
//         if (symbolResults.confidence >= SCAN_CONFIG.minConfidence) {
//           symbolsWithSignals++;
//           allResults.push(symbolResults);
//           this.scanResults.set(symbol, symbolResults);
//         } else {
//           // console.log(
//           //   `   âš ï¸ ${symbol}: Confidence ${symbolResults.confidence}% below weather-adjusted minimum ${SCAN_CONFIG.minConfidence}%`
//           // );
//         }
//         // symbolsWithSignals++;
//         // allResults.push(symbolResults);
//         // this.scanResults.set(symbol, symbolResults);
//       }
//     }

//     console.log('â•'.repeat(80));
//     console.log(`ðŸ“Š SCAN COMPLETE:`);
//     console.log(
//       `   Weather: ${this.getWeatherEmoji()} ${this.currentWeather?.condition || 'UNKNOWN'}`
//     );
//     console.log(`   Symbols Scanned: ${symbolsScanned}`);
//     console.log(`   Symbols with Signals: ${symbolsWithSignals}`);
//     console.log(`   Total Valid Signals: ${allResults.length}`);
//     console.log('â•'.repeat(80));

//     // After sorting by confidence, add strategy diversity
//     const diversifySignals = (signals: typeof allResults) => {
//       const strategyCount = new Map<string, number>();
//       const maxPerStrategy = Math.ceil(signals.length / 3); // Max 33% per strategy

//       return signals.filter((result) => {
//         const strategy = result.signal?.strategy as StrategyId;
//         const count = strategyCount.get(strategy) || 0;

//         if (count >= maxPerStrategy) {
//           console.log(
//             `   âš ï¸ ${result.symbol}: Skipping ${strategy} (already have ${count})`
//           );
//           return false;
//         }

//         strategyCount.set(strategy, count + 1);
//         return true;
//       });
//     };

//     allResults.sort((a, b) => b.confidence - a.confidence);
//     const diversified = diversifySignals(allResults);

//     // âœ… Apply weather-based position limits
//     const weatherLimitedResults = diversified.slice(
//       0,
//       this.currentWeather?.tradingRules.maxPositions || 2
//     );

//     if (weatherLimitedResults.length < diversified.length) {
//       console.log(
//         `\nðŸŒ¡ï¸ Weather limit: Keeping top ${weatherLimitedResults.length} signals (weather allows max ${this.currentWeather?.tradingRules.maxPositions})`
//       );
//     }
//     this.exportSignalsForBothModes(diversified);

//     return weatherLimitedResults;
//   }

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // STEP 4: Add helper method for weather emoji
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//   private getWeatherEmoji(): string {
//     if (!this.currentWeather) return 'â“';

//     const emojiMap = {
//       CLEAR: 'â˜€ï¸',
//       CLAUDE: 'â›…',
//       SHITTY: 'ðŸŒ§ï¸',
//       FUCK: 'ðŸŒ€',
//     } as any;

//     return emojiMap[this.currentWeather.condition] || 'â“';
//   }

//   private exportSignalsForBothModes(results: ExtendedScanResult[]): void {
//     const longSignals = results.filter((r) => r.signal?.side === 'LONG');
//     const shortSignals = results.filter((r) => r.signal?.side === 'SHORT');
//     const allSignals = results;

//     const spotOutput = longSignals
//       .filter((r) => r.confidence >= 60)
//       .map((r) => this.formatSignalOutput(r));
//     const futuresOutput = allSignals
//       .filter((r) => r.confidence >= 60)
//       .map((r) => this.formatSignalOutput(r));
//     const futuresLegacyOutput = allSignals
//       .filter((r) => r.confidence >= 60)
//       .map((r) => this.formatSignalOutput(r));
//     const allOutput = allSignals.map((r) => this.formatSignalOutput(r));

//     fs.writeFileSync(
//       SCAN_CONFIG.outputFiles.spot,
//       JSON.stringify(spotOutput, null, 2)
//     );
//     fs.writeFileSync(
//       SCAN_CONFIG.outputFiles.futures,
//       JSON.stringify(futuresOutput, null, 2)
//     );
//     fs.writeFileSync(
//       SCAN_CONFIG.outputFiles.futuresLegacy,
//       JSON.stringify(futuresLegacyOutput, null, 2)
//     );
//     fs.writeFileSync(
//       SCAN_CONFIG.outputFiles.all,
//       JSON.stringify(allOutput, null, 2)
//     );
//   }

//   private formatSignalOutput(result: ExtendedScanResult): any {
//     return {
//       symbol: result.symbol,
//       price: result.price,
//       confidence: result.confidence,
//       signal: result.signal
//         ? {
//             ...result.signal,
//             entryPrice: result.signal.entryPrice,
//             stopLoss: result.signal.stopLoss,
//             takeProfit: result.signal.takeProfit,
//             // ... other fields
//           }
//         : null,
//       regime: result.regime,
//       rsi: result.rsi,
//       timestamp: result.timestamp,
//       smc: result.smc
//         ? {
//             score: result.smc.smcScore,
//             zone: result.smc.premiumDiscount,
//             bos: result.smc.bos.detected ? result.smc.bos.type : null,
//             choch: result.smc.choch.detected ? result.smc.choch.type : null,
//             orderBlocks: result.smc.orderBlocks.length,
//             activeOrderBlocks: result.smc.orderBlocks.filter(
//               (ob) => !ob.mitigated
//             ).length,
//             fvgs: result.smc.fvgs.length,
//             activeFvgs: result.smc.fvgs.filter((fvg) => !fvg.filled).length,
//             liquidityLevels: result.smc.liquidityLevels.length,
//             sweptLiquidity: result.smc.liquidityLevels.filter((l) => l.swept)
//               .length,
//           }
//         : undefined,
//       wyckoff: result.wyckoff
//         ? {
//             // âœ… Add this
//             phase: result.wyckoff.phase,
//             stage: result.wyckoff.stage,
//             confidence: result.wyckoff.confidence,
//             signal: result.wyckoff.signal,
//             strength: result.wyckoff.strength,
//             description: result.wyckoff.description,
//           }
//         : undefined,
//     };
//   }

//   private async check24hVolume(
//     symbol: string,
//     marketType: BotType
//   ): Promise<number> {
//     try {
//       const normalizedSymbol = normalize(symbol, marketType).replace('/', '');
//       const baseUrl =
//         marketType === 'FUTURES'
//           ? 'https://fapi.binance.com/fapi/v1'
//           : 'https://api.binance.com/api/v3';

//       const response = await fetch(
//         `${baseUrl}/ticker/24hr?symbol=${normalizedSymbol}`
//       );

//       if (!response.ok) {
//         return 0;
//       }

//       const data = (await response.json()) as any;

//       // quoteVolume is the 24h volume in USDT
//       return parseFloat(data.quoteVolume || '0');
//     } catch (err: any) {
//       console.error(`Failed to fetch volume for ${symbol}: ${err.message}`);
//       return 0; // Return 0 to skip this symbol
//     }
//   }

//   private async updateAllCandles(): Promise<void> {
//     const updatePromises = symbols.map(async (symbol, index) => {
//       const normalizedSymbol = normalize(symbol, this.marketType);

//       try {
//         await this.candleManager.updateCandles(
//           normalizedSymbol,
//           this.marketType
//         );
//         await new Promise((resolve) => setTimeout(resolve, index * 100));
//       } catch (err: any) {
//         // Silently continue on error
//       }
//     });

//     await Promise.all(updatePromises);
//   }

//   displayResults(results: ExtendedScanResult[]): void {
//     console.clear();

//     console.log(
//       colorize(
//         'â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—',
//         colors.cyan
//       )
//     );
//     console.log(
//       colorize(
//         'â•‘                                                  ðŸš€ CRYPTO TRADING SCANNER WITH SMC ðŸš€                                                          â•‘',
//         colors.cyan
//       )
//     );

//     // âœ… ADD WEATHER STATUS
//     if (this.currentWeather) {
//       const emoji = this.getWeatherEmoji();
//       const djMood = this.getDJMood();
//       const weatherLine =
//         `â•‘  ${emoji} DJ Trump Status: ${djMood}`.padEnd(145) + 'â•‘';
//       console.log(colorize(weatherLine, colors.cyan));
//     }

//     console.log(
//       colorize(
//         'â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•',
//         colors.cyan
//       )
//     );
//     console.log();

//     const filteredResults = SCAN_CONFIG.showAllTokens
//       ? results
//       : results.filter((r) => r.confidence >= SCAN_CONFIG.minConfidence);
//     // console.log(
//     //   'ðŸ¥‘ ~ TradingScanner ~ displayResults ~ filteredResults:',
//     //   filteredResults
//     // );

//     const displayResults = filteredResults
//       .sort((a, b) => b.confidence - a.confidence)
//       .slice(0, SCAN_CONFIG.displayLimit);

//     const table = new Table({
//       head: [
//         colorize('#', colors.bright),
//         colorize('Symbol', colors.bright),
//         colorize('Price', colors.bright),
//         colorize('Signal', colors.bright),
//         colorize('Conf%', colors.bright),
//         colorize('RSI', colors.bright),
//         colorize('Trend', colors.bright),
//         colorize('SMC', colors.bright),
//         colorize('Zone', colors.bright),
//         colorize('Wyckoff', colors.bright),
//         colorize('Status', colors.bright),
//       ],
//       colWidths: [5, 12, 14, 10, 8, 8, 12, 10, 12, 15, 45],
//       style: {
//         head: [],
//         border: ['gray'],
//       },
//       chars: {
//         top: 'â•',
//         'top-mid': 'â•¤',
//         'top-left': 'â•”',
//         'top-right': 'â•—',
//         bottom: 'â•',
//         'bottom-mid': 'â•§',
//         'bottom-left': 'â•š',
//         'bottom-right': 'â•',
//         left: 'â•‘',
//         'left-mid': 'â•Ÿ',
//         mid: 'â”€',
//         'mid-mid': 'â”¼',
//         right: 'â•‘',
//         'right-mid': 'â•¢',
//         middle: 'â”‚',
//       },
//     });

//     displayResults.forEach((result, i) => {
//       // console.log(
//       //   'ðŸ¥‘ ~ TradingScanner ~ displayResults ~ result:',
//       //   JSON.stringify(result, null, 2)
//       // );
//       const rowNumber = colorize(
//         (i + 1).toString().padStart(2, ' '),
//         colors.gray
//       );
//       const symbolColor =
//         result.confidence >= SCAN_CONFIG.minConfidence
//           ? colors.brightCyan
//           : colors.gray;
//       const symbolText = colorize(result.symbol, symbolColor);

//       const priceColor =
//         result.signal?.side === 'LONG'
//           ? colors.brightGreen
//           : result.signal?.side === 'SHORT'
//             ? colors.brightRed
//             : colors.yellow;
//       const priceText = colorize(
//         `${result.price?.toFixed(getPriceDecimals(result.price))}`,
//         priceColor
//       );

//       let signalText = colorize('â”€', colors.gray);
//       if (result.signal?.side === 'LONG') {
//         signalText = colorize('ðŸš€ LONG', colors.brightGreen);
//       } else if (result.signal?.side === 'SHORT') {
//         signalText = colorize('ðŸ“‰ SHORT', colors.brightRed);
//       }

//       const confColor =
//         result.confidence >= 80
//           ? colors.brightGreen
//           : result.confidence >= 70
//             ? colors.green
//             : result.confidence >= 60
//               ? colors.yellow
//               : colors.gray;
//       const confText = colorize(`${result.confidence.toFixed(0)}%`, confColor);

//       let rsiText = '';
//       if (result.rsi && result.rsi < 30) {
//         rsiText = colorize(
//           `${result.rsi && result.rsi.toFixed(1)} ðŸ”¥`,
//           colors.brightGreen
//         );
//       } else if (result.rsi && result.rsi < 40) {
//         rsiText = colorize(
//           `${result.rsi && result.rsi.toFixed(1)} â†“`,
//           colors.green
//         );
//       } else if (result.rsi && result.rsi > 70) {
//         rsiText = colorize(
//           `${result.rsi && result.rsi.toFixed(1)} ðŸŒ¡ï¸`,
//           colors.brightRed
//         );
//       } else if (result.rsi && result.rsi > 60) {
//         rsiText = colorize(
//           `${result.rsi && result.rsi.toFixed(1)} â†‘`,
//           colors.red
//         );
//       } else {
//         rsiText = colorize(
//           `${result.rsi && result.rsi.toFixed(1)} â”€`,
//           colors.gray
//         );
//       }

//       let trendText = colorize('RANGING ðŸ“Š', colors.yellow);
//       if (result.regime?.trend === 'UPTREND') {
//         trendText = colorize('UPTREND ðŸ“ˆ', colors.green);
//       } else if (result.regime?.trend === 'DOWNTREND') {
//         trendText = colorize('DOWNTREND ðŸ“‰', colors.red);
//       }

//       let smcText = colorize('â”€', colors.gray);
//       if (result.smc) {
//         const smcColor =
//           result.smc.smcScore >= 70
//             ? colors.brightGreen
//             : result.smc.smcScore >= 50
//               ? colors.yellow
//               : colors.gray;
//         smcText = colorize(`${result.smc.smcScore.toFixed(0)}`, smcColor);
//         if (result.smc.bos.detected)
//           smcText += colorize(' BOS', colors.brightMagenta);
//         if (result.smc.choch.detected)
//           smcText += colorize(' CHoCH', colors.brightYellow);
//       }

//       let zoneText = colorize('â”€', colors.gray);
//       if (result.smc) {
//         if (result.smc.premiumDiscount === 'PREMIUM') {
//           zoneText = colorize('PREMIUM ðŸ”´', colors.red);
//         } else if (result.smc.premiumDiscount === 'DISCOUNT') {
//           zoneText = colorize('DISCOUNT ðŸŸ¢', colors.green);
//         } else {
//           zoneText = colorize('EQUILIBRIUM', colors.yellow);
//         }
//       }

//       let statusText = '';
//       if (result.confidence >= 70) {
//         statusText = colorize('â­ Strong Signal', colors.brightGreen);
//       } else if (result.confidence >= 60) {
//         statusText = colorize('âœ“ Good Signal', colors.green);
//       } else if (result.confidence >= 50) {
//         statusText = colorize('âš  Weak Signal', colors.yellow);
//       } else {
//         statusText = colorize('â”€ No Signal', colors.gray);
//       }

//       if (result.signal?.reason) {
//         const shortReason = result.signal.reason
//           .split('. ')[0]
//           ?.substring(0, 100);
//         statusText += colorize(` | ${shortReason}`, colors.brightGreen);
//       }

//       let wyckoffText = colorize('â”€', colors.gray);
//       if (result.wyckoff) {
//         const phaseEmoji = {
//           ACCUMULATION: 'ðŸ“¥',
//           MARKUP: 'ðŸš€',
//           DISTRIBUTION: 'ðŸ“¤',
//           MARKDOWN: 'ðŸ“‰',
//           NEUTRAL: 'â”€',
//           UNKNOWN: '?',
//         };

//         const phaseColor =
//           result.wyckoff.phase === 'ACCUMULATION' ||
//           result.wyckoff.phase === 'MARKUP'
//             ? colors.brightGreen
//             : result.wyckoff.phase === 'DISTRIBUTION' ||
//                 result.wyckoff.phase === 'MARKDOWN'
//               ? colors.brightRed
//               : colors.yellow;

//         wyckoffText = colorize(
//           `${phaseEmoji[result.wyckoff.phase]} ${result.wyckoff.confidence}%`,
//           phaseColor
//         );
//       }

//       table.push([
//         rowNumber,
//         symbolText,
//         priceText,
//         signalText,
//         confText,
//         rsiText,
//         trendText,
//         smcText,
//         zoneText,
//         wyckoffText,
//         statusText,
//       ]);
//     });

//     console.log(table.toString());

//     console.log(colorize('â•'.repeat(147), colors.cyan));

//     const longSignals = results.filter(
//       (r) =>
//         r.signal?.side === 'LONG' && r.confidence >= SCAN_CONFIG.minConfidence
//     ).length;
//     const shortSignals = results.filter(
//       (r) =>
//         r.signal?.side === 'SHORT' && r.confidence >= SCAN_CONFIG.minConfidence
//     ).length;
//     const strongSignals = results.filter((r) => r.confidence >= 70).length;
//     const smcSignals = results.filter(
//       (r) =>
//         r.signal &&
//         smcStrategies.includes(r.signal.strategy) &&
//         r.confidence >= SCAN_CONFIG.smcMinScore
//     ).length;
//     const avgConfidence =
//       results.length > 0
//         ? (
//             results.reduce((sum, r) => sum + r.confidence, 0) / results.length
//           ).toFixed(1)
//         : '0';

//     const summaryTable = new Table({
//       head: [
//         colorize('Metric', colors.bright),
//         colorize('Value', colors.bright),
//       ],
//       style: {
//         head: [],
//         border: ['gray'],
//       },
//     });

//     summaryTable.push(
//       [
//         'ðŸŒ¡ï¸ Market Weather',
//         this.currentWeather
//           ? colorize(
//               `${this.getWeatherEmoji()} ${this.currentWeather.condition}`,
//               this.getWeatherColor()
//             )
//           : colorize('Unknown', colors.gray),
//       ],
//       [
//         'ðŸ“Š BTC 24h Change',
//         this.currentWeather
//           ? colorize(
//               `${this.currentWeather.metrics.btcChange24h >= 0 ? '+' : ''}${this.currentWeather.metrics.btcChange24h.toFixed(2)}%`,
//               this.currentWeather.metrics.btcChange24h >= 0
//                 ? colors.green
//                 : colors.red
//             )
//           : colorize('â”€', colors.gray),
//       ],
//       [
//         'Total Tokens Scanned',
//         colorize(results.length.toString(), colors.cyan),
//       ],
//       [
//         'ðŸš€ Long Signals',
//         colorize(longSignals.toString(), colors.brightGreen),
//       ],
//       [
//         'ðŸ“‰ Short Signals',
//         colorize(shortSignals.toString(), colors.brightRed),
//       ],
//       [
//         'â­ Strong Signals (70%+)',
//         colorize(strongSignals.toString(), colors.brightYellow),
//       ],
//       [
//         'ðŸ’Ž SMC Signals (40%+)',
//         colorize(smcSignals.toString(), colors.brightMagenta),
//       ],
//       ['ðŸ“Š Average Confidence', colorize(`${avgConfidence}%`, colors.yellow)],
//       [
//         'ðŸ’¾ Memory Usage',
//         colorize(
//           `${this.candleManager.getMemoryStats().memoryMB}MB`,
//           colors.gray
//         ),
//       ],
//       [
//         'ðŸ”„ Next Scan In',
//         colorize(`${SCAN_CONFIG.scanInterval / 1000}s`, colors.cyan),
//       ]
//     );

//     console.log(summaryTable.toString());
//     console.log(colorize('â•'.repeat(80), colors.cyan));

//     const bullishCount = results.filter(
//       (r) => r.signal?.side === 'LONG'
//     ).length;
//     const bearishCount = results.filter(
//       (r) => r.signal?.side === 'SHORT'
//     ).length;
//     const bullishPercent =
//       results.length > 0
//         ? ((bullishCount / results.length) * 100).toFixed(0)
//         : '0';
//     const bearishPercent =
//       results.length > 0
//         ? ((bearishCount / results.length) * 100).toFixed(0)
//         : '0';

//     let sentiment = 'âš–ï¸  NEUTRAL';
//     let sentimentColor = colors.yellow;
//     if (results.length > 0 && bullishCount > bearishCount * 1.5) {
//       sentiment = 'ðŸŸ¢ BULLISH MARKET';
//       sentimentColor = colors.brightGreen;
//     } else if (results.length > 0 && bearishCount > bullishCount * 1.5) {
//       sentiment = 'ðŸ”´ BEARISH MARKET';
//       sentimentColor = colors.brightRed;
//     }

//     console.log(
//       colorize(
//         `Market Sentiment: ${sentiment} (${bullishPercent}% Bullish | ${bearishPercent}% Bearish)`,
//         sentimentColor
//       )
//     );
//     console.log(colorize('â•'.repeat(80), colors.cyan));
//     console.log(
//       colorize(
//         `SMC Mode: ${SCAN_CONFIG.smcEnabled ? 'ENABLED âœ…' : 'DISABLED'} | Mode: ${SCAN_CONFIG.tradingMode}`,
//         colors.brightCyan
//       )
//     );
//     console.log(colorize('â•'.repeat(80), colors.cyan));
//     console.log(
//       colorize(
//         'Press Ctrl+C to stop | Scanner running in-place update mode',
//         colors.gray
//       )
//     );

//     // In displayResults, add to summary table

//     const wyckoffAccumulation = results.filter(
//       (r) => r.wyckoff?.phase === 'ACCUMULATION' && r.wyckoff.confidence >= 70
//     ).length;

//     const wyckoffMarkup = results.filter(
//       (r) => r.wyckoff?.phase === 'MARKUP'
//     ).length;

//     summaryTable.push(
//       // ... existing rows ...
//       [
//         'ðŸ“¥ Wyckoff Accumulation',
//         colorize(wyckoffAccumulation.toString(), colors.brightGreen),
//       ],
//       [
//         'ðŸš€ Wyckoff Markup',
//         colorize(wyckoffMarkup.toString(), colors.brightCyan),
//       ]
//     );
//   }

//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   // STEP 6: Helper methods for weather display
//   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

//   private getDJMood(): string {
//     if (!this.currentWeather) return 'Unknown';

//     const moodMap = {
//       CLEAR: 'Playing smooth house - Perfect hunting! ðŸŽµ',
//       CLAUDE: 'Playing mid-tempo - Trade carefully ðŸŽ¶',
//       SHITTY: 'Playing hardcore - Dangerous! ðŸ”Š',
//       FUCK_ME: 'TARIFFS MIX! GET OUT! ðŸ’¥',
//     };

//     return moodMap[this.currentWeather.condition] || 'Unknown mix';
//   }

//   private getWeatherColor(): string {
//     if (!this.currentWeather) return colors.gray;

//     const colorMap = {
//       CLEAR: colors.brightGreen,
//       CLAUDE: colors.yellow,
//       SHITTY: colors.brightRed,
//       FUCK_ME: colors.brightMagenta,
//     };

//     return colorMap[this.currentWeather.condition] || colors.gray;
//   }

//   async startContinuousScanning(): Promise<void> {
//     await new Promise((resolve) => setTimeout(resolve, 3000));

//     const results = await this.scanAll();
//     this.displayResults(results);

//     setInterval(async () => {
//       const results = await this.scanAll();
//       this.displayResults(results);
//     }, SCAN_CONFIG.scanInterval);
//   }

//   async runSingleScan(): Promise<void> {
//     const results = await this.scanAll();
//     this.displayResults(results);
//     log('âœ… Single scan complete', 'success');
//   }

//   destroy(): void {
//     if (this.candleManager) {
//       this.candleManager.destroy();
//       log('ðŸ—‘ï¸ CandleManager destroyed', 'info');
//     }
//   }
// }

// // ============================================================================
// // MAIN
// // ============================================================================

// let scanner: TradingScanner | null = null;

// async function main() {
//   const args = process.argv.slice(2);
//   const modeArg = args.find((arg) => arg.startsWith('--mode='));

//   if (modeArg) {
//     const mode = modeArg.split('=')[1]?.toUpperCase();
//     if (mode === 'SPOT' || mode === 'FUTURES' || mode === 'BOTH') {
//       SCAN_CONFIG.tradingMode = mode as 'SPOT' | 'FUTURES' | 'BOTH';
//     }
//   }

//   console.log(colorize('â•'.repeat(80), colors.cyan));
//   console.log(
//     colorize(
//       'ðŸš€ Crypto Trading Scanner with SMC (Smart Money Concepts)',
//       colors.brightCyan
//     )
//   );
//   console.log(
//     colorize(
//       `   Mode: ${SCAN_CONFIG.tradingMode} | SMC: ${SCAN_CONFIG.smcEnabled ? 'ON' : 'OFF'}`,
//       colors.yellow
//     )
//   );
//   console.log(colorize('â•'.repeat(80), colors.cyan));

//   try {
//     scanner = new TradingScanner();
//     await scanner.initialize();

//     if (SCAN_CONFIG.enableContinuousMode) {
//       await scanner.startContinuousScanning();
//     } else {
//       await scanner.runSingleScan();
//       process.exit(0);
//     }
//   } catch (err: any) {
//     log(`Fatal error: ${err.message}`, 'error');
//     console.error(err.stack);
//     process.exit(1);
//   }
// }

// process.on('SIGINT', () => {
//   log('\nðŸ‘‹ Shutting down scanner...', 'warning');
//   if (scanner) {
//     scanner.destroy();
//   }
//   process.exit(0);
// });

// process.on('SIGTERM', () => {
//   log('\nðŸ‘‹ Shutting down scanner...', 'warning');
//   if (scanner) {
//     scanner.destroy();
//   }
//   process.exit(0);
// });

// main();

// // Type guard for the response
// function isBinanceOrderBookResponse(
//   data: unknown
// ): data is BinanceOrderBookResponse {
//   if (!data || typeof data !== 'object') return false;

//   const d = data as any;

//   return (
//     typeof d.lastUpdateId === 'number' &&
//     Array.isArray(d.bids) &&
//     Array.isArray(d.asks) &&
//     d.bids.every(
//       (bid: any) =>
//         Array.isArray(bid) &&
//         bid.length >= 2 &&
//         typeof bid[0] === 'string' &&
//         typeof bid[1] === 'string'
//     ) &&
//     d.asks.every(
//       (ask: any) =>
//         Array.isArray(ask) &&
//         ask.length >= 2 &&
//         typeof ask[0] === 'string' &&
//         typeof ask[1] === 'string'
//     )
//   );
// }

// interface BinanceOrderBookResponse {
//   lastUpdateId: number;
//   bids: string[][]; // [price, quantity]
//   asks: string[][]; // [price, quantity]
//   // Binance might also include these fields:
//   // E?: number; // Message output time
//   // T?: number; // Transaction time
// }

// // Define your OrderBook type (if you don't have it already)
// interface OrderBookLevel {
//   price: number;
//   quantity: number;
//   total: number;
// }

// interface OrderBook {
//   bids: OrderBookLevel[];
//   asks: OrderBookLevel[];
//   lastUpdateId: number;
// }

// // import fs from 'fs';

// // import Table from 'cli-table3';
// // import * as dotenv from 'dotenv';
// // import { EMA, RSI } from 'technicalindicators';

// // import {
// //   colors,
// //   getPriceDecimals,
// //   normalize,
// //   type MarketType,
// // } from '../../lib/helpers.js';
// // import { calculateIndicators, detectRegime } from '../../lib/trading-utils.js';
// // import {
// //   smcStrategies,
// //   smcStrategy,
// //   strategyId,
// //   type BotType,
// //   type CandleData,
// //   type EntrySignal,
// //   type Indicators,
// // } from '../../lib/type.js';
// // import { CandleManager, HTFCandleManager } from '../core/candles.js';

// // dotenv.config();

// // // ============================================================================
// // // SMC (SMART MONEY CONCEPTS) TYPES
// // // ============================================================================

// // interface OrderBlock {
// //   type: 'BULLISH' | 'BEARISH';
// //   high: number;
// //   low: number;
// //   index: number;
// //   strength: number;
// //   mitigated: boolean;
// // }

// // interface FairValueGap {
// //   type: 'BULLISH' | 'BEARISH';
// //   top: number;
// //   bottom: number;
// //   index: number;
// //   filled: boolean;
// // }

// // interface LiquidityLevel {
// //   type: 'HIGH' | 'LOW';
// //   price: number;
// //   strength: number;
// //   swept: boolean;
// // }

// // interface SMCAnalysis {
// //   orderBlocks: OrderBlock[];
// //   fvgs: FairValueGap[];
// //   liquidityLevels: LiquidityLevel[];
// //   bos: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
// //   choch: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
// //   premiumDiscount: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
// //   smcScore: number;
// // }

// // export interface ExtendedScanResult {
// //   symbol: string;
// //   signal: EntrySignal | null;
// //   confidence: number;
// //   price: number;
// //   indicators: Indicators;
// //   regime: any;
// //   rsi: number;
// //   timestamp: Date;
// //   smc?: SMCAnalysis;
// //   marketType?: BotType;
// // }

// // // ============================================================================
// // // CONFIGURATION
// // // ============================================================================

// // if (!process.env.ENABLED_SYMBOLS) {
// //   throw new Error('no symbol token was found!');
// // }

// // const SCAN_CONFIG = {
// //   symbols: process.env.ENABLED_SYMBOLS.split(','),
// //   scanInterval: 30_000,
// //   minConfidence: 50,
// //   timeframe: '15m',
// //   displayLimit: 50,
// //   enableContinuousMode: true,
// //   showAllTokens: true,
// //   tradingMode: (process.env.TRADING_MODE || 'BOTH') as
// //     | 'SPOT'
// //     | 'FUTURES'
// //     | 'BOTH',

// //   // âœ… Filter mode
// //   filterMode: (process.env.FILTER_MODE || 'CONSERVATIVE') as
// //     | 'CONSERVATIVE'
// //     | 'AGGRESSIVE',

// //   // âœ… Warmup & Cooldown
// //   warmupPeriodMs: 10 * 60 * 1000, // 10 minutes after startup
// //   symbolCooldownMs: 30 * 60 * 1000, // 30 minutes per symbol after a signal
// //   globalCooldownMs: 5 * 60 * 1000, // 5 minutes global after any trade

// //   smcEnabled: true,
// //   smcMinScore: 40,
// //   outputFiles: {
// //     spot: './signals/spot-signals.json',
// //     futures: './signals/futures-signals.json',
// //     futuresLegacy: './signals/futures-legacy-signals.json',
// //     all: './signals/scanner-output.json',
// //   },
// //   marketType: 'FUTURES' as MarketType,
// //   liquidity: {
// //     enabled: true,
// //     minDepth24h: 5_000_000,
// //   },
// // };

// // // ============================================================================
// // // UTILITY FUNCTIONS
// // // ============================================================================

// // function colorize(text: string, color: string): string {
// //   return `${color}${text}${colors.reset}`;
// // }

// // function log(
// //   msg: string,
// //   type: 'info' | 'success' | 'error' | 'warning' = 'info'
// // ) {
// //   const icons = { info: 'â„¹ï¸', success: 'âœ…', error: 'âŒ', warning: 'âš ï¸' };
// //   const timestamp = new Date().toISOString();
// //   console.log(`[${timestamp}] ${icons[type]} ${msg}`);
// // }

// // // ============================================================================
// // // SMC ANALYSIS FUNCTIONS
// // // ============================================================================

// // function detectOrderBlocks(candles: any, lookback: number = 20): OrderBlock[] {
// //   const orderBlocks: OrderBlock[] = [];
// //   const { highs, lows, closes, opens } = candles;
// //   const len = closes.length;

// //   for (let i = len - lookback; i < len - 3; i++) {
// //     if (i < 2) continue;

// //     const currentRange = highs[i] - lows[i];
// //     const prevRange = highs[i - 1] - lows[i - 1];

// //     // Bullish Order Block
// //     if (
// //       closes[i] < opens[i] &&
// //       closes[i + 1] > opens[i + 1] &&
// //       closes[i + 1] > highs[i] &&
// //       currentRange > prevRange * 0.5
// //     ) {
// //       const strength = ((closes[i + 1] - opens[i + 1]) / currentRange) * 100;
// //       orderBlocks.push({
// //         type: 'BULLISH',
// //         high: highs[i],
// //         low: lows[i],
// //         index: i,
// //         strength: Math.min(100, strength),
// //         mitigated: closes[len - 1] < lows[i],
// //       });
// //     }

// //     // Bearish Order Block
// //     if (
// //       closes[i] > opens[i] &&
// //       closes[i + 1] < opens[i + 1] &&
// //       closes[i + 1] < lows[i] &&
// //       currentRange > prevRange * 0.5
// //     ) {
// //       const strength = ((opens[i + 1] - closes[i + 1]) / currentRange) * 100;
// //       orderBlocks.push({
// //         type: 'BEARISH',
// //         high: highs[i],
// //         low: lows[i],
// //         index: i,
// //         strength: Math.min(100, strength),
// //         mitigated: closes[len - 1] > highs[i],
// //       });
// //     }
// //   }

// //   return orderBlocks.slice(-5);
// // }

// // function detectFairValueGaps(
// //   candles: any,
// //   lookback: number = 30
// // ): FairValueGap[] {
// //   const fvgs: FairValueGap[] = [];
// //   const { highs, lows, closes } = candles;
// //   const len = closes.length;

// //   for (let i = len - lookback; i < len - 2; i++) {
// //     if (i < 1) continue;

// //     // Bullish FVG
// //     const bullishGap = lows[i + 2] - highs[i];
// //     if (bullishGap > 0) {
// //       const filled = closes[len - 1] >= lows[i + 2];
// //       fvgs.push({
// //         type: 'BULLISH',
// //         top: lows[i + 2],
// //         bottom: highs[i],
// //         index: i,
// //         filled,
// //       });
// //     }

// //     // Bearish FVG
// //     const bearishGap = lows[i] - highs[i + 2];
// //     if (bearishGap > 0) {
// //       const filled = closes[len - 1] <= highs[i + 2];
// //       fvgs.push({
// //         type: 'BEARISH',
// //         top: lows[i],
// //         bottom: highs[i + 2],
// //         index: i,
// //         filled,
// //       });
// //     }
// //   }

// //   return fvgs.filter((f) => !f.filled).slice(-5);
// // }

// // function detectLiquidityLevels(
// //   candles: any,
// //   lookback: number = 50
// // ): LiquidityLevel[] {
// //   const levels: LiquidityLevel[] = [];
// //   const { highs, lows, closes } = candles;
// //   const len = closes.length;

// //   for (let i = len - lookback; i < len - 5; i++) {
// //     if (i < 5) continue;

// //     // Swing High
// //     if (
// //       highs[i] > highs[i - 1] &&
// //       highs[i] > highs[i - 2] &&
// //       highs[i] > highs[i + 1] &&
// //       highs[i] > highs[i + 2]
// //     ) {
// //       const swept = highs[len - 1] >= highs[i] || highs[len - 2] >= highs[i];
// //       const strength =
// //         ((highs[i] - Math.min(lows[i - 2], lows[i - 1], lows[i])) / highs[i]) *
// //         100;
// //       levels.push({
// //         type: 'HIGH',
// //         price: highs[i],
// //         strength: Math.min(100, strength * 10),
// //         swept,
// //       });
// //     }

// //     // Swing Low
// //     if (
// //       lows[i] < lows[i - 1] &&
// //       lows[i] < lows[i - 2] &&
// //       lows[i] < lows[i + 1] &&
// //       lows[i] < lows[i + 2]
// //     ) {
// //       const swept = lows[len - 1] <= lows[i] || lows[len - 2] <= lows[i];
// //       const strength =
// //         ((Math.max(highs[i - 2], highs[i - 1], highs[i]) - lows[i]) / lows[i]) *
// //         100;
// //       levels.push({
// //         type: 'LOW',
// //         price: lows[i],
// //         strength: Math.min(100, strength * 10),
// //         swept,
// //       });
// //     }
// //   }

// //   return levels.slice(-10);
// // }

// // function detectBOS(candles: any, lookback: number = 20) {
// //   const { highs, lows, closes } = candles;
// //   const len = closes.length;

// //   let swingHigh = -Infinity;
// //   let swingLow = Infinity;
// //   let swingHighIdx = -1;
// //   let swingLowIdx = -1;

// //   for (let i = len - lookback; i < len - 3; i++) {
// //     if (highs[i] > swingHigh) {
// //       swingHigh = highs[i];
// //       swingHighIdx = i;
// //     }
// //     if (lows[i] < swingLow) {
// //       swingLow = lows[i];
// //       swingLowIdx = i;
// //     }
// //   }

// //   if (closes[len - 1] > swingHigh && swingHighIdx > swingLowIdx) {
// //     return { detected: true, type: 'BULLISH' as const, index: swingHighIdx };
// //   }

// //   if (closes[len - 1] < swingLow && swingLowIdx > swingHighIdx) {
// //     return { detected: true, type: 'BEARISH' as const, index: swingLowIdx };
// //   }

// //   return { detected: false };
// // }

// // function detectCHoCH(candles: any, lookback: number = 30) {
// //   const { highs, lows, closes } = candles;
// //   const len = closes.length;

// //   const ema20 =
// //     closes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
// //   const ema50 =
// //     closes.slice(-50).reduce((a: number, b: number) => a + b, 0) / 50;
// //   const isUptrend = ema20 > ema50;

// //   let recentHigh = -Infinity;
// //   let recentLow = Infinity;
// //   let recentHighIdx = -1;
// //   let recentLowIdx = -1;

// //   for (let i = len - lookback; i < len - 3; i++) {
// //     if (highs[i] > recentHigh) {
// //       recentHigh = highs[i];
// //       recentHighIdx = i;
// //     }
// //     if (lows[i] < recentLow) {
// //       recentLow = lows[i];
// //       recentLowIdx = i;
// //     }
// //   }

// //   if (!isUptrend && closes[len - 1] > recentHigh) {
// //     return { detected: true, type: 'BULLISH' as const, index: recentHighIdx };
// //   }

// //   if (isUptrend && closes[len - 1] < recentLow) {
// //     return { detected: true, type: 'BEARISH' as const, index: recentLowIdx };
// //   }

// //   return { detected: false };
// // }

// // function calculatePremiumDiscount(
// //   currentPrice: number,
// //   highs: number[],
// //   lows: number[],
// //   lookback: number = 50
// // ): 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' {
// //   const recentHighs = highs.slice(-lookback);
// //   const recentLows = lows.slice(-lookback);

// //   const highest = Math.max(...recentHighs);
// //   const lowest = Math.min(...recentLows);
// //   const range = highest - lowest;
// //   const upperThreshold = lowest + range * 0.618;
// //   const lowerThreshold = lowest + range * 0.382;

// //   if (currentPrice >= upperThreshold) return 'PREMIUM';
// //   if (currentPrice <= lowerThreshold) return 'DISCOUNT';
// //   return 'EQUILIBRIUM';
// // }

// // function calculateSMCScore(smc: Omit<SMCAnalysis, 'smcScore'>): number {
// //   let score = 0;

// //   const activeOBs = smc.orderBlocks.filter((ob) => !ob.mitigated);
// //   score += Math.min(30, activeOBs.length * 10);

// //   const activeFVGs = smc.fvgs.filter((fvg) => !fvg.filled);
// //   score += Math.min(20, activeFVGs.length * 7);

// //   const recentSweeps = smc.liquidityLevels.filter((l) => l.swept);
// //   score += Math.min(20, recentSweeps.length * 10);

// //   if (smc.bos.detected) score += 15;
// //   if (smc.choch.detected) score += 15;

// //   return Math.min(100, score);
// // }

// // function analyzeSMC(candles: any): SMCAnalysis {
// //   const orderBlocks = detectOrderBlocks(candles);
// //   const fvgs = detectFairValueGaps(candles);
// //   const liquidityLevels = detectLiquidityLevels(candles);
// //   const bos = detectBOS(candles);
// //   const choch = detectCHoCH(candles);
// //   const currentPrice = candles.closes[candles.closes.length - 1];
// //   const premiumDiscount = calculatePremiumDiscount(
// //     currentPrice,
// //     candles.highs,
// //     candles.lows
// //   );

// //   const smcData = {
// //     orderBlocks,
// //     fvgs,
// //     liquidityLevels,
// //     bos,
// //     choch,
// //     premiumDiscount,
// //   };

// //   const smcScore = calculateSMCScore(smcData);

// //   return { ...smcData, smcScore };
// // }

// // // ============================================================================
// // // SIGNAL DETECTION
// // // ============================================================================

// // function detectSignal(
// //   symbol: string,
// //   indicators: Indicators,
// //   smc?: SMCAnalysis
// // ): EntrySignal[] {
// //   const longSignals: EntrySignal[] = [];
// //   const shortSignals: EntrySignal[] = [];
// //   const { currentPrice, rsi } = indicators;

// //   // âœ… Helper function: Apply RSI boost to confidence
// //   const applyRSIBoost = (
// //     baseConfidence: number,
// //     side: 'LONG' | 'SHORT'
// //   ): number => {
// //     let confidence = baseConfidence;

// //     if (side === 'LONG') {
// //       // Boost LONG signals when RSI is oversold
// //       if (rsi < 30) {
// //         confidence += 8; // Strong oversold
// //       } else if (rsi < 40) {
// //         confidence += 5; // Moderate oversold
// //       } else if (rsi > 70) {
// //         confidence -= 5; // Penalize if overbought
// //       }
// //     } else {
// //       // Boost SHORT signals when RSI is overbought
// //       if (rsi > 70) {
// //         confidence += 8; // Strong overbought
// //       } else if (rsi > 60) {
// //         confidence += 5; // Moderate overbought
// //       } else if (rsi < 30) {
// //         confidence -= 5; // Penalize if oversold
// //       }
// //     }

// //     return Math.min(95, Math.max(0, confidence));
// //   };

// //   if (smc && SCAN_CONFIG.smcEnabled) {
// //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// //     // SMC LONG SIGNALS
// //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// //     const bullishOB = smc.orderBlocks.find(
// //       (ob) => ob.type === 'BULLISH' && !ob.mitigated
// //     );

// //     // Priority 1: Strong Setup (OB + Discount + BOS/CHoCH)
// //     if (
// //       bullishOB &&
// //       smc.premiumDiscount === 'DISCOUNT' &&
// //       (smc.bos.type === 'BULLISH' || smc.choch.type === 'BULLISH')
// //     ) {
// //       let confidence = Math.min(90, 75 + smc.smcScore * 0.2);
// //       confidence = applyRSIBoost(confidence, 'LONG');

// //       longSignals.push({
// //         symbol,
// //         strategy: 'SMC_LONG',
// //         side: 'LONG',
// //         reason: `SMC: Bullish OB in discount + ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: bullishOB.low * 0.995,
// //         takeProfit: currentPrice * 1.08,
// //         timestamp: new Date(),
// //       });
// //     }
// //     // Priority 2: Moderate Setup (OB + Discount)
// //     else if (
// //       bullishOB &&
// //       smc.premiumDiscount === 'DISCOUNT' &&
// //       smc.smcScore >= 40
// //     ) {
// //       let confidence = Math.min(85, 65 + smc.smcScore * 0.2);
// //       confidence = applyRSIBoost(confidence, 'LONG');

// //       longSignals.push({
// //         symbol,
// //         strategy: 'SMC_LONG',
// //         side: 'LONG',
// //         reason: `SMC: Bullish OB in discount zone. Score: ${smc.smcScore.toFixed(0)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: bullishOB.low * 0.995,
// //         takeProfit: currentPrice * 1.06,
// //         timestamp: new Date(),
// //       });
// //     }
// //     // Priority 3: BOS/CHoCH alone
// //     else if (
// //       (smc.bos.type === 'BULLISH' || smc.choch.type === 'BULLISH') &&
// //       smc.smcScore >= 50
// //     ) {
// //       let confidence = Math.min(80, 60 + smc.smcScore * 0.3);
// //       confidence = applyRSIBoost(confidence, 'LONG');

// //       longSignals.push({
// //         symbol,
// //         strategy: 'SMC_LONG',
// //         side: 'LONG',
// //         reason: `SMC: Bullish ${smc.bos.detected ? 'BOS' : 'CHoCH'} detected. Score: ${smc.smcScore.toFixed(0)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: currentPrice * 0.97,
// //         takeProfit: currentPrice * 1.06,
// //         timestamp: new Date(),
// //       });
// //     }

// //     // FVG LONG
// //     const bullishFVG = smc.fvgs.find(
// //       (fvg) => fvg.type === 'BULLISH' && !fvg.filled
// //     );
// //     if (
// //       bullishFVG &&
// //       currentPrice >= bullishFVG.bottom &&
// //       currentPrice <= bullishFVG.top
// //     ) {
// //       let confidence = 72;
// //       confidence = applyRSIBoost(confidence, 'LONG');

// //       longSignals.push({
// //         symbol,
// //         strategy: 'FVG_FILL',
// //         side: 'LONG',
// //         reason: `Price in bullish FVG zone. Expected bounce from ${bullishFVG.bottom.toFixed(2)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: bullishFVG.bottom * 0.995,
// //         takeProfit: currentPrice * 1.05,
// //         timestamp: new Date(),
// //       });
// //     }

// //     // LIQUIDITY SWEEP LONG
// //     const sweptLow = smc.liquidityLevels.find(
// //       (l) => l.type === 'LOW' && l.swept && l.strength > 60
// //     );
// //     if (sweptLow && currentPrice > sweptLow.price * 1.001) {
// //       let confidence = 75;
// //       confidence = applyRSIBoost(confidence, 'LONG');

// //       longSignals.push({
// //         symbol,
// //         strategy: 'LIQUIDITY_SWEEP',
// //         side: 'LONG',
// //         reason: `Liquidity swept below ${sweptLow.price.toFixed(2)}. Reversal expected | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: sweptLow.price * 0.995,
// //         takeProfit: currentPrice * 1.06,
// //         timestamp: new Date(),
// //       });
// //     }

// //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// //     // SMC SHORT SIGNALS
// //     // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// //     const bearishOB = smc.orderBlocks.find(
// //       (ob) => ob.type === 'BEARISH' && !ob.mitigated
// //     );

// //     // Priority 1: Strong Setup (OB + Premium + BOS/CHoCH)
// //     if (
// //       bearishOB &&
// //       smc.premiumDiscount === 'PREMIUM' &&
// //       (smc.bos.type === 'BEARISH' || smc.choch.type === 'BEARISH')
// //     ) {
// //       let confidence = Math.min(90, 75 + smc.smcScore * 0.2);
// //       confidence = applyRSIBoost(confidence, 'SHORT');

// //       shortSignals.push({
// //         symbol,
// //         strategy: 'SMC_SHORT',
// //         side: 'SHORT',
// //         reason: `SMC: Bearish OB in premium + ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: bearishOB.high * 1.005,
// //         takeProfit: currentPrice * 0.92,
// //         timestamp: new Date(),
// //       });
// //     }
// //     // Priority 2: Moderate Setup (OB + Premium)
// //     else if (
// //       bearishOB &&
// //       smc.premiumDiscount === 'PREMIUM' &&
// //       smc.smcScore >= 40
// //     ) {
// //       let confidence = Math.min(85, 65 + smc.smcScore * 0.2);
// //       confidence = applyRSIBoost(confidence, 'SHORT');

// //       shortSignals.push({
// //         symbol,
// //         strategy: 'SMC_SHORT',
// //         side: 'SHORT',
// //         reason: `SMC: Bearish OB in premium zone. Score: ${smc.smcScore.toFixed(0)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: bearishOB.high * 1.005,
// //         takeProfit: currentPrice * 0.94,
// //         timestamp: new Date(),
// //       });
// //     }
// //     // Priority 3: BOS/CHoCH alone
// //     else if (
// //       (smc.bos.type === 'BEARISH' || smc.choch.type === 'BEARISH') &&
// //       smc.smcScore >= 50
// //     ) {
// //       let confidence = Math.min(80, 60 + smc.smcScore * 0.3);
// //       confidence = applyRSIBoost(confidence, 'SHORT');

// //       shortSignals.push({
// //         symbol,
// //         strategy: 'SMC_SHORT',
// //         side: 'SHORT',
// //         reason: `SMC: Bearish ${smc.bos.detected ? 'BOS' : 'CHoCH'} detected. Score: ${smc.smcScore.toFixed(0)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: currentPrice * 1.03,
// //         takeProfit: currentPrice * 0.94,
// //         timestamp: new Date(),
// //       });
// //     }

// //     // FVG SHORT
// //     const bearishFVG = smc.fvgs.find(
// //       (fvg) => fvg.type === 'BEARISH' && !fvg.filled
// //     );
// //     if (
// //       bearishFVG &&
// //       currentPrice >= bearishFVG.bottom &&
// //       currentPrice <= bearishFVG.top
// //     ) {
// //       let confidence = 72;
// //       confidence = applyRSIBoost(confidence, 'SHORT');

// //       shortSignals.push({
// //         symbol,
// //         strategy: 'FVG_FILL',
// //         side: 'SHORT',
// //         reason: `Price in bearish FVG zone. Expected drop from ${bearishFVG.top.toFixed(2)} | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: bearishFVG.top * 1.005,
// //         takeProfit: currentPrice * 0.95,
// //         timestamp: new Date(),
// //       });
// //     }

// //     // LIQUIDITY SWEEP SHORT
// //     const sweptHigh = smc.liquidityLevels.find(
// //       (l) => l.type === 'HIGH' && l.swept && l.strength > 60
// //     );
// //     if (sweptHigh && currentPrice < sweptHigh.price * 0.999) {
// //       let confidence = 75;
// //       confidence = applyRSIBoost(confidence, 'SHORT');

// //       shortSignals.push({
// //         symbol,
// //         strategy: 'LIQUIDITY_SWEEP',
// //         side: 'SHORT',
// //         reason: `Liquidity swept above ${sweptHigh.price.toFixed(2)}. Reversal expected | RSI: ${rsi.toFixed(1)}`,
// //         confidence,
// //         stopLoss: sweptHigh.price * 1.005,
// //         takeProfit: currentPrice * 0.94,
// //         timestamp: new Date(),
// //       });
// //     }
// //   }

// //   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// //   // CONFLICT RESOLUTION (Simplified)
// //   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// //   const signals: EntrySignal[] = [];

// //   if (longSignals.length > 0 && shortSignals.length > 0) {
// //     // Find best signals on each side
// //     const bestLong = longSignals.reduce((a, b) =>
// //       a.confidence > b.confidence ? a : b
// //     );
// //     const bestShort = shortSignals.reduce((a, b) =>
// //       a.confidence > b.confidence ? a : b
// //     );

// //     // Only take a trade if there's a clear winner (15% difference)
// //     if (bestLong.confidence > bestShort.confidence + 15) {
// //       signals.push(bestLong);
// //     } else if (bestShort.confidence > bestLong.confidence + 15) {
// //       signals.push(bestShort);
// //     }
// //     // Otherwise skip - too ambiguous
// //   } else if (longSignals.length > 0) {
// //     signals.push(...longSignals);
// //   } else if (shortSignals.length > 0) {
// //     signals.push(...shortSignals);
// //   }

// //   return signals.filter((s) => s !== null && s !== undefined);
// // }

// // // ============================================================================
// // // SCANNER CLASS
// // // ============================================================================

// // const SIGNALS_DIR = './signals';

// // class TradingScanner {
// //   private candleManager: CandleManager;
// //   private htfManager: HTFCandleManager;
// //   private scanResults: Map<string, ExtendedScanResult> = new Map();
// //   private scanCount = 0;
// //   private successfulInitializations = 0;
// //   private marketType: MarketType;
// //   private signalsDir = './signals';
// //   private outputFile = './signals/scanner-output.json';

// //   // âœ… Cooldown tracking
// //   private startTime: number;
// //   private symbolCooldowns: Map<string, number> = new Map();
// //   private lastGlobalSignalTime: number = 0;

// //   constructor(marketType: MarketType = SCAN_CONFIG.marketType) {
// //     this.marketType = marketType;
// //     this.candleManager = new CandleManager(SCAN_CONFIG.timeframe);
// //     this.htfManager = new HTFCandleManager();
// //     this.ensureSignalsDir();
// //     this.outputFile =
// //       marketType === 'SPOT'
// //         ? SCAN_CONFIG.outputFiles.spot
// //         : SCAN_CONFIG.outputFiles.futures;
// //     this.startTime = Date.now();
// //   }

// //   private ensureSignalsDir(): void {
// //     if (!fs.existsSync(this.signalsDir)) {
// //       fs.mkdirSync(this.signalsDir, { recursive: true });
// //       console.log(`âœ… Created signals directory: ${this.signalsDir}`);
// //     }
// //   }

// //   async initialize(): Promise<void> {
// //     log('ðŸš€ Initializing Trading Scanner...', 'info');
// //     log(
// //       `   Market Type: ${colorize(this.marketType, colors.brightCyan)}`,
// //       'info'
// //     );
// //     log(`   Symbols: ${symbols.length}`, 'info');
// //     log(`   Output File: ${this.outputFile}`, 'info');
// //     log('â•'.repeat(60), 'info');

// //     if (!fs.existsSync(SIGNALS_DIR)) {
// //       fs.mkdirSync(SIGNALS_DIR, { recursive: true });
// //       log(`ðŸ“ Created directory: ${SIGNALS_DIR}`, 'info');
// //     }

// //     let passed = 0;
// //     let failed = 0;

// //     for (let i = 0; i < symbols.length; i++) {
// //       const symbol = symbols[i];
// //       if (!symbol) continue;

// //       const normalizedSymbol = normalize(symbol, this.marketType);

// //       if (normalizedSymbol === 'NEXOUSDT' || normalizedSymbol === 'NEXO/USDT') {
// //         continue;
// //       }

// //       const success = await this.candleManager.initializeHistoricalCandles(
// //         normalizedSymbol,
// //         500,
// //         0,
// //         this.marketType
// //       );

// //       if (success) {
// //         passed++;
// //         this.successfulInitializations++;
// //       } else {
// //         failed++;
// //         log(`âŒ ${symbol} failed`, 'error');
// //       }

// //       if ((i + 1) % 10 === 0 || i === symbols.length - 1) {
// //         log(
// //           `ðŸ“Š Progress: ${i + 1}/${symbols.length} | Passed: ${passed} | Failed: ${failed}`,
// //           'info'
// //         );
// //       }

// //       if (i < symbols.length - 1) {
// //         await new Promise((resolve) => setTimeout(resolve, 500));
// //       }
// //     }

// //     log('â•'.repeat(60), 'info');
// //     log(
// //       `âœ… Initialization complete: ${passed} passed, ${failed} failed`,
// //       passed > 0 ? 'success' : 'error'
// //     );

// //     if (this.successfulInitializations === 0) {
// //       log('âŒ No symbols initialized! Scanner cannot run.', 'error');
// //       process.exit(1);
// //     }
// //   }

// //   async scanSymbol(symbol: string): Promise<ExtendedScanResult | null> {
// //     try {
// //       const normalizedSpot = normalize(symbol, 'SPOT');
// //       const normalizedFutures = normalize(symbol, 'FUTURES');

// //       const candlesSpot = this.candleManager.getCandles(
// //         normalizedSpot,
// //         'SPOT'
// //       ) as CandleData;
// //       const candlesFutures = this.candleManager.getCandles(
// //         normalizedFutures,
// //         'FUTURES'
// //       ) as CandleData;

// //       let candles: CandleData;
// //       let marketType: BotType;

// //       const spotValid = candlesSpot && candlesSpot.closes.length >= 210;
// //       const futuresValid =
// //         candlesFutures && candlesFutures.closes.length >= 210;

// //       if (futuresValid) {
// //         candles = candlesFutures;
// //         marketType = 'FUTURES';
// //       } else if (spotValid) {
// //         candles = candlesSpot;
// //         marketType = 'SPOT';
// //       } else {
// //         return null;
// //       }

// //       console.log(
// //         `   âœ… ${symbol} (${marketType}): ${candles.closes.length} candles loaded`
// //       );

// //       const indicators = calculateIndicators(candles);
// //       if (!indicators) {
// //         console.log(`   âŒ ${symbol}: Failed to calculate indicators`);
// //         return null;
// //       }

// //       const regime = detectRegime(indicators);
// //       const smc = SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;
// //       const allSignals = detectSignal(symbol, indicators, smc);

// //       const validSignals = allSignals.filter((signal) => {
// //         if (SCAN_CONFIG.tradingMode === 'SPOT' && signal?.side !== 'LONG') {
// //           return false;
// //         }

// //         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
// //           if (smc.smcScore < SCAN_CONFIG.smcMinScore) {
// //             return false;
// //           }
// //         }

// //         return true;
// //       });

// //       if (validSignals.length === 0) {
// //         return null;
// //       }

// //       const scoredSignals = validSignals.map((signal) => {
// //         let finalConfidence = signal?.confidence;

// //         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
// //           const smcContribution = (smc.smcScore / 100) * 30;
// //           finalConfidence = Math.min(95, signal.confidence + smcContribution);
// //         }

// //         return {
// //           signal,
// //           finalConfidence,
// //           smcScore: smc?.smcScore || 0,
// //         };
// //       });

// //       const bestScoredSignal = scoredSignals.reduce((best, current) => {
// //         const curFinalCon = current.finalConfidence as number;
// //         const bestFinalCon = best.finalConfidence as number;
// //         return curFinalCon > bestFinalCon ? current : best;
// //       });

// //       console.log(
// //         `   âœ… ${symbol}: Best signal: ${bestScoredSignal.signal?.strategy} (${bestScoredSignal.finalConfidence?.toFixed(0)}%)`
// //       );

// //       const result: ExtendedScanResult = {
// //         symbol,
// //         signal: bestScoredSignal.signal,
// //         confidence: bestScoredSignal.finalConfidence as number,
// //         price: indicators.currentPrice,
// //         indicators,
// //         regime,
// //         rsi: indicators.rsi,
// //         timestamp: new Date(),
// //         marketType: marketType as BotType,
// //       };

// //       if (smc) {
// //         result.smc = smc;
// //       }

// //       return result;
// //     } catch (err: any) {
// //       console.error(`âŒ Error scanning ${symbol}:`, err.message);
// //       return null;
// //     }
// //   }

// //   async scanAll(): Promise<ExtendedScanResult[]> {
// //     this.scanCount++;

// //     console.log('\n' + 'â•'.repeat(80));
// //     console.log(`ðŸ”„ SCAN #${this.scanCount} - Starting...`);
// //     console.log('â•'.repeat(80));

// //     await this.updateAllCandles();

// //     const allResults: ExtendedScanResult[] = [];
// //     let symbolsScanned = 0;
// //     let symbolsWithSignals = 0;

// //     for (const symbol of symbols) {
// //       symbolsScanned++;
// //       const symbolResults = await this.scanSymbol(symbol);

// //       if (symbolResults) {
// //         symbolsWithSignals++;
// //         allResults.push(symbolResults);
// //         this.scanResults.set(symbol, symbolResults);
// //       }
// //     }

// //     console.log('â•'.repeat(80));
// //     console.log(`ðŸ“Š SCAN COMPLETE:`);
// //     console.log(`   Symbols Scanned: ${symbolsScanned}`);
// //     console.log(`   Symbols with Signals: ${symbolsWithSignals}`);
// //     console.log(`   Total Signals: ${allResults.length}`);
// //     console.log('â•'.repeat(80));

// //     // âœ… APPLY QUALITY FILTER
// //     const filteredResults = this.applyQualityFilter(allResults);

// //     // âœ… PRIORITIZE SMC SIGNALS
// //     const prioritizedResults = this.prioritizeSignals(filteredResults);

// //     prioritizedResults.sort((a, b) => b.confidence - a.confidence);
// //     this.exportSignalsForBothModes(prioritizedResults);

// //     return prioritizedResults;
// //   }

// //   /**
// //    * âœ… Apply quality filters to reject weak signals
// //    */
// //   private applyQualityFilter(
// //     results: ExtendedScanResult[]
// //   ): ExtendedScanResult[] {
// //     const mode = SCAN_CONFIG.filterMode || 'CONSERVATIVE';
// //     const config =
// //       mode === 'CONSERVATIVE'
// //         ? this.getConservativeConfig()
// //         : this.getAggressiveConfig();

// //     console.log(`\nðŸŽ¯ Applying ${mode} filter...`);

// //     // Check warmup period
// //     const elapsed = Date.now() - this.startTime;
// //     if (elapsed < SCAN_CONFIG.warmupPeriodMs) {
// //       const remaining = Math.ceil(
// //         (SCAN_CONFIG.warmupPeriodMs - elapsed) / 1000
// //       );
// //       console.log(`   â³ WARMUP: ${remaining}s remaining - no signals allowed`);
// //       return [];
// //     }

// //     const filtered: ExtendedScanResult[] = [];
// //     const rejected: Array<{ symbol: string; reason: string }> = [];

// //     for (const result of results) {
// //       // 1. Check symbol-specific cooldown
// //       const symbolCooldown = this.symbolCooldowns.get(result.symbol);
// //       if (symbolCooldown && Date.now() < symbolCooldown) {
// //         const remaining = Math.ceil((symbolCooldown - Date.now()) / 1000 / 60);
// //         rejected.push({
// //           symbol: result.symbol,
// //           reason: `Symbol cooldown: ${remaining}m remaining`,
// //         });
// //         continue;
// //       }

// //       // 2. Check global cooldown
// //       if (this.lastGlobalSignalTime > 0) {
// //         const timeSinceLastSignal = Date.now() - this.lastGlobalSignalTime;
// //         if (timeSinceLastSignal < SCAN_CONFIG.globalCooldownMs) {
// //           const remaining = Math.ceil(
// //             (SCAN_CONFIG.globalCooldownMs - timeSinceLastSignal) / 1000 / 60
// //           );
// //           rejected.push({
// //             symbol: result.symbol,
// //             reason: `Global cooldown: ${remaining}m remaining`,
// //           });
// //           continue;
// //         }
// //       }

// //       // 3. Check quality criteria
// //       const rejection = this.filterSignal(result, config);

// //       if (rejection) {
// //         rejected.push({ symbol: result.symbol, reason: rejection });
// //       } else {
// //         filtered.push(result);

// //         // âœ… Set cooldowns for accepted signals
// //         this.symbolCooldowns.set(
// //           result.symbol,
// //           Date.now() + SCAN_CONFIG.symbolCooldownMs
// //         );
// //         this.lastGlobalSignalTime = Date.now();
// //       }
// //     }

// //     console.log(`   âœ… Passed: ${filtered.length}/${results.length}`);
// //     console.log(`   âŒ Rejected: ${rejected.length}/${results.length}`);

// //     // Show rejection breakdown
// //     if (rejected.length > 0) {
// //       const reasonCounts: Record<string, number> = {};
// //       rejected.forEach(({ reason }) => {
// //         const key = reason.split(':')[0] as string; // Group similar reasons
// //         reasonCounts[key] = (reasonCounts[key] || 0) + 1;
// //       });

// //       console.log(`\nðŸ“‹ Rejection Breakdown:`);
// //       Object.entries(reasonCounts)
// //         .sort(([, a], [, b]) => b - a)
// //         .slice(0, 5)
// //         .forEach(([reason, count]) => {
// //           console.log(`   ${count}x: ${reason}`);
// //         });
// //     }

// //     // Show active cooldowns
// //     const activeCooldowns = Array.from(this.symbolCooldowns.entries()).filter(
// //       ([, time]) => time > Date.now()
// //     ).length;

// //     if (activeCooldowns > 0) {
// //       console.log(`\nâ„ï¸  Active Cooldowns: ${activeCooldowns} symbols`);
// //     }

// //     return filtered;
// //   }

// //   /**
// //    * âœ… Reset cooldown for a specific symbol (call this when trade completes)
// //    */
// //   resetSymbolCooldown(symbol: string): void {
// //     this.symbolCooldowns.delete(symbol);
// //     console.log(`âœ… Cooldown reset for ${symbol}`);
// //   }

// //   /**
// //    * âœ… Get cooldown status for monitoring
// //    */
// //   getCooldownStatus(): {
// //     warmupRemaining: number;
// //     globalCooldownRemaining: number;
// //     symbolsOnCooldown: string[];
// //   } {
// //     const warmupRemaining = Math.max(
// //       0,
// //       SCAN_CONFIG.warmupPeriodMs - (Date.now() - this.startTime)
// //     );

// //     const globalCooldownRemaining =
// //       this.lastGlobalSignalTime > 0
// //         ? Math.max(
// //             0,
// //             SCAN_CONFIG.globalCooldownMs -
// //               (Date.now() - this.lastGlobalSignalTime)
// //           )
// //         : 0;

// //     const symbolsOnCooldown = Array.from(this.symbolCooldowns.entries())
// //       .filter(([, time]) => time > Date.now())
// //       .map(([symbol]) => symbol);

// //     return {
// //       warmupRemaining,
// //       globalCooldownRemaining,
// //       symbolsOnCooldown,
// //     };
// //   }

// //   /**
// //    * âœ… Prioritize SMC signals over RSI-only signals
// //    */
// //   private prioritizeSignals(
// //     results: ExtendedScanResult[]
// //   ): ExtendedScanResult[] {
// //     const smcSignals = results.filter(
// //       (r) => r.signal && smcStrategies.includes(r.signal.strategy)
// //     );

// //     const otherSignals = results.filter(
// //       (r) => r.signal && !smcStrategies.includes(r.signal.strategy)
// //     );

// //     console.log(`\nðŸŽ¯ Signal Priority:`);
// //     console.log(`   ðŸ’Ž SMC Signals: ${smcSignals.length}`);
// //     console.log(`   ðŸ“Š Other Signals: ${otherSignals.length}`);

// //     // Return SMC signals first, then others
// //     return [...smcSignals, ...otherSignals];
// //   }

// //   /**
// //    * âœ… Filter individual signal based on quality criteria
// //    */
// //   private filterSignal(result: ExtendedScanResult, config: any): string | null {
// //     const { signal, confidence, smc, rsi } = result;

// //     if (!signal) return 'No signal';

// //     // 1. Confidence check
// //     if (confidence < config.minConfidence) {
// //       return `Confidence ${confidence.toFixed(0)}% < ${config.minConfidence}%`;
// //     }

// //     // 2. SMC score check (only for SMC strategies)
// //     if (smc && smcStrategies.includes(signal.strategy)) {
// //       if (smc.smcScore < config.minSMCScore) {
// //         return `SMC score ${smc.smcScore.toFixed(0)} < ${config.minSMCScore}`;
// //       }
// //     }

// //     // 3. Multiple SMC factors (for CONSERVATIVE mode)
// //     if (
// //       config.requireMultipleSMCFactors &&
// //       smc &&
// //       smcStrategies.includes(signal.strategy)
// //     ) {
// //       const factorCount = this.countSMCFactors(smc, signal);
// //       if (factorCount < 2) {
// //         return `Only ${factorCount} SMC factor, need 2+`;
// //       }
// //     }

// //     // 4. Premium/Discount zone requirement
// //     if (config.requirePremiumDiscount && smc) {
// //       if (signal.side === 'LONG' && smc.premiumDiscount !== 'DISCOUNT') {
// //         return `LONG not in DISCOUNT (${smc.premiumDiscount})`;
// //       }
// //       if (signal.side === 'SHORT' && smc.premiumDiscount !== 'PREMIUM') {
// //         return `SHORT not in PREMIUM (${smc.premiumDiscount})`;
// //       }
// //     }

// //     // 5. RSI support check
// //     if (config.rsiMustSupport) {
// //       if (signal.side === 'LONG' && rsi > config.rsiOversoldMax) {
// //         return `LONG but RSI ${rsi.toFixed(1)} not oversold`;
// //       }
// //       if (signal.side === 'SHORT' && rsi < config.rsiOverboughtMin) {
// //         return `SHORT but RSI ${rsi.toFixed(1)} not overbought`;
// //       }
// //     }

// //     return null;
// //   }

// //   /**
// //    * Count SMC factors present in the signal
// //    */
// //   private countSMCFactors(smc: SMCAnalysis, signal: any): number {
// //     let count = 0;

// //     const side = signal.side === 'LONG' ? 'BULLISH' : 'BEARISH';

// //     // Order Block
// //     if (smc.orderBlocks.some((ob) => ob.type === side && !ob.mitigated))
// //       count++;

// //     // FVG
// //     if (smc.fvgs.some((fvg) => fvg.type === side && !fvg.filled)) count++;

// //     // BOS
// //     if (smc.bos.detected && smc.bos.type === side) count++;

// //     // CHoCH
// //     if (smc.choch.detected && smc.choch.type === side) count++;

// //     // Liquidity
// //     const liqType = signal.side === 'LONG' ? 'LOW' : 'HIGH';
// //     if (
// //       smc.liquidityLevels.some(
// //         (l) => l.type === liqType && l.swept && l.strength > 60
// //       )
// //     )
// //       count++;

// //     return count;
// //   }

// //   private getConservativeConfig() {
// //     return {
// //       minConfidence: 70,
// //       minSMCScore: 65,
// //       requireMultipleSMCFactors: true,
// //       requirePremiumDiscount: true,
// //       rsiMustSupport: true,
// //       rsiOversoldMax: 40,
// //       rsiOverboughtMin: 60,
// //     };
// //   }

// //   private getAggressiveConfig() {
// //     return {
// //       minConfidence: 60,
// //       minSMCScore: 50,
// //       requireMultipleSMCFactors: false,
// //       requirePremiumDiscount: false,
// //       rsiMustSupport: false,
// //       rsiOversoldMax: 50,
// //       rsiOverboughtMin: 50,
// //     };
// //   }

// //   private exportSignalsForBothModes(results: ExtendedScanResult[]): void {
// //     const longSignals = results.filter((r) => r.signal?.side === 'LONG');
// //     const shortSignals = results.filter((r) => r.signal?.side === 'SHORT');
// //     const allSignals = results;

// //     const spotOutput = longSignals
// //       .filter((r) => r.confidence >= 60)
// //       .map((r) => this.formatSignalOutput(r));
// //     const futuresOutput = allSignals
// //       .filter((r) => r.confidence >= 60)
// //       .map((r) => this.formatSignalOutput(r));
// //     const futuresLegacyOutput = allSignals
// //       .filter((r) => r.confidence >= 60)
// //       .map((r) => this.formatSignalOutput(r));
// //     const allOutput = allSignals.map((r) => this.formatSignalOutput(r));

// //     fs.writeFileSync(
// //       SCAN_CONFIG.outputFiles.spot,
// //       JSON.stringify(spotOutput, null, 2)
// //     );
// //     fs.writeFileSync(
// //       SCAN_CONFIG.outputFiles.futures,
// //       JSON.stringify(futuresOutput, null, 2)
// //     );
// //     fs.writeFileSync(
// //       SCAN_CONFIG.outputFiles.futuresLegacy,
// //       JSON.stringify(futuresLegacyOutput, null, 2)
// //     );
// //     fs.writeFileSync(
// //       SCAN_CONFIG.outputFiles.all,
// //       JSON.stringify(allOutput, null, 2)
// //     );
// //   }

// //   private formatSignalOutput(result: ExtendedScanResult): any {
// //     return {
// //       symbol: result.symbol,
// //       price: result.price,
// //       confidence: result.confidence,
// //       signal: result.signal,
// //       regime: result.regime,
// //       rsi: result.rsi,
// //       timestamp: result.timestamp,
// //       smc: result.smc
// //         ? {
// //             score: result.smc.smcScore,
// //             zone: result.smc.premiumDiscount,
// //             bos: result.smc.bos.detected ? result.smc.bos.type : null,
// //             choch: result.smc.choch.detected ? result.smc.choch.type : null,
// //             orderBlocks: result.smc.orderBlocks.length,
// //             activeOrderBlocks: result.smc.orderBlocks.filter(
// //               (ob) => !ob.mitigated
// //             ).length,
// //             fvgs: result.smc.fvgs.length,
// //             activeFvgs: result.smc.fvgs.filter((fvg) => !fvg.filled).length,
// //             liquidityLevels: result.smc.liquidityLevels.length,
// //             sweptLiquidity: result.smc.liquidityLevels.filter((l) => l.swept)
// //               .length,
// //           }
// //         : undefined,
// //     };
// //   }

// //   private async updateAllCandles(): Promise<void> {
// //     const updatePromises = symbols.map(async (symbol, index) => {
// //       const normalizedSymbol = normalize(symbol, this.marketType);

// //       try {
// //         await this.candleManager.updateCandles(
// //           normalizedSymbol,
// //           this.marketType
// //         );
// //         await new Promise((resolve) => setTimeout(resolve, index * 100));
// //       } catch (err: any) {
// //         // Silently continue on error
// //       }
// //     });

// //     await Promise.all(updatePromises);
// //   }

// //   displayResults(results: ExtendedScanResult[]): void {
// //     console.clear();

// //     console.log(
// //       colorize(
// //         'â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—',
// //         colors.cyan
// //       )
// //     );
// //     console.log(
// //       colorize(
// //         'â•‘                                                  ðŸš€ CRYPTO TRADING SCANNER WITH SMC ðŸš€                                                          â•‘',
// //         colors.cyan
// //       )
// //     );
// //     console.log(
// //       colorize(
// //         'â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•',
// //         colors.cyan
// //       )
// //     );
// //     console.log();

// //     const filteredResults = SCAN_CONFIG.showAllTokens
// //       ? results
// //       : results.filter((r) => r.confidence >= SCAN_CONFIG.minConfidence);

// //     const displayResults = filteredResults
// //       .sort((a, b) => b.confidence - a.confidence)
// //       .slice(0, SCAN_CONFIG.displayLimit);

// //     const table = new Table({
// //       head: [
// //         colorize('#', colors.bright),
// //         colorize('Symbol', colors.bright),
// //         colorize('Price', colors.bright),
// //         colorize('Signal', colors.bright),
// //         colorize('Conf%', colors.bright),
// //         colorize('RSI', colors.bright),
// //         colorize('Trend', colors.bright),
// //         colorize('SMC', colors.bright),
// //         colorize('Zone', colors.bright),
// //         colorize('Status', colors.bright),
// //       ],
// //       colWidths: [5, 12, 14, 10, 8, 8, 12, 10, 12, 45],
// //       style: {
// //         head: [],
// //         border: ['gray'],
// //       },
// //       chars: {
// //         top: 'â•',
// //         'top-mid': 'â•¤',
// //         'top-left': 'â•”',
// //         'top-right': 'â•—',
// //         bottom: 'â•',
// //         'bottom-mid': 'â•§',
// //         'bottom-left': 'â•š',
// //         'bottom-right': 'â•',
// //         left: 'â•‘',
// //         'left-mid': 'â•Ÿ',
// //         mid: 'â”€',
// //         'mid-mid': 'â”¼',
// //         right: 'â•‘',
// //         'right-mid': 'â•¢',
// //         middle: 'â”‚',
// //       },
// //     });

// //     displayResults.forEach((result, i) => {
// //       const rowNumber = colorize(
// //         (i + 1).toString().padStart(2, ' '),
// //         colors.gray
// //       );
// //       const symbolColor =
// //         result.confidence >= SCAN_CONFIG.minConfidence
// //           ? colors.brightCyan
// //           : colors.gray;
// //       const symbolText = colorize(result.symbol, symbolColor);

// //       const priceColor =
// //         result.signal?.side === 'LONG'
// //           ? colors.brightGreen
// //           : result.signal?.side === 'SHORT'
// //             ? colors.brightRed
// //             : colors.yellow;
// //       const priceText = colorize(
// //         `${result.price.toFixed(getPriceDecimals(result.price))}`,
// //         priceColor
// //       );

// //       let signalText = colorize('â”€', colors.gray);
// //       if (result.signal?.side === 'LONG') {
// //         signalText = colorize('ðŸš€ LONG', colors.brightGreen);
// //       } else if (result.signal?.side === 'SHORT') {
// //         signalText = colorize('ðŸ“‰ SHORT', colors.brightRed);
// //       }

// //       const confColor =
// //         result.confidence >= 80
// //           ? colors.brightGreen
// //           : result.confidence >= 70
// //             ? colors.green
// //             : result.confidence >= 60
// //               ? colors.yellow
// //               : colors.gray;
// //       const confText = colorize(`${result.confidence.toFixed(0)}%`, confColor);

// //       let rsiText = '';
// //       if (result.rsi! < 30) {
// //         rsiText = colorize(`${result.rsi!.toFixed(1)} ðŸ”¥`, colors.brightGreen);
// //       } else if (result.rsi! < 40) {
// //         rsiText = colorize(`${result.rsi!.toFixed(1)} â†“`, colors.green);
// //       } else if (result.rsi! > 70) {
// //         rsiText = colorize(`${result.rsi!.toFixed(1)} ðŸŒ¡ï¸`, colors.brightRed);
// //       } else if (result.rsi! > 60) {
// //         rsiText = colorize(`${result.rsi!.toFixed(1)} â†‘`, colors.red);
// //       } else {
// //         rsiText = colorize(`${result.rsi!.toFixed(1)} â”€`, colors.gray);
// //       }

// //       let trendText = colorize('RANGING ðŸ“Š', colors.yellow);
// //       if (result.regime?.trend === 'UPTREND') {
// //         trendText = colorize('UPTREND ðŸ“ˆ', colors.green);
// //       } else if (result.regime?.trend === 'DOWNTREND') {
// //         trendText = colorize('DOWNTREND ðŸ“‰', colors.red);
// //       }

// //       let smcText = colorize('â”€', colors.gray);
// //       if (result.smc) {
// //         const smcColor =
// //           result.smc.smcScore >= 70
// //             ? colors.brightGreen
// //             : result.smc.smcScore >= 50
// //               ? colors.yellow
// //               : colors.gray;
// //         smcText = colorize(`${result.smc.smcScore.toFixed(0)}`, smcColor);
// //         if (result.smc.bos.detected)
// //           smcText += colorize(' BOS', colors.brightMagenta);
// //         if (result.smc.choch.detected)
// //           smcText += colorize(' CHoCH', colors.brightYellow);
// //       }

// //       let zoneText = colorize('â”€', colors.gray);
// //       if (result.smc) {
// //         if (result.smc.premiumDiscount === 'PREMIUM') {
// //           zoneText = colorize('PREMIUM ðŸ”´', colors.red);
// //         } else if (result.smc.premiumDiscount === 'DISCOUNT') {
// //           zoneText = colorize('DISCOUNT ðŸŸ¢', colors.green);
// //         } else {
// //           zoneText = colorize('EQUILIBRIUM', colors.yellow);
// //         }
// //       }

// //       let statusText = '';
// //       if (result.confidence >= 70) {
// //         statusText = colorize('â­ Strong Signal', colors.brightGreen);
// //       } else if (result.confidence >= 60) {
// //         statusText = colorize('âœ“ Good Signal', colors.green);
// //       } else if (result.confidence >= 50) {
// //         statusText = colorize('âš  Weak Signal', colors.yellow);
// //       } else {
// //         statusText = colorize('â”€ No Signal', colors.gray);
// //       }

// //       if (result.signal?.reason) {
// //         const shortReason = result.signal.reason
// //           .split('. ')[0]
// //           ?.substring(0, 100);
// //         statusText += colorize(` | ${shortReason}`, colors.brightGreen);
// //       }

// //       table.push([
// //         rowNumber,
// //         symbolText,
// //         priceText,
// //         signalText,
// //         confText,
// //         rsiText,
// //         trendText,
// //         smcText,
// //         zoneText,
// //         statusText,
// //       ]);
// //     });

// //     console.log(table.toString());

// //     console.log(colorize('â•'.repeat(147), colors.cyan));

// //     const longSignals = results.filter(
// //       (r) =>
// //         r.signal?.side === 'LONG' && r.confidence >= SCAN_CONFIG.minConfidence
// //     ).length;
// //     const shortSignals = results.filter(
// //       (r) =>
// //         r.signal?.side === 'SHORT' && r.confidence >= SCAN_CONFIG.minConfidence
// //     ).length;
// //     const strongSignals = results.filter((r) => r.confidence >= 70).length;
// //     const smcSignals = results.filter(
// //       (r) =>
// //         r.signal &&
// //         smcStrategies.includes(r.signal.strategy) &&
// //         r.confidence >= SCAN_CONFIG.smcMinScore
// //     ).length;
// //     const avgConfidence =
// //       results.length > 0
// //         ? (
// //             results.reduce((sum, r) => sum + r.confidence, 0) / results.length
// //           ).toFixed(1)
// //         : '0';

// //     const summaryTable = new Table({
// //       head: [
// //         colorize('Metric', colors.bright),
// //         colorize('Value', colors.bright),
// //       ],
// //       style: {
// //         head: [],
// //         border: ['gray'],
// //       },
// //     });

// //     summaryTable.push(
// //       [
// //         'Total Tokens Scanned',
// //         colorize(results.length.toString(), colors.cyan),
// //       ],
// //       ['ðŸš€ Long Signals', colorize(longSignals.toString(), colors.brightGreen)],
// //       ['ðŸ“‰ Short Signals', colorize(shortSignals.toString(), colors.brightRed)],
// //       [
// //         'â­ Strong Signals (70%+)',
// //         colorize(strongSignals.toString(), colors.brightYellow),
// //       ],
// //       [
// //         'ðŸ’Ž SMC Signals (40%+)',
// //         colorize(smcSignals.toString(), colors.brightMagenta),
// //       ],
// //       ['ðŸ“Š Average Confidence', colorize(`${avgConfidence}%`, colors.yellow)],
// //       [
// //         'ðŸ’¾ Memory Usage',
// //         colorize(
// //           `${this.candleManager.getMemoryStats().memoryMB}MB`,
// //           colors.gray
// //         ),
// //       ],
// //       [
// //         'ðŸ”„ Next Scan In',
// //         colorize(`${SCAN_CONFIG.scanInterval / 1000}s`, colors.cyan),
// //       ]
// //     );

// //     console.log(summaryTable.toString());
// //     console.log(colorize('â•'.repeat(80), colors.cyan));

// //     const bullishCount = results.filter(
// //       (r) => r.signal?.side === 'LONG'
// //     ).length;
// //     const bearishCount = results.filter(
// //       (r) => r.signal?.side === 'SHORT'
// //     ).length;
// //     const bullishPercent =
// //       results.length > 0
// //         ? ((bullishCount / results.length) * 100).toFixed(0)
// //         : '0';
// //     const bearishPercent =
// //       results.length > 0
// //         ? ((bearishCount / results.length) * 100).toFixed(0)
// //         : '0';

// //     let sentiment = 'âš–ï¸  NEUTRAL';
// //     let sentimentColor = colors.yellow;
// //     if (results.length > 0 && bullishCount > bearishCount * 1.5) {
// //       sentiment = 'ðŸŸ¢ BULLISH MARKET';
// //       sentimentColor = colors.brightGreen;
// //     } else if (results.length > 0 && bearishCount > bullishCount * 1.5) {
// //       sentiment = 'ðŸ”´ BEARISH MARKET';
// //       sentimentColor = colors.brightRed;
// //     }

// //     console.log(
// //       colorize(
// //         `Market Sentiment: ${sentiment} (${bullishPercent}% Bullish | ${bearishPercent}% Bearish)`,
// //         sentimentColor
// //       )
// //     );
// //     console.log(colorize('â•'.repeat(80), colors.cyan));
// //     console.log(
// //       colorize(
// //         `SMC Mode: ${SCAN_CONFIG.smcEnabled ? 'ENABLED âœ…' : 'DISABLED'} | Mode: ${SCAN_CONFIG.tradingMode}`,
// //         colors.brightCyan
// //       )
// //     );
// //     console.log(colorize('â•'.repeat(80), colors.cyan));
// //     console.log(
// //       colorize(
// //         'Press Ctrl+C to stop | Scanner running in-place update mode',
// //         colors.gray
// //       )
// //     );
// //   }

// //   async startContinuousScanning(): Promise<void> {
// //     await new Promise((resolve) => setTimeout(resolve, 3000));

// //     const results = await this.scanAll();
// //     this.displayResults(results);

// //     setInterval(async () => {
// //       const results = await this.scanAll();
// //       this.displayResults(results);
// //     }, SCAN_CONFIG.scanInterval);
// //   }

// //   async runSingleScan(): Promise<void> {
// //     const results = await this.scanAll();
// //     this.displayResults(results);
// //     log('âœ… Single scan complete', 'success');
// //   }

// //   destroy(): void {
// //     if (this.candleManager) {
// //       this.candleManager.destroy();
// //       log('ðŸ—‘ï¸ CandleManager destroyed', 'info');
// //     }
// //   }
// // }

// // // ============================================================================
// // // MAIN
// // // ============================================================================

// // let scanner: TradingScanner | null = null;

// // async function main() {
// //   const args = process.argv.slice(2);
// //   const modeArg = args.find((arg) => arg.startsWith('--mode='));

// //   if (modeArg) {
// //     const mode = modeArg.split('=')[1]?.toUpperCase();
// //     if (mode === 'SPOT' || mode === 'FUTURES' || mode === 'BOTH') {
// //       SCAN_CONFIG.tradingMode = mode as 'SPOT' | 'FUTURES' | 'BOTH';
// //     }
// //   }

// //   console.log(colorize('â•'.repeat(80), colors.cyan));
// //   console.log(
// //     colorize(
// //       'ðŸš€ Crypto Trading Scanner with SMC (Smart Money Concepts)',
// //       colors.brightCyan
// //     )
// //   );
// //   console.log(
// //     colorize(
// //       `   Mode: ${SCAN_CONFIG.tradingMode} | SMC: ${SCAN_CONFIG.smcEnabled ? 'ON' : 'OFF'}`,
// //       colors.yellow
// //     )
// //   );
// //   console.log(colorize('â•'.repeat(80), colors.cyan));

// //   try {
// //     scanner = new TradingScanner();
// //     await scanner.initialize();

// //     if (SCAN_CONFIG.enableContinuousMode) {
// //       await scanner.startContinuousScanning();
// //     } else {
// //       await scanner.runSingleScan();
// //       process.exit(0);
// //     }
// //   } catch (err: any) {
// //     log(`Fatal error: ${err.message}`, 'error');
// //     console.error(err.stack);
// //     process.exit(1);
// //   }
// // }

// // process.on('SIGINT', () => {
// //   log('\nðŸ‘‹ Shutting down scanner...', 'warning');
// //   if (scanner) {
// //     scanner.destroy();
// //   }
// //   process.exit(0);
// // });

// // process.on('SIGTERM', () => {
// //   log('\nðŸ‘‹ Shutting down scanner...', 'warning');
// //   if (scanner) {
// //     scanner.destroy();
// //   }
// //   process.exit(0);
// // });

// // main();
