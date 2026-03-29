import type { CandleData, EntryType, PeakValleyValue } from '../../lib/type.js';
import { CandleManager } from './candles.js';

export interface DoubleTopBottomSignal {
  symbol: string;
  side: EntryType;
  strategy: 'DOUBLE_TOP' | 'DOUBLE_BOTTOM';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  firstPeakIndex: number;
  secondPeakIndex: number;
  firstPeakPrice: number;
  secondPeakPrice: number;
  confirmationCandle: number; // Index of red/green confirmation candle
  detectedAt: Date;
}

export class DoubleTopBottomDetector {
  private candleManager: CandleManager;

  // Configuration
  private readonly MIN_PEAK_DISTANCE = 5; // Minimum candles between peaks
  private readonly MAX_PEAK_DISTANCE = 50; // Maximum candles between peaks
  private readonly PEAK_TOLERANCE = 0.02; // 2% - peaks must be within this range
  private readonly MIN_PEAK_HEIGHT = 0.01; // 1% - peak must be at least 1% above/below neighbors
  private readonly CONFIRMATION_CANDLES = 1; // How many red/green candles needed after 2nd peak

  constructor(candleManager: CandleManager) {
    this.candleManager = candleManager;
  }

  /**
   * Scan for Double Top/Bottom patterns across all symbols
   */
  async scanAllSymbols(symbols: string[]): Promise<DoubleTopBottomSignal[]> {
    const signals: DoubleTopBottomSignal[] = [];

    for (const symbol of symbols) {
      const candles = this.candleManager.getCandles(symbol);
      if (!candles || candles.closes.length < 100) continue;

      // Check for Double Top (SHORT signal)
      const doubleTop = this.detectDoubleTop(symbol, candles);
      if (doubleTop) signals.push(doubleTop);

      // Check for Double Bottom (LONG signal)
      const doubleBottom = this.detectDoubleBottom(symbol, candles);
      if (doubleBottom) signals.push(doubleBottom);
    }

    return signals;
  }

  /**
   * 📉 DOUBLE TOP DETECTION (SHORT SIGNAL)
   *
   * Pattern:
   *     Peak1    Peak2
   *       /\      /\
   *      /  \    /  \↓ (red candle)
   *     /    \  /
   *    /      \/
   *
   * Rules:
   * 1. Find 2 consecutive peaks (local highs)
   * 2. Peaks must be similar height (within 2%)
   * 3. Second peak followed by red candle(s)
   * 4. Entry: 2% below current price
   * 5. Stop Loss: 1% above second peak
   */
  private detectDoubleTop(
    symbol: string,
    candles: CandleData
  ): DoubleTopBottomSignal | null {
    const len = candles.closes.length;
    if (len < 100) return null;

    // Find peaks (local highs)
    const peaks = this.findPeaks(candles);
    if (peaks.length < 2) return null;

    // Check the last two peaks
    for (let i = peaks.length - 2; i >= Math.max(0, peaks.length - 10); i--) {
      const firstPeak = peaks[i] as PeakValleyValue;
      const secondPeak = peaks[i + 1] as PeakValleyValue;

      // Check distance between peaks
      const distance = secondPeak.index - firstPeak.index;
      if (
        distance < this.MIN_PEAK_DISTANCE ||
        distance > this.MAX_PEAK_DISTANCE
      ) {
        continue;
      }

      // Check if peaks are similar height (within tolerance)
      const priceDiff =
        Math.abs(secondPeak.price - firstPeak.price) / firstPeak.price;
      if (priceDiff > this.PEAK_TOLERANCE) continue;

      // ✅ CHECK CONFIRMATION: Red candle(s) after second peak
      const confirmationIdx = secondPeak.index + 1;
      if (confirmationIdx >= len) continue;

      let redCandles = 0;
      for (
        let j = 0;
        j < this.CONFIRMATION_CANDLES && confirmationIdx + j < len;
        j++
      ) {
        const idx = confirmationIdx + j;
        const isRed = candles.closes[idx]! < candles.opens![idx]!;
        if (isRed) redCandles++;
      }

      if (redCandles < this.CONFIRMATION_CANDLES) continue;

      // ✅ PATTERN CONFIRMED!
      const currentPrice = candles.closes[len - 1]!;
      const entryPrice = currentPrice * 0.98; // Enter 2% below current
      const stopLoss = secondPeak.price * 1.01; // SL 1% above second peak
      const takeProfit = currentPrice * 0.94; // TP 4% below current (2:1 R:R)

      // Calculate confidence based on:
      // - How close the peaks are in price (closer = higher confidence)
      // - Volume at second peak
      // - Number of confirmation candles
      const peakSimilarity = 1 - priceDiff / this.PEAK_TOLERANCE;
      const volumeScore = this.calculateVolumeScore(candles, secondPeak.index);
      const confidence = Math.min(
        95,
        60 + peakSimilarity * 20 + volumeScore * 15
      );

      return {
        symbol,
        side: 'SHORT',
        strategy: 'DOUBLE_TOP',
        entryPrice,
        stopLoss,
        takeProfit,
        confidence,
        firstPeakIndex: firstPeak.index,
        secondPeakIndex: secondPeak.index,
        firstPeakPrice: firstPeak.price,
        secondPeakPrice: secondPeak.price,
        confirmationCandle: confirmationIdx,
        detectedAt: new Date(),
      };
    }

    return null;
  }

