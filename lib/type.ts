import type { ChildProcess } from 'child_process';

import type { StochasticOutput } from 'technicalindicators/declarations/momentum/Stochastic.js';
import type { MACDOutput } from 'technicalindicators/declarations/moving_averages/MACD.js';

import type { TrailingState } from '../src/core/trailling-monitor-loop.js';

// ---------- TYPES ----------
export type StrategyId =
  | 'EMA_PULLBACK'
  | 'FIB_RETRACEMENT'
  | 'FIB_BOUNCE'
  | 'BREAKOUT'
  | 'RSI_DIVERGENCE'
  | 'RSI_OVERBOUGHT'
  | 'EMA_RSI_STRATEGY'
  | 'EMA_PULLBACK_SHORT'
  | 'SHORT_EMA_RESISTANCE'
  | 'EMA_MOMENTUM'
  | 'MOMENTUM'
  | 'BREAKDOWN'
  | 'SHORT_FIB_RESISTANCE'
  | 'FIB_RETRACEMENT_SHORT'
  | 'LIQUIDITY_SWEEP'
  | 'FVG_FILL'
  | 'SMC_FVG'
  | 'SMC_LONG'
  | 'SMC_ORDER_BLOCK'
  | 'SMC_SHORT'
  | 'LIQUIDITY_RECLAIM'
  | 'MEAN_REVERSION';

export const strategyId = [
  'EMA_PULLBACK',
  'FIB_RETRACEMENT',
  'FIB_BOUNCE',
  'BREAKOUT',
  'RSI_DIVERGENCE',
  'RSI_OVERBOUGHT',
  'EMA_RSI_STRATEGY',
  'EMA_PULLBACK_SHORT',
  'SHORT_EMA_RESISTANCE',
  'EMA_MOMENTUM',
  'MOMENTUM',
  'BREAKDOWN',
  'SHORT_FIB_RESISTANCE',
  'FIB_RETRACEMENT_SHORT',
  'LIQUIDITY_SWEEP',
  'FVG_FILL',
  'SMC_FVG',
  'SMC_LONG',
  'SMC_ORDER_BLOCK',
  'SMC_SHORT',
  'LIQUIDITY_RECLAIM',
  'MEAN_REVERSION',
] as StrategyId[];

export const smcStrategy = [
  'LIQUIDITY_SWEEP',
  'LIQUIDITY_RECLAIM',
  'FVG_FILL',
  'SMC_FVG',
  'SMC_LONG',
  'SMC_ORDER_BLOCK',
  'SMC_SHORT',
];

export type ActionType =
  | 'BUY'
  | 'SELL'
  | 'PARTIAL_SELL'
  | 'LONG'
  | 'SHORT'
  | 'SPOT'
  | 'PARTIAL_COVER'
  | 'COVER';

export type EntryType = 'LONG' | 'SHORT' | 'SPOT';

export type BotType = 'SPOT' | 'FUTURES';
// export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'trade';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

// export type ExitReason = 'STOP_LOSS'|'TAKE_PROFIT'|'UNKNOWN_REASON'

export type EntrySignal = {
  symbol: string;
  strategy: StrategyId;
  side: EntryType;
  reason: string;
  confidence: number;
  stopLoss?: number;
  takeProfit?: number;
  entryPrice?: number;
  riskPct?: number;
  timestamp?: Date;
  reference?: Indicators;
  leverage?: number;
  filters?: {
    liquidityPassed: boolean;
    liquidityValue: number;
    minLiquidityRequired: number;
    pricePassed?: boolean;
    priceValue?: number;
    volatilityPassed?: boolean;
    volatilityValue?: number;
    candleCount: number;
    filtersApplied: string[]; // ['liquidity', 'price', 'volatility']
  };
  status?: 'AVAILABLE' | 'IN_TRADE' | 'COMPLETED' | 'EXPIRED';
  // ✅ NEW: Quality score
  qualityScore?: number; // 0-100
};

export type SignalQueueItem = {
  symbol: string;
  strategy: StrategyId;
  side: EntryType;
  reason: string;
  confidence: number;
  stopLoss?: number;
  price?: number;
  takeProfit?: number;
  scannedAt: Date;
};

