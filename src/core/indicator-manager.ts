import { ATR, BollingerBands, EMA, MACD, RSI } from 'technicalindicators';
import type { MACDOutput } from 'technicalindicators/declarations/moving_averages/MACD.js';

import type { Indicators } from '../../lib/type.js';

/**
 * Candle data structure
 */
export interface CandleData {
  timestamps: number[];
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
}

/**
 * Calculated indicators
 */
// export interface Indicators {
//   rsi: number;
//   rsi14: number;
//   ema9: number;
//   ema21: number;
//   ema50: number;
//   ema100: number;
//   ema200: number;
//   macd: number;
//   macdSignal: number;
//   macdHistogram: number;
//   bb_upper: number;
//   bb_middle: number;
//   bb_lower: number;
//   bb_width: number;
//   atr: number;
//   atr_14: number;
//   volume: number;
//   volumeMA: number;
//   price: number;
//   currentPrice: number;
//   trend?: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
//   volatility?: 'HIGH' | 'MEDIUM' | 'LOW';
// }

/**
 * IndicatorManager
 *
 * Manages calculation and caching of technical indicators
 * Used by regime detection and trading strategy systems
 */

export class IndicatorManager {
  private indicatorCache: Map<
    string,
    { indicators: Indicators; timestamp: number }
  > = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute cache

  /**
   * Get or calculate indicators for a symbol
   */
  public getIndicators(
    symbol: string,
    candles?: CandleData
  ): Indicators | null {
    // Check cache first
    const cached = this.indicatorCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.indicators;
    }

    // If no candles provided, return cached (even if stale) or null
    if (!candles) {
      return cached?.indicators || null;
    }

    // Calculate fresh indicators
    try {
      const indicators = this.calculateIndicators(candles);

      // Cache the result
      this.indicatorCache.set(symbol, {
        indicators,
        timestamp: Date.now(),
      });

      return indicators;
    } catch (error: any) {
      console.error(
        `❌ Failed to calculate indicators for ${symbol}:`,
        error.message
      );
      return cached?.indicators || null;
    }
  }

  /**
   * Calculate all indicators from candle data
   */
  private calculateIndicators(candles: CandleData): Indicators {
    const { closes, highs, lows, volumes } = candles;

    if (closes.length < 200) {
      throw new Error('Insufficient candle data (need at least 200 candles)');
    }

    // RSI
    const rsi14 = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsi14[rsi14.length - 1] || 50;

    // EMAs
    const ema9Array = EMA.calculate({ values: closes, period: 9 });
    const ema21Array = EMA.calculate({ values: closes, period: 21 });
    const ema50Array = EMA.calculate({ values: closes, period: 50 });
    const ema100Array = EMA.calculate({ values: closes, period: 100 });
    const ema200Array = EMA.calculate({ values: closes, period: 200 });

    const ema9 =
      ema9Array[ema9Array.length - 1] || (closes[closes.length - 1] as number);
    const ema21 =
      ema21Array[ema21Array.length - 1] ||
      (closes[closes.length - 1] as number);
    const ema50 =
      ema50Array[ema50Array.length - 1] ||
      (closes[closes.length - 1] as number);
    const ema100 =
      ema100Array[ema100Array.length - 1] ||
      (closes[closes.length - 1] as number);
    const ema200 =
      ema200Array[ema200Array.length - 1] ||
      (closes[closes.length - 1] as number);

    // MACD
    const macdArray = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    const latestMacd = macdArray[macdArray.length - 1];
    const macd = latestMacd?.MACD || 0;
    const macdSignal = latestMacd?.signal || 0;
    const macdHistogram = latestMacd?.histogram || 0;

    // Bollinger Bands
    const bbArray = BollingerBands.calculate({
      values: closes,
      period: 20,
      stdDev: 2,
    });

    const latestBB = bbArray[bbArray.length - 1];
    const bb_upper = latestBB?.upper || (closes[closes.length - 1] as number);
    const bb_middle = latestBB?.middle || (closes[closes.length - 1] as number);
    const bb_lower = latestBB?.lower || (closes[closes.length - 1] as number);
    const bb_width = bb_upper - bb_lower;

    // ATR
    const atrArray = ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14,
    });

    const atr = atrArray[atrArray.length - 1] || 0;

    // Volume
    const volume = volumes[volumes.length - 1] || 0;
    const volumeMA = volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20;

    // Current price
    const price = closes[closes.length - 1] as number;

    // Trend determination
    const trend = this.determineTrend(ema9, ema21, ema50, ema200);

    // Volatility determination
    const volatility = this.determineVolatility(atr, price, bb_width);

    return {
      rsi,
      rsi14: rsi,
      ema9: ema9,
      ema21: ema21,
      ema50: ema50,
      ema100: ema100,
      ema200: ema200,
      macd,
      macdSignal,
      macdHistogram,
      bb_upper,
      bb_middle,
      bb_lower,
      bb_width,
      atr,
      atr_14: atr,
      volume,
      volumeMA,
      price,
      currentPrice: price,
      trend,
      volatility,
    };
  }

  /**
   * Determine trend based on EMA alignment
   */
  private determineTrend(
    ema9: number,
    ema21: number,
    ema50: number,
    ema200: number
  ): 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' {
    // Strong uptrend: EMAs aligned bullishly
    if (ema9 > ema21 && ema21 > ema50 && ema50 > ema200) {
      return 'UPTREND';
    }

    // Strong downtrend: EMAs aligned bearishly
    if (ema9 < ema21 && ema21 < ema50 && ema50 < ema200) {
      return 'DOWNTREND';
    }

    // Mixed or ranging
    return 'SIDEWAYS';
  }

  /**
   * Determine volatility based on ATR and BB width
   */
  private determineVolatility(
    atr: number,
    price: number,
    bb_width: number
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    const atrPercent = (atr / price) * 100;
    const bbWidthPercent = (bb_width / price) * 100;

    // High volatility
    if (atrPercent > 3 || bbWidthPercent > 8) {
      return 'HIGH';
    }

    // Low volatility
    if (atrPercent < 1 || bbWidthPercent < 3) {
      return 'LOW';
    }

    // Medium volatility
    return 'MEDIUM';
  }

  /**
   * Clear cached indicators for a symbol
   */
  public clearCache(symbol: string): void {
    this.indicatorCache.delete(symbol);
  }

  /**
   * Clear all cached indicators
   */
  public clearAllCache(): void {
    this.indicatorCache.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; symbols: string[] } {
    return {
      size: this.indicatorCache.size,
      symbols: Array.from(this.indicatorCache.keys()),
    };
  }
}

/**
 * Standalone function to calculate indicators from candles
 * Useful for one-off calculations without caching
 */
export function calculateIndicators(candles: CandleData): Indicators {
  const manager = new IndicatorManager();
  const indicators = manager.getIndicators('temp', candles);

  if (!indicators) {
    throw new Error('Failed to calculate indicators');
  }

  return indicators;
}
