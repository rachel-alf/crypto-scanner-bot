import { normalize, type MarketType } from '../../lib/helpers.js';
import {
  MSCI_LARGE_CUP,
  MSCI_MID_CUP,
  MSCI_SMALL_CUP,
  MSCI_TINY_CUP,
  SYMBOLS,
} from '../../lib/token.js';
import type { StrategyId } from '../../lib/type.js';

export type Timeframe =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '8h'
  | '12h'
  | '1d'
  | '3d'
  | '1w'
  | '1M';

const POSITION_TYPE =
  (process.env.POSITION_TYPE as 'LONG' | 'SHORT' | 'BOTH') || 'LONG';
// ---------- BASE CONFIG (SHARED DEFAULTS) ----------

export const WYCKOFF_CONFIG = {
  enabled: true,
  minConfidence: 70, // Minimum confidence to take trade
  requirePhaseAlignment: true, // Signal must align with Wyckoff phase

  // Phase-specific settings
  phases: {
    ACCUMULATION: {
      enabled: true,
      minConfidence: 75,
      allowedStages: ['Late Accumulation', 'Spring'],
    },
    DISTRIBUTION: {
      enabled: true,
      minConfidence: 75,
      allowedStages: ['Late Distribution'],
    },
    MARKUP: {
      enabled: true,
      minConfidence: 65,
    },
    MARKDOWN: {
      enabled: true,
      minConfidence: 65,
    },
  },

  // Block trades in these phases
  blockPhases: ['MARKDOWN', 'DISTRIBUTION'],

  // Only trade in these phases (if specified)
  allowedPhases: ['ACCUMULATION', 'MARKUP'], // Leave empty to allow all except blocked

  // Confidence boosts
  boosts: {
    accumulation: 15, // Add 15% confidence in accumulation
    markup: 10,
    strongConfirmation: 20, // When Wyckoff confidence > 85%
  },
};

// export const QUICK_CONFIG = {

export const TEST_CONFIG = {
  mode: 'QUICK_TEST', // vs 'PRODUCTION'

  // Multiple stop conditions (first one hit wins)
  maxTotalTrades: 8, // Stop after 4 trades
  maxTestDuration: 15 * 60 * 1000, // OR 15 minutes
  maxLossStreak: 3, // OR 3 losses in a row
  targetPnL: 10, // OR reach +$10 profit

  // Fast execution
  signalCheckInterval: 3000, // Check every 3s
  dashboardRefreshMs: 2000, // Update every 2s
  maxConcurrentPositions: 1, // 2 at a time = faster completion
  defaultStopLossPercent: 1.3,
  defaultTakeProfitPercent: 3.7,
  // No cooldowns
  disableCooldowns: true,

  // Aggressive entry
  maxSlippagePercent: 5, // Accept more slippage
  requirePriceConfirmation: false,

  // Save detailed logs
  verboseLogging: true,
  saveTradeDetails: true,
  morayConfig: {
    enabled: true,
    partials: [
      { ratio: 1.5, percent: 0.5, label: 'First Bite 🥩' }, // 50% at 1.5R
      { ratio: 2.5, percent: 0.3, label: 'Second Helping 🍖' }, // 30% at 2.5R
      { ratio: 4.0, percent: 0.2, label: 'Runner 🎯' }, // 20% at 4R
    ],
    moveToBreakEvenAfter: 1.5, // Move SL to breakeven after 1.5R
  },
};

/*
 * 🎯 ATR-BASED SL/TP CONFIGURATION GUIDE
 */

export const ATR_CONFIG = {
  // ============================================
  // ATR CALCULATION
  // ============================================
  atrPeriod: 14, // Standard ATR period

  // ============================================
  // STOP LOSS SETTINGS
  // ============================================
  stopLoss: {
    // Multiplier for stop loss distance
    // Lower = tighter stops, more stop-outs but less loss per trade
    // Higher = wider stops, fewer stop-outs but more loss per trade
    multiplier: 1.6, // Recommended: 1.5-2.0

    // Maximum risk per trade (as percentage of entry price)
    maxRiskPercent: 1.7, // Never risk more than 3%

    // Minimum risk (avoid too tight stops)
    minRiskPercent: 1.0, // At least 0.5% room
  },

  // ============================================
  // TAKE PROFIT SETTINGS
  // ============================================
  takeProfit: {
    // Multiplier for take profit distance
    // Should be higher than SL multiplier for positive R:R
    multiplier: 3.0, // 1:2 R:R if SL = 1.5

    // Minimum R:R ratio (reward:risk)
    minRRRatio: 1.7, // Don't trade if R:R < 1:1.5
  },

  // ============================================
  // FALLBACK SETTINGS (if ATR fails)
  // ============================================
  fallback: {
    riskPercent: 0.011, // 1.5% stop loss
    rewardMultiplier: 2.7, // 3% take profit (1:2 R:R)
  },

  // ============================================
  // VOLATILITY ADJUSTMENTS
  // ============================================
  volatilityAdjustment: {
    enabled: true,

    // In high volatility, widen stops
    highVolatility: {
      threshold: 5.0, // If ATR > 5% of price
      slMultiplierBoost: 1.2, // Increase SL multiplier by 20%
    },

    // In low volatility, tighten stops
    lowVolatility: {
      threshold: 0.5, // If ATR < 0.5% of price
      slMultiplierReduce: 0.8, // Reduce SL multiplier by 20%
    },
  },
};