export type TradeLog = {
  symbol?: string;
  timestamp: string;
  action: ActionType;
  strategy: StrategyId;
  positionId: string;
  price: number;
  amount: number;
  entryPrice?: number;
  pnl?: string;
  pnlUsd?: number;
  pnlPct?: number;
  reason?: string;
  holdTime?: number;
  duration?: number;
  stopLoss?: number;
  takeProfit?: number;
};

export type FibonacciLevels = {
  level0: number;
  level236: number;
  level382: number;
  level500: number;
  level618: number;
  level786: number;
  level100: number;
  lockedAt: Date;
  swingHigh: number;
  swingLow: number;
};

export type Indicators = {
  rsi: number;
  rsi14?: number;
  ema8?: number;
  ema9?: number;
  ema21?: number;
  ema50: number;
  ema100?: number;
  ema200: number;
  price?: number;
  currentPrice: number;
  atr: number;
  atr_14?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  volume?: number;
  volumeMA?: number;
  volumeAverage?: number;
  support?: number;
  orderBlock?: OrderBlock;
  fvg?: FVG;
  relativeStrength?: number; // Unconventional RS indicator
  buyVolume?: number; // Volume from "Taker" buy orders
  sellVolume?: number; // Volume from "Taker" sell orders
  delta?: number; // buyVolume - sellVolume
  macd?: MACDOutput[] | number;
  macdSignal?: number;
  macdHistogram?: number;
  bb_upper?: number;
  bb_middle?: number;
  bb_lower?: number;
  bb_width?: number;
  stochastic?: StochasticOutput[];
  roc?: number[];
  momentumScore?: MomentumScore;
  trend?: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  volatility?:
    | 'LOW'
    | 'DEAD'
    | 'MEDIUM'
    | 'HIGH'
    | 'HIGH_BULL'
    | 'HIGH_BEAR'
    | 'HIGH_NEUTRAL'
    | 'VERY_LOW'
    | 'EXTREME';
};

