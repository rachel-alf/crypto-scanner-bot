import * as dotenv from 'dotenv';

import type { StrategyId } from '../../lib/type.js';

dotenv.config();
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

const REAL_BASE_CONFIG = {
  signalFile: '../data/signals/futures-signals.json',

  signalCheckInterval: 10000,
  signalExpiryMs: 10 * 60 * 1000,
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),
  // ============================================================================
  // 💰 CAPITAL - Lock the prison doors tight this time
  // ============================================================================
  totalCapital: parseFloat(process.env.TOTAL_CAPITAL || '200'),
  blockedStrategies: [] as StrategyId[],
  get positionSize(): number {
    return Math.floor(this.availableCapital / this.maxConcurrentPositions);
  },

  // ⚠️ ISSUE: availableCapital should be a VARIABLE, not a getter
  // Because it needs to be updated when positions open/close
  _availableCapital: 0, // Private variable

  // Reserve ratio (keep some capital free)
  reserveRatio: 0.1, // 10% reserve

  get availableCapital(): number {
    // If not initialized, calculate from total capital
    if (this._availableCapital === 0) {
      this._availableCapital = this.totalCapital * (1 - this.reserveRatio);
    }
    return this._availableCapital;
  },

  set availableCapital(value: number) {
    this._availableCapital = value;
  },

  MAX_CONCURRENT_POSITIONS: 2,
  RISK_PER_TRADE: 0.01, // ✅ Reduced to 2% (safer)
  RESERVE_RATIO: 0.1,
  MIN_TRADE_USDT: 5,
  ALLOCATION_STRATEGY: 'EQUAL_FIXED' as const,

  // ============================================================================
  // ⏰ TIMEFRAMES - Slower = Less chaos
  // ============================================================================
  TIMEFRAME: '15m' as const, // 🔒 1 hour (not 15min chaos)
  HTF_TIMEFRAME: '4h' as const, // 🔒 4 hour filter
  LOOP_INTERVAL_MS: 60_000, // Check every 1 min (not 30s)
  CANDLE_LIMIT: 310,

  RSI_PERIOD: 14,
  EMA_8: 8,
  EMA_21: 21,
  EMA_50: 50,
  EMA_200: 200,
  ATR_PERIOD: 14,

  // ============================================================================
  // 🎯 ENTRY RULES - VERY STRICT (Remember the prisoners!)
  // ============================================================================

  RSI_MIN: 30, // ✅ CHANGED: Only enter when truly oversold
  RSI_MAX: 45, // ✅ CHANGED: Avoid the danger zone (50-65)
  RSI_OVERSOLD: 30,
  RSI_OVERBOUGHT: 75,
  RSI_ENTRY_MIN: 30,
  RSI_ENTRY_MAX: 45, // ✅ CHANGED: Match RSI_MAX

  // Confidence
  MIN_CONFIDENCE_LONG: 0.7, // ✅ CHANGED: Increased from 0.65
  MIN_CONFIDENCE_SHORT: 0.75, // ✅ CHANGED: Increased from 0.70
  MIN_CONFIDENCE_COUNTER_TREND: 0.8,

  // ============================================================================
  // 🛡️ SAFETY - MAXIMUM PROTECTION
  // ============================================================================

  REQUIRE_HTF_ALIGNMENT: true,
  ENABLE_LONGS: true,
  ENABLE_SHORTS: false,
  ENABLE_COUNTER_TREND_SCALPING: false,
  ALLOW_HIGH_VOLATILITY: false,

  ATR_STOP_MULTIPLIER: 0.4, // ✅ CRITICAL: Increased from 2.5 to 4.0
  ATR_TP_MULTIPLIER: 2.6, // ✅ CRITICAL: Increased from 3.0 to 6.0
  MIN_RISK_REWARD: 2.0,

  SLIPPAGE_BUFFER: 0.002,
  MAX_PRICE_MOVE_PCT: 0.03,
  MIN_VOLUME_RATIO: 0.7,
  MIN_STOP_LOSS_PCT: 0.01,

  // ============================================================================
  // 🧊 COOLDOWN - AGGRESSIVE PROTECTION
  // ============================================================================

  COOLDOWN_AFTER_LOSS_MS: 30 * 60 * 1000, // 🔒 30 min timeout
  COOLDOWN_AFTER_CONSECUTIVE_LOSSES_MS: 2 * 60 * 60 * 1000, // 🔒 4 HOURS!
  MAX_CONSECUTIVE_LOSSES: 2, // 🔒 Stop after JUST 1 LOSS!

  // Why 1? Because you've seen what 2-3 losses in a row feels like.
  // Better to pause, reassess, wait for perfect setup.

  RECENT_TRADE_MEMORY_MS: 2 * 60 * 60 * 1000, // 🔒 2 hours memory
  RECENT_TRADE_PRICE_THRESHOLD: 0.008, // 🔒 0.8% (tight)

  // ============================================================================
  // 💎 PARTIAL PROFITS - LOCK GAINS FAST
  // ============================================================================

  PARTIAL_TP1_RATIO: 0.5, // ✅ CHANGED: Take 50% at TP1 (let more run)
  PARTIAL_TP1_R: 2.0, // ✅ CHANGED: First target at 2R
  PARTIAL_TP2_R: 4.0,

  // ============================================================================
  // 🚫 DISABLED FEATURES (No funny business)
  // ============================================================================

  SCALP_STOP_MULTIPLIER: 1.0,
  SCALP_TP1_R: 1.0,
  SCALP_TP2_R: 1.5,
  SCALP_RISK_PER_TRADE: 0.01,

  // ============================================================================
  // 📈 FIBONACCI
  // ============================================================================

  FIB_LOCK_DURATION_MS: 6 * 60 * 60 * 1000, // 🔒 6 hours (longer lock)
  FIB_SWING_LOOKBACK: 50,

  // ============================================================================
  // ⏰ TIME FILTERING
  // ============================================================================

  AVOID_HOURS: [13, 14, 15] as number[], // 🔒 Avoid NY open (volatile)

  // ============================================================================
  // 🎯 MODE
  // ============================================================================

  PAPER_TRADING: true, // You can go live with this
  INITIAL_PAPER_BALANCE: 200,
  TESTNET: true,

  smcEnabled: true, // ✅ Make sure this is true
  smcMinScore: 40, // ✅ Lowered threshold
  minConfidence: 70, // ✅ Lower to catch more signals (was 70)

  dashboardRefreshMs: 3000,
  priceUpdateInterval: 2000,

  liquidity: {
    enabled: true,
    minSpreadBps: 10, // 0.10% minimum spread
    maxSpreadBps: 50, // 0.50% maximum spread
    minDepthMultiplier: 10, // 10x position size in depth
    maxSlippagePct: 0.3, // 0.3% max slippage
    min24hVolumeUSD: 5_000_000, // $1M daily volume minimum
  },
};

