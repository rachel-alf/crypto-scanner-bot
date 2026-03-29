import type { Regime } from '../../lib/type.js';
import type { LiquidityClassification } from './liquidity-classifier.js';

interface DynamicMorayRatios {
  partials: Array<{ ratio: number; percent: number; label: string }>;
}

export function adjustMorayForRegime(
  regime: Regime,
  liquidity: LiquidityClassification
): DynamicMorayRatios {
  // Base ratios (defaults)
  let tp1Ratio = 1.5;
  let tp2Ratio = 2.5;
  let tp1Percent = 0.6;
  let tp2Percent = 0.4;

  // ════════════════════════════════════════════
  // VOLATILITY ADJUSTMENTS
  // ════════════════════════════════════════════

  if (regime.volatility === 'EXTREME' || regime.volatility === 'HIGH') {
    tp1Ratio = 2.0;
    tp2Ratio = 3.5;
    console.log(
      `   🌪️ High volatility - widening targets to ${tp1Ratio}R / ${tp2Ratio}R`
    );
  } else if (regime.volatility === 'VERY_LOW' || regime.volatility === 'DEAD') {
    tp1Ratio = 1.2;
    tp2Ratio = 2.0;
    console.log(
      `   💤 Low volatility - tightening targets to ${tp1Ratio}R / ${tp2Ratio}R`
    );
  }

  // ════════════════════════════════════════════
  // TREND ADJUSTMENTS
  // ════════════════════════════════════════════

  if (regime.trend === 'STRONG_UP' || regime.trend === 'STRONG_DOWN') {
    tp1Percent = 0.5;
    tp2Percent = 0.5;
    tp2Ratio = tp2Ratio * 1.2;
    console.log(
      `   🚀 Strong trend - letting runners go to ${tp2Ratio.toFixed(1)}R`
    );
  } else if (regime.trend === 'CHOP') {
    tp1Percent = 0.7;
    tp2Percent = 0.3;
    tp1Ratio = tp1Ratio * 0.85;
    console.log(
      `   ⚠️ Choppy - taking profit early at ${tp1Ratio.toFixed(1)}R`
    );
  }

  // ════════════════════════════════════════════
  // LIQUIDITY ADJUSTMENTS
  // ════════════════════════════════════════════

  if (liquidity.tier === 'LOW') {
    tp1Ratio = tp1Ratio * 0.9;
    tp2Ratio = tp2Ratio * 0.85;
    tp1Percent = 0.7;
    console.log(`   💧 Low liquidity - conservative targets`);
  }

  // ════════════════════════════════════════════
  // MARKET QUALITY ADJUSTMENTS
  // ════════════════════════════════════════════

  if (regime.marketQuality === 'LOW') {
    tp1Ratio = Math.min(tp1Ratio, 1.3);
    tp2Ratio = Math.min(tp2Ratio, 2.0);
    tp1Percent = 0.8;
    tp2Percent = 0.2;
    console.log(`   ⚠️ Low quality - very tight targets`);
  }

  return {
    partials: [
      { ratio: tp1Ratio, percent: tp1Percent, label: 'First Bite 🥩' },
      { ratio: tp2Ratio, percent: tp2Percent, label: 'Final Exit 🎯' },
    ],
  };
}
