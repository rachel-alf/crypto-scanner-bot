// ============================================================================
// TRADING MODES
// ============================================================================

import type { EntrySignal, ExtendedScanResult } from '../../lib/type.js';

export type TradingMode = 'CONSERVATIVE' | 'AGGRESSIVE';

export interface FilterConfig {
  mode: TradingMode;

  // Confidence thresholds
  minConfidence: number;
  minSMCScore: number;

  // SMC requirements
  requireMultipleSMCFactors: boolean; // Need 2+ SMC conditions
  requirePremiumDiscount: boolean; // LONG in DISCOUNT, SHORT in PREMIUM
  requireHTFAlignment: boolean; // Higher timeframe must agree

  stopLossMultiplier: number;
  takeProfitMultiplier: number;

  // RSI requirements
  rsiMustSupport: boolean; // RSI can't fight the direction
  rsiOversoldMax: number; // For LONG signals
  rsiOverboughtMin: number; // For SHORT signals

  // Other filters
  warmupPeriodMs: number; // Wait after bot starts
  minVolumeUSD: number; // Minimum 24h volume
  maxSpreadBps: number; // Maximum bid-ask spread
}

// ============================================================================
// MODE CONFIGURATIONS
// ============================================================================

export const CONFIG = {
  // ============================================
  // 🎯 SWING TRADER CONFIG
  // ============================================

  // Capital
  totalCapital: 215,
  maxConcurrentPositions: 1,
  leverageMultiplier: 3,

  // Risk (WIDE for swing)
  stopLossMultiplier: 1.3,
  takeProfitMultiplier: 3.3,

  // Timeframe (SLOW for swing)
  timeframe: '15m', // 4-hour candles, not 15m

  // Trades (PATIENT)
  maxTradesPerDay: 40, // Max 2/day, not 40
  minConfidence: 72,

  // Tokens (SAFE ONLY!)
  allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'],

  // Block the scanner from adding random tokens
  useWhitelistOnly: true,

  // Strategy
  enabledStrategies: ['FIB_RETRACEMENT'],

  // Environment
  testnet: true,
};

export const CONSERVATIVE_CONFIG: FilterConfig = {
  mode: 'CONSERVATIVE',

  // 🔒 Strict confidence
  minConfidence: 70,
  minSMCScore: 65,

  // 🔒 Multiple confirmations required
  requireMultipleSMCFactors: true,
  requirePremiumDiscount: true,
  requireHTFAlignment: true,

  stopLossMultiplier: 1,
  takeProfitMultiplier: 3,

  // 🔒 RSI must confirm
  rsiMustSupport: true,
  rsiOversoldMax: 40, // LONG: RSI must be < 40
  rsiOverboughtMin: 60, // SHORT: RSI must be > 60

  // 🔒 Quality filters
  warmupPeriodMs: 10 * 60 * 1000, // 10 minutes
  minVolumeUSD: 20_000_000, // $10M daily
  maxSpreadBps: 30, // 0.30%
};

export const AGGRESSIVE_CONFIG: FilterConfig = {
  mode: 'AGGRESSIVE',

  // 💪 Relaxed confidence
  minConfidence: 60,
  minSMCScore: 50,

  // 💪 Single confirmation OK
  requireMultipleSMCFactors: false,
  requirePremiumDiscount: false,
  requireHTFAlignment: false,

  stopLossMultiplier: 1,
  takeProfitMultiplier: 3,

  // 💪 RSI can fight slightly
  rsiMustSupport: false,
  rsiOversoldMax: 50, // LONG: RSI can be up to 50
  rsiOverboughtMin: 50, // SHORT: RSI can be down to 50

  // 💪 Less strict filters
  warmupPeriodMs: 3 * 60 * 1000, // 3 minutes
  minVolumeUSD: 20_000_000, // $5M daily
  maxSpreadBps: 50, // 0.50%
};

// ============================================================================
// SIGNAL FILTER CLASS
// ============================================================================

