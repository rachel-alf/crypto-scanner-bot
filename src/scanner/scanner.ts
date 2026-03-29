// import fs from 'fs';

// import Table from 'cli-table3';
// import * as dotenv from 'dotenv';
// import { ATR, EMA, RSI } from 'technicalindicators';

// import {
//   colors,
//   getPriceDecimals,
//   normalize,
//   type MarketType,
// } from '../../lib/helpers.js';
// import { detectRegime } from '../../lib/trading-utils.js';
// import {
//   smcStrategies,
//   smcStrategy,
//   strategyId,
//   type BotType,
//   type CandleData,
//   type EntrySignal,
//   type Indicators,
//   type LiquidityData,
//   type LiquidityMetrics,
//   type ScanResult,
//   type SymbolContext,
// } from '../../lib/type.js';
// import { CandleManager, HTFCandleManager } from '../core/candles.js';

// // // ============================================================================
// // // INDICATOR CALCULATION
// // // ============================================================================

// function calculateIndicators(candles: any): Indicators | null {
//   try {
//     const closes = candles.closes;
//     const highs = candles.highs;
//     const lows = candles.lows;

//     if (closes.length < 210) return null;

//     const ema8 = EMA.calculate({ period: 8, values: closes });
//     const ema21 = EMA.calculate({ period: 21, values: closes });
//     const ema50 = EMA.calculate({ period: 50, values: closes });
//     const ema200 = EMA.calculate({ period: 200, values: closes });
//     const rsi = RSI.calculate({ period: 14, values: closes });
//     const atr = ATR.calculate({
//       period: 14,
//       high: highs,
//       low: lows,
//       close: closes,
//     });

//     return {
//       ema8: ema8[ema8.length - 1] || 0,
//       ema21: ema21[ema21.length - 1] || 0,
//       ema50: ema50[ema50.length - 1] || 0,
//       ema200: ema200[ema200.length - 1] || 0,
//       rsi: rsi[rsi.length - 1] || 50,
//       atr: atr[atr.length - 1] || 0,
//       currentPrice: closes[closes.length - 1] || 0,
//       volume: candles.volumes[candles.volumes.length - 1] || 0,
//     };
//   } catch (err: any) {
//     log(`Error calculating indicators: ${err.message}`, 'error');
//     return null;
//   }
// }

// dotenv.config();

// // ============================================================================
// // SMC (SMART MONEY CONCEPTS) TYPES
// // ============================================================================

// interface OrderBlock {
//   type: 'BULLISH' | 'BEARISH';
//   high: number;
//   low: number;
//   index: number;
//   strength: number;
//   mitigated: boolean;
// }

// interface FairValueGap {
//   type: 'BULLISH' | 'BEARISH';
//   top: number;
//   bottom: number;
//   index: number;
//   filled: boolean;
// }

// interface LiquidityLevel {
//   type: 'HIGH' | 'LOW';
//   price: number;
//   strength: number;
//   swept: boolean;
// }

// interface SMCAnalysis {
//   orderBlocks: OrderBlock[];
//   fvgs: FairValueGap[];
//   liquidityLevels: LiquidityLevel[];
//   bos: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
//   choch: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
//   premiumDiscount: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
//   smcScore: number;
// }

// interface SignalExport {
//   timestamp: Date;
//   signals: Array<{
//     symbol: string;
//     side?: 'LONG' | 'SHORT';
//     confidence: number;
//     price: number;
//     reason?: string;
//     timestamp: Date;
//     smc?: {
//       score: number;
//       zone: string;
//       bos: boolean;
//       choch: boolean;
//       orderBlocks: number;
//       fvgs: number;
//     };
//   }>;
//   marketSentiment: {
//     bullish: number;
//     bearish: number;
//     neutral: number;
//   };
// }
// export interface ExtendedScanResult extends ScanResult {
//   smc?: SMCAnalysis;
//   marketType?: BotType;
// }

// // ============================================================================
// // CONFIGURATION
// // ============================================================================

// if (!process.env.ENABLED_SYMBOLS) {
//   throw new Error('no symbol token was found!');
// }
// const SCAN_CONFIG = {
//   symbols: process.env.ENABLED_SYMBOLS.split(','),
//   scanInterval: 30_000,
//   minConfidence: 50,
//   timeframe: '15m',
//   displayLimit: 50,
//   enableContinuousMode: true,
//   showAllTokens: true,

//   // ✅ NEW: Mode configuration
//   tradingMode: (process.env.TRADING_MODE || 'BOTH') as
//     | 'SPOT'
//     | 'FUTURES'
//     | 'BOTH',

//   // ✅ NEW: SMC configuration
//   smcEnabled: true,
//   smcMinScore: 40, // Minimum SMC score to consider

//   // ✅ NEW: Output files for different modes
//   outputFiles: {
//     spot: './signals/spot-signals.json',
//     futures: './signals/futures-signals.json',
//     futuresLegacy: './signals/futures-legacy-signals.json',
//     all: './signals/scanner-output.json',
//   },

//   marketType: 'FUTURES' as MarketType,

//   liquidity: {
//     enabled: true,
//     minSpreadBps: 10, // 0.10% minimum spread
//     maxSpreadBps: 50, // 0.50% maximum spread
//     minDepthMultiplier: 10, // 10x position size in depth
//     maxSlippagePct: 0.3, // 0.3% max slippage
//     minDepth24h: 10_000_000, // $1M daily volume minimum
//   },
// };

// function colorize(text: string, color: string): string {
//   return `${color}${text}${colors.reset}`;
// }

// function log(
//   msg: string,
//   type: 'info' | 'success' | 'error' | 'warning' = 'info'
// ) {
//   const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
//   const timestamp = new Date().toISOString();
//   console.log(`[${timestamp}] ${icons[type]} ${msg}`);
// }

// function createSymbolContext(symbol: string): SymbolContext {
//   const base = symbol.replace('/USDT', '').replace('USDT', '');
//   return {
//     display: `${base}/USDT`,
//     base,
//     futures: normalize(symbol),
//   } as SymbolContext;
// }

// // ============================================================================
// // SMC ANALYSIS FUNCTIONS
// // ============================================================================

// /**
//  * Detect Order Blocks (OB)
//  * An Order Block is a consolidation area before a strong move
//  */
// function detectOrderBlocks(candles: any, lookback: number = 20): OrderBlock[] {
//   const orderBlocks: OrderBlock[] = [];
//   const { highs, lows, closes, opens } = candles;
//   const len = closes.length;

//   for (let i = len - lookback; i < len - 3; i++) {
//     if (i < 2) continue;

//     const currentRange = highs[i] - lows[i];
//     const prevRange = highs[i - 1] - lows[i - 1];

//     // Bullish Order Block: Last down candle before strong up move
//     if (
//       closes[i] < opens[i] && // Current is bearish
//       closes[i + 1] > opens[i + 1] && // Next is bullish
//       closes[i + 1] > highs[i] && // Strong move up
//       currentRange > prevRange * 0.5 // Significant candle
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

//     // Bearish Order Block: Last up candle before strong down move
//     if (
//       closes[i] > opens[i] && // Current is bullish
//       closes[i + 1] < opens[i + 1] && // Next is bearish
//       closes[i + 1] < lows[i] && // Strong move down
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

//   return orderBlocks.slice(-5); // Keep last 5 OBs
// }