// ---------- BASE CONFIG (SHARED DEFAULTS) ----------
const BASE_CONFIG = {
  // Trading parameters
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  RISK_PER_TRADE: 0.01, // ✅ Default 2%
  ATR_STOP_MULTIPLIER: 2, // ✅ Default stop
  ATR_TP_MULTIPLIER: 2.5,
  LOOP_INTERVAL_MS: 30_000,
  MIN_TRADE_USDT: 5, // ✅ Default minimum
  TESTNET: false,
  // Indicator settings
  RSI_PERIOD: 14,
  EMA_SHORT: 50,
  EMA_LONG: 200,
  ATR_PERIOD: 14,
  RSI_MIN: 35,
  RSI_MAX: 65,
  RSI_ENTRY_MIN: 30,
  RSI_ENTRY_MAX: 70,
  RSI_OVERSOLD: 40,
  RSI_OVERBOUGHT: 70,
  CANDLE_LIMIT: 210,
  MIN_STOP_LOSS_PCT: 0.003,

  // Paper trading
  PAPER_TRADING: true,
  INITIAL_PAPER_BALANCE: 10000,

  ENABLE_LONGS: POSITION_TYPE === 'LONG' || POSITION_TYPE === 'BOTH',
  ENABLE_SHORTS: POSITION_TYPE === 'SHORT' || POSITION_TYPE === 'BOTH',
  REQUIRE_HTF_ALIGNMENT: false,
  ENABLE_COUNTER_TREND_SCALPING: true,
  ALLOW_HIGH_VOLATILITY: true,

  // Safety settings
  SLIPPAGE_BUFFER: 0.002, // ✅ Default 0.2%
  MAX_PRICE_MOVE_PCT: 0.05, // ✅ Default 5%
  MIN_VOLUME_RATIO: 0.6, // ✅ Default 60%
  MIN_RISK_REWARD: 1.5,

  // Fibonacci settings
  FIB_LOCK_DURATION_MS: 4 * 60 * 60 * 1000, // 4 hours
  FIB_SWING_LOOKBACK: 50,

  SCALP_STOP_MULTIPLIER: 0.8,
  SCALP_TP1_R: 0.8,
  SCALP_TP2_R: 1.2,
  SCALP_RISK_PER_TRADE: 0.02,

  // Cooldown settings
  COOLDOWN_AFTER_LOSS_MS: 15 * 60 * 1000,
  COOLDOWN_AFTER_CONSECUTIVE_LOSSES_MS: 60 * 60 * 1000,
  MAX_CONSECUTIVE_LOSSES: 3,
  RECENT_TRADE_MEMORY_MS: 60 * 60 * 1000, // 1 hour
  RECENT_TRADE_PRICE_THRESHOLD: 0.01, // 1%

  // Partial profit settings
  PARTIAL_TP1_RATIO: 0.5,
  PARTIAL_TP1_R: 1.5,
  PARTIAL_TP2_R: 2.5,

  MIN_CONFIDENCE_LONG: 0.4,
  MIN_CONFIDENCE_SHORT: 0.4,
  MIN_CONFIDENCE_COUNTER_TREND: 0.3,

  //==== CAPITAL ALLOCATION =====
  TOTAL_CAPITAL: 10000, //#// Total available capital (USDT)
  MAX_CONCURRENT_POSITIONS: 56, //#// Max positions at once
  ALLOCATION_STRATEGY: 'DYNAMIC_POOL', //#// EQUAL_FIXED | DYNAMIC_POOL | RISK_BASED | TIERED
  RESERVE_RATIO: 0.1, //#// Keep 10% in reserve

  // Time filtering (UTC hours)
  AVOID_HOURS: [13, 14, 15] as number[], // NY open
};

