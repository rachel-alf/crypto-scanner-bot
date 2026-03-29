import type { CandleData, EntrySignal, EntryType } from '../../lib/type.js';

interface SimplePeakValleySignal {
  detected: boolean;
  type: 'DOUBLE_TOP' | 'DOUBLE_BOTTOM';
  side: EntryType;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reason: string;
}

interface Peak {
  index: number;
  price: number;
}

// export function detectYourSimpleMethod(
//   candles: CandleData
// ): SimplePeakValleySignal | null {
//   const highs = candles.highs;
//   const lows = candles.lows;
//   const opens = candles.opens;
//   const closes = candles.closes;
//   const len = closes.length;

//   if (len < 15) return null;

//   // ═══════════════════════════════════════════════════════
//   // PART 1: DOUBLE TOP (SHORT) - Your exact description
//   // ═══════════════════════════════════════════════════════

//   const peaks: Array<{ index: number; price: number }> = [];

//   for (let i = 3; i < len - 3; i++) {
//     const highI = highs[i] as number;

//     const highIM1 = highs[i - 1] as number;
//     const highIP1 = highs[i + 1] as number;
//     const highIM2 = highs[i - 2] as number;
//     const highIP2 = highs[i + 2] as number;
//     const isPeak =
//       highI >= highIM1 &&
//       highI >= highIM2 &&
//       highI >= highIP1 &&
//       highI >= highIP2;

//     if (isPeak) {
//       peaks.push({ index: i, price: highs[i] as number });
//     }
//   }

//   if (peaks.length >= 2) {
//     const peak1 = peaks[peaks.length - 2] as Peak;
//     const peak2 = peaks[peaks.length - 1] as Peak;

//     // Count RED candles after 2nd peak (YOUR rule!)
//     let redCandles = 0;
//     for (let i = peak2.index + 1; i < len; i++) {
//       if (closes[i] < opens[i]) {
//         // Red candle
//         redCandles++;
//       }
//     }

//     // Need at least 2 red candles (YOUR confirmation)
//     if (redCandles >= 2) {
//       const currentPrice = closes[len - 1];

//       // YOUR RULE: "Entry at 2% below 2nd peak"
//       const entryAt2Percent = peak2.price * 0.98;
//       const entryPrice = Math.min(currentPrice, entryAt2Percent);

//       // YOUR RULE: "SL 1% above 2nd peak"
//       const stopLoss = peak2.price * 1.01;

//       // Take profit (1:2 risk/reward)
//       const risk = stopLoss - entryPrice;
//       const takeProfit = entryPrice - risk * 2;

//       let confidence = 60;
//       if (redCandles >= 3) confidence += 10;
//       if (peak2.price < peak1.price) confidence += 15; // Lower high

//       return {
//         detected: true,
//         type: 'DOUBLE_TOP',
//         side: 'SHORT',
//         entryPrice,
//         stopLoss,
//         takeProfit,
//         confidence,
//         reason: `Double top with ${redCandles} red candles`,
//       };
//     }
//   }

//   // ═══════════════════════════════════════════════════════
//   // PART 2: DOUBLE BOTTOM (LONG) - "2 alleys" as you said
//   // ═══════════════════════════════════════════════════════

//   const valleys: Array<{ index: number; price: number }> = [];

//   for (let i = 3; i < len - 3; i++) {
//     const isValley =
//       lows[i] <= lows[i - 1] &&
//       lows[i] <= lows[i - 2] &&
//       lows[i] <= lows[i + 1] &&
//       lows[i] <= lows[i + 2];

//     if (isValley) {
//       valleys.push({ index: i, price: lows[i] });
//     }
//   }

//   if (valleys.length >= 2) {
//     const valley1 = valleys[valleys.length - 2];
//     const valley2 = valleys[valleys.length - 1];

//     // Count GREEN candles after 2nd valley (YOUR rule!)
//     let greenCandles = 0;
//     for (let i = valley2.index + 1; i < len; i++) {
//       if (closes[i] > opens[i]) {
//         // Green candle
//         greenCandles++;
//       }
//     }

//     // Need at least 2 green candles (YOUR confirmation)
//     if (greenCandles >= 2) {
//       const currentPrice = closes[len - 1];