const CONFIG = {
  ...ATR_CONFIG,
  ...TEST_CONFIG,
  ...WYCKOFF_CONFIG,
  // ============================================================================
  // FILES & SIGNALS
  // ============================================================================

  wyckoffEnabled: true,
  signalFile: './data/signals/futures-signals.json',
  minConfidence: 70,
  signalCheckInterval: 10000,
  signalExpiryMs: 10 * 60 * 1000,
  paperTrading: false,
  blockedStrategies: [] as StrategyId[],
  preferredStrategies: [
    'SMC_LONG',
    'SMC_SHORT',
    'FVG_FILL',
    'BREAKOUT',
    'LIQUIDITY_SWEEP',
    'BREAKDOWN',
    'RSI_DIVERGENCE',
    'EMA_PULLBACK',
    'FIB_RETRACEMENT',
    'EMA_RSI_STRATEGY',
    'EMA_PULLBACK_SHORT',
    'SHORT_EMA_RESISTANCE',
    'EMA_MOMENTUM',
    'SHORT_FIB_RESISTANCE',
    'FIB_RETRACEMENT_SHORT',
  ],

  binanceEndpoints: [
    'https://api4.binance.com/api/v3', // Try this first fastest
    'https://api3.binance.com/api/v3', // Fallback
    'https://api.binance.com/api/v3', // Last resort stable
  ],

  // ============================================================================
  // CAPITAL MANAGEMENT (Dynamic)
  // ============================================================================
  totalCapital: parseFloat(process.env.TOTAL_CAPITAL || '200'),

  // ⚠️ ISSUE: availableCapital should be a VARIABLE, not a getter
  // Because it needs to be updated when positions open/close
  _availableCapital: 0, // Private variable

  // Reserve ratio (keep some capital free)
  reserveRatio: 0.2, // 10% reserve

  get availableCapital(): number {
    if (this._availableCapital === 0) {
      // ✅ Use full capital, no reserve needed
      this._availableCapital = this.totalCapital * (1 - this.reserveRatio);
    }
    return this._availableCapital;
  },

  set availableCapital(value: number) {
    this._availableCapital = value;
  },

  // ============================================================================
  // POSITION SIZING (Dynamic)
  // ============================================================================
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '1'),
  leverageMultiplier: 3,
  maxLeveragePerPosition: 1,
  timeframe: '15m',
  // ✅ NEW: Trade limit settings

  maxTradesPerSymbol: 10, // Max 1 trade per symbol (optional)
  maxTradesPerDay: 40, // Max 10 trades per day (optional)

  // maxTotalTrades: 15,
  stopOnLimit: true,
  saveAndExit: true,

  // Optional: Reset timer
  resetTradeCountDaily: false, // Reset count at midnight

  // ✅ MARGIN per position (what you allocate from capital)
  get marginPerPosition(): number {
    return Math.floor(this.availableCapital / this.maxConcurrentPositions);
    // 600 / 6 = 100 USDT margin per position
  },

  // Position size = Available capital / Max positions
  get positionSize(): number {
    return this.marginPerPosition * this.leverageMultiplier;
  },

  // Maximum notional value per position (with leverage)
  get maxNotionalPerPosition(): number {
    return this.marginPerPosition * this.leverageMultiplier;
  },

  // ============================================================================
  // ENTRY SETTINGS
  // ============================================================================
  requirePriceConfirmation: true,
  confirmationTicks: 3, // ✅ Changed from 3 to 0 (immediate entry)
  maxSlippagePercent: 1.0,

  // ============================================================================
  // ✅ OPTIMIZED EXIT STRATEGY (Hybrid Approach)
  // ============================================================================

  // 1. STOP LOSS & TAKE PROFIT (From signals)
  stopLossMultiplier: 1.0,
  takeProfitMultiplier: 3.0,

  // 2. BREAKEVEN PROTECTION ⭐ (Most Important!)
  breakEvenEnabled: true,
  breakEvenActivationPct: 5,
  breakEvenBuffer: 0.5,

  // 3. TRAILING STOP (Tighter than before)
  trailingStopEnabled: false,
  trailingStopPercent: 0.4,
  trailingStopActivationPct: 3.0,

  // 4. DYNAMIC TRAILING ⭐ (Gets tighter as profit grows)
  dynamicTrailingEnabled: true,
  dynamicTrailingLevels: [
    { minPnlPct: 0, trailingPct: 2.0 }, // 0-5%: 2% trailing
    { minPnlPct: 5, trailingPct: 1.5 }, // 5-10%: 1.5% trailing
    { minPnlPct: 10, trailingPct: 1.0 }, // 10%+: 1% trailing (tight)
  ],

  // 5. PARTIAL PROFIT TAKING ⭐ (Lock in gains)
  partialTakeProfitEnabled: true,
  partialTakeProfitLevels: [
    { pnlPct: 6, exitPercent: 33 }, // Take 1/3 at +6%
    { pnlPct: 12, exitPercent: 33 }, // Take 1/3 at +12%
    // Let last 1/3 ride with trailing stop
  ],

  // 6. TIME-BASED EXIT (Prevent stale positions)
  maxPositionDurationMs: 60 * 60 * 60 * 1000, // 6 hours max

  // 7. HARD STOPS (Safety net)
  maxLossPercent: 1.5, // Force close at -5% (on margin)
  maxProfitPercent: 25.0, // Take profit at +25% (rarely hit)

  // ============================================================================
  // SMC SETTINGS
  // ============================================================================
  smcEnabled: true,
  smcMinScore: 40,

  // ============================================================================
  // PERFORMANCE & DISPLAY
  // ============================================================================
  dashboardRefreshMs: 3000,
  priceUpdateInterval: 2000,

  liquidity: {
    enabled: true,
    minSpreadBps: 10, // 0.10% minimum spread
    maxSpreadBps: 50, // 0.50% maximum spread
    minDepthMultiplier: 10, // 10x position size in depth
    maxSlippagePct: 0.3, // 0.3% max slippage
    min24hVolumeUSD: 30_000_000, // $1M daily volume minimum

    liquidityTiers: {
      HIGH: { min24hVolumeUSD: 30_000_000, maxVolumeCV: 0.5 },
      MEDIUM: { min24hVolumeUSD: 30_000_000, maxVolumeCV: 1.0 },
    },
    volumeStabilityLookback: 20,
  },
};