export class SignalFilter {
  private config: FilterConfig;
  private startTime: number;

  constructor(mode: TradingMode = 'CONSERVATIVE') {
    this.config =
      mode === 'CONSERVATIVE' ? CONSERVATIVE_CONFIG : AGGRESSIVE_CONFIG;
    this.startTime = Date.now();

    console.log(`\n🎯 Signal Filter initialized in ${mode} mode`);
    this.logConfig();
  }

  /**
   * Switch between modes on the fly
   */
  switchMode(mode: TradingMode): void {
    this.config =
      mode === 'CONSERVATIVE' ? CONSERVATIVE_CONFIG : AGGRESSIVE_CONFIG;
    console.log(`\n🔄 Switched to ${mode} mode`);
    this.logConfig();
  }

  /**
   * Get current mode
   */
  getMode(): TradingMode {
    return this.config.mode;
  }

  /**
   * Main filter function - returns rejection reason or null if passed
   */
  filterSignal(result: ExtendedScanResult): string | null {
    const { signal, confidence, smc, indicators, rsi } = result;

    if (!signal) {
      return 'No signal present';
    }

    // 1. Warmup period check
    const elapsed = Date.now() - this.startTime;
    if (elapsed < this.config.warmupPeriodMs) {
      const remaining = Math.ceil(
        (this.config.warmupPeriodMs - elapsed) / 1000
      );
      return `Warmup period: ${remaining}s remaining`;
    }

    // 2. Confidence check
    if (confidence < this.config.minConfidence) {
      return `Confidence ${confidence.toFixed(0)}% < ${this.config.minConfidence}%`;
    }

    // 3. SMC score check
    if (smc && smc.smcScore < this.config.minSMCScore) {
      return `SMC score ${smc.smcScore.toFixed(0)} < ${this.config.minSMCScore}`;
    }

    // 4. Multiple SMC factors check
    if (this.config.requireMultipleSMCFactors && smc) {
      const smcFactors = this.countSMCFactors(smc, signal);
      if (smcFactors < 2) {
        return `Only ${smcFactors} SMC factor(s), need 2+`;
      }
    }

    // 5. Premium/Discount zone check
    if (this.config.requirePremiumDiscount && smc) {
      if (signal.side === 'LONG' && smc.premiumDiscount !== 'DISCOUNT') {
        return `LONG signal not in DISCOUNT zone (${smc.premiumDiscount})`;
      }
      if (signal.side === 'SHORT' && smc.premiumDiscount !== 'PREMIUM') {
        return `SHORT signal not in PREMIUM zone (${smc.premiumDiscount})`;
      }
    }

    // 6. RSI support check
    if (this.config.rsiMustSupport && indicators && rsi) {
      if (signal.side === 'LONG' && rsi > this.config.rsiOversoldMax) {
        return `LONG but RSI ${rsi.toFixed(1)} > ${this.config.rsiOversoldMax} (not oversold)`;
      }
      if (signal.side === 'SHORT' && rsi < this.config.rsiOverboughtMin) {
        return `SHORT but RSI ${rsi.toFixed(1)} < ${this.config.rsiOverboughtMin} (not overbought)`;
      }
    }

    // 7. HTF alignment check (if implemented)
    if (this.config.requireHTFAlignment) {
      // TODO: Add HTF trend check when available
      // For now, we'll skip this check
    }

    // ✅ All checks passed
    return null;
  }