//       // YOUR RULE: "Entry at 2% above 2nd valley"
//       const entryAt2Percent = valley2.price * 1.02;
//       const entryPrice = Math.max(currentPrice, entryAt2Percent);

//       // YOUR RULE: "SL 1% below 2nd valley"
//       const stopLoss = valley2.price * 0.99;

//       // Take profit (1:2 risk/reward)
//       const risk = entryPrice - stopLoss;
//       const takeProfit = entryPrice + risk * 2;

//       let confidence = 60;
//       if (greenCandles >= 3) confidence += 10;
//       if (valley2.price > valley1.price) confidence += 15; // Higher low

//       return {
//         detected: true,
//         type: 'DOUBLE_BOTTOM',
//         side: 'LONG',
//         entryPrice,
//         stopLoss,
//         takeProfit,
//         confidence,
//         reason: `Double bottom with ${greenCandles} green candles`,
//       };
//     }
//   }

//   return null;
// }

export function detectDoublePatternImproved(
  candles: CandleData
): SimplePeakValleySignal | null {
  const { highs, lows, closes, opens } = candles;
  const len = closes.length;

  if (len < 30) return null; // Need more data for reliable pattern

  // Configuration for 15m timeframe
  const config = {
    // Peak distance (candles)
    minPeakDistance: 5,
    maxPeakDistance: 16,

    // Price similarity
    maxPriceDifference: 0.005, // 0.5%

    // Retracement requirements
    minRetracement: 0.4, // 40%
    maxRetracement: 0.85, // 85%

    // Confirmation candles
    minConfirmationCandles: 2,
    confirmationType: 'color', // 'color' or 'close_below'
  };

  // ═══════════════════════════════════════════════════════
  // 1. DOUBLE TOP DETECTION (SHORT)
  // ═══════════════════════════════════════════════════════

  // Find recent peaks within constraints
  const recentPeaks: Array<{ index: number; price: number }> = [];

  for (let i = 10; i < len - 5; i++) {
    // Get all values with type safety
    const highI = highs[i];
    const highIM1 = highs[i - 1];
    const highIM2 = highs[i - 2];
    const highIP1 = highs[i + 1];
    const highIP2 = highs[i + 2];

    // Check if all values exist
    if (
      highI !== undefined &&
      highIM1 !== undefined &&
      highIM2 !== undefined &&
      highIP1 !== undefined &&
      highIP2 !== undefined
    ) {
      // Now TypeScript knows these are numbers
      if (
        highI >= highIM1 &&
        highI >= highIM2 &&
        highI >= highIP1 &&
        highI >= highIP2
      ) {
        // Only add if not too close to previous peak
        const lastPeak = recentPeaks[recentPeaks.length - 1];
        if (!lastPeak || i - lastPeak.index >= config.minPeakDistance) {
          recentPeaks.push({ index: i, price: highI });
        }
      }
    }
  }

  // Check for double top
  if (recentPeaks.length >= 2) {
    const peak2 = recentPeaks[recentPeaks.length - 1];
    const peak1 = recentPeaks[recentPeaks.length - 2];

    if (!peak1 || !peak2) return null; // Safety check

    // 1. Check distance between peaks
    const peakDistance = peak2.index - peak1.index;
    if (
      peakDistance < config.minPeakDistance ||
      peakDistance > config.maxPeakDistance
    ) {
      // Not a valid double top
    } else {
      // 2. Check price similarity
      const priceDiff = Math.abs(peak2.price - peak1.price) / peak1.price;
      if (priceDiff <= config.maxPriceDifference) {
        // 3. Find trough between peaks (neckline level)
        let troughPrice = Infinity;
        let troughIdx = -1;
        for (let i = peak1.index + 1; i < peak2.index; i++) {
          const low = lows[i];
          if (low !== undefined && low < troughPrice) {
            troughPrice = low;
            troughIdx = i;
          }
        }

        // Check if we found a valid trough
        if (troughIdx === -1) return null;

        // 4. Check retracement
        const retracement =
          (peak1.price - troughPrice) / (peak1.price - peak2.price);
        if (
          retracement >= config.minRetracement &&
          retracement <= config.maxRetracement
        ) {
          // 5. Check for neckline break confirmation
          let confirmationCandles = 0;
          let necklineBroken = false;
          const necklineLevel = troughPrice;

          for (let i = peak2.index + 1; i < len; i++) {
            const close = closes[i];
            const open = opens[i];

            if (close === undefined || open === undefined) continue;

            // Check if price closed below neckline
            if (close < necklineLevel) {
              necklineBroken = true;
            }

            // Count red candles after peak2
            if (close < open) {
              confirmationCandles++;
            }

            // Stop checking if we have enough data
            if (i > peak2.index + 10) break;
          }

          // 6. Entry logic
          if (
            necklineBroken &&
            confirmationCandles >= config.minConfirmationCandles
          ) {
            const currentPrice = closes[len - 1];
            if (currentPrice === undefined) return null;

            const neckline = troughPrice;

            // Entry: 0.5% below neckline for safety
            const entryPrice = neckline * 0.995;

            // Only enter if price is near entry
            if (
              currentPrice <= entryPrice * 1.02 &&
              currentPrice >= entryPrice * 0.98
            ) {
              // Stop loss: above the higher peak
              const stopLoss = Math.max(peak1.price, peak2.price) * 1.01;

              // Take profit: measured move (peak to neckline distance)
              const patternHeight = peak2.price - neckline;
              const takeProfit = entryPrice - patternHeight;

              // Risk/Reward check
              const risk = stopLoss - entryPrice;
              const reward = entryPrice - takeProfit;
              const rrRatio = reward / risk;

              if (rrRatio >= 1.5) {
                // Minimum 1.5:1 RR
                let confidence = 60;

                // Confidence factors
                if (confirmationCandles >= 3) confidence += 10;
                if (peak2.price < peak1.price) confidence += 10; // Lower high
                if (rrRatio >= 2) confidence += 10;

                return {
                  detected: true,
                  type: 'DOUBLE_TOP',
                  side: 'SHORT',
                  entryPrice,
                  stopLoss,
                  takeProfit,
                  confidence,
                  reason: `Double top confirmed with ${confirmationCandles} red candles, RR: ${rrRatio.toFixed(2)}:1`,
                };
              }
            }
          }
        }
      }
    }
  }
  // ═══════════════════════════════════════════════════════
  // 2. DOUBLE BOTTOM DETECTION (LONG)
  // ═══════════════════════════════════════════════════════

  // Similar logic for double bottom (inverse of above)
  const recentValleys: Array<{ index: number; price: number }> = [];

  for (let i = 10; i < len - 5; i++) {
    // Check if all values exist before using 'as number'
    const lowI = lows[i];
    const lowIM1 = lows[i - 1];
    const lowIM2 = lows[i - 2];
    const lowIP1 = lows[i + 1];
    const lowIP2 = lows[i + 2];

    if (
      lowI !== undefined &&
      lowIM1 !== undefined &&
      lowIM2 !== undefined &&
      lowIP1 !== undefined &&
      lowIP2 !== undefined
    ) {
      if (
        lowI <= lowIM1 &&
        lowI <= lowIM2 &&
        lowI <= lowIP1 &&
        lowI <= lowIP2
      ) {
        const lastValley = recentValleys[recentValleys.length - 1];
        if (!lastValley || i - lastValley.index >= config.minPeakDistance) {
          recentValleys.push({ index: i, price: lowI });
        }
      }
    }
  }

  if (recentValleys.length >= 2) {
    const valley2 = recentValleys[recentValleys.length - 1];
    const valley1 = recentValleys[recentValleys.length - 2];

    if (!valley1 || !valley2) return null;

    const valleyDistance = valley2.index - valley1.index;
    if (
      valleyDistance >= config.minPeakDistance &&
      valleyDistance <= config.maxPeakDistance
    ) {
      const priceDiff = Math.abs(valley2.price - valley1.price) / valley1.price;
      if (priceDiff <= config.maxPriceDifference) {
        // Find peak between valleys
        let peakPrice = -Infinity;
        let peakIdx = -1;
        for (let i = valley1.index + 1; i < valley2.index; i++) {
          const high = highs[i];
          if (high !== undefined && high > peakPrice) {
            peakPrice = high;
            peakIdx = i;
          }
        }

        if (peakIdx === -1) return null;

        const retracement =
          (peakPrice - valley1.price) / (valley2.price - valley1.price);
        if (
          retracement >= config.minRetracement &&
          retracement <= config.maxRetracement
        ) {
          let confirmationCandles = 0;
          let necklineBroken = false;
          const necklineLevel = peakPrice;

          for (let i = valley2.index + 1; i < len; i++) {
            const close = closes[i];
            const open = opens[i];

            if (close === undefined || open === undefined) continue;

            if (close > necklineLevel) {
              necklineBroken = true;
            }

            if (close > open) {
              confirmationCandles++;
            }

            if (i > valley2.index + 10) break;
          }

          if (
            necklineBroken &&
            confirmationCandles >= config.minConfirmationCandles
          ) {
            const currentPrice = closes[len - 1];
            if (currentPrice === undefined) return null;

            const entryPrice = necklineLevel * 1.005; // 0.5% above neckline

            if (
              currentPrice >= entryPrice * 0.98 &&
              currentPrice <= entryPrice * 1.02
            ) {
              const stopLoss = Math.min(valley1.price, valley2.price) * 0.99;
              const patternHeight = necklineLevel - valley2.price;
              const takeProfit = entryPrice + patternHeight;

              const risk = entryPrice - stopLoss;
              const reward = takeProfit - entryPrice;
              const rrRatio = reward / risk;

              if (rrRatio >= 1.5) {
                let confidence = 60;
                if (confirmationCandles >= 3) confidence += 10;
                if (valley2.price > valley1.price) confidence += 10; // Higher low
                if (rrRatio >= 2) confidence += 10;

                return {
                  detected: true,
                  type: 'DOUBLE_BOTTOM',
                  side: 'LONG',
                  entryPrice,
                  stopLoss,
                  takeProfit,
                  confidence,
                  reason: `Double bottom confirmed with ${confirmationCandles} green candles, RR: ${rrRatio.toFixed(2)}:1`,
                };
              }
            }
          }
        }
      }
    }
  }
  return null;
}
// export async function executeStealthTrade(signal: EntrySignal): Promise<void> {
//   // 1. Check radar first
//   if (radar.getTradingMode() === 'HIDDEN') {
//     console.log('Fisherman active! Hiding in coral...');
//     return;
//   }