// ---------- SYMBOL-SPECIFIC CONFIGS ----------
const BTC_CONFIG = {
  ...REAL_BASE_CONFIG, // ✅ Spread FIRST (gets all defaults)
  SYMBOL: 'BTC/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  // ✅ Override only what's different
  // Override: 1.5% instead of 2%
  MIN_TRADE_USDT: 5, // Override: $10 instead of $5
  SLIPPAGE_BUFFER: 0.001, // Override: 0.1% instead of 0.2%
  MAX_PRICE_MOVE_PCT: 0.03, // Override: 3% instead of 5%
  ATR_STOP_MULTIPLIER: 2.2, // Override: 2.2x instead of 2x
  MIN_VOLUME_RATIO: 0.7, // Override: 70% instead of 60%
};

const ETH_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ETH/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0015,
  MAX_PRICE_MOVE_PCT: 0.04,
  ATR_STOP_MULTIPLIER: 2.0,
};

const PAXG_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'PAXG/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0015,
  MAX_PRICE_MOVE_PCT: 0.04,
  ATR_STOP_MULTIPLIER: 2.0,
};

const SOL_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'SOL/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0015,
  MAX_PRICE_MOVE_PCT: 0.04,
  ATR_STOP_MULTIPLIER: 2.0,
};

const ZEC_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ZEC/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // SOL more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const AAVE_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'AAVE/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // SOL more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const LTC_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'LTC/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // LTC more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const QNT_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'QNT/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  // Uses BASE_CONFIG for most values
  // Only override what's different
  MAX_PRICE_MOVE_PCT: 0.06, // QNT more volatile
  ATR_STOP_MULTIPLIER: 1.8,
};

const PEPE_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'PEPE/USDT',
  TIMEFRAME: '15m' as Timeframe, // Override
  HTF_TIMEFRAME: '1h' as Timeframe, // Override

  // Aggressive for meme coins
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
  ...REAL_BASE_CONFIG,
  SYMBOL: 'XPL/USDT',
};

const WLFI_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'WLFI/USDT',
  TIMEFRAME: '30m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const VIRTUAL_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'VIRTUAL/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const ENA_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ENA/USDT',
};

const XRP_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'XRP/USDT',
};

const STX_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'STX/USDT',
};

const INJ_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'INJ/USDT',
};

const ADA_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ADA/USDT',
};

const HBAR_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'HBAR/USDT',
};

const PHB_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'PHB/USDT',
};

const JUP_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'JUP/USDT',
};

const WLD_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'WLD/USDT',
};