// /**
//  * Detect Fair Value Gaps (FVG)
//  * A gap between the high of candle 1 and low of candle 3
//  */
// function detectFairValueGaps(
//   candles: any,
//   lookback: number = 30
// ): FairValueGap[] {
//   const fvgs: FairValueGap[] = [];
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   for (let i = len - lookback; i < len - 2; i++) {
//     if (i < 1) continue;

//     // Bullish FVG: Gap between low of candle 3 and high of candle 1
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

//     // Bearish FVG: Gap between high of candle 3 and low of candle 1
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

//   return fvgs.filter((f) => !f.filled).slice(-5); // Keep last 5 unfilled FVGs
// }

// /**
//  * Detect liquidity levels (swing highs/lows)
//  */
// function detectLiquidityLevels(
//   candles: any,
//   lookback: number = 50
// ): LiquidityLevel[] {
//   const levels: LiquidityLevel[] = [];
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   for (let i = len - lookback; i < len - 5; i++) {
//     if (i < 5) continue;

//     // Swing High (liquidity above)
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

//     // Swing Low (liquidity below)
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

//   return levels.slice(-10); // Keep last 10 levels
// }

// /**
//  * Detect Break of Structure (BOS)
//  * Price breaks through previous high/low in trending direction
//  */
// function detectBOS(
//   candles: any,
//   lookback: number = 20
// ): { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number } {
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   // Find recent swing high/low
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

//   // Bullish BOS: Current price breaks above recent swing high
//   if (closes[len - 1] > swingHigh && swingHighIdx > swingLowIdx) {
//     return { detected: true, type: 'BULLISH', index: swingHighIdx };
//   }

//   // Bearish BOS: Current price breaks below recent swing low
//   if (closes[len - 1] < swingLow && swingLowIdx > swingHighIdx) {
//     return { detected: true, type: 'BEARISH', index: swingLowIdx };
//   }

//   return { detected: false };
// }

// /**
//  * Detect Change of Character (CHoCH)
//  * Reversal signal - breaks structure against the trend
//  */
// function detectCHoCH(
//   candles: any,
//   lookback: number = 30
// ): { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number } {
//   const { highs, lows, closes } = candles;
//   const len = closes.length;

//   // Determine recent trend using EMA
//   const ema20 =
//     closes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
//   const ema50 =
//     closes.slice(-50).reduce((a: number, b: number) => a + b, 0) / 50;
//   const isUptrend = ema20 > ema50;

//   // Find recent swing points
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

//   // Bullish CHoCH: In downtrend, price breaks above recent high
//   if (!isUptrend && closes[len - 1] > recentHigh) {
//     return { detected: true, type: 'BULLISH', index: recentHighIdx };
//   }

//   // Bearish CHoCH: In uptrend, price breaks below recent low
//   if (isUptrend && closes[len - 1] < recentLow) {
//     return { detected: true, type: 'BEARISH', index: recentLowIdx };
//   }

//   return { detected: false };
// }
// /**
//  * Determine if price is in premium or discount zone
//  */
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
//   const midPoint = lowest + range * 0.5;

//   const upperThreshold = lowest + range * 0.618; // 61.8% Fib level
//   const lowerThreshold = lowest + range * 0.382; // 38.2% Fib level

//   if (currentPrice >= upperThreshold) return 'PREMIUM';
//   if (currentPrice <= lowerThreshold) return 'DISCOUNT';
//   return 'EQUILIBRIUM';
// }

// /**
//  * Calculate overall SMC score
//  */
// function calculateSMCScore(smc: Omit<SMCAnalysis, 'smcScore'>): number {
//   let score = 0;

//   // Order Blocks (max 30 points)
//   const activeOBs = smc.orderBlocks.filter((ob) => !ob.mitigated);
//   score += Math.min(30, activeOBs.length * 10);

//   // Fair Value Gaps (max 20 points)
//   const activeFVGs = smc.fvgs.filter((fvg) => !fvg.filled);
//   score += Math.min(20, activeFVGs.length * 7);

//   // Liquidity Sweeps (max 20 points)
//   const recentSweeps = smc.liquidityLevels.filter((l) => l.swept);
//   score += Math.min(20, recentSweeps.length * 10);

//   // BOS (max 15 points)
//   if (smc.bos.detected) score += 15;

//   // CHoCH (max 15 points)
//   if (smc.choch.detected) score += 15;

//   return Math.min(100, score);
// }

// /**
//  * Main SMC analysis function
//  */
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

//   return {
//     ...smcData,
//     smcScore,
//   };
// }

// // ============================================================================
// // INDICATOR CALCULATION
// // ============================================================================

// function calculateInd(candles: any): Indicators | null {
//   try {
//     const closes = candles.closes;
//     const highs = candles.highs;
//     const lows = candles.lows;

//     if (closes.length < 210) return null;

//     const ema8 = EMA.calculate({ period: 8, values: closes });
//     const ema21 = EMA.calculate({ period: 21, values: closes });
//     const ema50 = EMA.calculate({ period: 50, values: closes });
//     const ema200 = EMA.calculate({ period: 200, values: closes });
//     const rsi = RSI.calculate({ period: 14, values: closes });
//     const atr = ATR.calculate({
//       period: 14,
//       high: highs,
//       low: lows,
//       close: closes,
//     });

//     return {
//       ema8: ema8[ema8.length - 1] || 0,
//       ema21: ema21[ema21.length - 1] || 0,
//       ema50: ema50[ema50.length - 1] || 0,
//       ema200: ema200[ema200.length - 1] || 0,
//       rsi: rsi[rsi.length - 1] || 50,
//       atr: atr[atr.length - 1] || 0,
//       currentPrice: closes[closes.length - 1] || 0,
//       volume: candles.volumes[candles.volumes.length - 1] || 0,
//     };
//   } catch (err: any) {
//     log(`Error calculating indicators: ${err.message}`, 'error');
//     return null;
//   }
// }

// // ============================================================================
// // SIGNAL DETECTION WITH SMC
// // ============================================================================

// function detectSignal(
//   symbol: string,
//   indicators: Indicators,
//   smc?: SMCAnalysis
// ): EntrySignal[] {
//   const longSignals: EntrySignal[] = [];
//   const shortSignals: EntrySignal[] = [];
//   const { currentPrice, rsi, ema8, ema21, ema50, ema200 } = indicators;

//   // ============= SMC SIGNALS (CHECK FIRST - HIGHEST PRIORITY) =============

//   const currentZone = smc?.premiumDiscount || 'EQUILIBRIUM';

//   if (smc && SCAN_CONFIG.smcEnabled) {
//     // 🔷 SMC LONG SIGNALS
//     const bullishOB = smc.orderBlocks.find(
//       (ob) => ob.type === 'BULLISH' && !ob.mitigated
//     );

//     // Priority 1: Strong SMC Setup (OB + Discount + BOS/CHoCH)
//     if (
//       bullishOB &&
//       smc.premiumDiscount === 'DISCOUNT' &&
//       (smc.bos.type === 'BULLISH' || smc.choch.type === 'BULLISH')
//     ) {
//       const confidence = Math.min(95, 75 + smc.smcScore * 0.2);
//       longSignals.push({
//         symbol,
//         strategy: 'SMC_LONG',
//         side: 'LONG',
//         reason: `SMC: Bullish OB in discount + ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)}`,
//         confidence,
//         stopLoss: bullishOB.low * 0.995,
//         takeProfit: currentPrice * 1.08,
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
//         stopLoss: bullishOB.low * 0.995,
//         takeProfit: currentPrice * 1.06,
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
//         stopLoss: currentPrice * 0.97,
//         takeProfit: currentPrice * 1.06,
//         timestamp: new Date(),
//       });
//     }

//     // 🔷 FVG Fill Signals (LONG)
//     const bullishFVG = smc.fvgs.find(
//       (fvg) => fvg.type === 'BULLISH' && !fvg.filled
//     );
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
//         stopLoss: bullishFVG.bottom * 0.995,
//         takeProfit: currentPrice * 1.05,
//         timestamp: new Date(),
//       });
//     }

//     // 🔷 Liquidity Sweep Signals (LONG)
//     const sweptLow = smc.liquidityLevels.find(
//       (l) => l.type === 'LOW' && l.swept && l.strength > 60
//     );
//     if (sweptLow && currentPrice > sweptLow.price * 1.001) {
//       longSignals.push({
//         symbol,
//         strategy: 'LIQUIDITY_SWEEP',
//         side: 'LONG',
//         reason: `Liquidity swept below ${sweptLow.price.toFixed(2)}. Reversal expected`,
//         confidence: 75,
//         stopLoss: sweptLow.price * 0.995,
//         takeProfit: currentPrice * 1.06,
//         timestamp: new Date(),
//       });
//     }

//     // 🔷 SMC SHORT SIGNALS
//     const bearishOB = smc.orderBlocks.find(
//       (ob) => ob.type === 'BEARISH' && !ob.mitigated
//     );

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
//         stopLoss: bearishOB.high * 1.005,
//         takeProfit: currentPrice * 0.92,
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
//         stopLoss: bearishOB.high * 1.005,
//         takeProfit: currentPrice * 0.94,
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
//         stopLoss: currentPrice * 1.03,
//         takeProfit: currentPrice * 0.94,
//         timestamp: new Date(),
//       });
//     }

//     // 🔷 FVG Fill Signals (SHORT)
//     const bearishFVG = smc.fvgs.find(
//       (fvg) => fvg.type === 'BEARISH' && !fvg.filled
//     );
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
//         stopLoss: bearishFVG.top * 1.005,
//         takeProfit: currentPrice * 0.95,
//         timestamp: new Date(),
//       });
//     }

//     // 🔷 Liquidity Sweep Signals (SHORT)
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
//         stopLoss: sweptHigh.price * 1.005,
//         takeProfit: currentPrice * 0.94,
//         timestamp: new Date(),
//       });
//     }
//   }

//   // ============= TRADITIONAL LONG SIGNALS =============

//   const breakout = detectBreakout(indicators);
//   if (breakout) {
//     longSignals.push({
//       symbol,
//       strategy: 'BREAKOUT',
//       side: 'LONG',
//       reason: breakout.reason,
//       confidence: breakout.confidence,
//       stopLoss: currentPrice * 0.97,
//       takeProfit: currentPrice * 1.06,
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
//       stopLoss: currentPrice * 0.97,
//       takeProfit: currentPrice * 1.06,
//       timestamp: new Date(),
//     });
//   }

//   const fib = detectFibRetracement(indicators);
//   if (fib) {
//     longSignals.push({
//       symbol,
//       strategy: 'FIB_RETRACEMENT',
//       side: 'LONG',
//       reason: fib.reason,
//       confidence: fib.confidence,
//       stopLoss: currentPrice * 0.97,
//       takeProfit: currentPrice * 1.06,
//       timestamp: new Date(),
//     });
//   }

//   // RSI Oversold - IMPROVED VERSION
//   if (rsi < 30) {
//     // Raised threshold (was 40)
//     // ✅ Only trade RSI in appropriate zones
//     const zoneOk =
//       !smc ||
//       smc.premiumDiscount === 'DISCOUNT' ||
//       smc.premiumDiscount === 'EQUILIBRIUM';

//     if (zoneOk) {
//       const confidence = 55 + (30 - rsi) * 1.5; // Lower base confidence

//       // Boost if in perfect zone
//       const finalConfidence =
//         smc?.premiumDiscount === 'DISCOUNT'
//           ? Math.min(75, confidence + 10) // Boost in discount
//           : Math.min(65, confidence); // Lower if equilibrium

//       longSignals.push({
//         symbol,
//         strategy: 'RSI_DIVERGENCE',
//         side: 'LONG',
//         reason: `Oversold RSI ${rsi.toFixed(1)}${smc ? ` in ${smc.premiumDiscount} zone` : ''}`,
//         confidence: finalConfidence,
//         timestamp: new Date(),
//       });
//     }
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
//       stopLoss: currentPrice * 1.03,
//       takeProfit: currentPrice * 0.94,
//       timestamp: new Date(),
//     });
//   }

//   // RSI Overbought - IMPROVED VERSION
//   if (rsi > 70) {
//     // Raised threshold
//     // ✅ Only trade RSI in appropriate zones
//     const zoneOk =
//       !smc ||
//       smc.premiumDiscount === 'PREMIUM' ||
//       smc.premiumDiscount === 'EQUILIBRIUM';

//     if (zoneOk) {
//       const confidence = 55 + (rsi - 70) * 1.2; // Lower base confidence

//       // Boost if in perfect zone
//       const finalConfidence =
//         smc?.premiumDiscount === 'PREMIUM'
//           ? Math.min(75, confidence + 10) // Boost in premium
//           : Math.min(65, confidence); // Lower if equilibrium

//       shortSignals.push({
//         symbol,
//         strategy: 'RSI_DIVERGENCE',
//         side: 'SHORT',
//         reason: `Overbought RSI ${rsi.toFixed(2)}${smc ? ` in ${smc.premiumDiscount} zone` : ''}`,
//         confidence: finalConfidence,
//         timestamp: new Date(),
//       });
//     }
//   }

//   // ============= ✅ CONFLICT RESOLUTION =============

//   const signals: EntrySignal[] = [];

//   if (longSignals.length > 0 && shortSignals.length > 0) {
//     // Find best signals on each side
//     const bestLong = longSignals.reduce((a, b) => {
//       if (!a) return b;
//       if (!b) return a;
//       return a.confidence > b.confidence ? a : b;
//     });

//     const bestShort = shortSignals.reduce((a, b) => {
//       if (!a) return b;
//       if (!b) return a;
//       return a.confidence > b.confidence ? a : b;
//     });

//     // Null safety check
//     if (!bestLong || !bestShort) {
//       // console.log(`   ⚠️  ${symbol}: Invalid signal data - SKIPPED`);
//       return [];
//     }

//     const confidenceDiff = Math.abs(bestLong.confidence - bestShort.confidence);
//     // console.log(`   ⚠️  ${symbol}: Conflicting signals (LONG ${bestLong.confidence.toFixed(0)}% vs SHORT ${bestShort.confidence.toFixed(0)}%, diff: ${confidenceDiff.toFixed(0)}%) - SKIPPED`);

//     // ✅ Strategy 1: Clear winner (15% difference)
//     if (bestLong.confidence > bestShort.confidence + 15) {
//       signals.push(bestLong);
//       // console.log(`   ✅ ${symbol}: LONG ${bestLong.confidence.toFixed(0)}% wins over SHORT ${bestShort.confidence.toFixed(0)}%`);
//     } else if (bestShort.confidence > bestLong.confidence + 15) {
//       signals.push(bestShort);
//       // console.log(`   ✅ ${symbol}: SHORT ${bestShort.confidence.toFixed(0)}% wins over LONG ${bestLong.confidence.toFixed(0)}%`);
//     }
//     // ✅ Strategy 2: SMC signals have priority over traditional
//     else {
//       // const smcStrategies = ['SMC_LONG', 'SMC_SHORT', 'FVG_FILL', 'LIQUIDITY_SWEEP'];
//       const longIsSMC = smcStrategies.includes(bestLong.strategy);
//       const shortIsSMC = smcStrategies.includes(bestShort.strategy);

//       if (longIsSMC && !shortIsSMC) {
//         signals.push(bestLong);
//         // console.log(`   ✅ ${symbol}: SMC LONG ${bestLong.confidence.toFixed(0)}% prioritized over traditional SHORT ${bestShort.confidence.toFixed(0)}%`);
//       } else if (shortIsSMC && !longIsSMC) {
//         signals.push(bestShort);
//         // console.log(`   ✅ ${symbol}: SMC SHORT ${bestShort.confidence.toFixed(0)}% prioritized over traditional LONG ${bestLong.confidence.toFixed(0)}%`);
//       } else {
//         // Too ambiguous - skip this token
//         // console.log(`   ⚠️  ${symbol}: Conflicting signals (LONG ${bestLong.confidence.toFixed(0)}% vs SHORT ${bestShort.confidence.toFixed(0)}%) - SKIPPED`);
//         return [];
//       }
//     }
//   } else if (longSignals.length > 0) {
//     // Only LONG signals - add them all
//     signals.push(...longSignals);
//   } else if (shortSignals.length > 0) {
//     // Only SHORT signals - add them all
//     signals.push(...shortSignals);
//   }

//   // ============= SUMMARY =============

//   if (signals.length === 0) {
//     console.log(
//       `   ⚠️  No signals (RSI ${rsi.toFixed(1)} in neutral zone, no SMC setups)`
//     );
//     return [];
//   }

//   const validSignals = signals.filter((s) => s !== null && s !== undefined);

//   if (validSignals.length === 0) {
//     console.log(`   ⚠️  No valid signals`);
//     return [];
//   }

//   const smcSignals = validSignals.filter((s) =>
//     strategyId.includes(s.strategy)
//   );
//   const tradSignals = validSignals.filter(
//     (s) => !strategyId.includes(s.strategy)
//   );

//   return validSignals;
// }

// // ============================================================================
// // FIXED: detectBreakout - More Lenient
// // ============================================================================

// function detectBreakout(
//   indicators: Indicators
// ): { confidence: number; reason: string } | null {
//   const { currentPrice, ema8, ema21, ema50, ema200, rsi } = indicators;

//   // ✅ RELAXED: Just need price > EMA21 and upward momentum
//   if (
//     ema8 &&
//     ema21 &&
//     currentPrice > ema21 &&
//     ema8 > ema21 &&
//     rsi > 45 &&
//     rsi < 80 // ✅ Wider range
//   ) {
//     let confidence = 60;

//     if (ema21 > ema50) confidence += 5;
//     if (currentPrice > ema200) confidence += 5;
//     if (rsi > 50 && rsi < 70) confidence += 5;
//     if (ema8 > ema50 * 1.01) confidence += 5;
//     if (currentPrice > ema21 * 1.02) confidence += 5;

//     return {
//       confidence: Math.min(95, confidence),
//       reason: `Breakout above EMA21 with momentum`,
//     };
//   }
//   return null;
// }

// // ============================================================================
// // ✅ STEP 4: Relaxed detectBreakdown
// // ============================================================================

// function detectBreakdown(
//   indicators: Indicators
// ): { confidence: number; reason: string } | null {
//   const { currentPrice, ema8, ema21, ema50, ema200, rsi } = indicators;

//   // ✅ RELAXED: Just need price < EMA21 and downward momentum
//   if (
//     ema8 &&
//     ema21 &&
//     currentPrice < ema21 &&
//     ema8 < ema21 &&
//     rsi < 55 &&
//     rsi > 20 // ✅ Wider range
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

// function calculateFinalScore(
//   signal: EntrySignal,
//   indicators: Indicators,
//   smc?: SMCAnalysis
// ): number | null {
//   let score = 0;

//   if (!signal) return null;
//   // 1. Base Confidence (40% weight) - Max 40 points
//   score += signal.confidence * 0.4;

//   // 2. SMC Score (30% weight) - Max 30 points
//   if (smc && smc.smcScore >= SCAN_CONFIG.smcMinScore) {
//     score += (smc.smcScore / 100) * 30;
//   }

//   // 3. RSI Quality (15% weight) - Max 15 points
//   const rsi = indicators.rsi;
//   if (signal.side === 'LONG') {
//     // LONG: Prefer RSI 30-50 (oversold recovery)
//     if (rsi >= 30 && rsi <= 50) {
//       score += 15;
//     } else if (rsi >= 25 && rsi <= 55) {
//       score += 10;
//     } else if (rsi >= 20 && rsi <= 60) {
//       score += 5;
//     }
//   } else {
//     // SHORT: Prefer RSI 50-70 (overbought)
//     if (rsi >= 50 && rsi <= 70) {
//       score += 15;
//     } else if (rsi >= 45 && rsi <= 75) {
//       score += 10;
//     } else if (rsi >= 40 && rsi <= 80) {
//       score += 5;
//     }
//   }

//   // 4. Trend Alignment (15% weight) - Max 15 points
//   const ema50 = indicators.ema50;
//   const ema200 = indicators.ema200;
//   const price = indicators.currentPrice;

//   if (signal?.side === 'LONG') {
//     // LONG: Want bullish trend
//     if (ema50 > ema200 && price > ema50) {
//       score += 15; // Strong uptrend
//     } else if (ema50 > ema200) {
//       score += 10; // Uptrend but price below EMA50
//     } else if (price > ema200) {
//       score += 5; // Price above 200 EMA at least
//     }
//   } else {
//     // SHORT: Want bearish trend
//     if (ema50 < ema200 && price < ema50) {
//       score += 15; // Strong downtrend
//     } else if (ema50 < ema200) {
//       score += 10; // Downtrend but price above EMA50
//     } else if (price < ema200) {
//       score += 5; // Price below 200 EMA at least
//     }
//   }

//   return Math.min(100, score); // Cap at 100
// }

// export class SimpleLiquidityChecker {
//   private cache = new Map<string, { volume: number; timestamp: number }>();
//   private CACHE_TTL = 60000; // 1 minute cache

//   async check24hVolume(symbol: string): Promise<number> {
//     // Check cache
//     const cached = this.cache.get(symbol);
//     if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
//       return cached.volume;
//     }

//     try {
//       const binanceSymbol = symbol.replace('/', '');
//       const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`;

//       const response = await fetch(url);
//       const data = await response.json();

//       const volume = parseFloat(data.quoteVolume || '0'); // Volume in USDT

//       // Cache result
//       this.cache.set(symbol, { volume, timestamp: Date.now() });

//       return volume;
//     } catch (err) {
//       console.error(`Failed to check volume for ${symbol}`);
//       return 0;
//     }
//   }
// }

// // // ============================================================================
// // // SCANNER CLASS WITH IN-PLACE DISPLAY
// // // ============================================================================

// const SIGNALS_FILE = './signals/scanner-output.json';
// const SIGNALS_DIR = './signals';

// class TradingScanner {
//   private candleManager: CandleManager;
//   private htfManager: HTFCandleManager;
//   private scanResults: Map<string, ScanResult> = new Map();
//   private scanCount = 0;
//   private successfulInitializations = 0;
//   private lastDisplayHeight = 0; // Track display height
//   // private liquidityChecker: EnhancedLiquidityChecker;
//   private marketType: MarketType;
//   private signalsDir = './signals';
//   private outputFile = './signals/scanner-output.json';

//   constructor(marketType: MarketType = SCAN_CONFIG.marketType) {
//     this.marketType = marketType;
//     this.candleManager = new CandleManager(
//       // SCAN_CONFIG.symbols,
//       SCAN_CONFIG.timeframe
//     );
//     // this.liquidityChecker = new EnhancedLiquidityChecker();
//     this.ensureSignalsDir();

//     this.htfManager = new HTFCandleManager();
//     this.outputFile =
//       marketType === 'SPOT'
//         ? SCAN_CONFIG.outputFiles.spot
//         : SCAN_CONFIG.outputFiles.futures;
//   }

//   //     /**
//   //    * ✅ Ensure signals directory exists
//   //    */
//   private ensureSignalsDir(): void {
//     if (!fs.existsSync(this.signalsDir)) {
//       fs.mkdirSync(this.signalsDir, { recursive: true });
//       console.log(`✅ Created signals directory: ${this.signalsDir}`);
//     }
//   }

//   async initialize(): Promise<void> {
//     log('🚀 Initializing Trading Scanner...', 'info');
//     log(
//       `   Market Type: ${colorize(this.marketType, colors.brightCyan)}`,
//       'info'
//     );
//     log(`   Symbols: ${SCAN_CONFIG.symbols.length}`, 'info');
//     log(`   Output File: ${this.outputFile}`, 'info');
//     log(`   Timeframe: ${SCAN_CONFIG.timeframe}`, 'info');
//     log(`   Scan Interval: ${SCAN_CONFIG.scanInterval / 1000}s`, 'info');
//     log('═'.repeat(60), 'info');

//     // ✅ Create signals directory
//     if (!fs.existsSync(SIGNALS_DIR)) {
//       fs.mkdirSync(SIGNALS_DIR, { recursive: true });
//       log(`📁 Created directory: ${SIGNALS_DIR}`, 'info');
//     }

//     let passed = 0;
//     let failed = 0;

//     for (let i = 0; i < SCAN_CONFIG.symbols.length; i++) {
//       const symbol = SCAN_CONFIG.symbols[i];
//       if (!symbol) continue;

//       const normalizedSymbol = normalize(symbol, this.marketType);
//       // log(`[${i + 1}/${SCAN_CONFIG.symbols.length}] Loading ${symbol}...`, 'info');

//       const success = await this.candleManager.initializeHistoricalCandles(
//         normalizedSymbol,
//         500,
//         0,
//         this.marketType
//       );

//       if (success) {
//         passed++;
//         // log(`✅ ${symbol} ready (${this.candleManager.getCandleCount(normalizedSymbol,'SPOT')} candles)`, 'success');
//         this.successfulInitializations++;
//       } else {
//         failed++;
//         log(`❌ ${symbol} failed`, 'error');
//       }

//       // if (i < SCAN_CONFIG.symbols.length - 1) {
//       //   await new Promise((resolve) => setTimeout(resolve, 500));
//       // }
//       // ✅ Show progress every 10 symbols
//       if ((i + 1) % 10 === 0 || i === SCAN_CONFIG.symbols.length - 1) {
//         log(
//           `📊 Progress: ${i + 1}/${SCAN_CONFIG.symbols.length} | ` +
//             `Passed: ${passed} | Failed: ${failed}`,
//           'info'
//         );
//       }

//       // Rate limiting
//       if (i < SCAN_CONFIG.symbols.length - 1) {
//         await new Promise((resolve) => setTimeout(resolve, 500));
//       }

//       // ✅ Create signals directory
//       // if (!fs.existsSync(SIGNALS_DIR)) {
//       //   fs.mkdirSync(SIGNALS_DIR, { recursive: true });
//       // }
//     }

//     log('═'.repeat(60), 'info');
//     log(
//       `✅ Initialization complete: ${passed} passed, ${failed} failed`,
//       passed > 0 ? 'success' : 'error'
//     );
//     // log(`✅ Scanner initialized: ${this.successfulInitializations}/${SCAN_CONFIG.symbols.length} symbols ready`, 'success');

//     if (this.successfulInitializations === 0) {
//       log('❌ No symbols initialized! Scanner cannot run.', 'error');
//       process.exit(1);
//     }
//   }

//   async scanSymbolWithAdvancedScoring(
//     symbol: string
//   ): Promise<ExtendedScanResult | null> {
//     try {
//       // ✅ AUTO-DETECT: Try to get data from the market that has it
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

//       // ✅ Smart selection: Use whichever has valid data
//       let candles: CandleData;
//       let marketType: BotType;

//       const spotValid = candlesSpot && candlesSpot.closes.length >= 210;
//       const futuresValid =
//         candlesFutures && candlesFutures.closes.length >= 210;

//       // console.log(`   ✅ ${symbol}: ${candles.closes.length} candles loaded`);

//       // if (SCAN_CONFIG.liquidity.enabled) {
//       //   const positionSize = 270; // Estimate position size (adjust as needed)
//       //   const liquidityData = await this.liquidityChecker.checkLiquidity(
//       //     symbol,
//       //     positionSize
//       //   );
//       //   const volume24h = await this.liquidityChecker.check24hVolume(symbol);

//       //   if (!liquidityData.passed) {
//       //     console.log(`   ❌ ${symbol}: Failed liquidity check`);
//       //     liquidityData.reasons.forEach((reason) => {
//       //       console.log(`      - ${reason}`);
//       //     });
//       //     return null; // ✅ Reject early
//       //   }

//       //   console.log(`   ✅ ${symbol}: Liquidity OK`);
//       //   console.log(
//       //     `      Volume: $${(liquidityData.volume24h / 1_000_000).toFixed(2)}M`
//       //   );
//       //   console.log(`      Spread: ${liquidityData.spread.toFixed(2)}bps`);
//       //   console.log(
//       //     `      Depth: $${Math.min(liquidityData.bidDepth, liquidityData.askDepth).toFixed(0)}`
//       //   );
//       //   console.log(
//       //     `      Slippage: ${liquidityData.estimatedSlippage.toFixed(2)}%`
//       //   );

//       //   // if (volume24h < SCAN_CONFIG.liquidity.minDepth24h) {
//       //   //   console.log(
//       //   //     `   ❌ ${symbol}: Low volume $${(volume24h / 1_000_000).toFixed(2)}M (min: $${(SCAN_CONFIG.liquidity.minDepth24h / 1_000_000).toFixed(1)}M)`
//       //   //   );
//       //   //   return null; // ✅ Reject early
//       //   // }

//       //   console.log(
//       //     `   ✅ ${symbol}: Volume $${(volume24h / 1_000_000).toFixed(2)}M`
//       //   );
//       // }

//       if (futuresValid) {
//         // ✅ Prefer FUTURES if available (can trade both directions)
//         candles = candlesFutures;
//         marketType = 'FUTURES';
//       } else if (spotValid) {
//         // ✅ Fallback to SPOT
//         candles = candlesSpot;
//         marketType = 'SPOT';
//       } else {
//         return null; // Neither has enough data
//       }

//       console.log(
//         `   ✅ ${symbol} (${marketType}): ${candles.closes.length} candles loaded`
//       );

//       const indicators = calculateIndicators(candles);
//       if (!indicators) {
//         console.log(`   ❌ ${symbol}: Failed to calculate indicators`);
//         return null;
//       }

//       // console.log(`   ✅ ${symbol}: Indicators calculated`);

//       const regime = detectRegime(indicators, candles);

//       // ✅ Skip SMC for now
//       // const smc = undefined; // SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;

//       const smc = SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;

//       const allSignals = detectSignal(symbol, indicators, smc);

//       const validSignals = allSignals.filter((signal) => {
//         // Filter by trading mode
//         if (SCAN_CONFIG.tradingMode === 'SPOT' && signal?.side !== 'LONG') {
//           return false;
//         }

//         // ✅ Filter low SMC scores for SMC strategies
//         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//           if (smc.smcScore < SCAN_CONFIG.smcMinScore) {
//             console.log(
//               `⚠️  ${symbol} ${signal.strategy}: SMC score ${smc.smcScore} < ${SCAN_CONFIG.smcMinScore}`
//             );
//             return false;
//           }
//         }

//         return true;
//       });

//       if (validSignals.length === 0) {
//         return null;
//       }

//       // ✅ FIX 2: Calculate COMBINED score for each signal
//       const scoredSignals = validSignals.map((signal) => {
//         let finalConfidence = signal?.confidence;

//         // ✅ Boost confidence based on SMC score for SMC strategies
//         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//           // SMC strategies: Combine base confidence + SMC score
//           // Formula: 70% base confidence + 30% SMC contribution
//           const smcContribution = (smc.smcScore / 100) * 30; // Max 30 points from SMC
//           finalConfidence = Math.min(95, signal.confidence + smcContribution);

//           console.log(
//             `📊 ${symbol} ${signal.strategy}: Base ${signal.confidence.toFixed(0)}% + SMC ${smc.smcScore} = ${finalConfidence.toFixed(0)}%`
//           );
//         }

//         return {
//           signal,
//           finalConfidence,
//           smcScore: smc?.smcScore || 0,
//         };
//       });

//       // ✅ FIX 3: Pick the BEST signal (highest combined score)
//       const bestScoredSignal = scoredSignals.reduce((best, current) => {
//         const curFinalCon = current.finalConfidence as number;
//         const bestFinalCon = best.finalConfidence as number;
//         return curFinalCon > bestFinalCon ? current : best;
//       });

//       // Pick best

//       console.log(
//         `   ✅ ${symbol}: Best signal: ${bestScoredSignal.signal?.strategy} (${bestScoredSignal.finalConfidence?.toFixed(0)}%)`
//       );

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
//       };

//       // Conditionally add smc if it exists
//       if (smc) {
//         result.smc = smc;
//       }
//       return result;
//     } catch (err: any) {
//       console.error(`❌ Error scanning ${symbol}:`, err.message);
//       return null;
//     }
//   }

//   async scanSymbol(symbol: string): Promise<ExtendedScanResult | null> {
//     const passed = await this.candleManager.initializeWithLiquidityFilter(
//       symbol,
//       10_000_000,
//       this.marketType
//     );

//     if (!passed) {
//       return null; // Failed liquidity filter
//     }

//     try {
//       // console.log(`\n📡 Scanning ${symbol}...`);

//       const normalizedSpotSymbol = normalize(symbol, this.marketType);
//       const candles = this.candleManager.getCandles(
//         normalizedSpotSymbol,
//         this.marketType
//       ) as CandleData;

//       if (!candles) {
//         // console.log(`❌ ${symbol}: No candle data available`);
//         return null;
//       }

//       if (candles.closes.length < 210) {
//         // console.log(`   ❌ ${symbol}: Only ${candles.closes.length} candles (need 210)`);
//         return null;
//       }

//       // console.log(`   ✅ ${symbol}: ${candles.closes.length} candles loaded`);

//       const indicators = calculateIndicators(candles);
//       if (!indicators) {
//         console.log(`   ❌ ${symbol}: Failed to calculate indicators`);
//         return null;
//       }

//       // console.log(`   ✅ ${symbol}: Indicators calculated`);

//       const regime = detectRegime(indicators, candles);

//       // ✅ Skip SMC for now
//       // const smc = undefined; // SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;

//       const smc = SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;

//       // Get signals with logging
//       const signals = detectSignal(symbol, indicators, smc);

//       // ✅ FILTER: Remove signals that don't meet criteria
//       const validSignals = signals.filter((signal) => {
//         // Filter by trading mode
//         if (
//           SCAN_CONFIG.tradingMode === this.marketType &&
//           signal?.side !== 'LONG'
//         ) {
//           return false;
//         }

//         // ✅ Filter low SMC scores for SMC strategies
//         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//           if (smc.smcScore < SCAN_CONFIG.smcMinScore) {
//             console.log(
//               `⚠️  ${symbol} ${signal.strategy}: SMC score ${smc.smcScore} < ${SCAN_CONFIG.smcMinScore}`
//             );
//             return false;
//           }
//         }

//         return true;
//       });

//       if (validSignals.length === 0) {
//         console.log(`   ℹ️  ${symbol}: No valid signals after filtering`);
//         return null;
//       }

//       // ✅ FIX 2: Calculate COMBINED score for each signal
//       const scoredSignals = validSignals.map((signal) => {
//         let finalConfidence = signal?.confidence;

//         // ✅ Boost confidence based on SMC score for SMC strategies
//         if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
//           // SMC strategies: Combine base confidence + SMC score
//           // Formula: 70% base confidence + 30% SMC contribution
//           const smcContribution = (smc.smcScore / 100) * 30; // Max 30 points from SMC
//           finalConfidence = Math.min(95, signal.confidence + smcContribution);

//           console.log(
//             `📊 ${symbol} ${signal.strategy}: Base ${signal.confidence.toFixed(0)}% + SMC ${smc.smcScore} = ${finalConfidence.toFixed(0)}%`
//           );
//         }

//         return {
//           signal,
//           finalConfidence,
//           smcScore: smc?.smcScore || 0,
//         };
//       });

//       // ✅ FIX 3: Pick the BEST signal (highest combined score)
//       const bestScoredSignal = scoredSignals.reduce((best, current) => {
//         const curFinalCon = current.finalConfidence as number;
//         const bestFinalCon = best.finalConfidence as number;
//         return curFinalCon > bestFinalCon ? current : best;
//       });

//       console.log(
//         `   ✅ ${symbol}: Best signal: ${bestScoredSignal.signal?.strategy} (${bestScoredSignal.finalConfidence?.toFixed(0)}%)`
//       );

//       //  const uniqueSignals = this.deduplicateSignals(signals);

//       // if (signals.length === 0) {
//       //   console.log(`   ⚠️  ${symbol}: No signals detected`);
//       //   return null;
//       // }

//       // // Filter by mode
//       // let filteredSignals = signals.filter((s): s is EntrySignal => s !== null);
//       // if (SCAN_CONFIG.tradingMode === 'SPOT') {
//       //   filteredSignals = filteredSignals.filter(s => s?.side === 'LONG');
//       //   console.log(`   📊 ${symbol}: Filtered to ${filteredSignals.length} LONG signals`);
//       // } else if (SCAN_CONFIG.tradingMode === 'FUTURES') {
//       //   console.log(`   📊 ${symbol}: All ${filteredSignals.length} signals (LONG + SHORT)`);
//       // }

//       // Create results

//       const result: ExtendedScanResult = {
//         symbol,
//         signal: bestScoredSignal.signal,
//         confidence: bestScoredSignal.finalConfidence as number,
//         price: indicators.currentPrice,
//         indicators,
//         regime,
//         rsi: indicators.rsi,
//         timestamp: new Date(),
//       };

//       // Conditionally add smc if it exists
//       if (smc) {
//         result.smc = smc;
//       }

//       return result;
//     } catch (err: any) {
//       // console.log(`   ✅ ${symbol}: Returning ${results.length} result(s)\n`);

//       console.error(`   ❌ ${symbol}: Error - ${err.message}`);
//       return null;
//     }
//   }

//   // ============================================================================
//   // ✅ STEP 6: Enhanced scanAll with Summary
//   // ============================================================================

//   async scanAll(): Promise<ScanResult[]> {
//     this.scanCount++;

//     console.log('\n' + '═'.repeat(80));
//     console.log(`🔄 SCAN #${this.scanCount} - Starting...`);
//     console.log('═'.repeat(80));

//     await this.updateAllCandles();

//     const allResults: ScanResult[] = [];
//     let symbolsScanned = 0;
//     let symbolsWithSignals = 0;

//     for (const symbol of SCAN_CONFIG.symbols) {
//       symbolsScanned++;
//       const symbolResults = await this.scanSymbolWithAdvancedScoring(symbol);

//       if (symbolResults) {
//         symbolsWithSignals++;
//         allResults.push(symbolResults);

//         // // Store best signal
//         // const bestSignal = symbolResults.reduce((best, curr) =>
//         //   curr.confidence > best.confidence ? curr : best
//         // );
//         this.scanResults.set(symbol, symbolResults);
//       }
//     }

//     console.log('═'.repeat(80));
//     console.log(`📊 SCAN COMPLETE:`);
//     console.log(`   Symbols Scanned: ${symbolsScanned}`);
//     console.log(`   Symbols with Signals: ${symbolsWithSignals}`);
//     console.log(`   Total Signals: ${allResults.length}`);
//     console.log('═'.repeat(80));

//     allResults.sort((a, b) => b.confidence - a.confidence);

//     // Export signals
//     this.exportSignalsForBothModes(allResults);

//     return allResults;
//   }

//   // Update exportSignalsForBothModes (around line 2043)
//   private exportSignalsForBothModes(results: ExtendedScanResult[]): void {
//     // Filter signals by type
//     const longSignals = results.filter((r) => r.signal?.side === 'LONG');
//     const shortSignals = results.filter((r) => r.signal?.side === 'SHORT');
//     const allSignals = results;

//     // ✅ SPOT OUTPUT: Only LONG signals
//     const spotOutput = longSignals
//       .filter((r) => r.confidence >= 60)
//       .map((r) => this.formatSignalOutput(r));

//     // ✅ FUTURES OUTPUT: Both LONG and SHORT signals
//     const futuresOutput = allSignals
//       .filter((r) => r.confidence >= 60)
//       .map((r) => this.formatSignalOutput(r));

//     const futuresLegacyOutput = allSignals
//       .filter((r) => r.confidence >= 60)
//       .map((r) => this.formatSignalOutput(r));

//     // ✅ ALL OUTPUT: Everything (for general use)
//     const allOutput = allSignals.map((r) => this.formatSignalOutput(r));

//     // Write files
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

//   private deduplicateSignals(signals: EntrySignal[]): EntrySignal[] {
//     const seen = new Map<string, EntrySignal>();

//     for (const signal of signals) {
//       const key = `${signal?.side}_${signal?.strategy}`; // Or use price/confidence
//       const existing = seen.get(key);

//       if (!existing || (signal && signal.confidence > existing.confidence)) {
//         seen.set(key, signal);
//       }
//     }

//     return Array.from(seen.values());
//   }

//   // Update formatSignalOutput to include SMC data (find this method and update it)
//   private formatSignalOutput(result: ExtendedScanResult): any {
//     return {
//       symbol: result.symbol,
//       price: result.price,
//       confidence: result.confidence,
//       signal: result.signal,
//       regime: result.regime,
//       rsi: result.rsi,
//       timestamp: result.timestamp,
//       // ✅ Add SMC data
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
//     };
//   }

//   private writeOutputFile(results: ScanResult[]): void {
//     try {
//       // ✅ Based on mode, filter signals
//       let filteredResults = results;

//       if (SCAN_CONFIG.tradingMode === 'SPOT') {
//         // Only LONG signals
//         filteredResults = results.filter((r) => r.signal?.side === 'LONG');
//       } else if (SCAN_CONFIG.tradingMode === 'FUTURES') {
//         // Both LONG and SHORT
//         filteredResults = results;
//       } else {
//         // BOTH mode - all signals
//         filteredResults = results;
//       }

//       const output = results
//         .filter((r) => r.signal !== null)
//         .map((r) => ({
//           symbol: r.symbol,
//           signal: {
//             strategy: r.signal?.strategy,
//             side: r.signal?.side,
//             reason: r.signal?.reason,
//             stopLoss: r.signal?.stopLoss,
//             takeProfit: r.signal?.takeProfit,
//           },
//           confidence: r.confidence,
//           price: r.price,
//           indicators: {
//             rsi: r.indicators.rsi,
//             ema8: r.indicators.ema8,
//             ema21: r.indicators.ema21,
//             ema50: r.indicators.ema50,
//             ema200: r.indicators.ema200,
//           },
//           regime: r.regime,
//           timestamp: r.timestamp || new Date(),
//         }));

//       fs.writeFileSync(this.outputFile, JSON.stringify(output, null, 2));

//       // Log only if we have signals
//       if (output.length > 0) {
//         log(
//           `📝 Wrote ${output.length} signals to ${this.outputFile}`,
//           'success'
//         );
//       }
//     } catch (err: any) {
//       console.error(`Failed to write output: ${err.message}`);
//     }
//   }

//   //  // ✅ Export signals to JSON file
//   // private exportSignals(results: ScanResult[]): void {
//   //   const signalsWithConfidence = results.filter(r =>
//   //     r.signal !== null && r.confidence >= 60
//   //   );

//   //   const bullish = results.filter(r => r.signal?.side === 'LONG').length;
//   //   const bearish = results.filter(r => r.signal?.side === 'SHORT').length;
//   //   const neutral = results.length - bullish - bearish;

//   //   const exportData: SignalExport = {
//   //     timestamp: new Date(),
//   //     signals: signalsWithConfidence,
//   //     marketSentiment: {
//   //       bullish: (bullish / results.length) * 100,
//   //       bearish: (bearish / results.length) * 100,
//   //       neutral: (neutral / results.length) * 100,
//   //     },
//   //   };

//   //   try {
//   //     fs.writeFileSync(SIGNALS_FILE, JSON.stringify(exportData, null, 2));
//   //   } catch (err: any) {
//   //     console.error(`Failed to export signals: ${err.message}`);
//   //   }
//   // }

//   // ✅ ADD THIS NEW METHOD
//   private async updateAllCandles(): Promise<void> {
//     const updatePromises = SCAN_CONFIG.symbols.map(async (symbol, index) => {
//       const normalizedSymbol = normalize(symbol, this.marketType);

//       try {
//         await this.candleManager.updateCandles(
//           normalizedSymbol,
//           this.marketType
//         );

//         // Small delay to avoid rate limits (stagger requests)
//         await new Promise((resolve) => setTimeout(resolve, index * 100));
//       } catch (err: any) {
//         // Silently continue on error
//       }
//     });

//     // Wait for all updates to complete
//     await Promise.all(updatePromises);

//     // for (const symbol of SCAN_CONFIG.symbols) {
//     //   const normalizedSymbol = normalize(symbol);
//     //   try {
//     //     // Fetch latest candle and append it
//     //     await this.candleManager.updateCandles(normalizedSymbol);
//     //   } catch (err: any) {
//     //     // Silently continue if update fails
//     //     console.error(`Failed to update ${symbol}: ${err.message}`);
//     //   }
//     // }
//   }

//   // ✅ NEW: Clear screen and move cursor to top
//   private clearDisplay(): void {
//     // Clear entire screen
//     process.stdout.write('\x1b[2J');
//     // Move cursor to home position (0,0)
//     process.stdout.write('\x1b[H');
//   }

//   private exportSignals(results: ExtendedScanResult[]): void {
//     const spotSignals = results.filter(
//       (r) =>
//         r.signal !== null && r.signal?.side === 'LONG' && r.confidence >= 60
//     );

//     const futureSignals = results.filter(
//       (r) => r.signal !== null && r.confidence >= 60
//     );

//     const bullish = results.filter((r) => r.signal?.side === 'LONG').length;
//     const bearish = results.filter((r) => r.signal?.side === 'SHORT').length;
//     const neutral = results.length - bullish - bearish;

//     // Simply export all results
//     const exportData = {
//       timestamp: new Date(),
//       results: results, // Export the full results array
//       summary: {
//         total: results.length,
//         bullish,
//         bearish,
//         neutral,
//         bullishPercent:
//           results.length > 0 ? (bullish / results.length) * 100 : 0,
//         bearishPercent:
//           results.length > 0 ? (bearish / results.length) * 100 : 0,
//         neutralPercent:
//           results.length > 0 ? (neutral / results.length) * 100 : 0,
//       },
//       highConfidenceSignals: {
//         spot: spotSignals,
//         futures: futureSignals,
//       },
//     };

//     try {
//       fs.writeFileSync(SIGNALS_FILE, JSON.stringify(exportData, null, 2));
//     } catch (err: any) {
//       console.error(`Failed to export signals: ${err.message}`);
//     }
//   }

//   displayResults(results: ExtendedScanResult[]): void {
//     console.clear();

//     console.log(
//       colorize(
//         '╔═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗',
//         colors.cyan
//       )
//     );
//     console.log(
//       colorize(
//         '║                                                  🚀 CRYPTO TRADING SCANNER WITH SMC 🚀                                                          ║',
//         colors.cyan
//       )
//     );
//     console.log(
//       colorize(
//         '╚═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝',
//         colors.cyan
//       )
//     );
//     console.log();

//     const filteredResults = SCAN_CONFIG.showAllTokens
//       ? results
//       : results.filter((r) => r.confidence >= SCAN_CONFIG.minConfidence);

//     const displayResults = filteredResults
//       .sort((a, b) => b.confidence - a.confidence)
//       .slice(0, SCAN_CONFIG.displayLimit);

//     this.exportSignals(results);

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
//         colorize('Status', colors.bright),
//       ],
//       colWidths: [5, 12, 14, 10, 8, 8, 12, 10, 12, 45],
//       style: {
//         head: [],
//         border: ['gray'],
//       },
//       chars: {
//         top: '═',
//         'top-mid': '╤',
//         'top-left': '╔',
//         'top-right': '╗',
//         bottom: '═',
//         'bottom-mid': '╧',
//         'bottom-left': '╚',
//         'bottom-right': '╝',
//         left: '║',
//         'left-mid': '╟',
//         mid: '─',
//         'mid-mid': '┼',
//         right: '║',
//         'right-mid': '╢',
//         middle: '│',
//       },
//     });

//     displayResults.forEach((result: ExtendedScanResult, i) => {
//       // console.log("🥑 ~ TradingScanner ~ displayResults ~ result:", JSON.stringify(result,null,2))

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
//         `$${result.price.toFixed(getPriceDecimals(result.price))}`,
//         priceColor
//       );

//       let signalText = colorize('─', colors.gray);
//       if (result.signal?.side === 'LONG') {
//         signalText = colorize('🚀 LONG', colors.brightGreen);
//       } else if (result.signal?.side === 'SHORT') {
//         signalText = colorize('📉 SHORT', colors.brightRed);
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

//       let rsiText;
//       if (result.rsi && result.rsi < 30) {
//         rsiText =
//           result.rsi &&
//           colorize(`${result.rsi.toFixed(1)} 🔥`, colors.brightGreen);
//       } else if (result.rsi && result.rsi < 40) {
//         rsiText =
//           result.rsi && colorize(`${result.rsi.toFixed(1)} ↓`, colors.green);
//       } else if (result.rsi && result.rsi > 70) {
//         rsiText =
//           result.rsi &&
//           colorize(`${result.rsi.toFixed(1)} 🌡️`, colors.brightRed);
//       } else if (result.rsi && result.rsi > 60) {
//         rsiText =
//           result.rsi && colorize(`${result.rsi.toFixed(1)} ↑`, colors.red);
//       } else {
//         rsiText =
//           result.rsi && colorize(`${result.rsi.toFixed(1)} ─`, colors.gray);
//       }

//       let trendText = colorize('RANGING 📊', colors.yellow);
//       if (result.regime?.trend === 'UPTREND') {
//         trendText = colorize('UPTREND 📈', colors.green);
//       } else if (result.regime?.trend === 'DOWNTREND') {
//         trendText = colorize('DOWNTREND 📉', colors.red);
//       }

//       // SMC Score
//       let smcText = colorize('─', colors.gray);
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

//       // Premium/Discount Zone
//       let zoneText = colorize('─', colors.gray);
//       if (result.smc) {
//         if (result.smc.premiumDiscount === 'PREMIUM') {
//           zoneText = colorize('PREMIUM 🔴', colors.red);
//         } else if (result.smc.premiumDiscount === 'DISCOUNT') {
//           zoneText = colorize('DISCOUNT 🟢', colors.green);
//         } else {
//           zoneText = colorize('EQUILIBRIUM', colors.yellow);
//         }
//       }

//       let statusText = '';
//       if (result.confidence >= 70) {
//         statusText = colorize('⭐ Strong Signal', colors.brightGreen);
//       } else if (result.confidence >= 60) {
//         statusText = colorize('✓ Good Signal', colors.green);
//       } else if (result.confidence >= 50) {
//         statusText = colorize('⚠ Weak Signal', colors.yellow);
//       } else {
//         statusText = colorize('─ No Signal', colors.gray);
//       }

//       if (result.signal?.reason) {
//         const shortReason = result.signal.reason
//           .split('. ')[0]
//           ?.substring(0, 100);
//         // console.log("🥑 ~ TradingScanner ~ displayResults ~ shortReason:", shortReason, result.signal.reason, typeof result.signal.reason)
//         statusText += colorize(
//           ` | ${result.signal?.reason}`,
//           colors.brightGreen
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
//         statusText,
//       ]);
//     });

//     console.log(table.toString());

//     // Summary
//     console.log(colorize('═'.repeat(147), colors.cyan));

//     const longSignals = results.filter(
//       (r) =>
//         r.signal?.side === 'LONG' && r.confidence >= SCAN_CONFIG.minConfidence
//     ).length;
//     const shortSignals = results.filter(
//       (r) =>
//         r.signal?.side === 'SHORT' && r.confidence >= SCAN_CONFIG.minConfidence
//     ).length;
//     const strongSignals = results.filter((r) => r.confidence >= 70).length;
//     const smcSignals = results.filter((r) => {
//       return (
//         r.signal &&
//         smcStrategies.includes(r.signal.strategy) &&
//         r.confidence >= SCAN_CONFIG.smcMinScore
//       );
//     }).length;
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
//         'Total Tokens Scanned',
//         colorize(results.length.toString(), colors.cyan),
//       ],
//       ['🚀 Long Signals', colorize(longSignals.toString(), colors.brightGreen)],
//       ['📉 Short Signals', colorize(shortSignals.toString(), colors.brightRed)],
//       [
//         '⭐ Strong Signals (70%+)',
//         colorize(strongSignals.toString(), colors.brightYellow),
//       ],
//       [
//         '💎 SMC Signals (40%+)',
//         colorize(smcSignals.toString(), colors.brightMagenta),
//       ],
//       ['📊 Average Confidence', colorize(`${avgConfidence}%`, colors.yellow)],
//       [
//         '💾 Memory Usage',
//         colorize(
//           `${this.candleManager.getMemoryStats().memoryMB}MB`,
//           colors.gray
//         ),
//       ],
//       [
//         '🔄 Next Scan In',
//         colorize(`${SCAN_CONFIG.scanInterval / 1000}s`, colors.cyan),
//       ]
//     );

//     console.log(summaryTable.toString());
//     console.log(colorize('═'.repeat(80), colors.cyan));

//     // Market sentiment
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

//     let sentiment = '⚖️  NEUTRAL';
//     let sentimentColor = colors.yellow;
//     if (results.length > 0 && bullishCount > bearishCount * 1.5) {
//       sentiment = '🟢 BULLISH MARKET';
//       sentimentColor = colors.brightGreen;
//     } else if (results.length > 0 && bearishCount > bullishCount * 1.5) {
//       sentiment = '🔴 BEARISH MARKET';
//       sentimentColor = colors.brightRed;
//     }

//     console.log(
//       colorize(
//         `Market Sentiment: ${sentiment} (${bullishPercent}% Bullish | ${bearishPercent}% Bearish)`,
//         sentimentColor
//       )
//     );
//     console.log(colorize('═'.repeat(80), colors.cyan));
//     console.log(
//       colorize(
//         `SMC Mode: ${SCAN_CONFIG.smcEnabled ? 'ENABLED ✅' : 'DISABLED'} | Mode: ${SCAN_CONFIG.tradingMode}`,
//         colors.brightCyan
//       )
//     );
//     console.log(colorize('═'.repeat(80), colors.cyan));
//     console.log(
//       colorize(
//         'Press Ctrl+C to stop | Scanner running in-place update mode',
//         colors.gray
//       )
//     );
//   }

//   async startContinuousScanning(): Promise<void> {
//     // log('🔄 Starting continuous scanning mode with SMC...', 'info');
//     // log('   Display will update in-place (no scrolling)', 'success');
//     // log('   Press Ctrl+C to stop', 'warning');

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
//     log('✅ Single scan complete', 'success');
//   }

//   destroy(): void {
//     if (this.candleManager) {
//       this.candleManager.destroy();
//       log('🗑️ CandleManager destroyed', 'info');
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

//   console.log(colorize('═'.repeat(80), colors.cyan));
//   console.log(
//     colorize(
//       '🚀 Crypto Trading Scanner with SMC (Smart Money Concepts)',
//       colors.brightCyan
//     )
//   );
//   console.log(
//     colorize(
//       `   Mode: ${SCAN_CONFIG.tradingMode} | SMC: ${SCAN_CONFIG.smcEnabled ? 'ON' : 'OFF'}`,
//       colors.yellow
//     )
//   );
//   console.log(colorize('═'.repeat(80), colors.cyan));

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
//   log('\n👋 Shutting down scanner...', 'warning');
//   if (scanner) {
//     scanner.destroy();
//   }
//   process.exit(0);
// });

// process.on('SIGTERM', () => {
//   log('\n👋 Shutting down scanner...', 'warning');
//   if (scanner) {
//     scanner.destroy();
//   }
//   process.exit(0);
// });

// main();

import fs from 'fs';

import Table from 'cli-table3';
import * as dotenv from 'dotenv';
import { ATR, EMA, RSI } from 'technicalindicators';

import {
  colors,
  getPriceDecimals,
  normalize,
  type MarketType,
} from '../../lib/helpers.js';
import { detectRegime } from '../../lib/trading-utils.js';
import {
  smcStrategies,
  smcStrategy,
  strategyId,
  type BotType,
  type CandleData,
  type EntrySignal,
  type Indicators,
  type LiquidityData,
  type LiquidityMetrics,
  type ScanResult,
  type SymbolContext,
} from '../../lib/type.js';
import { CandleManager, HTFCandleManager } from '../core/candles.js';

dotenv.config();

// ============================================================================
// SMC TYPES
// ============================================================================

interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  index: number;
  strength: number;
  mitigated: boolean;
}

interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  index: number;
  filled: boolean;
}