//   // 2. Generate stealth values
//   const stealth = generateStealthNumbers(signal.entryPrice, signal.side);

//   // 3. Calculate position size with weird percentage
//   const riskPercent = 0.83 + Math.random() * 0.34; // 0.83-1.17%
//   const positionSize = calculatePositionSize(
//     accountBalance,
//     Math.abs(stealth.entry - stealth.stopLoss),
//     riskPercent
//   );

//   // 4. Place orders with weird decimals
//   const entryOrder = await exchange.placeOrder({
//     symbol: signal.symbol,
//     side: signal.side === 'LONG' ? 'buy' : 'sell',
//     type: 'limit',
//     price: roundToWeirdDecimal(stealth.entry),
//     amount: roundToWeirdAmount(positionSize), // 0.873 not 0.87 or 0.88
//   });

//   // 5. Set stop loss with offset
//   const stopOrder = await exchange.placeOrder({
//     symbol: signal.symbol,
//     side: signal.side === 'LONG' ? 'sell' : 'buy',
//     type: 'stop_market',
//     stopPrice: roundToWeirdDecimal(stealth.stopLoss),
//     amount: roundToWeirdAmount(positionSize),
//   });

//   // 6. Take profit with weird ratio
//   const tpPrice =
//     signal.side === 'LONG'
//       ? stealth.entry + (stealth.entry - stealth.stopLoss) * stealth.rrRatio
//       : stealth.entry - (stealth.stopLoss - stealth.entry) * stealth.rrRatio;

//   const tpOrder = await exchange.placeOrder({
//     symbol: signal.symbol,
//     side: signal.side === 'LONG' ? 'sell' : 'buy',
//     type: 'limit',
//     price: roundToWeirdDecimal(tpPrice),
//     amount: roundToWeirdAmount(positionSize),
//   });

//   // 7. Log with radar signature
//   console.log(`Stealth trade executed. Radar evasion: ${stealth.weirdOffset}`);
// }