export interface MomentumScore {
  macdScore: number;
  stochasticScore: number;
  rocScore: number;
  overall: number;
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export type HTFConfirmation = {
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  ema50: number;
  ema200: number;
  rsi: number;
  // aligned: boolean;
  alignedLong?: boolean;
  alignedShort?: boolean;
  strength?: number;
};

export type Position = {
  symbol: string;
  entryPrice: number;
  initialAmount?: number;
  amount: number;
  remainingAmount: number;
  takeProfit: number;
  entryTime: Date;
  trailingActive?: boolean;
  strategy: StrategyId;
  signalReason?: string;
  partialTakeProfit1?: number;
  partialTakeProfit2?: number;
  partialsSold: number;
  currentPrice: number;
  stopLoss: number;
  pnlUsd: number;
  pnlPct: number;
  positionId: string;
  allocatedCapital?: number;
  leverage?: number;
  notionalValue?: number;
  marginUsed?: number;
  liquidationPrice?: number;
  side: EntryType;
  positionValue?: number;
  confidence?: number;
  isExiting?: boolean;
  entryFee?: number;
  exitFee?: number;
  totalFees?: number;
  feeRate?: number;
  entryOrderId?: string;
  markPrice?: number;
  stopLossOrderId?: string | undefined;
  takeProfitOrderId?: string | undefined;
  partialTargets?: PartialTarget[];
  partialOrderIds?: string[];
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  contracts?: number;
  entryRegime?: Regime;
  currentRegime?: Regime;
  trailing?: TrailingState;
  trailingEnabled?: boolean;
  trailingMultiplier?: number;
  _lastWebSocketUpdate?: number;
};

// Add new export types for multi-symbol scanning
export type SymbolCandidate = {
  symbol: string;
  price: number;
  signal: EntrySignal;
  confidence: number;
  regime: Regime;
  indicators: Indicators;
};

// export type ScanResult = {
//   symbol: string;
//   signal: EntrySignal;
//   confidence: number;
//   price: number;
//   indicators: Indicators;
// };

export type ScanResult = {
  symbol: string;
  signal?: EntrySignal | null;
  confidence: number;
  price: number;
  indicators: Indicators;
  regime?: Regime;
  htfTrend?: string;
  rsi?: number;
  timestamp?: Date;
  finalScore?: number;
};

export type Regime = {
  trend:
    | 'UP'
    | 'DOWN'
    | 'CHOP'
    | 'UPTREND'
    | 'DOWNTREND'
    | 'DEAD_CHOP'
    | 'STRONG_UP'
    | 'STRONG_DOWN'
    | 'WEAK_UP'
    | 'WEAK_DOWN';
  volatility:
    | 'LOW'
    | 'DEAD'
    | 'MEDIUM'
    | 'HIGH'
    | 'HIGH_BULL'
    | 'HIGH_BEAR'
    | 'HIGH_NEUTRAL'
    | 'VERY_LOW'
    | 'EXTREME';
  trendStrength: number;
  volRatio: number;
  volumeRatio?: number;
  momentum?: number;
  shortTermMomentum?: number;
  longTermTrend?: number;
  mediumTermTrend?: number;
  emaAlignment?: string;
  marketQuality: 'HIGH' | 'MEDIUM' | 'LOW';
};

export type FinalTp = {
  ratio: number;
  label: string;
  percent: number;
};

export type CooldownState = {
  until: Date | null;
  reason: string;
  consecutiveLosses: number;
};

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

export type BotStatus =
  | 'running'
  | 'waiting'
  | 'stopped'
  | 'error'
  | 'cooldown'
  | 'starting'
  | 'idle';

export type ReasonType =
  | 'TP'
  | 'SL'
  | 'MANUAL'
  | 'PARTIAL'
  | 'TRAILING'
  | 'TAKE_PROFIT'
  | 'ALL_PARTIALS_HIT'
  | 'STOP_LOSS';

export const smcStrategies = [
  ,
  'LIQUIDITY_SWEEP',
  'FVG_FILL',
  'SMC_LONG',
  'SMC_SHORT',
];

export type BotInstance = {
  symbol: string;
  process?: ChildProcess | null;
  side?: EntryType | undefined;
  status: BotStatus;
  startTime: Date | null;
  lastError?: string | null;
  restartCount?: number;
  pnl: number;
  totalPnl?: number;
  sessionPnl?: number;
  wins?: number;
  losses?: number;
  trades: number;
  position: Position | null;
  lastHeartbeat: Date | null;
  needsRestart?: boolean;
  restarting?: boolean;
  entrySignals?: EntrySignal[];
  cooldown?: CooldownState;
  allocatedCapital?: number;
  logStream?: any;
  config?: any;
  balance?: number;
  winRate?: number;
  avgWin?: number;
  avgLoss?: number;
  priceHistory?: number[];
  lastUpdate?: Date;
  confirmationTicks?: number;
  lastPriceDirection?: number;
  signal?: EntrySignal | null;
  tickCount?: number;
  highestPriceSeen?: number;
  lowestPriceSeen?: number;
  ticker?: {
    quoteVolume: number;
  };
};

export type BotStats = {
  wins: number;
  losses: number;
  totalTrades: number;
  winRate: number;
  sessionPnl: number;
  avgWin: number;
  avgLoss: number;
  leverage?: number;
};

export type WeatherCondition =
  | 'CLEAR'
  | 'CLOUDY'
  | 'SHITTY'
  | 'HURRICANE'
  | 'STORMY'
  | 'GOLDEN';

export interface BotState {
  version: string;
  lastSave: string;
  totalCapital: number;
  availableCapital: number;
  bots: BotInstance[];
  tradeHistory: CompletedTrade[];
  tradeCounters?: {
    total: number;
    today: number;
    perSymbol: Record<string, number>;
    sessionStart: string;
  };
}

export type BOSResult =
  | { detected: true; type: 'BULLISH' | 'BEARISH'; index: number }
  | { detected: false };

export type CHoCHResult =
  | { detected: true; type: 'BULLISH' | 'BEARISH'; index: number }
  | { detected: false };

export type LauncherConfig = {
  enabledSymbols: string[];
  maxBotsRunning: number;
  maxConcurrentPositions: number;
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
  healthCheckIntervalMs: number;
  aggregateLogging: boolean;
  minVolume24h?: number;
  dashboardRefreshMs?: number;
  scanIntervalMs?: number;
  minScore?: number;
  drawdownLimitPct?: number;
  emergencyStopOnDrawdown?: boolean;
  drawdownCheckIntervalMs?: number;
};

export type SymbolContext = {
  symbol: string;
  candles: CandleData;
  indicators: Indicators;
  regime: Regime;
  lastUpdate: Date;
  display: string; // PEPE/USDT
  futures: string; // 1000PEPEUSDT
  base: string; // PEPE
};

export type EntryChecklist = {
  htfTrend: { ok: boolean; value: string; need: string };
  ltfRegime: { ok: boolean; value: string; need: string };
  volatility: { ok: boolean; value: string; need: string };
  rsi: { ok: boolean; value: string; need: string };
  emaDistance: { ok: boolean; value: string; need: string };
};

export type MarketInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  minNotional: number;
  minQty: number;
  stepSize: number;
  tickSize: number;
};
export type AllocationStrategy =
  | 'EQUAL_FIXED'
  | 'DYNAMIC_POOL'
  | 'RISK_BASED'
  | 'TIERED';