const ONDO_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ONDO/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const IMX_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'IMX/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const CONFIG_2Z = {
  ...REAL_BASE_CONFIG,
  SYMBOL: '2Z/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const ARB_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ARB/USDT',
};

const RENDER_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'RENDER/USDT',
};

const TIA_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'TIA/USDT',
};

const LDO_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'LDO/USDT',
};

const SEI_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'SEI/USDT',
};

const TRX_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'TRX/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const CRV_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'CRV/USDT',
};

const FET_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'FET/USDT',
};

const ETHFI_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ETHFI/USDT',
};

const XLM_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'XLM/USDT',
};

const CAKE_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'CAKE/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const ASTER_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ASTER/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const NEXO_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'NEXO/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const KAIA_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'KAIA/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const AVAX_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'AVAX/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const ZEN_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ZEN/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const LINK_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'LINK/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const TON_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'TON/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const ZBT_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ZBT/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const SOMI_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'SOMI/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
};

const SUI_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'SUI/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const XTZ_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'XTZ/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const UNI_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'UNI/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const NEAR_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'NEAR/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const MEME_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'MEME/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const FIL_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'FIL/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const DOT_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'DOT/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const DASH_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'DASH/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const CHZ_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'CHZ/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const APT_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'APT/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};
const ALGO_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'ALGO/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
};

const BNB_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'BNB/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0018,
  MAX_PRICE_MOVE_PCT: 0.045,
  ATR_STOP_MULTIPLIER: 2.0,
};

const BCH_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'BCH/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  MIN_TRADE_USDT: 5,
  SLIPPAGE_BUFFER: 0.0018,
  MAX_PRICE_MOVE_PCT: 0.045,
  ATR_STOP_MULTIPLIER: 2.0,
};

const DOGE_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'DOGE/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const GRT_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'GRT/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const OP_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'OP/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const SKY_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'SKY/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  MIN_VOLUME_RATIO: 0.35,
  MAX_PRICE_MOVE_PCT: 0.12,
  SLIPPAGE_BUFFER: 0.004,
  AVOID_HOURS: [] as number[],
};

const SHIB_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'SHIB/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const PUMP_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'PUMP/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const PENGU_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'PENGU/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,

  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const VET_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'VET/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const FLOKI_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'FLOKI/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '4h' as Timeframe,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

const BONK_CONFIG = {
  ...REAL_BASE_CONFIG,
  SYMBOL: 'BONK/USDT',
  TIMEFRAME: '15m' as Timeframe,
  HTF_TIMEFRAME: '1h' as Timeframe,
  MIN_VOLUME_RATIO: 0.4,
  MAX_PRICE_MOVE_PCT: 0.1,
  SLIPPAGE_BUFFER: 0.004,
};