// ============================================
// RECOMMENDED SETTINGS BY TRADING STYLE
// ============================================

export const TRADING_STYLE_CONFIGS = {
  // Conservative: Tight stops, lower R:R
  conservative: {
    slMultiplier: 1.2,
    tpMultiplier: 3.0,
    maxRiskPercent: 2.0,
    minRRRatio: 1.3,
  },

  // Balanced: Medium stops, good R:R
  balanced: {
    slMultiplier: 1.5,
    tpMultiplier: 3.0,
    maxRiskPercent: 3.0,
    minRRRatio: 1.5,
  },

  // Aggressive: Wider stops, higher R:R
  aggressive: {
    slMultiplier: 2.0,
    tpMultiplier: 4.0,
    maxRiskPercent: 4.0,
    minRRRatio: 1.8,
  },

  // Scalping: Very tight stops, quick profits
  scalping: {
    slMultiplier: 0.8,
    tpMultiplier: 1.5,
    maxRiskPercent: 1.5,
    minRRRatio: 1.2,
  },

  // Swing: Wide stops, patient profits
  swing: {
    slMultiplier: 2.5,
    tpMultiplier: 5.0,
    maxRiskPercent: 5.0,
    minRRRatio: 1.8,
  },
};

let reservedCapital = 0;

/**
 * Reserve capital for a new position
 */
function reserveCapital(amount: number): boolean {
  const available = CONFIG.availableCapital - reservedCapital;

  if (amount > available) {
    console.log(
      `❌ Insufficient capital: Need $${amount}, Available $${available.toFixed(2)}`
    );
    return false;
  }

  reservedCapital += amount;
  console.log(
    `💰 Reserved $${amount} | Total Reserved: $${reservedCapital}/$${CONFIG.availableCapital}`
  );
  return true;
}

/**
 * Release capital when closing position
 */