export type BotAllocation = {
  symbol: string;
  allocatedCapital: number;
  inPosition: boolean;
  lockedAt: Date | null;
};

export type CapitalConfig = {
  totalCapital: number;
  strategy: AllocationStrategy;
  maxConcurrentPositions: number;
  riskPerTrade: number; // For risk-based
  reserveRatio: number; // Keep X% in reserve
};

export type CandleData = {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  opens: number[];
  timestamps: number[];
  lastAccess?: number;
};

export type StrategyContext = {
  ind: Indicators;
  fib: FibonacciLevels;
  regime: Regime;
  closes: number[];
  volumes: number[];
  htf: HTFConfirmation;
  riskPerUnit: number;
};

export type StrategyResult = {
  passed: boolean;
  signal?: EntrySignal;
  reason?: string;
};

export type SignalExport = {
  timestamp: Date;
  signals: ScanResult[];
  marketSentiment: {
    bullish: number;
    bearish: number;
    neutral: number;
  };
};

export type CompletedTrade = {
  symbol: string;
  strategy: StrategyId;
  side: EntryType;
  entryPrice: number;
  exitPrice: number;
  amount: number;
  stopLoss: number;
  takeProfit: number;
  pnlUsd: number;
  pnlPct: number;
  duration: number; // milliseconds
  exitReason: ReasonType;
  entryTime: Date;
  exitTime: Date;
  isWin: boolean;
  tradeId?: string;
  leverage?: number;
  notionalValue?: number;
  marginUsed?: number;
  rawPnl?: number;
  timestamp?: Date;
};

export interface TradeHistoryRecord {
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  amount: number;
  leverage: number;
  pnl: number;
  pnlPct: number;
  realizedPnl: number;
  closeReason: string;
  timestamp: number;
  duration: number;
}

export interface BotStatsData {
  [symbol: string]: {
    stats: BotStats;
    tradeHistory: TradeHistoryRecord[];
  };
}

export interface TokenScore {
  symbol: string;
  price: number;
  change: number;
  volume: number;
  high: number;
  low: number;
  timestamp: number;
  score: number;
}

export interface TokenData {
  symbol: string;
  price: number;
  change: number; // 24h percentage change
  volume: number; // 24h volume
  high: number; // 24h high
  low: number; // 24h low
  liquidity?: number; // Optional liquidity score
  volatility?: number; // Optional volatility score
}

export type TradingCandidate = {
  symbol: string;
  price: number; // Current price
  change: number; // 24h change percentage
  volume: number; // 24h volume
  confidence: number; // 0-1 confidence score
  signal: EntrySignal; // Trading signal
  indicators?: Indicators;
};

// export type TradeSide = 'LONG' | 'SHORT';

export interface SignalState {
  status: 'AVAILABLE' | 'IN_TRADE' | 'COMPLETED' | 'EXPIRED';
  takenAt?: Date;
  botId?: string;
  entryPrice?: number;
  exitedAt?: Date;
  pnl?: number;
}

export interface ManagedSignal extends EntrySignal {
  state: SignalState;
  addedAt: Date;
}