interface LiquidityLevel {
  type: 'HIGH' | 'LOW';
  price: number;
  strength: number;
  swept: boolean;
}

interface SMCAnalysis {
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  liquidityLevels: LiquidityLevel[];
  bos: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
  choch: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
  premiumDiscount: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  smcScore: number;
}

interface SignalExport {
  timestamp: Date;
  signals: Array<{
    symbol: string;
    side?: 'LONG' | 'SHORT';
    confidence: number;
    price: number;
    reason?: string;
    timestamp: Date;
    smc?: {
      score: number;
      zone: string;
      bos: boolean;
      choch: boolean;
      orderBlocks: number;
      fvgs: number;
    };
  }>;
  marketSentiment: {
    bullish: number;
    bearish: number;
    neutral: number;
  };
}

export interface ExtendedScanResult extends ScanResult {
  smc?: SMCAnalysis;
  marketType?: BotType;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

if (!process.env.ENABLED_FUTURE_SYMBOLS) {
  throw new Error('no symbol token was found!');
}

const SCAN_CONFIG = {
  symbols: process.env.ENABLED_FUTURE_SYMBOLS.split(','),
  scanInterval: 30_000,
  minConfidence: 50,
  timeframe: '15m',
  displayLimit: 200,
  enableContinuousMode: true,
  showAllTokens: true,
  tradingMode: (process.env.TRADING_MODE || 'BOTH') as
    | 'SPOT'
    | 'FUTURES'
    | 'BOTH',
  smcEnabled: true,
  smcMinScore: 40,
  outputFiles: {
    spot: './signals/spot-signals.json',
    futures: './signals/futures-signals.json',
    futuresLegacy: './signals/futures-legacy-signals.json',
    all: './signals/scanner-output.json',
  },
  marketType: 'FUTURES' as MarketType,
  liquidity: {
    enabled: true,
    minSpreadBps: 10,
    maxSpreadBps: 50,
    minDepthMultiplier: 10,
    maxSlippagePct: 0.3,
    minDepth24h: 100_000_000,
  },
};

function colorize(text: string, color: string): string {
  return `${color}${text}${colors.reset}`;
}

function log(
  msg: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info'
) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${icons[type]} ${msg}`);
}

function createSymbolContext(symbol: string): SymbolContext {
  const base = symbol.replace('/USDT', '').replace('USDT', '');
  return {
    display: `${base}/USDT`,
    base,
    futures: normalize(symbol),
  } as SymbolContext;
}

// ============================================================================
// INDICATOR CALCULATION — single definition, used everywhere
// ============================================================================

function calculateIndicators(candles: any): Indicators | null {
  try {
    const closes = candles.closes;
    const highs = candles.highs;
    const lows = candles.lows;

    if (closes.length < 210) return null;

    const ema8 = EMA.calculate({ period: 8, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const atr = ATR.calculate({
      period: 14,
      high: highs,
      low: lows,
      close: closes,
    });

    return {
      ema8: ema8[ema8.length - 1] || 0,
      ema21: ema21[ema21.length - 1] || 0,
      ema50: ema50[ema50.length - 1] || 0,
      ema200: ema200[ema200.length - 1] || 0,
      rsi: rsi[rsi.length - 1] || 50,
      atr: atr[atr.length - 1] || 0,
      currentPrice: closes[closes.length - 1] || 0,
      volume: candles.volumes[candles.volumes.length - 1] || 0,
    };
  } catch (err: any) {
    log(`Error calculating indicators: ${err.message}`, 'error');
    return null;
  }
}

// ============================================================================
// SMC ANALYSIS
// ============================================================================

function detectOrderBlocks(candles: any, lookback: number = 20): OrderBlock[] {
  const orderBlocks: OrderBlock[] = [];
  const { highs, lows, closes, opens } = candles;
  const len = closes.length;

  for (let i = len - lookback; i < len - 3; i++) {
    if (i < 2) continue;

    const currentRange = highs[i] - lows[i];
    const prevRange = highs[i - 1] - lows[i - 1];

    // Bullish OB: last bearish candle before strong up move
    if (
      closes[i] < opens[i] &&
      closes[i + 1] > opens[i + 1] &&
      closes[i + 1] > highs[i] &&
      currentRange > prevRange * 0.5
    ) {
      const strength = ((closes[i + 1] - opens[i + 1]) / currentRange) * 100;
      orderBlocks.push({
        type: 'BULLISH',
        high: highs[i],
        low: lows[i],
        index: i,
        strength: Math.min(100, strength),
        mitigated: closes[len - 1] < lows[i],
      });
    }

    // Bearish OB: last bullish candle before strong down move
    if (
      closes[i] > opens[i] &&
      closes[i + 1] < opens[i + 1] &&
      closes[i + 1] < lows[i] &&
      currentRange > prevRange * 0.5
    ) {
      const strength = ((opens[i + 1] - closes[i + 1]) / currentRange) * 100;
      orderBlocks.push({
        type: 'BEARISH',
        high: highs[i],
        low: lows[i],
        index: i,
        strength: Math.min(100, strength),
        mitigated: closes[len - 1] > highs[i],
      });
    }
  }

  return orderBlocks.slice(-5);
}

function detectFairValueGaps(
  candles: any,
  lookback: number = 30
): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  const { highs, lows, closes } = candles;
  const len = closes.length;

  for (let i = len - lookback; i < len - 2; i++) {
    if (i < 1) continue;

    const bullishGap = lows[i + 2] - highs[i];
    if (bullishGap > 0) {
      const filled = closes[len - 1] >= lows[i + 2];
      fvgs.push({
        type: 'BULLISH',
        top: lows[i + 2],
        bottom: highs[i],
        index: i,
        filled,
      });
    }

    const bearishGap = lows[i] - highs[i + 2];
    if (bearishGap > 0) {
      const filled = closes[len - 1] <= highs[i + 2];
      fvgs.push({
        type: 'BEARISH',
        top: lows[i],
        bottom: highs[i + 2],
        index: i,
        filled,
      });
    }
  }

  return fvgs.filter((f) => !f.filled).slice(-5);
}

function detectLiquidityLevels(
  candles: any,
  lookback: number = 50
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];
  const { highs, lows, closes } = candles;
  const len = closes.length;

  for (let i = len - lookback; i < len - 5; i++) {
    if (i < 5) continue;

    if (
      highs[i] > highs[i - 1] &&
      highs[i] > highs[i - 2] &&
      highs[i] > highs[i + 1] &&
      highs[i] > highs[i + 2]
    ) {
      const swept = highs[len - 1] >= highs[i] || highs[len - 2] >= highs[i];
      const strength =
        ((highs[i] - Math.min(lows[i - 2], lows[i - 1], lows[i])) / highs[i]) *
        100;
      levels.push({
        type: 'HIGH',
        price: highs[i],
        strength: Math.min(100, strength * 10),
        swept,
      });
    }

    if (
      lows[i] < lows[i - 1] &&
      lows[i] < lows[i - 2] &&
      lows[i] < lows[i + 1] &&
      lows[i] < lows[i + 2]
    ) {
      const swept = lows[len - 1] <= lows[i] || lows[len - 2] <= lows[i];
      const strength =
        ((Math.max(highs[i - 2], highs[i - 1], highs[i]) - lows[i]) / lows[i]) *
        100;
      levels.push({
        type: 'LOW',
        price: lows[i],
        strength: Math.min(100, strength * 10),
        swept,
      });
    }
  }

  return levels.slice(-10);
}

function detectBOS(
  candles: any,
  lookback: number = 20
): { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number } {
  const { highs, lows, closes } = candles;
  const len = closes.length;

  let swingHigh = -Infinity;
  let swingLow = Infinity;
  let swingHighIdx = -1;
  let swingLowIdx = -1;

  for (let i = len - lookback; i < len - 3; i++) {
    if (highs[i] > swingHigh) {
      swingHigh = highs[i];
      swingHighIdx = i;
    }
    if (lows[i] < swingLow) {
      swingLow = lows[i];
      swingLowIdx = i;
    }
  }

  if (closes[len - 1] > swingHigh && swingHighIdx > swingLowIdx) {
    return { detected: true, type: 'BULLISH', index: swingHighIdx };
  }
  if (closes[len - 1] < swingLow && swingLowIdx > swingHighIdx) {
    return { detected: true, type: 'BEARISH', index: swingLowIdx };
  }

  return { detected: false };
}

function detectCHoCH(
  candles: any,
  lookback: number = 30
): { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number } {
  const { highs, lows, closes } = candles;
  const len = closes.length;

  const ema20 =
    closes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
  const ema50 =
    closes.slice(-50).reduce((a: number, b: number) => a + b, 0) / 50;
  const isUptrend = ema20 > ema50;

  let recentHigh = -Infinity;
  let recentLow = Infinity;
  let recentHighIdx = -1;
  let recentLowIdx = -1;

  for (let i = len - lookback; i < len - 3; i++) {
    if (highs[i] > recentHigh) {
      recentHigh = highs[i];
      recentHighIdx = i;
    }
    if (lows[i] < recentLow) {
      recentLow = lows[i];
      recentLowIdx = i;
    }
  }

  if (!isUptrend && closes[len - 1] > recentHigh) {
    return { detected: true, type: 'BULLISH', index: recentHighIdx };
  }
  if (isUptrend && closes[len - 1] < recentLow) {
    return { detected: true, type: 'BEARISH', index: recentLowIdx };
  }

  return { detected: false };
}

function calculatePremiumDiscount(
  currentPrice: number,
  highs: number[],
  lows: number[],
  lookback: number = 50
): 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' {
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const highest = Math.max(...recentHighs);
  const lowest = Math.min(...recentLows);
  const range = highest - lowest;
  const upperThreshold = lowest + range * 0.618;
  const lowerThreshold = lowest + range * 0.382;

  if (currentPrice >= upperThreshold) return 'PREMIUM';
  if (currentPrice <= lowerThreshold) return 'DISCOUNT';
  return 'EQUILIBRIUM';
}

function calculateSMCScore(smc: Omit<SMCAnalysis, 'smcScore'>): number {
  let score = 0;
  score += Math.min(
    30,
    smc.orderBlocks.filter((ob) => !ob.mitigated).length * 10
  );
  score += Math.min(20, smc.fvgs.filter((fvg) => !fvg.filled).length * 7);
  score += Math.min(20, smc.liquidityLevels.filter((l) => l.swept).length * 10);
  if (smc.bos.detected) score += 15;
  if (smc.choch.detected) score += 15;
  return Math.min(100, score);
}

function analyzeSMC(candles: any): SMCAnalysis {
  const orderBlocks = detectOrderBlocks(candles);
  const fvgs = detectFairValueGaps(candles);
  const liquidityLevels = detectLiquidityLevels(candles);
  const bos = detectBOS(candles);
  const choch = detectCHoCH(candles);
  const currentPrice = candles.closes[candles.closes.length - 1];
  const premiumDiscount = calculatePremiumDiscount(
    currentPrice,
    candles.highs,
    candles.lows
  );
  const smcData = {
    orderBlocks,
    fvgs,
    liquidityLevels,
    bos,
    choch,
    premiumDiscount,
  };
  return { ...smcData, smcScore: calculateSMCScore(smcData) };
}

// ============================================================================
// SIGNAL DETECTION — 3 clean lanes, no redundancy
//
// Lane 1 (highest priority): SMC setups — OB, FVG, Liquidity Sweep
// Lane 2 (fallback):         Momentum breakout/breakdown
// Lane 3 (fallback):         RSI extreme — only fires when lanes 1+2 are silent
//
// Confidence is set ONCE here. No re-scoring downstream.
// Each signal carries a structural stopLoss from the setup itself.
// ============================================================================

function detectSignal(
  symbol: string,
  indicators: Indicators,
  smc?: SMCAnalysis
): EntrySignal[] {
  const longSignals: EntrySignal[] = [];
  const shortSignals: EntrySignal[] = [];
  const { currentPrice, rsi, ema8, ema21, ema50, ema200 } = indicators;

  // ─────────────────────────────────────────────────────────────
  // LANE 1: SMC signals
  // ─────────────────────────────────────────────────────────────

  if (smc && SCAN_CONFIG.smcEnabled) {
    const bullishOB = smc.orderBlocks.find(
      (ob) => ob.type === 'BULLISH' && !ob.mitigated
    );
    const bearishOB = smc.orderBlocks.find(
      (ob) => ob.type === 'BEARISH' && !ob.mitigated
    );

    // ── SMC LONG ──
    // Priority 1: OB + Discount + BOS/CHoCH (strongest setup)
    if (
      bullishOB &&
      smc.premiumDiscount === 'DISCOUNT' &&
      (smc.bos.type === 'BULLISH' || smc.choch.type === 'BULLISH')
    ) {
      longSignals.push({
        symbol,
        strategy: 'SMC_LONG',
        side: 'LONG',
        reason: `SMC: Bullish OB in discount + ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)}`,
        confidence: Math.min(95, 75 + smc.smcScore * 0.2),
        stopLoss: bullishOB.low * 0.995,
        takeProfit: currentPrice * 1.08,
        timestamp: new Date(),
      });
    }
    // Priority 2: OB + Discount (no BOS yet)
    else if (
      bullishOB &&
      smc.premiumDiscount === 'DISCOUNT' &&
      smc.smcScore >= 40
    ) {
      longSignals.push({
        symbol,
        strategy: 'SMC_LONG',
        side: 'LONG',
        reason: `SMC: Bullish OB in discount zone. Score: ${smc.smcScore.toFixed(0)}`,
        confidence: Math.min(85, 65 + smc.smcScore * 0.2),
        stopLoss: bullishOB.low * 0.995,
        takeProfit: currentPrice * 1.06,
        timestamp: new Date(),
      });
    }
    // Priority 3: BOS/CHoCH alone (no OB required, but score must be high)
    else if (
      (smc.bos.type === 'BULLISH' || smc.choch.type === 'BULLISH') &&
      smc.smcScore >= 50
    ) {
      longSignals.push({
        symbol,
        strategy: 'SMC_LONG',
        side: 'LONG',
        reason: `SMC: Bullish ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)}`,
        confidence: Math.min(80, 60 + smc.smcScore * 0.3),
        stopLoss: currentPrice * 0.97,
        takeProfit: currentPrice * 1.06,
        timestamp: new Date(),
      });
    }

    // FVG fill (LONG)
    const bullishFVG = smc.fvgs.find(
      (fvg) => fvg.type === 'BULLISH' && !fvg.filled
    );
    if (
      bullishFVG &&
      currentPrice >= bullishFVG.bottom &&
      currentPrice <= bullishFVG.top
    ) {
      longSignals.push({
        symbol,
        strategy: 'FVG_FILL',
        side: 'LONG',
        reason: `Price in bullish FVG zone. Expected bounce from ${bullishFVG.bottom.toFixed(2)}`,
        confidence: 72,
        stopLoss: bullishFVG.bottom * 0.995,
        takeProfit: currentPrice * 1.05,
        timestamp: new Date(),
      });
    }

    // Liquidity sweep (LONG)
    const sweptLow = smc.liquidityLevels.find(
      (l) => l.type === 'LOW' && l.swept && l.strength > 60
    );
    if (sweptLow && currentPrice > sweptLow.price * 1.001) {
      longSignals.push({
        symbol,
        strategy: 'LIQUIDITY_SWEEP',
        side: 'LONG',
        reason: `Liquidity swept below ${sweptLow.price.toFixed(2)}. Reversal expected`,
        confidence: 75,
        stopLoss: sweptLow.price * 0.995,
        takeProfit: currentPrice * 1.06,
        timestamp: new Date(),
      });
    }

    // ── SMC SHORT ──
    // Priority 1: OB + Premium + BOS/CHoCH
    if (
      bearishOB &&
      smc.premiumDiscount === 'PREMIUM' &&
      (smc.bos.type === 'BEARISH' || smc.choch.type === 'BEARISH')
    ) {
      shortSignals.push({
        symbol,
        strategy: 'SMC_SHORT',
        side: 'SHORT',
        reason: `SMC: Bearish OB in premium + ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)}`,
        confidence: Math.min(95, 75 + smc.smcScore * 0.2),
        stopLoss: bearishOB.high * 1.005,
        takeProfit: currentPrice * 0.92,
        timestamp: new Date(),
      });
    }
    // Priority 2: OB + Premium
    else if (
      bearishOB &&
      smc.premiumDiscount === 'PREMIUM' &&
      smc.smcScore >= 40
    ) {
      shortSignals.push({
        symbol,
        strategy: 'SMC_SHORT',
        side: 'SHORT',
        reason: `SMC: Bearish OB in premium zone. Score: ${smc.smcScore.toFixed(0)}`,
        confidence: Math.min(85, 65 + smc.smcScore * 0.2),
        stopLoss: bearishOB.high * 1.005,
        takeProfit: currentPrice * 0.94,
        timestamp: new Date(),
      });
    }
    // Priority 3: BOS/CHoCH alone
    else if (
      (smc.bos.type === 'BEARISH' || smc.choch.type === 'BEARISH') &&
      smc.smcScore >= 50
    ) {
      shortSignals.push({
        symbol,
        strategy: 'SMC_SHORT',
        side: 'SHORT',
        reason: `SMC: Bearish ${smc.bos.detected ? 'BOS' : 'CHoCH'}. Score: ${smc.smcScore.toFixed(0)}`,
        confidence: Math.min(80, 60 + smc.smcScore * 0.3),
        stopLoss: currentPrice * 1.03,
        takeProfit: currentPrice * 0.94,
        timestamp: new Date(),
      });
    }

    // FVG fill (SHORT)
    const bearishFVG = smc.fvgs.find(
      (fvg) => fvg.type === 'BEARISH' && !fvg.filled
    );
    if (
      bearishFVG &&
      currentPrice >= bearishFVG.bottom &&
      currentPrice <= bearishFVG.top
    ) {
      shortSignals.push({
        symbol,
        strategy: 'FVG_FILL',
        side: 'SHORT',
        reason: `Price in bearish FVG zone. Expected drop from ${bearishFVG.top.toFixed(2)}`,
        confidence: 72,
        stopLoss: bearishFVG.top * 1.005,
        takeProfit: currentPrice * 0.95,
        timestamp: new Date(),
      });
    }

    // Liquidity sweep (SHORT)
    const sweptHigh = smc.liquidityLevels.find(
      (l) => l.type === 'HIGH' && l.swept && l.strength > 60
    );
    if (sweptHigh && currentPrice < sweptHigh.price * 0.999) {
      shortSignals.push({
        symbol,
        strategy: 'LIQUIDITY_SWEEP',
        side: 'SHORT',
        reason: `Liquidity swept above ${sweptHigh.price.toFixed(2)}. Reversal expected`,
        confidence: 75,
        stopLoss: sweptHigh.price * 1.005,
        takeProfit: currentPrice * 0.94,
        timestamp: new Date(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LANE 2: Momentum breakout/breakdown
  // Only fires when Lane 1 produced no signals — avoids stacking
  // ─────────────────────────────────────────────────────────────

  if (longSignals.length === 0) {
    const breakout = detectBreakout(indicators);
    if (breakout) {
      longSignals.push({
        symbol,
        strategy: 'BREAKOUT',
        side: 'LONG',
        reason: breakout.reason,
        confidence: breakout.confidence,
        stopLoss: (ema21 || currentPrice) * 0.997, // structural: just below EMA21 support
        takeProfit: currentPrice * 1.06,
        timestamp: new Date(),
      });
    }
  }

  if (shortSignals.length === 0) {
    const breakdown = detectBreakdown(indicators);
    if (breakdown) {
      shortSignals.push({
        symbol,
        strategy: 'BREAKDOWN',
        side: 'SHORT',
        reason: breakdown.reason,
        confidence: breakdown.confidence,
        stopLoss: (ema21 || currentPrice) * 1.003, // structural: just above EMA21 resistance
        takeProfit: currentPrice * 0.94,
        timestamp: new Date(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LANE 3: RSI extreme
  // Only fires when Lanes 1+2 are completely silent on that side
  // ─────────────────────────────────────────────────────────────

  if (longSignals.length === 0 && rsi < 30) {
    const zoneOk = !smc || smc.premiumDiscount !== 'PREMIUM';
    if (zoneOk) {
      const base = 55 + (30 - rsi) * 1.5;
      const confidence =
        smc?.premiumDiscount === 'DISCOUNT'
          ? Math.min(75, base + 10)
          : Math.min(65, base);
      longSignals.push({
        symbol,
        strategy: 'RSI_DIVERGENCE',
        side: 'LONG',
        reason: `Oversold RSI ${rsi.toFixed(1)}${smc ? ` in ${smc.premiumDiscount} zone` : ''}`,
        confidence,
        stopLoss: currentPrice * 0.97,
        takeProfit: currentPrice * 1.05,
        timestamp: new Date(),
      });
    }
  }

  if (shortSignals.length === 0 && rsi > 70) {
    const zoneOk = !smc || smc.premiumDiscount !== 'DISCOUNT';
    if (zoneOk) {
      const base = 55 + (rsi - 70) * 1.2;
      const confidence =
        smc?.premiumDiscount === 'PREMIUM'
          ? Math.min(75, base + 10)
          : Math.min(65, base);
      shortSignals.push({
        symbol,
        strategy: 'RSI_DIVERGENCE',
        side: 'SHORT',
        reason: `Overbought RSI ${rsi.toFixed(2)}${smc ? ` in ${smc.premiumDiscount} zone` : ''}`,
        confidence,
        stopLoss: currentPrice * 1.03,
        takeProfit: currentPrice * 0.95,
        timestamp: new Date(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // CONFLICT RESOLUTION
  // Both sides fired → pick clear winner or skip
  // ─────────────────────────────────────────────────────────────

  if (longSignals.length > 0 && shortSignals.length > 0) {
    const bestLong = longSignals.reduce((a, b) =>
      a.confidence > b.confidence ? a : b
    );
    const bestShort = shortSignals.reduce((a, b) =>
      a.confidence > b.confidence ? a : b
    );

    // Clear winner: 15% confidence gap
    if (bestLong.confidence > bestShort.confidence + 15) return [bestLong];
    if (bestShort.confidence > bestLong.confidence + 15) return [bestShort];

    // SMC signal beats non-SMC on same side
    const longIsSMC = smcStrategies.includes(bestLong.strategy);
    const shortIsSMC = smcStrategies.includes(bestShort.strategy);
    if (longIsSMC && !shortIsSMC) return [bestLong];
    if (shortIsSMC && !longIsSMC) return [bestShort];

    // Too ambiguous — skip this token entirely
    return [];
  }

  if (longSignals.length > 0)
    return [
      longSignals.reduce((a, b) => (a.confidence > b.confidence ? a : b)),
    ];
  if (shortSignals.length > 0)
    return [
      shortSignals.reduce((a, b) => (a.confidence > b.confidence ? a : b)),
    ];
  return [];
}

// ============================================================================
// BREAKOUT / BREAKDOWN DETECTORS
// ============================================================================

function detectBreakout(
  indicators: Indicators
): { confidence: number; reason: string } | null {
  const { currentPrice, ema8, ema21, ema50, ema200, rsi } = indicators;

  if (
    ema8 &&
    ema21 &&
    currentPrice > ema21 &&
    ema8 > ema21 &&
    rsi > 45 &&
    rsi < 80
  ) {
    let confidence = 60;
    if (ema21 > ema50) confidence += 5;
    if (currentPrice > ema200) confidence += 5;
    if (rsi > 50 && rsi < 70) confidence += 5;
    if (ema8 > ema50 * 1.01) confidence += 5;
    if (currentPrice > ema21 * 1.02) confidence += 5;
    return {
      confidence: Math.min(85, confidence),
      reason: `Breakout above EMA21 with momentum`,
    };
  }
  return null;
}

function detectBreakdown(
  indicators: Indicators
): { confidence: number; reason: string } | null {
  const { currentPrice, ema8, ema21, ema50, ema200, rsi } = indicators;

  if (
    ema8 &&
    ema21 &&
    currentPrice < ema21 &&
    ema8 < ema21 &&
    rsi < 55 &&
    rsi > 20
  ) {
    let confidence = 60;
    if (ema21 < ema50) confidence += 5;
    if (currentPrice < ema200) confidence += 5;
    if (rsi < 50 && rsi > 30) confidence += 5;
    if (ema8 < ema50 * 0.99) confidence += 5;
    if (currentPrice < ema21 * 0.98) confidence += 5;
    return {
      confidence: Math.min(85, confidence),
      reason: `Breakdown below EMA21 with bearish momentum`,
    };
  }
  return null;
}

// ============================================================================
// LIQUIDITY CHECKER
// ============================================================================

export class SimpleLiquidityChecker {
  private cache = new Map<string, { volume: number; timestamp: number }>();
  private CACHE_TTL = 60000;

  async check24hVolume(symbol: string): Promise<number> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL)
      return cached.volume;

    try {
      const binanceSymbol = symbol.replace('/', '');
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`;
      const response = await fetch(url);
      const data = await response.json();
      const volume = parseFloat(data.quoteVolume || '0');
      this.cache.set(symbol, { volume, timestamp: Date.now() });
      return volume;
    } catch {
      console.error(`Failed to check volume for ${symbol}`);
      return 0;
    }
  }
}