function releaseCapital(amount: number, pnl: number = 0): void {
  CONFIG.availableCapital += amount;
  CONFIG.totalCapital += pnl;

  // Ensure available doesn't exceed total
  if (CONFIG.availableCapital > CONFIG.totalCapital) {
    CONFIG.availableCapital = CONFIG.totalCapital;
  }

  console.log(
    `💰 Released $${amount.toFixed(2)}, PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
  );
  console.log(
    `   Total: $${CONFIG.totalCapital.toFixed(2)}, Available: $${CONFIG.availableCapital.toFixed(2)}`
  );
}

/**
 * Get current capital utilization
 */
// function getCapitalUtilization(): number {
//   return (
//     ((CONFIG.totalCapital - CONFIG.availableCapital) / CONFIG.totalCapital) *
//     100
//   );
// }

// ============================================================================
// VALIDATION FUNCTION
// ============================================================================

/**
 * Get current capital utilization
 */
function getCapitalUtilization(): {
  total: number;
  reserved: number;
  available: number;
  utilizationPercent: number;
} {
  const available = CONFIG.availableCapital - reservedCapital;
  const utilizationPercent = (reservedCapital / CONFIG.availableCapital) * 100;

  return {
    total: CONFIG.availableCapital,
    reserved: reservedCapital,
    available,
    utilizationPercent,
  };
}

/**
 * Validate configuration
 */
function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check capital settings
  if (CONFIG.availableCapital > CONFIG.totalCapital) {
    errors.push('Available capital cannot exceed total capital');
  }

  // Check position sizing
  const maxCapitalNeeded =
    CONFIG.maxConcurrentPositions * CONFIG.marginPerPosition;
  if (maxCapitalNeeded > CONFIG.availableCapital) {
    errors.push(
      `Position sizing error: ${CONFIG.maxConcurrentPositions} positions × ` +
        `$${CONFIG.marginPerPosition} = $${maxCapitalNeeded} exceeds available ` +
        `capital of $${CONFIG.availableCapital}`
    );
  }

  // Check leverage
  if (CONFIG.leverageMultiplier < 1 || CONFIG.leverageMultiplier > 125) {
    errors.push('Leverage must be between 1x and 125x');
  }

  // Check risk percentages
  if (CONFIG.defaultStopLossPercent >= CONFIG.defaultTakeProfitPercent) {
    errors.push('Stop loss % should be less than take profit %');
  }

  // Check Moray percentages
  if (CONFIG.morayConfig.enabled) {
    const totalPercent = CONFIG.morayConfig.partials.reduce(
      (sum, p) => sum + p.percent,
      0
    );
    if (Math.abs(totalPercent - 1.0) > 0.01) {
      errors.push(
        `Moray partial percentages must sum to 100% (currently ${(totalPercent * 100).toFixed(1)}%)`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

const BASE_CONFIG = {
  signalFile: './data/signals/futures-signals.json',
  // Trading parameters
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.02, // ✅ Default 2%
  ATR_STOP_MULTIPLIER: 2, // ✅ Default stop
  ATR_TP_MULTIPLIER: 2.5,
  LOOP_INTERVAL_MS: 30_000,
  MIN_TRADE_USDT: 5, // ✅ Default minimum

  // Indicator settings
  RSI_PERIOD: 14,
  EMA_SHORT: 50,
  EMA_LONG: 200,
  ATR_PERIOD: 14,
  RSI_MIN: 35,
  RSI_ENTRY_MIN: 35,
  RSI_ENTRY_MAX: 70,
  RSI_MAX: 65,
  RSI_OVERSOLD: 40,
  RSI_OVERBOUGHT: 70,
  CANDLE_LIMIT: 300,
  MIN_STOP_LOSS_PCT: 0.003,
  // Paper trading
  PAPER_TRADING: true,
  INITIAL_PAPER_BALANCE: 10000,
  SAFE_MODE: true,
  // Safety settings
  SLIPPAGE_BUFFER: 0.002, // ✅ Default 0.2%
  MAX_PRICE_MOVE_PCT: 0.05, // ✅ Default 5%
  MIN_VOLUME_RATIO: 0.6, // ✅ Default 60%
  MIN_RISK_REWARD: 1.5,

  ENABLE_LONGS: POSITION_TYPE === 'LONG' || POSITION_TYPE === 'BOTH',
  ENABLE_SHORTS: POSITION_TYPE === 'SHORT' || POSITION_TYPE === 'BOTH',
  REQUIRE_HTF_ALIGNMENT: false,
  ENABLE_COUNTER_TREND_SCALPING: true,
  ALLOW_HIGH_VOLATILITY: true,

  // Fibonacci settings
  FIB_LOCK_DURATION_MS: 4 * 60 * 60 * 1000, // 4 hours
  FIB_SWING_LOOKBACK: 50,

  // Cooldown settings
  COOLDOWN_AFTER_LOSS_MS: 10 * 60 * 1000,
  COOLDOWN_AFTER_WIN_MS: 5 * 60 * 1000,
  COOLDOWN_AFTER_CONSECUTIVE_LOSSES_MS: 60 * 60 * 1000,
  MAX_CONSECUTIVE_LOSSES: 3,
  RECENT_TRADE_MEMORY_MS: 60 * 60 * 1000, // 1 hour
  RECENT_TRADE_PRICE_THRESHOLD: 0.01, // 1%

  // Partial profit settings
  PARTIAL_TP1_RATIO: 0.5,
  PARTIAL_TP1_R: 1.5,
  PARTIAL_TP2_R: 2.5,

  SCALP_STOP_MULTIPLIER: 0.8,
  SCALP_TP1_R: 0.8,
  SCALP_TP2_R: 1.2,
  SCALP_RISK_PER_TRADE: 0.02,

  MIN_CONFIDENCE_LONG: 0.4,
  MIN_CONFIDENCE_SHORT: 0.4,
  MIN_CONFIDENCE_COUNTER_TREND: 0.3,

  //==== CAPITAL ALLOCATION =====
  TOTAL_CAPITAL: 200, //#// Total available capital (USDT)
  MAX_CONCURRENT_POSITIONS: 10, //#// Max positions at once
  MAX_ACTIVE_BOTS: 55,
  MAX_BOTS: 55,
  ALLOCATION_STRATEGY: 'DYNAMIC_POOL', //#// EQUAL_FIXED | DYNAMIC_POOL | RISK_BASED | TIERED
  // RISK_PER_TRADE:0.02,                   //#// 2% risk per trade (for RISK_BASED)
  RESERVE_RATIO: 0.1, //#// Keep 10% in reserve

  // Time filtering (UTC hours)
  AVOID_HOURS: [13, 14, 15] as number[], // NY open
};

const QUICK_TEST_CONFIG = {
  ...BASE_CONFIG,

  // 🚀 Fast but observable (30s-3min closes)
  MIN_STOP_LOSS_PCT: 0.0001,
  ATR_STOP_MULTIPLIER: 0.2, // ~0.5% stop
  ATR_TP_MULTIPLIER: 0.4, // ~0.8% TP

  SCALP_STOP_MULTIPLIER: 0.4,
  SCALP_TP1_R: 0.5,
  SCALP_TP2_R: 0.8,

  PARTIAL_TP1_R: 0.3,
  PARTIAL_TP2_R: 0.6,

  // Easy entries
  RSI_MIN: 20,
  RSI_MAX: 80,
  MIN_CONFIDENCE_LONG: 0.2,
  MIN_CONFIDENCE_SHORT: 0.2,
  MIN_CONFIDENCE_COUNTER_TREND: 0.15,
  MAX_CONCURRENT_POSITIONS: 56,

  // Relaxed safety
  MAX_PRICE_MOVE_PCT: 0.5,
  MIN_VOLUME_RATIO: 0.2,
  MIN_RISK_REWARD: 0.5,

  // Speed
  LOOP_INTERVAL_MS: 10_000, // 10 seconds
  COOLDOWN_AFTER_LOSS_MS: 1 * 60 * 1000, // 1 min
  COOLDOWN_AFTER_CONSECUTIVE_LOSSES_MS: 2 * 60 * 1000,

  // No restrictions
  AVOID_HOURS: [] as number[],
};
// ---------- SYMBOL-SPECIFIC CONFIGS ----------
const BTC_CONFIG = {
  ...BASE_CONFIG, // ✅ Spread FIRST (gets all defaults)
  SYMBOL: 'BTCUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  // ✅ Override only what's different
  RISK_PER_TRADE: 0.02, // Override: 1.5% instead of 2%
  MIN_TRADE_USDT: 5, // Override: $10 instead of $5
  SLIPPAGE_BUFFER: 0.001, // Override: 0.1% instead of 0.2%
  MAX_PRICE_MOVE_PCT: 0.03, // Override: 3% instead of 5%
  ATR_STOP_MULTIPLIER: 2.2, // Override: 2.2x instead of 2x
  MIN_VOLUME_RATIO: 0.7, // Override: 70% instead of 60%
};

const ETH_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ETHUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  RISK_PER_TRADE: 0.02,
  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0015,
  MAX_PRICE_MOVE_PCT: 0.04,
  ATR_STOP_MULTIPLIER: 2.0,
};

const PAXG_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'PAXGUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  RISK_PER_TRADE: 0.02,
  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0015,
  MAX_PRICE_MOVE_PCT: 0.04,
  ATR_STOP_MULTIPLIER: 2.0,
};

const SOL_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'SOLUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  RISK_PER_TRADE: 0.02,
  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0015,
  MAX_PRICE_MOVE_PCT: 0.04,
  ATR_STOP_MULTIPLIER: 2.0,
};

const ZEC_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ZECUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // SOL more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const AAVE_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'AAVEUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // SOL more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const LTC_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'LTCUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // LTC more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const QNT_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'QNTUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // QNT more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const PEPE_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'PEPEUSDT',
  TIMEFRAME: '15m' as Timeframe, // Override
  HTF_TIMEFRAME: '1h' as Timeframe, // Override

  // Aggressive for meme coins
  RISK_PER_TRADE: 0.03, // 3%
  ATR_STOP_MULTIPLIER: 1.5, // Tight stops
  ATR_TP_MULTIPLIER: 2.0, // Quick exits
  LOOP_INTERVAL_MS: 15_000, // Check every 15s

  // Lenient safety
  MIN_VOLUME_RATIO: 0.3, // 30%
  MAX_PRICE_MOVE_PCT: 0.15, // 15% moves normal
  MIN_RISK_REWARD: 1.3,
  SLIPPAGE_BUFFER: 0.005, // 0.5%

  // Faster recovery
  COOLDOWN_AFTER_LOSS_MS: 10 * 60 * 1000, // 10 min
  COOLDOWN_AFTER_CONSECUTIVE_LOSSES_MS: 30 * 60 * 1000, // 30 min
  MAX_CONSECUTIVE_LOSSES: 2,

  // Adjusted RSI
  RSI_MIN: 30,
  RSI_MAX: 70,
  RSI_OVERBOUGHT: 75,

  // Trade 24/7
  AVOID_HOURS: [] as number[],

  // Shorter fib lock
  FIB_LOCK_DURATION_MS: 2 * 60 * 60 * 1000, // 2h
  FIB_SWING_LOOKBACK: 30,
};

const XPL_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'XPLUSDT',
};

const WLFI_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'WLFIUSDT',
  TIMEFRAME: '30m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const VIRTUAL_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'VIRTUALUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const ENA_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ENAUSDT',
};

const XRP_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'XRPUSDT',
};
const SATS_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'SATSUSDT',
};

const STX_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'STXUSDT',
};

const INJ_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'INJUSDT',
};

const ADA_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ADAUSDT',
};

const HBAR_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'HBARUSDT',
};

const PHB_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'PHBUSDT',
};

const JUP_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'JUPUSDT',
};

const WLD_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'WLDUSDT',
};

const ONDO_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ONDOUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const IMX_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'IMXUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const CONFIG_2Z = {
  ...BASE_CONFIG,
  SYMBOL: '2ZUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const ARB_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ARBUSDT',
};

const RENDER_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'RENDERUSDT',
};

const TIA_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'TIAUSDT',
};

const LDO_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'LDOUSDT',
};

const SEI_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'SEIUSDT',
};

const TRX_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'TRXUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const CRV_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'CRVUSDT',
};

const FET_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'FETUSDT',
};

const ETHFI_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ETHFIUSDT',
};

const XLM_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'XLMUSDT',
};

const CAKE_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'CAKEUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const ASTER_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ASTERUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const NEXO_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'NEXOUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const KAIA_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'KAIAUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const AVAX_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'AVAXUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const ZEN_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'ZENUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const LINK_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'LINKUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const AXS_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'AXSUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const NEAR_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'NEARUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const TON_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'TONUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const SOMI_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'SOMIUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const SUI_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'SUIUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const HYPE_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'HYPEUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const BNB_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'BNBUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.02,
  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0018,
  MAX_PRICE_MOVE_PCT: 0.045,
  ATR_STOP_MULTIPLIER: 2.0,
};

const BCH_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'BCHUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.02,
  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0018,
  MAX_PRICE_MOVE_PCT: 0.045,
  ATR_STOP_MULTIPLIER: 2.0,
};

const DOGE_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'DOGEUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const GRT_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'GRTUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const OP_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'OPUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const SKY_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'SKYUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const SHIB_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'SHIBUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const PUMP_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'PUMPUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const PENGU_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'PENGUUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const VET_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'VETUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const FLOKI_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'FLOKIUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const BONK_CONFIG = {
  ...BASE_CONFIG,
  SYMBOL: 'BONKUSDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.025,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const FUTURES_SYMBOL_CONFIGS: Record<string, any> = {
  '1000BONKUSDT': BONK_CONFIG,
  '1000FLOKIUSDT': FLOKI_CONFIG,
  '1000PEPEUSDT': PEPE_CONFIG,
  '1000SATS/USDT': SATS_CONFIG,
  '1000SHIBUSDT': SHIB_CONFIG,
  '2ZUSDT': CONFIG_2Z,
  AAVEUSDT: AAVE_CONFIG,
  ADAUSDT: ADA_CONFIG,
  ARBUSDT: ARB_CONFIG,
  ASTERUSDT: ASTER_CONFIG,
  AVAXUSDT: AVAX_CONFIG,
  AXSUSDT: AXS_CONFIG,
  BCHUSDT: BCH_CONFIG,
  BNBUSDT: BNB_CONFIG,
  BTCUSDT: BTC_CONFIG,
  CAKEUSDT: CAKE_CONFIG,
  CRVUSDT: CRV_CONFIG,
  DOGEUSDT: DOGE_CONFIG,
  ENAUSDT: ENA_CONFIG,
  ETHFIUSDT: ETHFI_CONFIG,
  ETHUSDT: ETH_CONFIG,
  FETUSDT: FET_CONFIG,
  GRTUSDT: GRT_CONFIG,
  HBARUSDT: HBAR_CONFIG,
  HYPEUSDT: HYPE_CONFIG,
  IMXUSDT: IMX_CONFIG,
  INJUSDT: INJ_CONFIG,
  JUPUSDT: JUP_CONFIG,
  KAIAUSDT: KAIA_CONFIG,
  LDOUSDT: LDO_CONFIG,
  LINKUSDT: LINK_CONFIG,
  LTCUSDT: LTC_CONFIG,
  NEARUSDT: NEAR_CONFIG,
  ONDOUSDT: ONDO_CONFIG,
  OPUSDT: OP_CONFIG,
  PAXGUSDT: PAXG_CONFIG,
  PENGUUSDT: PENGU_CONFIG,
  PHBUSDT: PHB_CONFIG,
  PUMPUSDT: PUMP_CONFIG,
  QNTUSDT: QNT_CONFIG,
  RENDERUSDT: RENDER_CONFIG,
  SEIUSDT: SEI_CONFIG,
  SKYUSDT: SKY_CONFIG,
  SOLUSDT: SOL_CONFIG,
  SOMIUSDT: SOMI_CONFIG,
  STXUSDT: STX_CONFIG,
  SUIUSDT: SUI_CONFIG,
  TIAUSDT: TIA_CONFIG,
  TONUSDT: TON_CONFIG,
  TRXUSDT: TRX_CONFIG,
  VETUSDT: VET_CONFIG,
  VIRTUALUSDT: VIRTUAL_CONFIG,
  WLDUSDT: WLD_CONFIG,
  WLFIUSDT: WLFI_CONFIG,
  XLMUSDT: XLM_CONFIG,
  XPLUSDT: XPL_CONFIG,
  XRPUSDT: XRP_CONFIG,
  ZECUSDT: ZEC_CONFIG,
  ZENUSDT: ZEN_CONFIG,
};

// ---------- CONFIG BUILDER ----------
function getFuturesConfigForSymbol(symbol: string) {
  // Check if quick test mode is enabled
  if (process.env.QUICK_TEST === 'true') {
    console.log('🚀 QUICK TEST MODE ENABLED - Ultra-tight stops active!');
    return { ...QUICK_TEST_CONFIG, SYMBOL: symbol };
  }

  const symbolConfig =
    FUTURES_SYMBOL_CONFIGS[symbol as keyof typeof FUTURES_SYMBOL_CONFIGS];

  if (!symbolConfig) {
    console.warn(
      `⚠️ No config found for ${symbol}, using BASE_CONFIG with symbol override`
    );
    return { ...BASE_CONFIG, SYMBOL: symbol };
  }

  // Already merged via spread operator in each config
  return symbolConfig;
}

// ---------- EXPORT ----------
const ACTIVE_FUTURES_SYMBOL = process.env.TRADING_SYMBOL_FUTURES || 'SOLUSDT';
export const FUTURES_CONFIG = getFuturesConfigForSymbol(ACTIVE_FUTURES_SYMBOL);

export { getFuturesConfigForSymbol };

export {
  CONFIG,
  reserveCapital,
  releaseCapital,
  getCapitalUtilization,
  validateConfig,
};
export {
  BASE_CONFIG,
  AAVE_CONFIG,
  ADA_CONFIG,
  ARB_CONFIG,
  ASTER_CONFIG,
  AVAX_CONFIG,
  AXS_CONFIG,
  BCH_CONFIG,
  BNB_CONFIG,
  BONK_CONFIG,
  BTC_CONFIG,
  CAKE_CONFIG,
  CONFIG_2Z,
  CRV_CONFIG,
  DOGE_CONFIG,
  ENA_CONFIG,
  ETH_CONFIG,
  ETHFI_CONFIG,
  FET_CONFIG,
  FLOKI_CONFIG,
  GRT_CONFIG,
  HBAR_CONFIG,
  IMX_CONFIG,
  INJ_CONFIG,
  JUP_CONFIG,
  KAIA_CONFIG,
  LDO_CONFIG,
  LINK_CONFIG,
  LTC_CONFIG,
  NEAR_CONFIG,
  ONDO_CONFIG,
  OP_CONFIG,
  PAXG_CONFIG,
  PENGU_CONFIG,
  PEPE_CONFIG,
  PHB_CONFIG,
  PUMP_CONFIG,
  QNT_CONFIG,
  RENDER_CONFIG,
  SATS_CONFIG,
  SEI_CONFIG,
  SHIB_CONFIG,
  SKY_CONFIG,
  SOL_CONFIG,
  SOMI_CONFIG,
  STX_CONFIG,
  SUI_CONFIG,
  TIA_CONFIG,
  TON_CONFIG,
  TRX_CONFIG,
  VET_CONFIG,
  VIRTUAL_CONFIG,
  WLD_CONFIG,
  WLFI_CONFIG,
  XLM_CONFIG,
  XPL_CONFIG,
  XRP_CONFIG,
  ZEC_CONFIG,
  ZEN_CONFIG,
  FUTURES_SYMBOL_CONFIGS,
  QUICK_TEST_CONFIG,
};

const PESKY_TOKENS = {
  // 🚩 CATEGORY 1: Obvious Meme/Scam Names
  obviousShit: [
    'FARTCOIN/USDT', // 💩 Literally fart
    'BROCCOLI714/USDT', // 🥦 What even is this?
    'MELANIA/USDT', // 🚩 Political meme
    'TRUMP/USDT', // 🚩 Political meme (you already know this one!)
    'PIPPIN/USDT', // 🐸 Random meme
    'SYRUP/USDT', // 🥞 Food token? Really?
    'NIGHT/USDT', // 🌙 Generic name
    'M/USDT', // 🤔 Single letter? Sus
    'IP/USDT', // 🤔 Another single letter
    'CC/USDT', // 🤔 Two letters? Still sus
    '币安人生/USDT', // 🇨🇳 Chinese characters (might cause issues)
  ],

  // 🚩 CATEGORY 2: Ultra Low Cap / New Scams
  suspiciousNewTokens: [
    '2Z/USDT', // 🚩 Weird name
    'BREV/USDT', // 🚩 Never heard of it
    'TST/USDT', // 🚩 "Test"? Really?
    'ZBT/USDT', // 🚩 Random letters
    'XPL/USDT', // 🚩 Unknown
    'MYX/USDT', // 🚩 Very new
    'SOMI/USDT', // 🚩 Unknown project
    'KAITO/USDT', // 🚩 Anime reference?
    'WLFI/USDT', // 🚩 Random letters
  ],

  // 🚩 CATEGORY 3: Dead/Dying Tokens
  deadOrDying: [
    'LUNC/USDT', // 💀 Terra Luna Classic (dead)
    'BTT/USDT', // 💀 BitTorrent (dead project)
    'JST/USDT', // 💀 JUST (Tron ecosystem, dead)
    'SUN/USDT', // 💀 Sun Token (Tron, dead)
    'BSV/USDT', // 💀 Bitcoin SV (Craig Wright scam)
    'PHB/USDT', // 💀 Phoenix (dead project)
    'PROM/USDT', // 💀 Prometeus (low activity)
  ],

  // ⚠️ CATEGORY 4: High Risk Meme Coins (Optional to filter)
  highRiskMemes: [
    'SHIB/USDT', // 🐕 Shiba Inu (pure meme)
    'PEPE/USDT', // 🐸 Pepe (pure meme)
    'FLOKI/USDT', // 🐕 Floki (Elon meme)
    'BONK/USDT', // 🐕 Bonk (Solana meme)
    'WIF/USDT', // 🐕 Dogwifhat (meme)
    'MEME/USDT', // 🎭 Memecoin (literally meme)
    'SATS/USDT', // 🚩 Ordinals meme
    'RATS/USDT', // 🐀 Another ordinals meme
  ],
};

export const COMPLETE_BLOCKLIST = [
  // ...PESKY_TOKENS.obviousShit,
  // ...PESKY_TOKENS.suspiciousNewTokens,
  // ...PESKY_TOKENS.deadOrDying,
  // Uncomment if you want to block meme coins too:
  // ...PESKY_TOKENS.highRiskMemes,
  '',
];

console.log(`🚫 Blocking ${COMPLETE_BLOCKLIST.length} pesky tokens`);

// ═══════════════════════════════════════════════════════════════
// STEP 3: Filter function
// ═══════════════════════════════════════════════════════════════

export function filterPeskyTokens(
  symbolList: string[],
  market: MarketType = 'FUTURES'
): string[] {
  const blockedSet = new Set(COMPLETE_BLOCKLIST);

  const filtered = symbolList.filter((symbol) => {
    // Normalize symbol (add /USDT if missing)
    // const normalizedSymbol = symbol.includes('/') ? symbol : `${symbol}/USDT`;
    const normalizedSymbol = normalize(symbol, market);

    if (blockedSet.has(normalizedSymbol)) {
      console.log(`🚫 Blocked pesky token: ${normalizedSymbol}`);
      return false;
    }

    return true;
  });

  console.log(
    `\n✅ Filtered: ${symbolList.length} → ${filtered.length} tokens`
  );
  console.log(
    `🗑️ Removed: ${symbolList.length - filtered.length} pesky tokens\n`
  );

  return filtered;
}

// export const YOUR_SYMBOLS = [
//   '2Z/USDT',
//   'XEC/USDT',
//   'LUNC/USDT',
//   'PEPE/USDT',
//   'AAVE/USDT',
//   'ADA/USDT',
//   'APT/USDT',
//   'ARB/USDT',
//   'ATOM/USDT',
//   'AERO/USDT',
//   'AVAX/USDT',
//   'AXS/USDT',
//   'BCH/USDT',
//   'BEAT/USDT',
//   'BREV/USDT',
//   'BTC/USDT',
//   'BNB/USDT',
//   'BONK/USDT',
//   'BSV/USDT',
//   'BULLA/USDT',
//   'CAKE/USDT',
//   'CC/USDT',
//   'CHZ/USDT',
//   'CRV/USDT',
//   'CYS/USDT',
//   'ENA/USDT',
//   'ETH/USDT',
//   'FARTCOIN/USDT',
//   'FET/USDT',
//   'FIL/USDT',
//   'FLUID/USDT',
//   'FOGO/USDT',
//   'DASH/USDT',
//   'DOGE/USDT',
//   'DOT/USDT',
//   'DUSK/USDT',
//   'G/USDT',
//   'GALA/USDT',
//   'GALA/USDT',
//   'GLM/USDT',
//   'GTC/USDT',
//   'HYPE/USDT',
//   'HBAR/USDT',
//   'ICP/USDT',
//   'ICNT/USDT',
//   'IMX/USDT',
//   'INJ/USDT',
//   'IP/USDT',
//   'IOTA/USDT',
//   'JASMY/USDT',
//   'JST/USDT',
//   'JOE/USDT',
//   'JUP/USDT',
//   'KAIA/USDT',
//   'KITE/USDT',
//   'LIT/USDT',
//   'LPT/USDT',
//   'LTC/USDT',
//   'LDO/USDT',
//   'LINK/USDT',
//   'M/USDT',
//   'MASK/USDT',
//   'MORPHO/USDT',
//   'MEME/USDT',
//   'MBOX/USDT',
//   'MEW/USDT',
//   'MYX/USDT',
//   'NEXO/USDT',
//   'NEAR/USDT',
//   'NIGHT/USDT',
//   'NOT/USDT',
//   'ONDO/USDT',
//   'OP/USDT',
//   'PAXG/USDT',
//   'PENGU/USDT',
//   'PIPPIN/USDT',
//   'PHB/USDT',
//   'PLAY/USDT',
//   'PENDLE/USDT',
//   'PIEVERSE/USDT',
//   'PIPPIN/USDT',
//   'PROM/USDT',
//   'POL/USDT',
//   'PUMP/USDT',
//   'PYTH/USDT',
//   'ONT/USDT',
//   'QNT/USDT',
//   'SUI/USDT',
//   'RATS/USDT',
//   'RIF/USDT',
//   'RENDER/USDT',
//   'RUNE/USDT',
//   'RED/USDT',
//   'SEI/USDT',
//   'SENT/USDT',
//   'SKY/USDT',
//   'SOL/USDT',
//   'SOMI/USDT',
//   'STX/USDT',
//   'STRK/USDT',
//   'SYRUP/USDT',
//   'SUN/USDT',
//   'TAO/USDT',
//   'TIA/USDT',
//   'TST/USDT',
//   'TRX/USDT',
//   'TUT/USDT',
//   'TON/USDT',
//   'UNI/USDT',
//   'VET/USDT',
//   'VIRTUAL/USDT',
//   'WLD/USDT',
//   'WIF/USDT',
//   'WOO/USDT',
//   'XMR/USDT',
//   'XRP/USDT',
//   'XTZ/USDT',
//   'XPL/USDT',
//   'XLM/USDT',
//   'ZEC/USDT',
//   'ZEN/USDT',
//   'ZK/USDT',
// ];

export const YOUR_SYMBOLS = [
  ...SYMBOLS,
  // ...MSCI_LARGE_CUP,
  // ...MSCI_MID_CUP,
  // ...MSCI_SMALL_CUP,
  // ...MSCI_TINY_CUP,
];

const CLEAN_SYMBOLS = filterPeskyTokens(YOUR_SYMBOLS);

const removed = YOUR_SYMBOLS.filter((s) => !CLEAN_SYMBOLS.includes(s));

const categories = {
  'Obvious Scams': PESKY_TOKENS.obviousShit,
  'Suspicious New': PESKY_TOKENS.suspiciousNewTokens,
  'Dead/Dying': PESKY_TOKENS.deadOrDying,
};

Object.entries(categories).forEach(([category, tokens]) => {
  const categoryRemoved = removed.filter((s) => tokens.includes(s));
  if (categoryRemoved.length > 0) {
    console.log(`\n${category}:`);
    categoryRemoved.forEach((token) => console.log(`  🚫 ${token}`));
  }
});

export type BotFutureConfig = typeof FUTURES_CONFIG;
