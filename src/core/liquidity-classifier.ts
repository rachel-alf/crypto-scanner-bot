// ============================================================
// CONFIG — add this into your existing liquidity config block
// ============================================================

export const liquidityConfig = {
  enabled: true,
  minSpreadBps: 10,
  maxSpreadBps: 50,
  minDepthMultiplier: 10,
  maxSlippagePct: 0.3,
  min24hVolumeUSD: 20_000_000, // entry gate stays at 50M

  // Tiered classification for trailing stop behavior
  // Both conditions must pass to qualify for a tier.
  // Fails either → falls to next tier down.
  liquidityTiers: {
    HIGH: {
      min24hVolumeUSD: 1_000_000_000, // $1B+ (BNB, ETH, BTC)
      maxVolumeCV: 0.5, // volume must be stable
    },
    MEDIUM: {
      min24hVolumeUSD: 20_000_000, // $100M+ (mid-caps like LINK, AAVE)
      maxVolumeCV: 1.0, // moderate stability ok
    },
    // Anything that passes entry gate but fails MEDIUM → LOW
    // This catches TRUMP: high raw volume but CV > 1.0
  },

  // How many candles of volume history to use for CV calculation
  volumeStabilityLookback: 20,
} as const;

// ============================================================
// CLASSIFIER
// ============================================================

export interface LiquidityClassification {
  tier: 'HIGH' | 'MEDIUM' | 'LOW';
  volume24h: number;
  volumeCV: number; // coefficient of variation
  reason: string;
}

export function classifyLiquidity(params: {
  volume24h: number;
  volumes: number[]; // recent candle volumes from CandleData
}): LiquidityClassification {
  const { volume24h, volumes } = params;
  const config = liquidityConfig.liquidityTiers;
  const lookback = liquidityConfig.volumeStabilityLookback; // 20

  // --- calculate CV (coefficient of variation) from recent volumes ---
  const recent = volumes.slice(-lookback);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;

  const variance =
    recent.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / recent.length;
  const stddev = Math.sqrt(variance);

  const cv = mean > 0 ? stddev / mean : Infinity;

  // --- tier classification: both volume AND stability must pass ---

  // HIGH: $1B+ volume AND CV < 0.5
  if (
    volume24h >= config.HIGH.min24hVolumeUSD &&
    cv <= config.HIGH.maxVolumeCV
  ) {
    return {
      tier: 'HIGH',
      volume24h,
      volumeCV: cv,
      reason: `vol=$${(volume24h / 1e9).toFixed(2)}B, CV=${cv.toFixed(2)} — stable high-cap`,
    };
  }

  // MEDIUM: $100M+ volume AND CV < 1.0
  if (
    volume24h >= config.MEDIUM.min24hVolumeUSD &&
    cv <= config.MEDIUM.maxVolumeCV
  ) {
    return {
      tier: 'MEDIUM',
      volume24h,
      volumeCV: cv,
      reason: `vol=$${(volume24h / 1e6).toFixed(0)}M, CV=${cv.toFixed(2)} — mid-cap`,
    };
  }

  // LOW: everything else that passed the entry gate
  // This is where TRUMP lands: high volume but CV > 1.0
  const reason =
    volume24h < config.MEDIUM.min24hVolumeUSD
      ? `vol=$${(volume24h / 1e6).toFixed(0)}M — below MEDIUM volume threshold`
      : `vol=$${(volume24h / 1e6).toFixed(0)}M but CV=${cv.toFixed(2)} — volume too spiky`;

  return {
    tier: 'LOW',
    volume24h,
    volumeCV: cv,
    reason,
  };
}

// ============================================================
// USAGE — call this once at entry, pass result into trailing
// ============================================================
//
// Inside enterPosition, after you already have candles in scope:
//
//   const liquidity = classifyLiquidity({
//     volume24h: ticker.quoteVolume,   // from Binance ticker API
//     volumes: candles.volumes,        // already in your CandleData
//   });
//
//   console.log(`💧 ${bot.symbol} liquidity: ${liquidity.tier} — ${liquidity.reason}`);
//
// Then pass liquidity.tier into the trailing stop eligibility check.
//
// ============================================================
// EXPECTED CLASSIFICATION (calibrated from real Binance data)
// ============================================================
//
// Token     | 24h Vol    | CV     | Result
// ──────────────────────────────────────────
// ETH       | $3.9B      | ~0.3   | HIGH  ✓
// BNB       | $3.4B      | ~0.3   | HIGH  ✓
// LINK      | $200M      | ~0.7   | MEDIUM ✓
// TRUMP     | $300M      | ~2.1   | LOW   ✓  ← caught by CV
// MAGA      | $7.6M      | —      | LOW   ✓  ← caught by volume
// dead coin | $3M        | —      | blocked by entry gate entirely
