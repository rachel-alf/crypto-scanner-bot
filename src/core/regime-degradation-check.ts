// ============================================================================
// UNIVERSAL REGIME DEGRADATION CHECK
// Add this to your position monitor loop — runs for EVERY position
// ============================================================================

import type { BotInstance, Position, Regime } from '../../lib/type.js';

/**
 * Check if market regime has degraded since entry.
 * Returns FORCE_EXIT if conditions changed enough to invalidate the trade.
 * This runs for ALL positions, regardless of trailing enabled or not.
 */
export function checkRegimeDegradation(params: {
  position: Position;
  currentRegime: Regime;
  hoursInTrade: number;
}): { shouldExit: boolean; reason: string } {
  const { position, currentRegime, hoursInTrade } = params;

  // If position doesn't have entry regime stored, can't check degradation
  if (!position.entryRegime) {
    return { shouldExit: false, reason: '' };
  }

  const entryQ = position.entryRegime.marketQuality;
  const nowQ = currentRegime.marketQuality;
  const entryV = position.entryRegime.volatility;
  const nowV = currentRegime.volatility;

  // ─────────────────────────────────────────────────────────────
  // RULE 1: Volatility spiked to EXTREME → always exit
  // Market is too chaotic, anything can happen
  // ─────────────────────────────────────────────────────────────
  if (nowV === 'EXTREME' && entryV !== 'EXTREME') {
    return {
      shouldExit: true,
      reason: `Volatility spiked to EXTREME (was ${entryV} at entry)`,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // RULE 2: Market quality dropped to LOW → always exit
  // Original trend/structure thesis is dead
  // ─────────────────────────────────────────────────────────────
  if (nowQ === 'LOW' && entryQ !== 'LOW') {
    return {
      shouldExit: true,
      reason: `Market quality dropped to LOW (was ${entryQ} at entry)`,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // RULE 3: Quality dropped AND position isn't running
  // If quality dropped from HIGH→MEDIUM but we're already +2R, let it run
  // But if we're breakeven or losing after quality drop, cut it
  // ─────────────────────────────────────────────────────────────
  if (entryQ === 'HIGH' && nowQ === 'MEDIUM') {
    const riskDist = Math.abs(position.entryPrice - position.stopLoss);
    const rawPnl =
      position.side === 'LONG'
        ? position.currentPrice - position.entryPrice
        : position.entryPrice - position.currentPrice;
    const currentR = rawPnl / riskDist;

    // If we're not at least +1R yet, quality drop means exit
    if (currentR < 1.0) {
      return {
        shouldExit: true,
        reason: `Quality dropped HIGH→MEDIUM while only at ${currentR.toFixed(2)}R`,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RULE 4: Time decay — been in trade too long without progress
  // Your 3-hour rule: if trade isn't working after 3 hours, cut it
  // ─────────────────────────────────────────────────────────────
  const MAX_HOURS = 3;
  const MIN_PROFIT_PCT = 0.5; // 0.5% of margin

  if (hoursInTrade > MAX_HOURS) {
    const posMarginUsed = position.marginUsed as number;
    const profitPct = (position.pnlUsd / posMarginUsed) * 100;

    if (profitPct < 0) {
      return {
        shouldExit: true,
        reason: `${hoursInTrade.toFixed(1)}h elapsed, still negative (${profitPct.toFixed(2)}%)`,
      };
    }

    if (profitPct < MIN_PROFIT_PCT) {
      return {
        shouldExit: true,
        reason: `${hoursInTrade.toFixed(1)}h elapsed, minimal progress (${profitPct.toFixed(2)}%)`,
      };
    }

    // If it's running well (>0.5% profit), let it continue
    // but this is where trailing would tighten if enabled
  }

  // ─────────────────────────────────────────────────────────────
  // RULE 5: Trend reversal (optional, can be aggressive)
  // If we entered on UPTREND and it flipped to DOWNTREND, exit
  // ─────────────────────────────────────────────────────────────
  const entryTrend = position.entryRegime.trend;
  const nowTrend = currentRegime.trend;

  if (
    (entryTrend === 'STRONG_UP' || entryTrend === 'UP') &&
    (nowTrend === 'STRONG_DOWN' || nowTrend === 'DOWN')
  ) {
    return {
      shouldExit: true,
      reason: `Trend reversed from ${entryTrend} to ${nowTrend}`,
    };
  }

  if (
    (entryTrend === 'STRONG_DOWN' || entryTrend === 'DOWN') &&
    (nowTrend === 'STRONG_UP' || nowTrend === 'UP')
  ) {
    return {
      shouldExit: true,
      reason: `Trend reversed from ${entryTrend} to ${nowTrend}`,
    };
  }

  // No degradation detected
  return { shouldExit: false, reason: '' };
}

// ============================================================================
// HOW TO USE IN YOUR MONITOR LOOP
// ============================================================================

// Inside your position update function that runs every candle:

// async function updatePosition(bot: BotInstance, currentPrice: number) {
//   const position = bot.position;
//   if (!position) return;

//   // Recalculate regime
//   const candles = this.candleManager.getCandles(bot.symbol, 'FUTURES');
//   const indicators = this.indicatorManager.getIndicators(bot.symbol, candles);
//   const currentRegime = detectRegime(indicators, candles);

//   // Calculate time in trade
//   const hoursInTrade =
//     (Date.now() - position.entryTime.getTime()) / (1000 * 60 * 60);

//   // ──────────────────────────────────────────────────────────────
//   // CHECK 1: REGIME DEGRADATION (runs for ALL positions)
//   // ──────────────────────────────────────────────────────────────
//   const degradation = checkRegimeDegradation({
//     position,
//     currentRegime,
//     hoursInTrade,
//   });

//   if (degradation.shouldExit) {
//     console.log(`🚨 REGIME EXIT [${position.symbol}]: ${degradation.reason}`);

//     // Execute market close
//     if (!CONFIG.paperTrading) {
//       await this.binance.createMarketOrder(
//         position.symbol,
//         position.side === 'LONG' ? 'SELL' : 'BUY',
//         position.remainingAmount
//       );
//     }

//     // Clean up
//     releaseCapital(position.marginUsed, position.pnlUsd);
//     bot.position = null;
//     bot.status = 'idle';

//     return; // Exit early, position closed
//   }

//   // ──────────────────────────────────────────────────────────────
//   // CHECK 2: VIRTUAL SL (if trailing enabled)
//   // This is your existing SL check from earlier
//   // ──────────────────────────────────────────────────────────────
//   const slPrice = position.trailing?.currentTrailingStop ?? position.stopLoss;
//   const side = position.side;

//   let stopLossHit = false;
//   if (side === 'LONG' && currentPrice <= slPrice) {
//     stopLossHit = true;
//   }
//   if (side === 'SHORT' && currentPrice >= slPrice) {
//     stopLossHit = true;
//   }

//   if (stopLossHit) {
//     console.log(`🚨 STOP LOSS HIT [${position.symbol}]`);
//     // ... your existing SL execution code ...
//     return;
//   }

//   // ──────────────────────────────────────────────────────────────
//   // CHECK 3: UPDATE TRAILING (if enabled)
//   // This is your existing trailing update logic
//   // ──────────────────────────────────────────────────────────────
//   if (position.trailing?.profile.eligible) {
//     const result = updateTrailingStop({
//       position,
//       currentPrice,
//       currentATR,
//       candles,
//       currentRegime: {
//         marketQuality: currentRegime.marketQuality,
//         volatility: currentRegime.volatility,
//       },
//     });

//     if (result.action === 'UPDATE_SL') {
//       position.stopLoss = result.newSL;
//       position.trailing.currentTrailingStop = result.newSL;
//     }

//     if (result.action === 'FORCE_EXIT') {
//       // ... execute exit ...
//       return;
//     }
//   }

//   // Continue with rest of position monitoring (PnL updates, Moray checks, etc)
// }

// ============================================================================
// WHAT TO ADD TO THE POSITION OBJECT (in enterPosition section 7)
// ============================================================================

// When creating the position in section 7, add this field:

// const position: Position = {
//   // ... all your existing fields ...

//   // Add this: store regime snapshot at entry
//   entryRegime: {
//     marketQuality: regime.marketQuality,
//     volatility: regime.volatility,
//     trend: regime.trend,
//   },
// };

// ============================================================================
// EXECUTION ORDER (what runs when)
// ============================================================================
//
// Every candle close, for each position:
//
// 1. CHECK REGIME DEGRADATION  ← NEW, runs for ALL positions
//    └─ exit? → close and return
//
// 2. CHECK VIRTUAL SL  ← existing, runs for trailing-enabled positions
//    └─ hit? → close and return
//
// 3. UPDATE TRAILING   ← existing, runs for trailing-enabled positions
//    └─ force exit? → close and return
//    └─ update SL? → update position.stopLoss
//
// 4. UPDATE PNL, CHECK MORAY PARTIALS, ETC  ← existing logic continues
//
// The key: regime degradation runs FIRST and for EVERYONE.
// Trailing is just a bonus on top for eligible positions.
//
// ============================================================================