// ---------- CONFIG REGISTRY ----------
const SYMBOL_CONFIGS = {
  '2Z/USDT': CONFIG_2Z,
  'AAVE/USDT': AAVE_CONFIG,
  'ADA/USDT': ADA_CONFIG,
  'ALGO/USDT': ALGO_CONFIG,
  'APT/USDT': APT_CONFIG,
  'ARB/USDT': ARB_CONFIG,
  'ASTER/USDT': ASTER_CONFIG,
  'AVAX/USDT': AVAX_CONFIG,
  'BCH/USDT': BCH_CONFIG,
  'BNB/USDT': BNB_CONFIG,
  'BONK/USDT': BONK_CONFIG,
  'BTC/USDT': BTC_CONFIG,
  'CAKE/USDT': CAKE_CONFIG,
  'CHZ/USDT': CHZ_CONFIG,
  'CRV/USDT': CRV_CONFIG,
  'DASH/USDT': DASH_CONFIG,
  'DOGE/USDT': DOGE_CONFIG,
  'DOT/USDT': DOT_CONFIG,
  'ENA/USDT': ENA_CONFIG,
  'ETHFI/USDT': ETHFI_CONFIG,
  'ETH/USDT': ETH_CONFIG,
  'FET/USDT': FET_CONFIG,
  'FIL/USDT': FET_CONFIG,
  'FLOKI/USDT': FLOKI_CONFIG,
  'GRT/USDT': GRT_CONFIG,
  'HBAR/USDT': HBAR_CONFIG,
  'IMX/USDT': IMX_CONFIG,
  'INJ/USDT': INJ_CONFIG,
  'JUP/USDT': JUP_CONFIG,
  'KAIA/USDT': KAIA_CONFIG,
  'LDO/USDT': LDO_CONFIG,
  'LINK/USDT': LINK_CONFIG,
  'LTC/USDT': LTC_CONFIG,
  'MEME/USDT': MEME_CONFIG,
  'NEXO/USDT': NEXO_CONFIG,
  'NEAR/USDT': NEXO_CONFIG,
  'ONDO/USDT': ONDO_CONFIG,
  'OP/USDT': OP_CONFIG,
  'PAXG/USDT': PAXG_CONFIG,
  'PENGU/USDT': PENGU_CONFIG,
  'PEPE/USDT': PEPE_CONFIG,
  'PHB/USDT': PHB_CONFIG,
  'PUMP/USDT': PUMP_CONFIG,
  'QNT/USDT': QNT_CONFIG,
  'RENDER/USDT': RENDER_CONFIG,
  'SEI/USDT': SEI_CONFIG,
  'SHIB/USDT': SHIB_CONFIG,
  'SKY/USDT': SKY_CONFIG,
  'SOL/USDT': SOL_CONFIG,
  'SOMI/USDT': SOMI_CONFIG,
  'STX/USDT': STX_CONFIG,
  'SUI/USDT': SUI_CONFIG,
  'TIA/USDT': TIA_CONFIG,
  'TON/USDT': TON_CONFIG,
  'TRX/USDT': TRX_CONFIG,
  'UNI/USDT': UNI_CONFIG,
  'VET/USDT': VET_CONFIG,
  'VIRTUAL/USDT': VIRTUAL_CONFIG,
  'WLD/USDT': WLD_CONFIG,
  'WLFI/USDT': WLFI_CONFIG,
  'XLM/USDT': XLM_CONFIG,
  'XPL/USDT': XPL_CONFIG,
  'XRP/USDT': XRP_CONFIG,
  'XTZ/USDT': XTZ_CONFIG,
  'ZBT/USDT': ZBT_CONFIG,
  'ZEC/USDT': ZEC_CONFIG,
  'ZEN/USDT': ZEN_CONFIG,
};

// ---------- CONFIG BUILDER ----------
function getConfigForSymbol(symbol: string) {
  const binanceSymbol = symbol.includes('/') ? symbol.replace('/', '') : symbol;
  const symbolConfig = SYMBOL_CONFIGS[symbol as keyof typeof SYMBOL_CONFIGS];
  console.log({ symbol });
  if (!symbolConfig) {
    console.warn(
      `⚠️ No config found for ${symbol}, using BASE_CONFIG with symbol override`
    );
    return { ...REAL_BASE_CONFIG, SYMBOL: symbol };
  }

  // Already merged via spread operator in each config
  return symbolConfig;
}

// ---------- EXPORT ----------
if (!process.env.TRADING_SYMBOL) {
  throw new Error('TRADING_SYMBOL environment variable is not set.');
}
const ACTIVE_SYMBOL = process.env.TRADING_SYMBOL;
export const CONFIG = getConfigForSymbol(ACTIVE_SYMBOL);

export { getConfigForSymbol };
export {
  REAL_BASE_CONFIG,
  CONFIG_2Z,
  AAVE_CONFIG,
  ADA_CONFIG,
  ALGO_CONFIG,
  APT_CONFIG,
  ARB_CONFIG,
  ASTER_CONFIG,
  AVAX_CONFIG,
  BCH_CONFIG,
  BNB_CONFIG,
  BONK_CONFIG,
  BTC_CONFIG,
  CAKE_CONFIG,
  CHZ_CONFIG,
  CRV_CONFIG,
  DASH_CONFIG,
  DOGE_CONFIG,
  DOT_CONFIG,
  ENA_CONFIG,
  ETHFI_CONFIG,
  ETH_CONFIG,
  FET_CONFIG,
  FIL_CONFIG,
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
  MEME_CONFIG,
  NEXO_CONFIG,
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
  UNI_CONFIG,
  VET_CONFIG,
  VIRTUAL_CONFIG,
  WLD_CONFIG,
  WLFI_CONFIG,
  XLM_CONFIG,
  XPL_CONFIG,
  XTZ_CONFIG,
  XRP_CONFIG,
  ZBT_CONFIG,
  ZEC_CONFIG,
  ZEN_CONFIG,
  SYMBOL_CONFIGS,
};

export type BotConfig = typeof CONFIG;
