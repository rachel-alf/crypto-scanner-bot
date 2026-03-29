// ============================================================
// TYPES
// ============================================================

export type MarketQuality = 'HIGH' | 'MEDIUM' | 'LOW';
export type VolatilityRegime =
  | 'LOW'
  | 'DEAD'
  | 'MEDIUM'
  | 'HIGH'
  | 'HIGH_BULL'
  | 'HIGH_BEAR'
  | 'HIGH_NEUTRAL'
  | 'VERY_LOW'
  | 'EXTREME';
export type LiquidityTier = 'HIGH' | 'MEDIUM' | 'LOW';
export type DegradationRule = 'TIGHTEN_THEN_EXIT' | 'EXIT_IMMEDIATELY';

// What comes OUT of the mapper — locked at entry, never changes
export interface TrailingProfile {
  eligible: boolean;
  reason: string; // why eligible or why blocked

  // only meaningful if eligible = true
  activationR: number; // how far in profit before trail starts (e.g. 1.5 = 1.5x risk)
  atrMultiplier: number; // how wide the trail sits behind price
  minCandlesBeforeActivation: number;
  degradationRule: DegradationRule; // what to do if regime gets worse mid-trade
}

// What goes INTO the mapper — all already available at entry time
export interface EntryContext {
  marketQuality: MarketQuality; // from detectRegime → calculateMarketQuality
  volatility: VolatilityRegime; // from detectRegime
  liquidityTier: LiquidityTier; // from classifyLiquidity
}

// ============================================================
// MAPPER
// ============================================================

export function getTrailingProfile(ctx: EntryContext): TrailingProfile {
  const { marketQuality, volatility, liquidityTier } = ctx;

  // ─────────────────────────────────────────────
  // GATE 1: Hard blocks — no trailing at all
  // ─────────────────────────────────────────────

  if (marketQuality === 'LOW') {
    return blocked(`marketQuality LOW — no reliable trend structure`);
  }

  if (volatility === 'EXTREME') {
    return blocked(`volatility EXTREME — price too chaotic to trail`);
  }

  if (volatility === 'DEAD' || volatility === 'VERY_LOW') {
    return blocked(
      `volatility ${volatility} — not enough price movement to trail`
    );
  }

  // At this point we know:
  //   marketQuality = HIGH or MEDIUM
  //   volatility    = LOW, MEDIUM, or HIGH
  //   liquidityTier = HIGH, MEDIUM, or LOW

  // ─────────────────────────────────────────────
  // GATE 2: LOW volatility needs strong conviction
  // ─────────────────────────────────────────────

  if (volatility === 'LOW') {
    // In low volatility, only trail if market quality is HIGH
    // and the token has decent liquidity
    if (marketQuality !== 'HIGH') {
      return blocked(
        `volatility LOW + marketQuality ${marketQuality} — not enough conviction`
      );
    }
    if (liquidityTier === 'LOW') {
      return blocked(
        `volatility LOW + liquidityTier LOW — gaps can destroy tight trails`
      );
    }

    // Passed: LOW vol + HIGH quality + HIGH/MEDIUM liquidity
    // Late activation, tight trail (ATR is small here so multiplier stays low)
    return {
      eligible: true,
      reason: `LOW vol + HIGH quality + ${liquidityTier} liquidity — late activation`,
      activationR: 2.5,
      atrMultiplier: 2.0,
      minCandlesBeforeActivation: 5,
      degradationRule: 'TIGHTEN_THEN_EXIT',
    };
  }

  // ─────────────────────────────────────────────
  // GATE 3: CHOP check via marketQuality
  // ─────────────────────────────────────────────
  // marketQuality already catches choppy markets (trendStrength < 0.001 → LOW)
  // So if we're still here, we have a real trend. Good.

  // ─────────────────────────────────────────────
  // MAIN PROFILES: MEDIUM and HIGH volatility
  // ─────────────────────────────────────────────

  if (volatility === 'MEDIUM') {
    // MEDIUM volatility is the sweet spot for trailing.
    // Tune based on market quality + liquidity.

    if (marketQuality === 'HIGH') {
      // Best case scenario
      return {
        eligible: true,
        reason: `MEDIUM vol + HIGH quality + ${liquidityTier} liquidity`,
        activationR:
          liquidityTier === 'HIGH'
            ? 1.5
            : liquidityTier === 'MEDIUM'
              ? 1.8
              : 2.5,
        atrMultiplier: liquidityTier === 'LOW' ? 2.4 : 2.0,
        minCandlesBeforeActivation: liquidityTier === 'LOW' ? 5 : 3,
        degradationRule:
          liquidityTier === 'LOW' ? 'EXIT_IMMEDIATELY' : 'TIGHTEN_THEN_EXIT',
      };
    }

    // marketQuality === 'MEDIUM'
    // Less conviction in the trend, be more cautious
    return {
      eligible: true,
      reason: `MEDIUM vol + MEDIUM quality + ${liquidityTier} liquidity — cautious`,
      activationR:
        liquidityTier === 'HIGH' ? 2.0 : liquidityTier === 'MEDIUM' ? 2.2 : 3.0,
      atrMultiplier: liquidityTier === 'LOW' ? 2.6 : 2.2,
      minCandlesBeforeActivation: liquidityTier === 'LOW' ? 6 : 4,
      degradationRule:
        liquidityTier === 'LOW' ? 'EXIT_IMMEDIATELY' : 'TIGHTEN_THEN_EXIT',
    };
  }

  if (volatility === 'HIGH') {
    // HIGH volatility: trail is wider, activation is later.
    // Price whips more, so trail needs room to breathe.

    if (marketQuality === 'HIGH') {
      return {
        eligible: true,
        reason: `HIGH vol + HIGH quality + ${liquidityTier} liquidity — wide trail`,
        activationR:
          liquidityTier === 'HIGH'
            ? 2.0
            : liquidityTier === 'MEDIUM'
              ? 2.2
              : 3.0,
        atrMultiplier: liquidityTier === 'LOW' ? 3.0 : 2.8,
        minCandlesBeforeActivation: liquidityTier === 'LOW' ? 6 : 4,
        degradationRule:
          liquidityTier === 'LOW' ? 'EXIT_IMMEDIATELY' : 'TIGHTEN_THEN_EXIT',
      };
    }

    // marketQuality === 'MEDIUM' + HIGH volatility
    // Risky combo. Only trail if liquidity is decent.
    if (liquidityTier === 'LOW') {
      return blocked(
        `HIGH vol + MEDIUM quality + LOW liquidity — too risky to trail`
      );
    }

    return {
      eligible: true,
      reason: `HIGH vol + MEDIUM quality + ${liquidityTier} liquidity — very cautious`,
      activationR: liquidityTier === 'HIGH' ? 2.5 : 3.0,
      atrMultiplier: 2.8,
      minCandlesBeforeActivation: 5,
      degradationRule: 'TIGHTEN_THEN_EXIT' as const,
    };
  }

  // Should never reach here, but safety net
  return blocked(
    `unhandled combination: vol=${volatility} quality=${marketQuality} liq=${liquidityTier}`
  );
}

