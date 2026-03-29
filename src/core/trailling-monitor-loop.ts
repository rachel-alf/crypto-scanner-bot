// ============================================================
// TYPES
// ============================================================

import type { Position } from '../../lib/type.js';
import type {
  LiquidityTier,
  MarketQuality,
  TrailingProfile,
  VolatilityRegime,
} from './trailling-stop-mapper.js';

// Stored on the Position object at entry time — never changes
export interface TrailingState {
  // --- from mapper (locked) ---
  profile: TrailingProfile;

  // --- regime snapshot at entry (locked, for degradation comparison) ---
  entryMarketQuality: MarketQuality;
  entryVolatility: VolatilityRegime;
  entryLiquidityTier: LiquidityTier;

  // --- live tracking (mutates each candle) ---
  activated: boolean;
  activatedAtR: number | null;
  currentTrailingStop: number | null; // the actual trailing SL price
  highestR: number; // peak R multiple seen so far
  candlesInTrade: number;
  candlesWithoutProgress: number; // resets when highestR improves

  // --- degradation tracking ---
  degradationDetected: boolean;
  degradationTightenApplied: boolean; // did we already tighten once?
}

// What the monitor loop returns each candle
export type TrailingAction =
  | { action: 'NONE' }
  | { action: 'UPDATE_SL'; newSL: number; reason: string }
  | { action: 'FORCE_EXIT'; reason: string };

// What the monitor loop needs each candle
export interface MonitorInput {
  position: Position & { trailing: TrailingState };
  currentPrice: number;
  currentATR: number; // recalculated each candle
  candles: { highs: number[]; lows: number[]; closes: number[] };
  currentRegime: {
    // fresh detectRegime() output
    marketQuality: MarketQuality;
    volatility: VolatilityRegime;
  };
}

// ============================================================
// INITIALIZE — call once at entry, attach to Position object
// ============================================================

export function initTrailingState(params: {
  profile: TrailingProfile;
  marketQuality: MarketQuality;
  volatility: VolatilityRegime;
  liquidityTier: LiquidityTier;
}): TrailingState {
  return {
    profile: params.profile,

    entryMarketQuality: params.marketQuality,
    entryVolatility: params.volatility,
    entryLiquidityTier: params.liquidityTier,

    activated: false,
    activatedAtR: null,
    currentTrailingStop: null,
    highestR: 0,
    candlesInTrade: 0,
    candlesWithoutProgress: 0,

    degradationDetected: false,
    degradationTightenApplied: false,
  };
}

// ============================================================
// MONITOR LOOP — call every candle close
// ============================================================