export interface OrderBook {
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
}

export interface LiquidityData {
  symbol: string;
  volume24h: number;
  spread: number;
  bidDepth: number;
  askDepth: number;
  estimatedSlippage: number;
  passed: boolean;
  reasons: string[];
}

export interface LiquidityMetrics {
  symbol: string;
  bidVolume: number; // Total USDT on bid side
  askVolume: number; // Total USDT on ask side
  spread: number; // Price difference (%)
  spreadBps: number; // Spread in basis points
  depth1Percent: number; // USDT within 1% of mid price
  slippageEstimate: number; // Estimated slippage for position size
  isLiquid: boolean; // Pass/fail
  warnings: string[];
}

export interface OrderBlock {
  type?: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  index?: number;
  strength: number;
  mitigated?: boolean;
}

export type FVG = {
  top: number;
  bottom: number;
  type?: 'BULLISH' | 'BEARISH';
};

export interface ExtendedScanResult {
  symbol: string;
  signal: EntrySignal | null;
  confidence: number;
  price?: number;
  indicators?: Indicators;
  regime?: any;
  rsi?: number;
  timestamp?: Date;
  smc?: SMCAnalysis;
  marketType?: BotType;
  reason?: string;
  wyckoff?: WyckoffPhase | null;
  positionSize?: {
    // ✅ ADD if you don't have it
    quantity: number;
    dollarAmount: number;
    riskAmount: number;
    riskRewardRatio: number;
    method: string;
  };
}

export interface SMCAnalysis {
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  liquidityLevels: LiquidityLevel[];
  bos: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
  choch: { detected: boolean; type?: 'BULLISH' | 'BEARISH'; index?: number };
  premiumDiscount: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  smcScore: number;
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  index: number;
  filled: boolean;
}

export interface PeakValleyValue {
  index: number;
  price: number;
}

export interface LiquidityLevel {
  type: 'HIGH' | 'LOW';
  price: number;
  strength: number;
  swept: boolean;
  index: number;
}

export interface SpotPosition extends Position {
  // Spot-specific fields can be added here if needed
  // For now, it uses the base position structure
}

/**
 * Spot-specific bot instance
 */
export interface SpotBotInstance extends BotInstance {
  position: SpotPosition | null;
  priceHistory?: any[];
  lastUpdate?: Date;
}

export interface StrategyCandidate {
  strategy: StrategyId;
  confidence: number;
  reason: string;
  stopLoss: number;
  takeProfit: number;
}

export interface ConfidenceFactors {
  baseConfidence: number;
  rsiScore: number;
  trendScore: number;
  volumeScore: number;
  volatilityScore: number;
  momentumScore: number;
  smcScore?: number;
}

export interface ConfidenceWeights {
  rsi: number;
  trend: number;
  volume: number;
  volatility: number;
  momentum: number;
  smc?: number;
}

export interface CooldownInfo {
  symbol: string;
  reason: 'LOSS' | 'CONSECUTIVE_LOSSES' | 'BIG_LOSS';
  cooldownUntil: Date;
  lossAmount: number;
  consecutiveLosses: number;
}

export interface PartialTarget {
  ratio: number; // R:R ratio (1.5, 2.5, 4.0)
  percent: number; // % of position to close (0.5 = 50%)
  label: string; // "First Bite 🥩", "Second Helping 🍖", etc.
  executed: boolean; // Has this target been hit?
  executedAt?: number; // Timestamp of execution
  orderId?: string | undefined;
  onExchange?: boolean;
  filled?: number;
  amount?: number;
  targetPrice?: number;
}

export interface MorayPosition extends Position {
  partialTargets?: PartialTarget[];
  partialsSold: number;
  breakEvenMoved?: boolean;
  partialPnlRealized?: number; // Track PnL from partials separately
  remainingAmount: number;
  _loggedTargets?: boolean;
}

export interface PartialTradeRecord {
  symbol: string;
  side: EntryType;
  entryPrice: number;
  exitPrice: number;
  amount: number;
  pnlUsd: number;
  pnlPct: number;
  targetLabel: string;
  ratio: number;
  timestamp: Date;
}