  /**
   * 📈 DOUBLE BOTTOM DETECTION (LONG SIGNAL)
   *
   * Pattern:
   *    /      \/
   *   /    \  /    \
   *  /  \    /  \  ↑ (green candle)
   *     \  /    \/
   *    Valley1  Valley2
   *
   * Rules:
   * 1. Find 2 consecutive valleys (local lows)
   * 2. Valleys must be similar depth (within 2%)
   * 3. Second valley followed by green candle(s)
   * 4. Entry: 2% above current price
   * 5. Stop Loss: 1% below second valley
   */
  private detectDoubleBottom(
    symbol: string,
    candles: CandleData
  ): DoubleTopBottomSignal | null {
    const len = candles.closes.length;
    if (len < 100) return null;

    // Find valleys (local lows)
    const valleys = this.findValleys(candles);
    if (valleys.length < 2) return null;

    // Check the last two valleys
    for (
      let i = valleys.length - 2;
      i >= Math.max(0, valleys.length - 10);
      i--
    ) {
      const firstValley = valleys[i] as PeakValleyValue;
      const secondValley = valleys[i + 1] as PeakValleyValue;

      // Check distance between valleys
      const distance = secondValley.index - firstValley.index;
      if (
        distance < this.MIN_PEAK_DISTANCE ||
        distance > this.MAX_PEAK_DISTANCE
      ) {
        continue;
      }

      // Check if valleys are similar depth (within tolerance)
      const priceDiff =
        Math.abs(secondValley.price - firstValley.price) / firstValley.price;
      if (priceDiff > this.PEAK_TOLERANCE) continue;

      // ✅ CHECK CONFIRMATION: Green candle(s) after second valley
      const confirmationIdx = secondValley.index + 1;
      if (confirmationIdx >= len) continue;

      let greenCandles = 0;
      for (
        let j = 0;
        j < this.CONFIRMATION_CANDLES && confirmationIdx + j < len;
        j++
      ) {
        const idx = confirmationIdx + j;
        const isGreen = candles.closes[idx]! > candles.opens![idx]!;
        if (isGreen) greenCandles++;
      }

      if (greenCandles < this.CONFIRMATION_CANDLES) continue;

      // ✅ PATTERN CONFIRMED!
      const currentPrice = candles.closes[len - 1]!;
      const entryPrice = currentPrice * 1.02; // Enter 2% above current
      const stopLoss = secondValley.price * 0.99; // SL 1% below second valley
      const takeProfit = currentPrice * 1.06; // TP 4% above current (2:1 R:R)

      // Calculate confidence
      const valleySimilarity = 1 - priceDiff / this.PEAK_TOLERANCE;
      const volumeScore = this.calculateVolumeScore(
        candles,
        secondValley.index
      );
      const confidence = Math.min(
        95,
        60 + valleySimilarity * 20 + volumeScore * 15
      );

      return {
        symbol,
        side: 'LONG',
        strategy: 'DOUBLE_BOTTOM',
        entryPrice,
        stopLoss,
        takeProfit,
        confidence,
        firstPeakIndex: firstValley.index,
        secondPeakIndex: secondValley.index,
        firstPeakPrice: firstValley.price,
        secondPeakPrice: secondValley.price,
        confirmationCandle: confirmationIdx,
        detectedAt: new Date(),
      };
    }

    return null;
  }

  /**
   * Find local peaks (highs) in candle data
   */
  private findPeaks(
    candles: CandleData
  ): Array<{ index: number; price: number }> {
    const peaks: Array<{ index: number; price: number }> = [];
    const len = candles.highs.length;
    const lookback = 5; // Look 5 candles left and right

    for (let i = lookback; i < len - lookback; i++) {
      const currentHigh = candles.highs[i]!;
      let isPeak = true;

      // Check if current high is higher than surrounding candles
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles.highs[j]! >= currentHigh) {
          isPeak = false;
          break;
        }
      }