// function blocked(reason: string): TrailingProfile {
//   return {
//     eligible: false,
//     reason,
//     activationR: 0,
//     atrMultiplier: 0,
//     minCandlesBeforeActivation: 0,
//     degradationRule: 'EXIT_IMMEDIATELY',
//   };
// }

// ============================================================
// HELPER
// ============================================================

function blocked(reason: string): TrailingProfile {
  return {
    eligible: false,
    reason,
    activationR: 0,
    atrMultiplier: 0,
    minCandlesBeforeActivation: 0,
    degradationRule: 'EXIT_IMMEDIATELY',
  };
}

// ============================================================
// USAGE — inside enterPosition, after section 5 (SL/TP calc)
// ============================================================
//
//   const regime = detectRegime(indicators, candles);
//   const liquidity = classifyLiquidity({ volume24h, volumes: candles.volumes });
//
//   const trailingProfile = getTrailingProfile({
//     marketQuality: regime.marketQuality,
//     volatility:    regime.volatility,
//     liquidityTier: liquidity.tier,
//   });
//
//   console.log(
//     `🎯 Trailing [${bot.symbol}]: ${trailingProfile.eligible ? 'ENABLED' : 'DISABLED'} — ${trailingProfile.reason}`
//   );
//
// Then attach trailingProfile to your Position object in section 7.
// The monitor loop reads it later to know how to trail.
//
// ============================================================
// FULL DECISION TABLE (for reference)
// ============================================================
//
// marketQuality  volatility  liquidityTier  → eligible  activationR  atrMult  degradation
// ──────────────────────────────────────────────────────────────────────────────────────────
// LOW            *           *              → NO        —            —        —
// *              EXTREME     *              → NO        —            —        —
// *              DEAD        *              → NO        —            —        —
// *              VERY_LOW    *              → NO        —            —        —
// MEDIUM         LOW         *              → NO        —            —        —
// HIGH           LOW         LOW            → NO        —            —        —
// HIGH           LOW         HIGH/MEDIUM    → YES       2.5          2.0      TIGHTEN_THEN_EXIT
// HIGH           MEDIUM      HIGH           → YES       1.5          2.0      TIGHTEN_THEN_EXIT
// HIGH           MEDIUM      MEDIUM         → YES       1.8          2.0      TIGHTEN_THEN_EXIT
// HIGH           MEDIUM      LOW            → YES       2.5          2.4      EXIT_IMMEDIATELY
// MEDIUM         MEDIUM      HIGH           → YES       2.0          2.0      TIGHTEN_THEN_EXIT
// MEDIUM         MEDIUM      MEDIUM         → YES       2.2          2.2      TIGHTEN_THEN_EXIT
// MEDIUM         MEDIUM      LOW            → YES       3.0          2.6      EXIT_IMMEDIATELY
// HIGH           HIGH        HIGH           → YES       2.0          2.8      TIGHTEN_THEN_EXIT
// HIGH           HIGH        MEDIUM         → YES       2.2          2.8      TIGHTEN_THEN_EXIT
// HIGH           HIGH        LOW            → YES       3.0          3.0      EXIT_IMMEDIATELY
// MEDIUM         HIGH        HIGH           → YES       2.5          2.8      TIGHTEN_THEN_EXIT
// MEDIUM         HIGH        MEDIUM         → YES       3.0          2.8      TIGHTEN_THEN_EXIT
// MEDIUM         HIGH        LOW            → NO        —            —        —