export interface OpenPositionParams {
  symbol: string;
  side: EntryType;
  notionalValue: number; // Total position size in USDT (e.g., $300 with 3x leverage)
  leverage: number;
  stopLoss: number;
  takeProfit: number;
}
export interface TakeProfitParams {
  symbol: string;
  side: string;
  quantity: number;
  takeProfitPrice: number;
}

export interface StopLossParams {
  symbol: string;
  side: string;
  quantity: number;
  stopPrice: number;
}

export interface LivePriceData {
  price: number;
  timestamp: number;
  source: 'binance' | 'cache';
  confidence: 'high' | 'medium' | 'low'; // ✅ NEW: Price confidence
}

export interface OrderBookData {
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  spread: number;
  spreadPercent: number;
  timestamp: number; // ✅ NEW: When was this fetched
}

export interface PriceFetchResult {
  price: number;
  source: 'live' | 'cache' | 'fallback';
  age: number; // milliseconds since fetched
  confidence: 'high' | 'medium' | 'low';
}

export type OrderSide = 'BUY' | 'SELL';

interface Trade {
  id: string; // Trade ID
  orderId?: string; // Order ID (if available)
  symbol: string; // Trading pair (e.g., 'BTC/USDT')
  timestamp: number; // Trade timestamp in milliseconds
  datetime: string; // ISO string of the timestamp
  side: 'buy' | 'sell'; // Trade direction
  price: number; // Price per unit
  amount: number; // Trade amount
  cost: number; // Total cost (price * amount)
  fee?: {
    // Fee information
    cost: number; // Fee amount
    currency: string; // Currency the fee is in
  };
  takerOrMaker?: 'taker' | 'maker'; // Type of order
  info: any; // Raw exchange response
}

interface FeeInterface {
  type: 'taker' | 'maker'; // Fee type
  currency: string; // Currency the fee is charged in
  rate: number; // Fee rate (e.g., 0.001 for 0.1%)
  cost: number; // Actual fee cost in the currency
}

export type EntryOrder = {
  id: string;
  clientOrderId?: string | undefined;
  datetime?: string;
  timestamp: number;
  lastTradeTimestamp?: number;
  lastUpdateTimestamp?: number;
  status: string | undefined;
  symbol: string;
  type: string | undefined;
  timeInForce?: string;
  side: string | undefined;
  price: number;
  average?: number;
  amount?: number;
  filled: number;
  remaining: number;
  stopPrice?: number;
  triggerPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  cost?: number;
  trades?: Trade[];
  fee?: FeeInterface | undefined;
  reduceOnly?: boolean | undefined;
  postOnly?: boolean | undefined;
  info?: any;
};

// export type EntryOrder = {
//   id: string;
//   symbol: string;
//   type: string;
//   side: OrderSide;
//   price: number;
//   average: number;
//   filled: number;
//   remaining: number;
//   status: string;
//   timestamp: Date;
// };
export type StopLossOrder = {
  id: string;
  symbol: string;
  type: string;
  side: string;
  price: number;
  stopPrice: number;
};
export type TakeProfitOrder = {
  id: string;
  symbol: string;
  type: string;
  side: string;
  price: number;
  stopPrice: number;
};

export type OrderResult = {
  entryOrder: EntryOrder;
  stopLossOrder?: StopLossOrder;
  takeProfitOrder?: TakeProfitOrder;
};

// export interface SignalQueueItem {
//   symbol: string;
//   confidence: number;
//   side: TradeSide;
//   strategyId: StrategyId;
//   reason: string;
//   price: number;
//   stopLoss: number;
//   takeProfit: number;
//   scannedAt: Date;
// }

// export interface Position {
//   side: TradeSide;
//   entryPrice: number;
//   currentPrice: number;
//   amount: number;
//   stopLoss: number;
//   takeProfit: number;
//   pnlUsd: number;
//   pnlPct: number;
//   entryTime: Date;
//   symbol: string;
//   strategyId: StrategyId;
//   confidence: number;
// }