  /**
   * Count how many SMC factors are present
   */
  private countSMCFactors(smc: any, signal: EntrySignal): number {
    let count = 0;

    // Check for order blocks
    const relevantOB = smc.orderBlocks.find(
      (ob: any) =>
        ob.type === (signal.side === 'LONG' ? 'BULLISH' : 'BEARISH') &&
        !ob.mitigated
    );
    if (relevantOB) count++;

    // Check for FVG
    const relevantFVG = smc.fvgs.find(
      (fvg: any) =>
        fvg.type === (signal.side === 'LONG' ? 'BULLISH' : 'BEARISH') &&
        !fvg.filled
    );
    if (relevantFVG) count++;

    // Check for BOS
    if (
      smc.bos.detected &&
      smc.bos.type === (signal.side === 'LONG' ? 'BULLISH' : 'BEARISH')
    ) {
      count++;
    }

    // Check for CHoCH
    if (
      smc.choch.detected &&
      smc.choch.type === (signal.side === 'LONG' ? 'BULLISH' : 'BEARISH')
    ) {
      count++;
    }

    // Check for liquidity sweeps
    const relevantLiquidity = smc.liquidityLevels.find(
      (l: any) =>
        l.type === (signal.side === 'LONG' ? 'LOW' : 'HIGH') &&
        l.swept &&
        l.strength > 60
    );
    if (relevantLiquidity) count++;

    return count;
  }

  /**
   * Log current configuration
   */
  private logConfig(): void {
    console.log(`   Min Confidence: ${this.config.minConfidence}%`);
    console.log(`   Min SMC Score: ${this.config.minSMCScore}`);
    console.log(
      `   Multiple SMC Factors: ${this.config.requireMultipleSMCFactors ? 'REQUIRED' : 'Optional'}`
    );
    console.log(
      `   Premium/Discount: ${this.config.requirePremiumDiscount ? 'REQUIRED' : 'Optional'}`
    );
    console.log(
      `   HTF Alignment: ${this.config.requireHTFAlignment ? 'REQUIRED' : 'Optional'}`
    );
    console.log(
      `   RSI Must Support: ${this.config.rsiMustSupport ? 'YES' : 'NO'}`
    );
    console.log(`   Warmup Period: ${this.config.warmupPeriodMs / 1000}s`);
  }

  /**
   * Get filter statistics
   */
  getStats(results: ExtendedScanResult[]): {
    total: number;
    passed: number;
    rejected: number;
    rejectionReasons: Record<string, number>;
  } {
    const stats = {
      total: results.length,
      passed: 0,
      rejected: 0,
      rejectionReasons: {} as Record<string, number>,
    };

    for (const result of results) {
      const rejection = this.filterSignal(result);
      if (rejection) {
        stats.rejected++;
        stats.rejectionReasons[rejection] =
          (stats.rejectionReasons[rejection] || 0) + 1;
      } else {
        stats.passed++;
      }
    }

    return stats;
  }
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

export function filterSignals(
  results: ExtendedScanResult[],
  mode: TradingMode = 'CONSERVATIVE'
): {
  passed: ExtendedScanResult[];
  rejected: Array<{ result: ExtendedScanResult; reason: string }>;
} {
  const filter = new SignalFilter(mode);
  const passed: ExtendedScanResult[] = [];
  const rejected: Array<{ result: ExtendedScanResult; reason: string }> = [];

  for (const result of results) {
    const rejection = filter.filterSignal(result);

    if (rejection) {
      rejected.push({ result, reason: rejection });
    } else {
      passed.push(result);
    }
  }

  console.log(`\n📊 Filter Results (${mode} mode):`);
  console.log(`   ✅ Passed: ${passed.length}/${results.length}`);
  console.log(`   ❌ Rejected: ${rejected.length}/${results.length}`);

  if (rejected.length > 0) {
    console.log(`\n📋 Rejection Summary:`);
    const reasonCounts: Record<string, number> = {};
    for (const { reason } of rejected) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    Object.entries(reasonCounts)
      .sort(([, a], [, b]) => b - a)
      .forEach(([reason, count]) => {
        console.log(`   ${count}x: ${reason}`);
      });
  }

  return { passed, rejected };
}

// ============================================================================
// INTEGRATION WITH CONFIG
// ============================================================================

export function getFilterModeFromEnv(): TradingMode {
  const mode = process.env.FILTER_MODE?.toUpperCase();

  if (mode === 'AGGRESSIVE') {
    return 'AGGRESSIVE';
  }

  // Default to CONSERVATIVE for safety
  return 'CONSERVATIVE';
}