export function updateTrailingStop(input: MonitorInput): TrailingAction {
  const { position, currentPrice, currentATR, candles, currentRegime } = input;
  const ts = position.trailing;
  const profile = ts.profile;
  const side = position.side;
  const entry = position.entryPrice;
  const riskDist = Math.abs(entry - position.stopLoss); // original risk distance

  // ─────────────────────────────────────────────
  // 1. SKIP if not eligible
  // ─────────────────────────────────────────────
  if (!profile.eligible) {
    return { action: 'NONE' };
  }

  // ─────────────────────────────────────────────
  // 2. TRACK: candles, R multiple, peak R
  // ─────────────────────────────────────────────
  ts.candlesInTrade += 1;

  const rawPnl = side === 'LONG' ? currentPrice - entry : entry - currentPrice;
  const currentR = rawPnl / riskDist;

  if (currentR > ts.highestR) {
    ts.highestR = currentR;
    ts.candlesWithoutProgress = 0;
  } else {
    ts.candlesWithoutProgress += 1;
  }

  // ─────────────────────────────────────────────
  // 3. CHECK REGIME DEGRADATION (before anything else)
  //    Compare current regime vs what it was at entry.
  //    Only ever tightens or exits — never loosens.
  // ─────────────────────────────────────────────
  const degradation = checkDegradation(ts, currentRegime);

  if (degradation.action === 'FORCE_EXIT') {
    return { action: 'FORCE_EXIT', reason: degradation.reason };
  }

  // If degradation wants to tighten, we'll apply it after
  // calculating the normal trailing SL (pick the tighter of the two)

  // ─────────────────────────────────────────────
  // 4. CHECK ACTIVATION
  // ─────────────────────────────────────────────
  if (!ts.activated) {
    const reachedR = currentR >= profile.activationR;
    const reachedCandles =
      ts.candlesInTrade >= profile.minCandlesBeforeActivation;

    if (!reachedR || !reachedCandles) {
      return { action: 'NONE' };
    }

    // ACTIVATE
    ts.activated = true;
    ts.activatedAtR = currentR;
    console.log(
      `✅ Trailing ACTIVATED [${position.symbol}]: R=${currentR.toFixed(2)}, candles=${ts.candlesInTrade}`
    );
  }

  // ─────────────────────────────────────────────
  // 5. CALCULATE CANDIDATE TRAILING SL
  // ─────────────────────────────────────────────
  const trailDistance = currentATR * profile.atrMultiplier;

  let candidateSL: number;
  if (side === 'LONG') {
    candidateSL = currentPrice - trailDistance;
  } else {
    candidateSL = currentPrice + trailDistance;
  }

  // ─────────────────────────────────────────────
  // 6. APPLY DEGRADATION TIGHTEN (if needed)
  //    Use a tighter multiplier (0.6x of normal) and
  //    pick whichever is MORE protective
  // ─────────────────────────────────────────────
  if (degradation.action === 'TIGHTEN' && !ts.degradationTightenApplied) {
    const tightenedDistance = currentATR * profile.atrMultiplier * 0.6;

    let tightenedSL: number;
    if (side === 'LONG') {
      tightenedSL = currentPrice - tightenedDistance;
      candidateSL = Math.max(candidateSL, tightenedSL); // higher = tighter for LONG
    } else {
      tightenedSL = currentPrice + tightenedDistance;
      candidateSL = Math.min(candidateSL, tightenedSL); // lower = tighter for SHORT
    }

    ts.degradationTightenApplied = true;
    console.log(
      `⚠️ Trailing TIGHTENED [${position.symbol}] due to regime degradation`
    );
  }

  // ─────────────────────────────────────────────
  // 7. MONOTONIC CHECK — never loosen
  // ─────────────────────────────────────────────
  if (ts.currentTrailingStop !== null) {
    if (side === 'LONG' && candidateSL <= ts.currentTrailingStop) {
      return { action: 'NONE' }; // would loosen, reject
    }
    if (side === 'SHORT' && candidateSL >= ts.currentTrailingStop) {
      return { action: 'NONE' }; // would loosen, reject
    }
  }

  // ─────────────────────────────────────────────
  // 8. MIN DELTA FILTER — ignore micro-moves
  //    Don't update exchange order for tiny shifts
  // ─────────────────────────────────────────────
  const MIN_DELTA_PCT = 0.15; // 0.15% of entry price

  if (ts.currentTrailingStop !== null) {
    const deltaPct =
      (Math.abs(candidateSL - ts.currentTrailingStop) / entry) * 100;
    if (deltaPct < MIN_DELTA_PCT) {
      return { action: 'NONE' };
    }
  }

  // ─────────────────────────────────────────────
  // 9. TIME DECAY — if price hasn't made progress in too long, tighten
  // ─────────────────────────────────────────────
  const MAX_CANDLES_WITHOUT_PROGRESS = 10;

  if (ts.candlesWithoutProgress >= MAX_CANDLES_WITHOUT_PROGRESS) {
    const decayDistance = currentATR * profile.atrMultiplier * 0.6;

    let decaySL: number;
    if (side === 'LONG') {
      decaySL = currentPrice - decayDistance;
      candidateSL = Math.max(candidateSL, decaySL);
    } else {
      decaySL = currentPrice + decayDistance;
      candidateSL = Math.min(candidateSL, decaySL);
    }

    console.log(
      `⏰ Time decay tightening [${position.symbol}]: ${ts.candlesWithoutProgress} candles without R progress`
    );

    // Re-run monotonic check after time decay adjustment
    if (ts.currentTrailingStop !== null) {
      if (side === 'LONG' && candidateSL <= ts.currentTrailingStop) {
        return { action: 'NONE' };
      }
      if (side === 'SHORT' && candidateSL >= ts.currentTrailingStop) {
        return { action: 'NONE' };
      }
    }
  }

  // ─────────────────────────────────────────────
  // 10. COMMIT — update trailing SL
  // ─────────────────────────────────────────────
  const prev = ts.currentTrailingStop;
  ts.currentTrailingStop = candidateSL;

  console.log(
    `📈 Trail [${position.symbol}]: ${prev ? prev.toFixed(6) : 'INIT'} → ${candidateSL.toFixed(6)} | R=${currentR.toFixed(2)} | peakR=${ts.highestR.toFixed(2)}`
  );

  return {
    action: 'UPDATE_SL',
    newSL: candidateSL,
    reason: `R=${currentR.toFixed(2)}, peakR=${ts.highestR.toFixed(2)}`,
  };
}

// ============================================================
// DEGRADATION CHECK — internal helper
// ============================================================
// Compares current regime vs entry regime.
// Only ever returns TIGHTEN or FORCE_EXIT, never "loosen".
// ============================================================