      if (isPeak) {
        // Verify peak is significant (at least 1% above neighbors)
        const leftAvg =
          candles.highs.slice(i - lookback, i).reduce((a, b) => a + b, 0) /
          lookback;
        const rightAvg =
          candles.highs
            .slice(i + 1, i + lookback + 1)
            .reduce((a, b) => a + b, 0) / lookback;
        const avgNeighbor = (leftAvg + rightAvg) / 2;

        if ((currentHigh - avgNeighbor) / avgNeighbor >= this.MIN_PEAK_HEIGHT) {
          peaks.push({ index: i, price: currentHigh });
        }
      }
    }

    return peaks;
  }

  /**
   * Find local valleys (lows) in candle data
   */
  private findValleys(
    candles: CandleData
  ): Array<{ index: number; price: number }> {
    const valleys: Array<{ index: number; price: number }> = [];
    const len = candles.lows.length;
    const lookback = 5;

    for (let i = lookback; i < len - lookback; i++) {
      const currentLow = candles.lows[i]!;
      let isValley = true;

      // Check if current low is lower than surrounding candles
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles.lows[j]! <= currentLow) {
          isValley = false;
          break;
        }
      }

      if (isValley) {
        // Verify valley is significant
        const leftAvg =
          candles.lows.slice(i - lookback, i).reduce((a, b) => a + b, 0) /
          lookback;
        const rightAvg =
          candles.lows
            .slice(i + 1, i + lookback + 1)
            .reduce((a, b) => a + b, 0) / lookback;
        const avgNeighbor = (leftAvg + rightAvg) / 2;

        if ((avgNeighbor - currentLow) / avgNeighbor >= this.MIN_PEAK_HEIGHT) {
          valleys.push({ index: i, price: currentLow });
        }
      }
    }

    return valleys;
  }

  /**
   * Calculate volume score for confidence
   */
  private calculateVolumeScore(candles: CandleData, index: number): number {
    if (index < 20 || index >= candles.volumes.length) return 0;

    const currentVolume = candles.volumes[index]!;
    const avgVolume =
      candles.volumes.slice(index - 20, index).reduce((a, b) => a + b, 0) / 20;

    // Score based on how much higher current volume is than average
    const volumeRatio = currentVolume / avgVolume;

    if (volumeRatio >= 1.5) return 1.0; // 50% above average = max score
    if (volumeRatio >= 1.2) return 0.7; // 20% above average = good
    if (volumeRatio >= 1.0) return 0.5; // Average = neutral
    return 0.2; // Below average = low score
  }

  /**
   * Export signal in scanner format
   */
  exportSignal(signal: DoubleTopBottomSignal): any {
    return {
      symbol: signal.symbol,
      side: signal.side,
      strategy: signal.strategy,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      confidence: signal.confidence,
      timestamp: signal.detectedAt.toISOString(),
      metadata: {
        firstPeak: {
          index: signal.firstPeakIndex,
          price: signal.firstPeakPrice,
        },
        secondPeak: {
          index: signal.secondPeakIndex,
          price: signal.secondPeakPrice,
        },
        confirmationCandle: signal.confirmationCandle,
      },
    };
  }

  /**
   * Validate signal is still valid (not stale)
   */
  isSignalValid(
    signal: DoubleTopBottomSignal,
    maxAgeMinutes: number = 15
  ): boolean {
    const ageMs = Date.now() - signal.detectedAt.getTime();
    return ageMs < maxAgeMinutes * 60 * 1000;
  }
}

// ✅ EXAMPLE USAGE:
/*
import { CandleManager } from './candles.js';
import { DoubleTopBottomDetector } from './doubleTopBottom.js';

const candleManager = new CandleManager('15m');
const detector = new DoubleTopBottomDetector(candleManager);

// Initialize candles for symbols
await candleManager.initializeHistoricalCandles('BTCUSDT', 500);
await candleManager.initializeHistoricalCandles('ETHUSDT', 500);

// Scan for patterns
const signals = await detector.scanAllSymbols(['BTCUSDT', 'ETHUSDT']);

for (const signal of signals) {
  console.log(`📊 ${signal.strategy} on ${signal.symbol}`);
  console.log(`   Side: ${signal.side}`);
  console.log(`   Entry: $${signal.entryPrice.toFixed(2)}`);
  console.log(`   SL: $${signal.stopLoss.toFixed(2)}`);
  console.log(`   TP: $${signal.takeProfit.toFixed(2)}`);
  console.log(`   Confidence: ${signal.confidence.toFixed(1)}%`);
  console.log(`   Peaks: $${signal.firstPeakPrice.toFixed(2)} → $${signal.secondPeakPrice.toFixed(2)}`);
}
*/