// ============================================================================
// SCANNER CLASS
// ============================================================================

const SIGNALS_FILE = './signals/scanner-output.json';
const SIGNALS_DIR = './signals';

class TradingScanner {
  private candleManager: CandleManager;
  private htfManager: HTFCandleManager;
  private scanResults: Map<string, ScanResult> = new Map();
  private scanCount = 0;
  private successfulInitializations = 0;
  private lastDisplayHeight = 0;
  private marketType: MarketType;
  private signalsDir = './signals';
  private outputFile = './signals/scanner-output.json';

  constructor(marketType: MarketType = SCAN_CONFIG.marketType) {
    this.marketType = marketType;
    this.candleManager = new CandleManager(SCAN_CONFIG.timeframe);
    this.ensureSignalsDir();
    this.htfManager = new HTFCandleManager();
    this.outputFile =
      marketType === 'SPOT'
        ? SCAN_CONFIG.outputFiles.spot
        : SCAN_CONFIG.outputFiles.futures;
  }

  private ensureSignalsDir(): void {
    if (!fs.existsSync(this.signalsDir)) {
      fs.mkdirSync(this.signalsDir, { recursive: true });
      console.log(`✅ Created signals directory: ${this.signalsDir}`);
    }
  }

  async initialize(): Promise<void> {
    log('🚀 Initializing Trading Scanner...', 'info');
    log(
      `   Market Type: ${colorize(this.marketType, colors.brightCyan)}`,
      'info'
    );
    log(`   Symbols: ${SCAN_CONFIG.symbols.length}`, 'info');
    log(`   Output File: ${this.outputFile}`, 'info');
    log(`   Timeframe: ${SCAN_CONFIG.timeframe}`, 'info');
    log(`   Scan Interval: ${SCAN_CONFIG.scanInterval / 1000}s`, 'info');
    log('═'.repeat(60), 'info');

    if (!fs.existsSync(SIGNALS_DIR)) {
      fs.mkdirSync(SIGNALS_DIR, { recursive: true });
      log(`📁 Created directory: ${SIGNALS_DIR}`, 'info');
    }

    let passed = 0;
    let failed = 0;

    for (let i = 0; i < SCAN_CONFIG.symbols.length; i++) {
      const symbol = SCAN_CONFIG.symbols[i];
      if (!symbol) continue;

      const normalizedSymbol = normalize(symbol, this.marketType);
      const success = await this.candleManager.initializeHistoricalCandles(
        normalizedSymbol,
        500,
        0,
        this.marketType
      );

      if (success) {
        passed++;
        this.successfulInitializations++;
      } else {
        failed++;
        log(`❌ ${symbol} failed`, 'error');
      }

      if ((i + 1) % 10 === 0 || i === SCAN_CONFIG.symbols.length - 1) {
        log(
          `📊 Progress: ${i + 1}/${SCAN_CONFIG.symbols.length} | Passed: ${passed} | Failed: ${failed}`,
          'info'
        );
      }

      if (i < SCAN_CONFIG.symbols.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    log('═'.repeat(60), 'info');
    log(
      `✅ Initialization complete: ${passed} passed, ${failed} failed`,
      passed > 0 ? 'success' : 'error'
    );

    if (this.successfulInitializations === 0) {
      log('❌ No symbols initialized! Scanner cannot run.', 'error');
      process.exit(1);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // scanSymbol: single unified scan path
  // Removed: scanSymbol (old liquidity-gated version)
  // Removed: duplicate scoring logic
  // ──────────────────────────────────────────────────────────────
  async scanSymbol(symbol: string): Promise<ExtendedScanResult | null> {
    try {
      const normalizedSpot = normalize(symbol, 'SPOT');
      const normalizedFutures = normalize(symbol, 'FUTURES');

      const candlesSpot = this.candleManager.getCandles(
        normalizedSpot,
        'SPOT'
      ) as CandleData;
      const candlesFutures = this.candleManager.getCandles(
        normalizedFutures,
        'FUTURES'
      ) as CandleData;

      const spotValid = candlesSpot && candlesSpot.closes.length >= 210;
      const futuresValid =
        candlesFutures && candlesFutures.closes.length >= 210;

      let candles: CandleData;
      let marketType: BotType;

      if (futuresValid) {
        candles = candlesFutures;
        marketType = 'FUTURES';
      } else if (spotValid) {
        candles = candlesSpot;
        marketType = 'SPOT';
      } else {
        return null;
      }

      const indicators = calculateIndicators(candles);
      if (!indicators) {
        log(`❌ ${symbol}: Failed to calculate indicators`, 'error');
        return null;
      }

      const regime = detectRegime(indicators, candles);
      const smc = SCAN_CONFIG.smcEnabled ? analyzeSMC(candles) : undefined;

      // detectSignal now returns at most 1 signal (best winner already resolved)
      const signals = detectSignal(symbol, indicators, smc);

      if (signals.length === 0) return null;

      // Filter by trading mode
      const validSignals = signals.filter((signal) => {
        if (SCAN_CONFIG.tradingMode === 'SPOT' && signal?.side !== 'LONG')
          return false;
        if (smc && signal?.strategy && smcStrategy.includes(signal.strategy)) {
          if (smc.smcScore < SCAN_CONFIG.smcMinScore) return false;
        }
        return true;
      });

      if (validSignals.length === 0) return null;

      // detectSignal already picked the best — just take index 0
      const best = validSignals[0]!;

      console.log(
        `   ✅ ${symbol} (${marketType}): ${best.strategy} ${best.side} (${best.confidence.toFixed(0)}%)`
      );

      const result: ExtendedScanResult = {
        symbol,
        signal: best,
        confidence: best.confidence,
        price: indicators.currentPrice,
        indicators,
        regime,
        rsi: indicators.rsi,
        timestamp: new Date(),
        marketType: marketType as BotType,
      };

      if (smc) result.smc = smc;
      return result;
    } catch (err: any) {
      console.error(`❌ Error scanning ${symbol}:`, err.message);
      return null;
    }
  }

  async scanAll(): Promise<ScanResult[]> {
    this.scanCount++;
    console.log('\n' + '═'.repeat(80));
    console.log(`🔄 SCAN #${this.scanCount} - Starting...`);
    console.log('═'.repeat(80));

    await this.updateAllCandles();

    const allResults: ScanResult[] = [];
    let symbolsScanned = 0;
    let symbolsWithSignals = 0;

    for (const symbol of SCAN_CONFIG.symbols) {
      symbolsScanned++;
      const result = await this.scanSymbol(symbol);

      if (result) {
        symbolsWithSignals++;
        allResults.push(result);
        this.scanResults.set(symbol, result);
      }
    }

    console.log('═'.repeat(80));
    console.log(
      `📊 SCAN COMPLETE: ${symbolsScanned} scanned, ${symbolsWithSignals} with signals`
    );
    console.log('═'.repeat(80));

    allResults.sort((a, b) => b.confidence - a.confidence);
    this.exportSignalsForBothModes(allResults);
    return allResults;
  }

  private exportSignalsForBothModes(results: ExtendedScanResult[]): void {
    const longSignals = results.filter((r) => r.signal?.side === 'LONG');
    const allSignals = results;

    const spotOutput = longSignals
      .filter((r) => r.confidence >= 60)
      .map((r) => this.formatSignalOutput(r));

    const futuresOutput = allSignals
      .filter((r) => r.confidence >= 60)
      .map((r) => this.formatSignalOutput(r));

    fs.writeFileSync(
      SCAN_CONFIG.outputFiles.spot,
      JSON.stringify(spotOutput, null, 2)
    );
    fs.writeFileSync(
      SCAN_CONFIG.outputFiles.futures,
      JSON.stringify(futuresOutput, null, 2)
    );
    fs.writeFileSync(
      SCAN_CONFIG.outputFiles.futuresLegacy,
      JSON.stringify(futuresOutput, null, 2)
    );
    fs.writeFileSync(
      SCAN_CONFIG.outputFiles.all,
      JSON.stringify(
        allSignals.map((r) => this.formatSignalOutput(r)),
        null,
        2
      )
    );
  }

  // ──────────────────────────────────────────────────────────────
  // formatSignalOutput — now includes atr + structuralStopLoss
  // so the launcher can skip its candle re-fetch
  // ──────────────────────────────────────────────────────────────
  private formatSignalOutput(result: ExtendedScanResult): any {
    return {
      symbol: result.symbol,
      price: result.price,
      confidence: result.confidence,
      signal: {
        strategy: result.signal?.strategy,
        side: result.signal?.side,
        reason: result.signal?.reason,
        // structural SL from the setup — launcher should use this as primary
        stopLoss: result.signal?.stopLoss,
        takeProfit: result.signal?.takeProfit,
      },
      // key values so launcher can skip its own candle fetch for entry validation
      atr: result.indicators?.atr,
      regime: result.regime,
      rsi: result.rsi,
      timestamp: result.timestamp,
      smc: result.smc
        ? {
            score: result.smc.smcScore,
            zone: result.smc.premiumDiscount,
            bos: result.smc.bos.detected ? result.smc.bos.type : null,
            choch: result.smc.choch.detected ? result.smc.choch.type : null,
            orderBlocks: result.smc.orderBlocks.length,
            activeOrderBlocks: result.smc.orderBlocks.filter(
              (ob) => !ob.mitigated
            ).length,
            fvgs: result.smc.fvgs.length,
            activeFvgs: result.smc.fvgs.filter((fvg) => !fvg.filled).length,
            liquidityLevels: result.smc.liquidityLevels.length,
            sweptLiquidity: result.smc.liquidityLevels.filter((l) => l.swept)
              .length,
          }
        : undefined,
    };
  }

  private async updateAllCandles(): Promise<void> {
    const updatePromises = SCAN_CONFIG.symbols.map(async (symbol, index) => {
      const normalizedSymbol = normalize(symbol, this.marketType);
      try {
        await this.candleManager.updateCandles(
          normalizedSymbol,
          this.marketType
        );
        await new Promise((resolve) => setTimeout(resolve, index * 100));
      } catch {
        // silently continue
      }
    });

    await Promise.all(updatePromises);
  }

  private clearDisplay(): void {
    process.stdout.write('\x1b[2J');
    process.stdout.write('\x1b[H');
  }

  displayResults(results: ExtendedScanResult[]): void {
    console.clear();

    console.log(colorize('╔' + '═'.repeat(145) + '╗', colors.cyan));
    console.log(
      colorize(
        '║' +
          '  🚀 CRYPTO TRADING SCANNER WITH SMC 🚀'.padStart(90).padEnd(145) +
          '║',
        colors.cyan
      )
    );
    console.log(colorize('╚' + '═'.repeat(145) + '╝', colors.cyan));
    console.log();

    const filteredResults = SCAN_CONFIG.showAllTokens
      ? results
      : results.filter((r) => r.confidence >= SCAN_CONFIG.minConfidence);

    const displayResults = filteredResults
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, SCAN_CONFIG.displayLimit);

    this.exportSignals(results);

    const table = new Table({
      head: [
        colorize('#', colors.bright),
        colorize('Symbol', colors.bright),
        colorize('Price', colors.bright),
        colorize('Signal', colors.bright),
        colorize('Conf%', colors.bright),
        colorize('RSI', colors.bright),
        colorize('Trend', colors.bright),
        colorize('SMC', colors.bright),
        colorize('Zone', colors.bright),
        colorize('Status', colors.bright),
      ],
      colWidths: [5, 12, 14, 10, 8, 8, 12, 10, 12, 45],
      style: { head: [], border: ['gray'] },
      chars: {
        top: '═',
        'top-mid': '╤',
        'top-left': '╔',
        'top-right': '╗',
        bottom: '═',
        'bottom-mid': '╧',
        'bottom-left': '╚',
        'bottom-right': '╝',
        left: '║',
        'left-mid': '╟',
        mid: '─',
        'mid-mid': '┼',
        right: '║',
        'right-mid': '╢',
        middle: '│',
      },
    });

    displayResults.forEach((result: ExtendedScanResult, i) => {
      const rowNumber = colorize(
        (i + 1).toString().padStart(2, ' '),
        colors.gray
      );
      const symbolColor =
        result.confidence >= SCAN_CONFIG.minConfidence
          ? colors.brightCyan
          : colors.gray;
      const symbolText = colorize(result.symbol, symbolColor);

      const priceColor =
        result.signal?.side === 'LONG'
          ? colors.brightGreen
          : result.signal?.side === 'SHORT'
            ? colors.brightRed
            : colors.yellow;
      const priceText = colorize(
        `$${result.price.toFixed(getPriceDecimals(result.price))}`,
        priceColor
      );

      let signalText = colorize('─', colors.gray);
      if (result.signal?.side === 'LONG')
        signalText = colorize('🚀 LONG', colors.brightGreen);
      else if (result.signal?.side === 'SHORT')
        signalText = colorize('📉 SHORT', colors.brightRed);

      const confColor =
        result.confidence >= 80
          ? colors.brightGreen
          : result.confidence >= 70
            ? colors.green
            : result.confidence >= 60
              ? colors.yellow
              : colors.gray;
      const confText = colorize(`${result.confidence.toFixed(0)}%`, confColor);

      let rsiText: string;
      if (result.rsi && result.rsi < 30)
        rsiText = colorize(`${result.rsi.toFixed(1)} 🔥`, colors.brightGreen);
      else if (result.rsi && result.rsi < 40)
        rsiText = colorize(`${result.rsi.toFixed(1)} ↓`, colors.green);
      else if (result.rsi && result.rsi > 70)
        rsiText = colorize(`${result.rsi.toFixed(1)} 🌡️`, colors.brightRed);
      else if (result.rsi && result.rsi > 60)
        rsiText = colorize(`${result.rsi.toFixed(1)} ↑`, colors.red);
      else
        rsiText = colorize(`${result.rsi?.toFixed(1) ?? '─'} ─`, colors.gray);

      let trendText = colorize('RANGING 📊', colors.yellow);
      if (result.regime?.trend === 'UPTREND')
        trendText = colorize('UPTREND 📈', colors.green);
      else if (result.regime?.trend === 'DOWNTREND')
        trendText = colorize('DOWNTREND 📉', colors.red);

      let smcText = colorize('─', colors.gray);
      if (result.smc) {
        const smcColor =
          result.smc.smcScore >= 70
            ? colors.brightGreen
            : result.smc.smcScore >= 50
              ? colors.yellow
              : colors.gray;
        smcText = colorize(`${result.smc.smcScore.toFixed(0)}`, smcColor);
        if (result.smc.bos.detected)
          smcText += colorize(' BOS', colors.brightMagenta);
        if (result.smc.choch.detected)
          smcText += colorize(' CHoCH', colors.brightYellow);
      }

      let zoneText = colorize('─', colors.gray);
      if (result.smc) {
        if (result.smc.premiumDiscount === 'PREMIUM')
          zoneText = colorize('PREMIUM 🔴', colors.red);
        else if (result.smc.premiumDiscount === 'DISCOUNT')
          zoneText = colorize('DISCOUNT 🟢', colors.green);
        else zoneText = colorize('EQUILIBRIUM', colors.yellow);
      }

      let statusText = '';
      if (result.confidence >= 70)
        statusText = colorize('⭐ Strong Signal', colors.brightGreen);
      else if (result.confidence >= 60)
        statusText = colorize('✓ Good Signal', colors.green);
      else if (result.confidence >= 50)
        statusText = colorize('⚠ Weak Signal', colors.yellow);
      else statusText = colorize('─ No Signal', colors.gray);

      if (result.signal?.reason) {
        statusText += colorize(
          ` | ${result.signal.reason.split('. ')[0]?.substring(0, 100)}`,
          colors.brightGreen
        );
      }

      table.push([
        rowNumber,
        symbolText,
        priceText,
        signalText,
        confText,
        rsiText,
        trendText,
        smcText,
        zoneText,
        statusText,
      ]);
    });

    console.log(table.toString());
    console.log(colorize('═'.repeat(147), colors.cyan));

    const longSignals = results.filter(
      (r) =>
        r.signal?.side === 'LONG' && r.confidence >= SCAN_CONFIG.minConfidence
    ).length;
    const shortSignals = results.filter(
      (r) =>
        r.signal?.side === 'SHORT' && r.confidence >= SCAN_CONFIG.minConfidence
    ).length;
    const strongSignals = results.filter((r) => r.confidence >= 70).length;
    const smcSignals = results.filter(
      (r) =>
        r.signal &&
        smcStrategies.includes(r.signal.strategy) &&
        r.confidence >= SCAN_CONFIG.smcMinScore
    ).length;
    const avgConfidence =
      results.length > 0
        ? (
            results.reduce((sum, r) => sum + r.confidence, 0) / results.length
          ).toFixed(1)
        : '0';

    const summaryTable = new Table({
      head: [
        colorize('Metric', colors.bright),
        colorize('Value', colors.bright),
      ],
      style: { head: [], border: ['gray'] },
    });

    summaryTable.push(
      [
        'Total Tokens Scanned',
        colorize(results.length.toString(), colors.cyan),
      ],
      ['🚀 Long Signals', colorize(longSignals.toString(), colors.brightGreen)],
      ['📉 Short Signals', colorize(shortSignals.toString(), colors.brightRed)],
      [
        '⭐ Strong Signals (70%+)',
        colorize(strongSignals.toString(), colors.brightYellow),
      ],
      [
        '💎 SMC Signals (40%+)',
        colorize(smcSignals.toString(), colors.brightMagenta),
      ],
      ['📊 Average Confidence', colorize(`${avgConfidence}%`, colors.yellow)],
      [
        '💾 Memory Usage',
        colorize(
          `${this.candleManager.getMemoryStats().memoryMB}MB`,
          colors.gray
        ),
      ],
      [
        '🔄 Next Scan In',
        colorize(`${SCAN_CONFIG.scanInterval / 1000}s`, colors.cyan),
      ]
    );

    console.log(summaryTable.toString());

    const bullishCount = results.filter(
      (r) => r.signal?.side === 'LONG'
    ).length;
    const bearishCount = results.filter(
      (r) => r.signal?.side === 'SHORT'
    ).length;
    const bullishPercent =
      results.length > 0
        ? ((bullishCount / results.length) * 100).toFixed(0)
        : '0';
    const bearishPercent =
      results.length > 0
        ? ((bearishCount / results.length) * 100).toFixed(0)
        : '0';

    let sentiment = '⚖️  NEUTRAL';
    let sentimentColor = colors.yellow;
    if (results.length > 0 && bullishCount > bearishCount * 1.5) {
      sentiment = '🟢 BULLISH MARKET';
      sentimentColor = colors.brightGreen;
    } else if (results.length > 0 && bearishCount > bullishCount * 1.5) {
      sentiment = '🔴 BEARISH MARKET';
      sentimentColor = colors.brightRed;
    }

    console.log(
      colorize(
        `Market Sentiment: ${sentiment} (${bullishPercent}% Bullish | ${bearishPercent}% Bearish)`,
        sentimentColor
      )
    );
    console.log(colorize('═'.repeat(80), colors.cyan));
    console.log(
      colorize(
        `SMC Mode: ${SCAN_CONFIG.smcEnabled ? 'ENABLED ✅' : 'DISABLED'} | Mode: ${SCAN_CONFIG.tradingMode}`,
        colors.brightCyan
      )
    );
    console.log(colorize('═'.repeat(80), colors.cyan));
    console.log(
      colorize(
        'Press Ctrl+C to stop | Scanner running in-place update mode',
        colors.gray
      )
    );
  }

  private exportSignals(results: ExtendedScanResult[]): void {
    const spotSignals = results.filter(
      (r) =>
        r.signal !== null && r.signal?.side === 'LONG' && r.confidence >= 60
    );
    const futureSignals = results.filter(
      (r) => r.signal !== null && r.confidence >= 60
    );

    const bullish = results.filter((r) => r.signal?.side === 'LONG').length;
    const bearish = results.filter((r) => r.signal?.side === 'SHORT').length;
    const neutral = results.length - bullish - bearish;

    const exportData = {
      timestamp: new Date(),
      results,
      summary: {
        total: results.length,
        bullish,
        bearish,
        neutral,
        bullishPercent:
          results.length > 0 ? (bullish / results.length) * 100 : 0,
        bearishPercent:
          results.length > 0 ? (bearish / results.length) * 100 : 0,
        neutralPercent:
          results.length > 0 ? (neutral / results.length) * 100 : 0,
      },
      highConfidenceSignals: { spot: spotSignals, futures: futureSignals },
    };

    try {
      fs.writeFileSync(SIGNALS_FILE, JSON.stringify(exportData, null, 2));
    } catch (err: any) {
      console.error(`Failed to export signals: ${err.message}`);
    }
  }

  async startContinuousScanning(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const results = await this.scanAll();
    this.displayResults(results);

    setInterval(async () => {
      const results = await this.scanAll();
      this.displayResults(results);
    }, SCAN_CONFIG.scanInterval);
  }

  async runSingleScan(): Promise<void> {
    const results = await this.scanAll();
    this.displayResults(results);
    log('✅ Single scan complete', 'success');
  }

  destroy(): void {
    if (this.candleManager) {
      this.candleManager.destroy();
      log('🗑️ CandleManager destroyed', 'info');
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

let scanner: TradingScanner | null = null;

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith('--mode='));

  if (modeArg) {
    const mode = modeArg.split('=')[1]?.toUpperCase();
    if (mode === 'SPOT' || mode === 'FUTURES' || mode === 'BOTH') {
      SCAN_CONFIG.tradingMode = mode as 'SPOT' | 'FUTURES' | 'BOTH';
    }
  }

  console.log(colorize('═'.repeat(80), colors.cyan));
  console.log(
    colorize(
      '🚀 Crypto Trading Scanner with SMC (Smart Money Concepts)',
      colors.brightCyan
    )
  );
  console.log(
    colorize(
      `   Mode: ${SCAN_CONFIG.tradingMode} | SMC: ${SCAN_CONFIG.smcEnabled ? 'ON' : 'OFF'}`,
      colors.yellow
    )
  );
  console.log(colorize('═'.repeat(80), colors.cyan));

  try {
    scanner = new TradingScanner();
    await scanner.initialize();

    if (SCAN_CONFIG.enableContinuousMode) {
      await scanner.startContinuousScanning();
    } else {
      await scanner.runSingleScan();
      process.exit(0);
    }
  } catch (err: any) {
    log(`Fatal error: ${err.message}`, 'error');
    console.error(err.stack);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  log('\n👋 Shutting down scanner...', 'warning');
  if (scanner) scanner.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('\n👋 Shutting down scanner...', 'warning');
  if (scanner) scanner.destroy();
  process.exit(0);
});

main();