export type DegradationResult =
  | { action: 'NONE' }
  | { action: 'TIGHTEN'; reason: string }
  | { action: 'FORCE_EXIT'; reason: string };

function checkDegradation(
  ts: TrailingState,
  currentRegime: { marketQuality: MarketQuality; volatility: VolatilityRegime }
): DegradationResult {
  const entryQ = ts.entryMarketQuality;
  const nowQ = currentRegime.marketQuality;
  const entryV = ts.entryVolatility;
  const nowV = currentRegime.volatility;
  const liq = ts.entryLiquidityTier;
  const rule = ts.profile.degradationRule;

  // ─── volatility spiked to EXTREME → always exit ───
  if (nowV === 'EXTREME') {
    return {
      action: 'FORCE_EXIT',
      reason: `volatility spiked to EXTREME (was ${entryV} at entry)`,
    };
  }

  // ─── marketQuality dropped to LOW → always exit ───
  if (nowQ === 'LOW') {
    return {
      action: 'FORCE_EXIT',
      reason: `marketQuality dropped to LOW (was ${entryQ} at entry)`,
    };
  }

  // ─── LOW liquidity tokens: any quality drop → exit immediately ───
  if (liq === 'LOW' && nowQ !== entryQ) {
    return {
      action: 'FORCE_EXIT',
      reason: `LOW liquidity token — quality shifted from ${entryQ} to ${nowQ}, exiting immediately`,
    };
  }

  // ─── HIGH/MEDIUM liquidity: quality dropped one step → tighten ───
  if (entryQ === 'HIGH' && nowQ === 'MEDIUM') {
    if (rule === 'TIGHTEN_THEN_EXIT') {
      return {
        action: 'TIGHTEN',
        reason: `marketQuality dropped HIGH → MEDIUM`,
      };
    }
    // shouldn't hit this (HIGH quality + EXIT_IMMEDIATELY = LOW liquidity, caught above)
    // but safety net
    return {
      action: 'FORCE_EXIT',
      reason: `marketQuality dropped HIGH → MEDIUM, rule is EXIT_IMMEDIATELY`,
    };
  }

  // ─── volatility jumped up one tier (MEDIUM→HIGH or LOW→MEDIUM) ───
  //     Not necessarily fatal, but worth tightening
  const volOrder: VolatilityRegime[] = [
    'DEAD',
    'VERY_LOW',
    'LOW',
    'MEDIUM',
    'HIGH',
    'EXTREME',
  ];
  const entryVolIdx = volOrder.indexOf(entryV);
  const nowVolIdx = volOrder.indexOf(nowV);

  if (nowVolIdx > entryVolIdx + 1) {
    // Jumped more than one tier (e.g. MEDIUM → EXTREME already caught above)
    // So this catches e.g. LOW → HIGH
    return {
      action: 'TIGHTEN',
      reason: `volatility jumped from ${entryV} to ${nowV}`,
    };
  }

  // ─── no degradation detected ───
  return { action: 'NONE' };
}

// ============================================================
// USAGE — inside your position monitor loop (every candle close)
// ============================================================
//
//   // You already recalculate regime and ATR each candle presumably
//   const regime = detectRegime(indicators, candles);
//   const atrArray = ATR.calculate({ high, low, close, period: 14 });
//   const currentATR = atrArray[atrArray.length - 1];
//
//   if (position.trailing?.profile.eligible) {
//     const result = updateTrailingStop({
//       position,
//       currentPrice,
//       currentATR,
//       candles,
//       currentRegime: {
//         marketQuality: regime.marketQuality,
//         volatility: regime.volatility,
//       },
//     });
//
//     if (result.action === 'UPDATE_SL') {
//       // Cancel old SL order on Binance, place new one at result.newSL
//       // Also update position.stopLoss = result.newSL
//       console.log(`🛡️ Trail updated [${position.symbol}]: new SL @ ${result.newSL}`);
//     }
//
//     if (result.action === 'FORCE_EXIT') {
//       // Market close the position
//       console.log(`🚨 Trail FORCE EXIT [${position.symbol}]: ${result.reason}`);
//     }
//   }
//
// ============================================================
// INITIALIZATION — inside enterPosition, section 7
// ============================================================
//
//   const position: Position = {
//     ...existingFields,
//
//     trailing: initTrailingState({
//       profile: trailingProfile,                // from getTrailingProfile()
//       marketQuality: regime.marketQuality,     // snapshot, locked
//       volatility: regime.volatility,           // snapshot, locked
//       liquidityTier: liquidity.tier,           // snapshot, locked
//     }),
//   };