// export interface BotInstance {
//   symbol: string;
//   status: BotStatus;
//   startTime: Date;
//   sessionPnl: number;
//   trades: number;
//   wins: number;
//   losses: number;
//   position: Position | null;
//   lastUpdate: Date;
//   signal: SignalQueueItem | null;
//   priceHistory: number[];
//   // ✅ NEW: Entry confirmation tracking
//   confirmationTicks: number;
//   lastPriceDirection: number; // 1 for up, -1 for down, 0 for neutral
// }

// export interface CompletedTrade {
//   symbol: string;
//   strategy: StrategyId;
//   entryPrice: number;
//   exitPrice: number;
//   amount: number;
//   pnlUsd: number;
//   pnlPct: number;
//   duration: number;
//   exitReason: string;
//   entryTime: Date;
//   exitTime: Date;
//   isWin: boolean;
// }

export interface TradeRecord {
  id: string;
  symbol: string;
  side: EntryType;
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  quantity: number;
  leverage: number;
  action?: ActionType;
  // P&L
  realizedPnl: number; // Actual profit/loss in USD
  realizedPnlPct: number; // Return on margin %

  // Trade details
  entryReason?: string; // 'SIGNAL', 'MANUAL', etc.
  exitReason: ReasonType;
  // Fees
  entryFee?: number;
  exitFee?: number;
  totalFees?: number;

  // Risk metrics
  marginUsed: number;
  maxDrawdown?: number; // Lowest point during trade

  // Duration
  durationMinutes?: number;
  strategy?: StrategyId;
}

export interface TradingStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;

  totalPnl: number;
  totalPnlPct: number;

  avgWin: number;
  avgLoss: number;
  profitFactor: number; // Total wins / Total losses

  largestWin: number;
  largestLoss: number;

  avgTradeDuration: number; // Minutes
  totalFeesPaid: number;
}

export interface TrendAnalysis {
  trend: 'UP' | 'DOWN' | 'SIDEWAYS';
  strength: number; // 0-100
  higherHighs: boolean;
  higherLows: boolean;
}

export interface StealthNumbers {
  entry: number;
  stopLoss: number;
  takeProfit?: number;
  rrRatio: number;
  weirdOffset: number;
}

export interface AdvancedRegime {
  regime:
    | 'TRENDING_UP'
    | 'TRENDING_DOWN'
    | 'RANGING'
    | 'BREAKOUT'
    | 'REVERSAL'
    | 'ACCUMULATION'
    | 'DISTRIBUTION';
  confidence: number; // 0-100%
  characteristics: {
    trendStrength: number; // 0-1
    volatility: number; // 0-1
    volumeConfirmation: number; // 0-1
    momentum: number; // -1 to +1
    marketBreadth?: number; // 0-1 (if multi-symbol)
  };
  expectedDuration: 'SHORT' | 'MEDIUM' | 'LONG';
  optimalStrategy: string[];
  riskMultiplier: number;
}

export interface FormattedSignalOutput {
  symbol: string;
  price: number;
  confidence: number;
  signal: {
    side: EntryType;
    strategy: string;
    confidence: number;
    reason: string;
    entryPrice?: number | undefined;
    stopLoss?: number;
    takeProfit?: number;
  } | null;
  regime: string;
  rsi: number;
  timestamp: Date;
  smc?: {
    score: number;
    zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' | null;
    bos: 'BULLISH' | 'BEARISH' | null;
    choch: 'BULLISH' | 'BEARISH' | null;
    orderBlocks: number;
    activeOrderBlocks: number;
    fvgs: number;
    activeFvgs: number;
    liquidityLevels: number;
    sweptLiquidity: number;
  };

  wyckoff?: WyckoffPhase | undefined; // ✅ Add | undefined here too
}

export interface WyckoffPhase {
  phase:
    | 'ACCUMULATION'
    | 'MARKUP'
    | 'DISTRIBUTION'
    | 'MARKDOWN'
    | 'NEUTRAL'
    | 'UNKNOWN';
  confidence: number; // 0-100
  stage?: string | undefined; // PS, SC, AR, ST, etc.
  signal?: 'BUY' | 'SELL' | 'HOLD' | undefined;
  strength: number; // 0-100
  description: string;
}

type BOS =
  | { detected: false }
  | { detected: true; type: 'BULLISH' | 'BEARISH' };

export interface Binance24hTicker {
  quoteVolume: string;
}
