import Table from 'cli-table3';
import { ATR, EMA, MACD, ROC, RSI, Stochastic } from 'technicalindicators';
import type { StochasticOutput } from 'technicalindicators/declarations/momentum/Stochastic.js';
import type { MACDOutput } from 'technicalindicators/declarations/moving_averages/MACD.js';

import { CONFIG } from '../src/spot/config-spot.js';
import type {
  CandleData,
  EntrySignal,
  EntryType,
  Indicators,
  Regime,
  Timeframe,
} from './type.js';

export type WeatherCondition =
  | 'CLEAR'
  | 'CLOUDY'
  | 'SHITTY'
  | 'HURRICANE'
  | 'STORMY'
  | 'CLOUDY'
  | 'CLEAR'
  | 'GOLDEN';

export interface MarketWeather {
  condition: WeatherCondition;
  shouldTrade: boolean;
  reason: string;
  metrics: {
    volatility: number;
    btcChange24h: number;
    volume: number;
    trendStrength: number;
  };
  tradingRules: {
    maxPositions: number;
    minConfidence: number;
    riskMultiplier: number;
    allowShorts?: boolean;
    allowLongs?: boolean;
  };
}

export const REALISTIC_WEATHER_CONFIG = {
  btcChange: {
    apocalypse: -15,
    crash: -8,
    dump: -5,
    pump: 5,
    moon: 10,
    scam: 20,
  },

  volatility: {
    dead: 0.5,
    low: 1.5,
    normal: 3.0,
    high: 5.0,
    extreme: 8.0,
    nuclear: 12.0,
  },

  volume: {
    dead: 0.2,
    low: 0.5,
    normal: 1.0,
    high: 1.8,
    fomo: 3.0,
    panic: 5.0,
  },

  trendStrength: {
    deadChop: 0.15,
    choppy: 0.35,
    moderate: 0.6,
    strong: 0.75,
    extreme: 0.85,
  },

  funding: {
    extremePositive: 0.1,
    highPositive: 0.05,
    extremeNegative: -0.05,
    highNegative: -0.03,
  },
};

const WEATHER_CONFIG = {
  volatility: {
    calm: 1,
    clear: 3,
    cloudy: 5,
    shitty: 10,
    fuck: 10,
  },

  btcChange: {
    crash: -10,
    weak: -5,
    neutral: 5,
    strong: 10,
  },

  volume: {
    dead: 0.3,
    low: 0.7,
    normal: 1.5,
    high: 3.0,
  },

  trendStrength: {
    choppy: 0.25,
    weak: 0.4,
    strong: 0.65,
  },
};

function log(
  msg: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info'
) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [CANDLE-MGR] ${icons[type]} ${msg}`);
}

const CACHE_CONFIG = {
  MAX_ENTRIES: 30,
  CACHE_DURATION: 60000,
  CLEANUP_INTERVAL: 2 * 60 * 1000,
};

const candleCache = new Map<
  string,
  {
    data: CandleData;
    timestamp: number;
    timeframe: string;
    accessCount: number;
  }
>();

let lastCacheCleanup = 0;

/**
 * ✅ Clean stale and least-used cache entries
 */
function cleanupCandleCache(): void {
  const now = Date.now();

  if (now - lastCacheCleanup < CACHE_CONFIG.CLEANUP_INTERVAL) return;
  lastCacheCleanup = now;

  const staleKeys: string[] = [];
  candleCache.forEach((value, key) => {
    if (now - value.timestamp > CACHE_CONFIG.CACHE_DURATION) {
      staleKeys.push(key);
    }
  });

  staleKeys.forEach((key) => candleCache.delete(key));

  if (candleCache.size > CACHE_CONFIG.MAX_ENTRIES) {
    const sorted = Array.from(candleCache.entries()).sort(
      ([, a], [, b]) => a.accessCount - b.accessCount
    );

    const toRemove = sorted.slice(
      0,
      candleCache.size - CACHE_CONFIG.MAX_ENTRIES
    );
    toRemove.forEach(([key]) => candleCache.delete(key));
  }

  if (staleKeys.length > 0) {
    console.log(
      `[CACHE] Cleaned ${staleKeys.length} stale entries, ${candleCache.size} remaining`
    );
  }
}

/**
 * ✅ Store in cache with automatic cleanup
 */
export function setCandleCache(
  key: string,
  data: CandleData,
  timeframe: string
): void {
  cleanupCandleCache();

  if (candleCache.size >= CACHE_CONFIG.MAX_ENTRIES) {
    const oldest = Array.from(candleCache.entries()).sort(
      ([, a], [, b]) => a.timestamp - b.timestamp
    )[0];

    if (oldest) {
      candleCache.delete(oldest[0]);
    }
  }

  candleCache.set(key, {
    data,
    timestamp: Date.now(),
    timeframe,
    accessCount: 0,
  });
}

/**
 * ✅ Get from cache with access tracking
 */
export function getCandleCache(key: string): CandleData | null {
  const cached = candleCache.get(key);

  if (!cached) return null;

  if (Date.now() - cached.timestamp > CACHE_CONFIG.CACHE_DURATION) {
    candleCache.delete(key);
    return null;
  }

  cached.accessCount++;

  return cached.data;
}

/**
 * ✅ Clear cache with limits
 */
export function clearCandleCache(symbol?: string, timeframe?: string): void {
  if (!symbol) {
    candleCache.clear();
    return;
  }

  const keys = Array.from(candleCache.keys()).filter((key) => {
    if (timeframe) {
      return key.startsWith(`${symbol}_${timeframe}_`);
    }
    return key.startsWith(`${symbol}_`);
  });

  keys.forEach((key) => candleCache.delete(key));
}

setInterval(() => {
  cleanupCandleCache();
}, CACHE_CONFIG.CLEANUP_INTERVAL);

export function calculateIndicators(candles: CandleData): Indicators | null {
  const minRequired = Math.max(CONFIG.RSI_PERIOD, CONFIG.EMA_200) + 1;
  if (candles.closes.length < minRequired) {
    log(
      `Need ${minRequired} candles, have ${candles.closes.length}`,
      'warning'
    );
    return null;
  }

  const atrVals = ATR.calculate({
    high: candles.highs,
    low: candles.lows,
    close: candles.closes,
    period: CONFIG.ATR_PERIOD,
  });
  const rsiVals = RSI.calculate({
    period: CONFIG.RSI_PERIOD,
    values: candles.closes,
  });
  const ema8Vals = EMA.calculate({
    period: CONFIG.EMA_8,
    values: candles.closes,
  });
  const ema21Vals = EMA.calculate({
    period: CONFIG.EMA_21,
    values: candles.closes,
  });
  const ema50Vals = EMA.calculate({
    period: CONFIG.EMA_50,
    values: candles.closes,
  });
  const ema200Vals = EMA.calculate({
    period: CONFIG.EMA_200,
    values: candles.closes,
  });

  if (
    !atrVals.length ||
    !rsiVals.length ||
    !ema8Vals.length ||
    !ema21Vals.length ||
    !ema50Vals.length ||
    !ema200Vals.length
  ) {
    log('Indicator calculation failed', 'warning');
    return null;
  }

  const atr = atrVals[atrVals.length - 1] as number;
  const rsi = rsiVals[rsiVals.length - 1] as number;
  const ema8 = ema8Vals[ema8Vals.length - 1] as number;
  const ema21 = ema21Vals[ema21Vals.length - 1] as number;
  const ema50 = ema50Vals[ema50Vals.length - 1] as number;
  const ema200 = ema200Vals[ema200Vals.length - 1] as number;
  const currentPrice = candles.closes[candles.closes.length - 1] as number;

  // const decimals = currentPrice < 1 ? 4 : currentPrice < 100 ? 2 : 0;

  let macd: MACDOutput[] = [];
  if (candles.closes.length >= 26) {
    const macdResult = MACD.calculate({
      values: candles.closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    macd = macdResult || [];
  }

  let stochastic: StochasticOutput[] = [];
  if (candles.closes.length >= 14) {
    const stochasticResult = Stochastic.calculate({
      high: candles.highs,
      low: candles.lows,
      close: candles.closes,
      period: 14,
      signalPeriod: 3,
    });
    stochastic = stochasticResult || [];
  }

  let roc: number[] = [];
  if (candles.closes.length >= 13) {
    const rocResult = ROC.calculate({
      values: candles.closes,
      period: 12,
    });
    roc = rocResult || [];
  }

  const momentumScore = calculateMomentumScore(macd, stochastic, roc);

  return {
    rsi,
    ema8,
    ema21,
    ema50,
    ema200,
    currentPrice,
    atr,
    stopLossPrice: currentPrice - atr * CONFIG.ATR_STOP_MULTIPLIER,
    takeProfitPrice: currentPrice + atr * CONFIG.ATR_TP_MULTIPLIER,
    macd,
    stochastic,
    roc,
    momentumScore,
  };
}

export function detectRegime(ind: Indicators, candles: CandleData): Regime {
  const trendStrength = (ind.ema50 - ind.ema200) / ind.ema200;
  const volRatio = ind.atr / ind.currentPrice;

  const ema8 = ind.ema8 as number;
  const ema21 = ind.ema21 as number;
  const ema50 = ind.ema50 as number;
  const ema200 = ind.ema200 as number;

  const shortTerm = (ema8 - ema21) / ema21;
  const mediumTerm = (ema21 - ema50) / ema50;
  const longTerm = (ema50 - ema200) / ema200;

  const volumes = candles.volumes || [];
  const recentVol =
    volumes.length > 0 ? volumes.slice(-5).reduce((a, b) => a + b) / 5 : 0;
  const avgVol =
    volumes.length > 20 ? volumes.slice(-20).reduce((a, b) => a + b) / 20 : 1;
  const volumeRatio = recentVol / avgVol;

  const momentum = (ind.currentPrice - ema21) / ema21;

  const bullishAlignment = ema8 > ema21 && ema21 > ema50 && ema50 > ema200;
  const bearishAlignment = ema8 < ema21 && ema21 < ema50 && ema50 < ema200;

  let trend: Regime['trend'];
  const absStrength = Math.abs(trendStrength);
  const absLongTerm = Math.abs(longTerm);

  // if (absLongTerm < 0.0005) {
  //   trend = 'CHOP';
  // } else if (longTerm > 0.005) {
  //   trend =
  //     bullishAlignment && volumeRatio > 1.2 && shortTerm > 0
  //       ? 'STRONG_UP'
  //       : 'UP';
  // } else if (longTerm > 0.001) {
  //   trend = shortTerm > 0 ? 'WEAK_UP' : 'CHOP';
  // } else if (longTerm < -0.005) {
  //   trend =
  //     bearishAlignment && volumeRatio > 1.2 && shortTerm < 0
  //       ? 'STRONG_DOWN'
  //       : 'DOWN';
  // } else if (longTerm < -0.001) {
  //   trend = shortTerm < 0 ? 'WEAK_DOWN' : 'CHOP';
  // } else {
  //   trend = 'CHOP';
  // }

  // let trend: Regime['trend'];

  // Dead flat market
  if (absLongTerm < 0.0005) {
    trend = 'CHOP';
  }
  // Strong uptrend
  else if (longTerm > 0.005) {
    trend =
      bullishAlignment && volumeRatio > 1.2 && shortTerm > 0
        ? 'STRONG_UP'
        : 'UP';
  }
  // Moderate uptrend
  else if (longTerm > 0.001) {
    trend = shortTerm > 0 ? 'WEAK_UP' : 'CHOP';
  }
  // Strong downtrend
  else if (longTerm < -0.005) {
    trend =
      bearishAlignment && volumeRatio > 1.2 && shortTerm < 0
        ? 'STRONG_DOWN'
        : 'DOWN';
  }
  // Moderate downtrend
  else if (longTerm < -0.001) {
    trend = shortTerm < 0 ? 'WEAK_DOWN' : 'CHOP';
  }
  // Range between -0.001 and +0.001 (excluding < 0.0005)
  else {
    trend = 'CHOP';
  }

  let volatility: Regime['volatility'];
  if (volRatio < 0.003) {
    volatility = 'VERY_LOW';
  } else if (volRatio < 0.008) {
    volatility = volumeRatio > 0.8 ? 'LOW' : 'DEAD';
  } else if (volRatio < 0.015) {
    volatility = 'MEDIUM';
  } else if (volRatio < 0.025) {
    volatility = 'HIGH';
  } else {
    volatility = 'EXTREME';
  }

  // ✅ ADD THIS: Better trend strength calculation
  const compositeTrendStrength = Math.max(
    Math.abs(shortTerm), // Short-term momentum (8-21 EMA)
    Math.abs(mediumTerm) * 0.8, // Medium-term trend (21-50 EMA)
    Math.abs(longTerm) * 100 // Long-term trend (50-200 EMA, scaled)
  );

  const displayTrendStrength = Math.max(
    Math.abs(shortTerm) * 5, // Weight recent moves heavily
    Math.abs(mediumTerm) * 3,
    Math.abs(longTerm) * 100
  );

  // ✅ ADD THIS DEBUG BLOCK:
  // console.log('\n🔍 TREND STRENGTH CALCULATION:');
  // console.log(`   EMA8: ${ema8}`);
  // console.log(`   EMA21: ${ema21}`);
  // console.log(`   EMA50: ${ema50}`);
  // console.log(`   EMA200: ${ema200}`);
  // console.log(`   ---`);
  // console.log(`   shortTerm (8-21): ${shortTerm * 100}%`);
  // console.log(`   mediumTerm (21-50): ${mediumTerm * 100}%`);
  // console.log(`   longTerm (50-200): ${longTerm * 100}%`);
  // console.log(`   ---`);
  // console.log(`   shortTerm × 5 = ${Math.abs(shortTerm) * 5}`);
  // console.log(`   mediumTerm × 3 = ${Math.abs(mediumTerm) * 3}`);
  // console.log(`   longTerm × 100 = ${Math.abs(longTerm) * 100}`);
  // console.log(`   ---`);
  // console.log(`   FINAL displayTrendStrength = ${displayTrendStrength}`);
  // console.log(`   As percentage: ${displayTrendStrength * 100}%\n`);

  return {
    trend,
    volatility,
    trendStrength: displayTrendStrength,
    longTermTrend: longTerm,
    shortTermMomentum: shortTerm,
    mediumTermTrend: mediumTerm,
    volRatio,
    volumeRatio,
    momentum,
    emaAlignment: bullishAlignment
      ? 'BULLISH'
      : bearishAlignment
        ? 'BEARISH'
        : 'NEUTRAL',
    marketQuality: calculateMarketQuality(longTerm, volRatio, volumeRatio),
  };
}

function calculateMarketQuality(
  trendStrength: number,
  volatility: number,
  volumeRatio: number
): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (
    Math.abs(trendStrength) > 0.005 &&
    volatility > 0.005 &&
    volatility < 0.015 &&
    volumeRatio > 0.8 &&
    volumeRatio < 3
  ) {
    return 'HIGH';
  }

  if (
    Math.abs(trendStrength) < 0.001 ||
    volatility > 0.025 ||
    volumeRatio < 0.3
  ) {
    return 'LOW';
  }

  return 'MEDIUM';
}

maxPositions: 2;

maxPositions: 2;

export interface EnhancedMarketData {
  fundingRate: number;
  openInterest?: number | undefined;
  longShortRatio?: number | undefined;
}

export async function checkMarketWeather(
  btcCandles: CandleData,
  marketData?: EnhancedMarketData
): Promise<MarketWeather> {
  const volatility = calculateVolatility(btcCandles);
  const btcChange24h = calculate24hChange(btcCandles);
  const volume = calculateVolumeRatio(btcCandles);
  const trendStrength = calculateTrendStrength(btcCandles);

  const fundingRate = marketData?.fundingRate || 0;
  const metrics = { volatility, btcChange24h, volume, trendStrength };

  if (fundingRate > REALISTIC_WEATHER_CONFIG.funding.extremePositive) {
    return {
      condition: 'STORMY',
      shouldTrade: true,
      reason: `⚠️ FUNDING CRISIS! ${(fundingRate * 100).toFixed(3)}% - Longs overleveraged, dump risk high`,
      metrics,
      tradingRules: {
        maxPositions: 1,
        minConfidence: 80,
        riskMultiplier: 0.8,
        allowShorts: true,
        allowLongs: false,
      },
    };
  }

  if (fundingRate < REALISTIC_WEATHER_CONFIG.funding.extremeNegative) {
    return {
      condition: 'STORMY',
      shouldTrade: true,
      reason: `⚠️ SHORT SQUEEZE RISK! ${(fundingRate * 100).toFixed(3)}% - Shorts overleveraged, pump likely`,
      metrics,
      tradingRules: {
        maxPositions: 1,
        minConfidence: 80,
        riskMultiplier: 0.8,
        allowShorts: false,
        allowLongs: true,
      },
    };
  }

  if (fundingRate > REALISTIC_WEATHER_CONFIG.funding.highPositive) {
    console.log(
      `   📊 Elevated funding: ${(fundingRate * 100).toFixed(3)}% - Short bias active`
    );
  }

  if (fundingRate < REALISTIC_WEATHER_CONFIG.funding.highNegative) {
    console.log(
      `   📊 Negative funding: ${(fundingRate * 100).toFixed(3)}% - Long bias active`
    );
  }

  if (btcChange24h < REALISTIC_WEATHER_CONFIG.btcChange.apocalypse) {
    return {
      condition: 'HURRICANE',
      shouldTrade: false,
      reason: `🌀 APOCALYPSE! BTC ${btcChange24h.toFixed(1)}% - Market broken`,
      metrics,
      tradingRules: {
        maxPositions: 0,
        minConfidence: 100,
        riskMultiplier: 0,
        allowShorts: false,
        allowLongs: false,
      },
    };
  }

  if (btcChange24h > REALISTIC_WEATHER_CONFIG.btcChange.scam) {
    return {
      condition: 'HURRICANE',
      shouldTrade: false,
      reason: `🌀 SCAM PUMP! BTC +${btcChange24h.toFixed(1)}% - Manipulation`,
      metrics,
      tradingRules: {
        maxPositions: 0,
        minConfidence: 100,
        riskMultiplier: 0,
        allowShorts: false,
        allowLongs: false,
      },
    };
  }

  if (volatility > REALISTIC_WEATHER_CONFIG.volatility.nuclear) {
    return {
      condition: 'HURRICANE',
      shouldTrade: false,
      reason: `🌀 NUCLEAR VOL ${volatility.toFixed(1)}% - Liquidation cascade`,
      metrics,
      tradingRules: {
        maxPositions: 0,
        minConfidence: 100,
        riskMultiplier: 0,
        allowShorts: false,
        allowLongs: false,
      },
    };
  }

  if (volatility > REALISTIC_WEATHER_CONFIG.volatility.extreme) {
    return {
      condition: 'STORMY',
      shouldTrade: true,
      reason: `⛈️  EXTREME VOL ${volatility.toFixed(1)}% - Wide stops required`,
      metrics,
      tradingRules: {
        maxPositions: 1,

        minConfidence: 82,
        riskMultiplier: 0.8,
        allowShorts: btcChange24h < -2,
        allowLongs: btcChange24h > 2,
      },
    };
  }

  if (btcChange24h < REALISTIC_WEATHER_CONFIG.btcChange.crash) {
    return {
      condition: 'STORMY',
      shouldTrade: true,
      reason: `⛈️  BTC DUMPING ${btcChange24h.toFixed(1)}% - Short opportunities`,
      metrics,
      tradingRules: {
        maxPositions: 1,

        minConfidence: 75,
        riskMultiplier: 0.8,
        allowShorts: true,
        allowLongs: false,
      },
    };
  }

  if (btcChange24h > REALISTIC_WEATHER_CONFIG.btcChange.moon) {
    return {
      condition: 'STORMY',
      shouldTrade: true,
      reason: `⛈️  BTC MOONING +${btcChange24h.toFixed(1)}% - Long opportunities`,
      metrics,
      tradingRules: {
        maxPositions: 1,
        minConfidence: 75,
        riskMultiplier: 0.8,
        allowShorts: false,
        allowLongs: true,
      },
    };
  }

  if (volume > REALISTIC_WEATHER_CONFIG.volume.panic) {
    return {
      condition: 'STORMY',
      shouldTrade: true,
      reason: `⛈️  PANIC VOLUME ${(volume * 100).toFixed(0)}% - Major event`,
      metrics,
      tradingRules: {
        maxPositions: 1,

        minConfidence: 82,
        riskMultiplier: 0.8,
        allowShorts: btcChange24h < 0,
        allowLongs: btcChange24h > 0,
      },
    };
  }

  if (volatility > REALISTIC_WEATHER_CONFIG.volatility.high) {
    return {
      condition: 'CLOUDY',
      shouldTrade: true,
      reason: `⛅ HIGH VOL ${volatility.toFixed(1)}% - Normal crypto volatility`,
      metrics,
      tradingRules: {
        maxPositions: 3,
        minConfidence: 70,
        riskMultiplier: 1.4,
        allowShorts: true,
        allowLongs: true,
      },
    };
  }

  if (btcChange24h < REALISTIC_WEATHER_CONFIG.btcChange.dump) {
    return {
      condition: 'CLOUDY',
      shouldTrade: true,
      reason: `⛅ CORRECTION ${btcChange24h.toFixed(1)}% - Healthy pullback`,
      metrics,
      tradingRules: {
        maxPositions: 3,
        minConfidence: 70,
        riskMultiplier: 1.4,
        allowShorts: true,
        allowLongs: trendStrength > 0.5,
      },
    };
  }

  if (btcChange24h > REALISTIC_WEATHER_CONFIG.btcChange.pump) {
    return {
      condition: 'CLOUDY',
      shouldTrade: true,
      reason: `⛅ RALLY +${btcChange24h.toFixed(1)}% - Healthy move up`,
      metrics,
      tradingRules: {
        maxPositions: 3,
        minConfidence: 70,
        riskMultiplier: 1.4,
        allowShorts: trendStrength < 0.35,
        allowLongs: true,
      },
    };
  }

  if (
    volume < REALISTIC_WEATHER_CONFIG.volume.dead &&
    trendStrength < REALISTIC_WEATHER_CONFIG.trendStrength.deadChop
  ) {
    return {
      condition: 'CLOUDY',
      shouldTrade: true,
      reason: `⛅ DEAD MARKET - Vol: ${(volume * 100).toFixed(0)}%, Trend: ${(trendStrength * 100).toFixed(0)}% - Weekend mode`,
      metrics,
      tradingRules: {
        maxPositions: 1,
        minConfidence: 85,
        riskMultiplier: 1.4,
        allowShorts: true,
        allowLongs: true,
      },
    };
  }

  if (trendStrength < REALISTIC_WEATHER_CONFIG.trendStrength.choppy) {
    return {
      condition: 'CLOUDY',
      shouldTrade: true,
      reason: `⛅ CHOPPY - Trend ${(trendStrength * 100).toFixed(0)}% - Range trading mode`,
      metrics,
      tradingRules: {
        maxPositions: 1,

        minConfidence: 72,
        riskMultiplier: 1.4,
        allowShorts: true,
        allowLongs: true,
      },
    };
  }

  if (volume > REALISTIC_WEATHER_CONFIG.volume.fomo) {
    return {
      condition: 'CLOUDY',
      shouldTrade: true,
      reason: `⛅ HIGH VOLUME ${(volume * 100).toFixed(0)}% - Active trading day`,
      metrics,
      tradingRules: {
        maxPositions: 3,
        minConfidence: 70,
        riskMultiplier: 1.4,
        allowShorts: true,
        allowLongs: true,
      },
    };
  }

  if (
    trendStrength > REALISTIC_WEATHER_CONFIG.trendStrength.strong &&
    volatility >= REALISTIC_WEATHER_CONFIG.volatility.low &&
    volatility <= REALISTIC_WEATHER_CONFIG.volatility.high &&
    volume >= REALISTIC_WEATHER_CONFIG.volume.normal &&
    volume <= REALISTIC_WEATHER_CONFIG.volume.fomo
  ) {
    const direction = btcChange24h > 0 ? 'UP' : 'DOWN';

    const fundingAligned =
      (direction === 'DOWN' && fundingRate > 0.03) ||
      (direction === 'UP' && fundingRate < -0.02);

    return {
      condition: 'GOLDEN',
      shouldTrade: true,
      reason: `🥚 GOLDEN! Strong ${direction} trend + perfect vol${fundingAligned ? ' + funding aligned' : ''}`,
      metrics,
      tradingRules: {
        maxPositions: 4,
        minConfidence: 65,
        riskMultiplier: fundingAligned ? 1.4 : 1.2,
        allowShorts: direction === 'DOWN',
        allowLongs: direction === 'UP',
      },
    };
  }

  return {
    condition: 'CLEAR',
    shouldTrade: true,
    reason: `☀️  GOOD CONDITIONS! Vol: ${volatility.toFixed(1)}%, Trend: ${(trendStrength * 100).toFixed(0)}%, Volume: ${(volume * 100).toFixed(0)}%`,
    metrics,
    tradingRules: {
      maxPositions: 3,
      minConfidence: 70,
      riskMultiplier: 1.4,
      allowShorts: true,
      allowLongs: true,
    },
  };
}

export function shouldTradeThisToken(
  marketWeather: MarketWeather,
  tokenRegime: Regime,
  signal: EntrySignal
): {
  allowed: boolean;
  reason: string;
  adjustedRiskMultiplier: number;
} {
  if (!marketWeather.shouldTrade) {
    return {
      allowed: false,
      reason: `Market weather: ${marketWeather.reason}`,
      adjustedRiskMultiplier: 0,
    };
  }

  if (signal.side === 'LONG' && !marketWeather.tradingRules.allowLongs) {
    return {
      allowed: false,
      reason: 'Market weather forbids LONG positions',
      adjustedRiskMultiplier: 0,
    };
  }

  if (signal.side === 'SHORT' && !marketWeather.tradingRules.allowShorts) {
    return {
      allowed: false,
      reason: 'Market weather forbids SHORT positions',
      adjustedRiskMultiplier: 0,
    };
  }

  if (signal.confidence < marketWeather.tradingRules.minConfidence) {
    return {
      allowed: false,
      reason: `Confidence ${signal.confidence}% < required ${marketWeather.tradingRules.minConfidence}%`,
      adjustedRiskMultiplier: 0,
    };
  }

  let riskMultiplier = marketWeather.tradingRules.riskMultiplier;

  if (tokenRegime.volatility === 'EXTREME') {
    riskMultiplier *= 0.8;
  }

  return {
    allowed: true,
    reason: `${marketWeather.condition} weather + ${tokenRegime.trend} trend`,
    adjustedRiskMultiplier: riskMultiplier,
  };
}

/**
 * Decide if trailing stops should be enabled based on YOUR regime
 */
export function shouldEnableTrailing(
  regime: Regime,
  side: EntryType
): {
  enabled: boolean;
  trailMultiplier: number;
  reason: string;
} {
  if (regime.volatility === 'EXTREME') {
    return {
      enabled: true,
      trailMultiplier: 1.0,
      reason: 'EXTREME volatility - tight trail to protect profits',
    };
  }

  if (regime.volatility === 'HIGH') {
    return {
      enabled: true,
      trailMultiplier: 1.3,
      reason: 'HIGH volatility - moderate trail to ride swings',
    };
  }

  if (regime.trend === 'STRONG_UP' && side === 'LONG') {
    return {
      enabled: true,
      trailMultiplier: 2.0,
      reason: 'STRONG_UP + LONG - let winners run!',
    };
  }

  if (regime.trend === 'STRONG_DOWN' && side === 'SHORT') {
    return {
      enabled: true,
      trailMultiplier: 2.0,
      reason: 'STRONG_DOWN + SHORT - let winners run!',
    };
  }

  if (regime.trend === 'UP' && side === 'LONG') {
    return {
      enabled: true,
      trailMultiplier: 1.5,
      reason: 'UP trend + LONG - trail with trend',
    };
  }

  if (regime.trend === 'DOWN' && side === 'SHORT') {
    return {
      enabled: true,
      trailMultiplier: 1.5,
      reason: 'DOWN trend + SHORT - trail with trend',
    };
  }

  if (regime.trend === 'WEAK_UP' && side === 'LONG') {
    if (regime.volumeRatio && regime.volumeRatio > 1.1) {
      return {
        enabled: true,
        trailMultiplier: 1.2,
        reason: 'WEAK_UP with volume - cautious trail',
      };
    }

    return {
      enabled: false,
      trailMultiplier: 0,
      reason: 'WEAK_UP no volume - fixed stops safer',
    };
  }

  if (regime.trend === 'WEAK_DOWN' && side === 'SHORT') {
    if (regime.volumeRatio && regime.volumeRatio > 1.1) {
      return {
        enabled: true,
        trailMultiplier: 1.2,
        reason: 'WEAK_DOWN with volume - cautious trail',
      };
    }
    return {
      enabled: false,
      trailMultiplier: 0,
      reason: 'WEAK_DOWN no volume - fixed stops safer',
    };
  }

  if (regime.trend === 'CHOP' || regime.trend === 'DEAD_CHOP') {
    return {
      enabled: false,
      trailMultiplier: 0,
      reason: 'CHOPPY - fixed stops to avoid whipsaws',
    };
  }

  if (regime.volatility === 'DEAD' || regime.volatility === 'VERY_LOW') {
    return {
      enabled: false,
      trailMultiplier: 0,
      reason: 'DEAD market - no momentum to trail',
    };
  }

  if (regime.trend === 'STRONG_UP' && side === 'SHORT') {
    return {
      enabled: false,
      trailMultiplier: 0,
      reason: 'SHORT against STRONG_UP - quick exit needed',
    };
  }

  if (regime.trend === 'STRONG_DOWN' && side === 'LONG') {
    return {
      enabled: false,
      trailMultiplier: 0,
      reason: 'LONG against STRONG_DOWN - quick exit needed',
    };
  }

  return {
    enabled: true,
    trailMultiplier: 1.3,
    reason: 'Default moderate trail - normal market',
  };
}

function calculateVolatility(candles: any): number {
  const closes = candles.closes.slice(-24);
  const highs = candles.highs.slice(-24);
  const lows = candles.lows.slice(-24);

  let sumTR = 0;
  for (let i = 1; i < closes.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    sumTR += tr;
  }

  const atr = sumTR / (closes.length - 1);
  const avgPrice = closes[closes.length - 1];
  const volatility = (atr / avgPrice) * 100;

  return volatility;
}

function calculate24hChange(candles: any): number {
  const closes = candles.closes;
  const current = closes[closes.length - 1];
  const before24h = closes[closes.length - 25];

  if (!before24h) return 0;

  return ((current - before24h) / before24h) * 100;
}

function calculateVolumeRatio(candles: any): number {
  const volumes = candles.volumes;

  const currentVol = volumes[volumes.length - 1];

  const avgVol =
    volumes.slice(-25, -1).reduce((a: number, b: number) => a + b, 0) / 24;

  if (avgVol === 0) return 0;

  return currentVol / avgVol;
}

// function calculateTrendStrength(candles: any): number {
//   const closes = candles.closes.slice(-50);

//   const n = closes.length;
//   let sumX = 0;
//   let sumY = 0;
//   let sumXY = 0;
//   let sumX2 = 0;

//   for (let i = 0; i < n; i++) {
//     sumX += i;
//     sumY += closes[i];
//     sumXY += i * closes[i];
//     sumX2 += i * i;
//   }

//   const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
//   const avgPrice = sumY / n;

//   const normalizedSlope = Math.abs(slope / avgPrice) * 50;

//   return Math.min(1, normalizedSlope);
// }

function calculateTrendStrength(candles: any): number {
  const closes = candles.closes.slice(-50);

  if (closes.length < 10) return 0;

  // Calculate linear regression
  const n = closes.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += closes[i];
    sumXY += i * closes[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Calculate how much price has changed along the trend line
  const trendlineStart = intercept;
  const trendlineEnd = slope * (n - 1) + intercept;
  const trendlineChange = Math.abs(
    (trendlineEnd - trendlineStart) / trendlineStart
  );

  // Calculate R-squared to measure how well price follows the trend
  let ssRes = 0;
  let ssTot = 0;
  const mean = sumY / n;

  for (let i = 0; i < n; i++) {
    const predicted = slope * i + intercept;
    ssRes += Math.pow(closes[i] - predicted, 2);
    ssTot += Math.pow(closes[i] - mean, 2);
  }

  const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 0;

  // ✅ IMPROVED: Better scaling and clamping
  const magnitudeScore = Math.min(1, trendlineChange * 20);
  const consistencyScore = Math.max(0, rSquared);

  // Combine: both need to be high for strong trend
  const strength = magnitudeScore * consistencyScore;

  // ✅ Return 0-1 range (multiply by 100 if you want percentage)
  return strength; // or: return strength * 100;
}

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightCyan: '\x1b[96m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
};

function colorize(text: string, color: string): string {
  return `${color}${text}${colors.reset}`;
}

export function displayWeather(weather: MarketWeather): void {
  console.log('\n' + colorize('═'.repeat(100), colors.cyan));
  console.log(colorize('🌊 MARKET WEATHER CHECK', colors.brightCyan));
  console.log(colorize('═'.repeat(100), colors.cyan));

  const weatherStyles: Record<
    string,
    { emoji: string; color: string; description: string }
  > = {
    HURRICANE: {
      emoji: '🌀',
      color: colors.brightRed,
      description: 'EXTREME DANGER - Stay inside!',
    },
    STORMY: {
      emoji: '⛈️ ',
      color: colors.red,
      description: 'HIGH RISK - Trade carefully',
    },
    CLOUDY: {
      emoji: '⛅',
      color: colors.yellow,
      description: 'NORMAL CONDITIONS - Standard trading',
    },
    CLEAR: {
      emoji: '☀️ ',
      color: colors.green,
      description: 'GOOD CONDITIONS - Trade actively',
    },
    GOLDEN: {
      emoji: '🥚',
      color: colors.brightYellow,
      description: 'PERFECT SETUP - Max bet!',
    },
  };

  const style = weatherStyles[weather.condition] || weatherStyles.CLEAR;

  const styColor = style?.color as string;

  console.log(
    colorize(
      `${style?.emoji} Condition: ${weather.condition}`,
      colors.bright + style?.color
    )
  );
  console.log(colorize(`   ${style?.description}`, styColor));
  console.log(colorize(`📊 ${weather.reason}`, colors.cyan));
  console.log();

  const metricsTable = new Table({
    head: [
      colorize('Metric', colors.bright),
      colorize('Value', colors.bright),
      colorize('Status', colors.bright),
    ],
    colWidths: [25, 20, 35],
    style: { head: [], border: ['gray'] },
  });

  let volStatus = '';
  let volColor = colors.green;
  if (weather.metrics.volatility < 1.5) {
    volStatus = '🟢 LOW - Safe';
    volColor = colors.green;
  } else if (weather.metrics.volatility < 3.0) {
    volStatus = '🟡 NORMAL - Good';
    volColor = colors.yellow;
  } else if (weather.metrics.volatility < 5.0) {
    volStatus = '🟠 HIGH - Careful';
    volColor = colors.yellow;
  } else if (weather.metrics.volatility < 8.0) {
    volStatus = '🔴 EXTREME - Risky';
    volColor = colors.red;
  } else {
    volStatus = '🚨 NUCLEAR - Danger!';
    volColor = colors.brightRed;
  }

  let btcStatus = '';
  let btcColor = colors.green;
  const btcChange = weather.metrics.btcChange24h;
  if (btcChange < -15) {
    btcStatus = '🚨 APOCALYPSE';
    btcColor = colors.brightRed;
  } else if (btcChange < -8) {
    btcStatus = '🔴 CRASH';
    btcColor = colors.brightRed;
  } else if (btcChange < -5) {
    btcStatus = '🟠 DUMP';
    btcColor = colors.red;
  } else if (btcChange < -2) {
    btcStatus = '🟡 CORRECTION';
    btcColor = colors.yellow;
  } else if (btcChange < 2) {
    btcStatus = '🟢 STABLE';
    btcColor = colors.green;
  } else if (btcChange < 5) {
    btcStatus = '🟢 RALLY';
    btcColor = colors.green;
  } else if (btcChange < 10) {
    btcStatus = '🟡 PUMP';
    btcColor = colors.yellow;
  } else if (btcChange < 20) {
    btcStatus = '🟠 MOON';
    btcColor = colors.yellow;
  } else {
    btcStatus = '🚨 SCAM PUMP';
    btcColor = colors.brightRed;
  }

  let volStatus2 = '';
  let volColor2 = colors.green;
  const vol = weather.metrics.volume;
  console.log('🥑 ~ displayWeather ~ vol:', vol);
  if (vol < 0.3) {
    volStatus2 = '💀 DEAD';
    volColor2 = colors.gray;
  } else if (vol < 0.6) {
    volStatus2 = '🟡 LOW';
    volColor2 = colors.yellow;
  } else if (vol < 1.5) {
    volStatus2 = '🟢 NORMAL';
    volColor2 = colors.green;
  } else if (vol < 3.0) {
    volStatus2 = '🟡 HIGH';
    volColor2 = colors.yellow;
  } else if (vol < 5.0) {
    volStatus2 = '🟠 FOMO';
    volColor2 = colors.yellow;
  } else {
    volStatus2 = '🚨 PANIC';
    volColor2 = colors.brightRed;
  }

  let trendStatus = '';
  let trendColor = colors.green;
  let trend = weather.metrics.trendStrength;
  console.log('🥑 ~ displayWeather ~ trend:', trend);
  if (trend > 1.0) {
    console.error(`❌ BUG: Trend is ${trend}, capping to 1.0`);
    trend = Math.min(trend / 100, 1.0); // Normalize if needed
  }

  if (trend < 0.2) {
    trendStatus = '💀 DEAD CHOP';
    trendColor = colors.gray;
  } else if (trend < 0.4) {
    trendStatus = '🟡 CHOPPY';
    trendColor = colors.yellow;
  } else if (trend < 0.6) {
    trendStatus = '🟢 MODERATE';
    trendColor = colors.green;
  } else if (trend < 0.75) {
    trendStatus = '🟢 STRONG';
    trendColor = colors.brightGreen;
  } else {
    trendStatus = '🚀 EXTREME';
    trendColor = colors.brightYellow;
  }

  metricsTable.push(
    [
      'Volatility',
      colorize(`${weather.metrics.volatility.toFixed(2)}%`, volColor),
      colorize(volStatus, volColor),
    ],
    [
      'BTC 24h Change',
      colorize(
        `${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(2)}%`,
        btcColor
      ),
      colorize(btcStatus, btcColor),
    ],
    [
      'Volume',
      colorize(`${(vol * 100).toFixed(0)}%`, volColor2),
      colorize(volStatus2, volColor2),
    ],
    [
      'Trend Strength',
      colorize(`${(trend * 100).toFixed(0)}%`, trendColor),
      colorize(trendStatus, trendColor),
    ]
  );

  console.log(metricsTable.toString());
  console.log();

  const rulesTable = new Table({
    head: [
      colorize('Rule', colors.bright),
      colorize('Value', colors.bright),
      colorize('Impact', colors.bright),
    ],
    colWidths: [25, 15, 40],
    style: { head: [], border: ['gray'] },
  });

  const shouldTradeColor = weather.shouldTrade
    ? colors.brightGreen
    : colors.brightRed;
  const shouldTradeText = weather.shouldTrade ? '✅ YES' : '❌ NO';

  const positionsColor =
    weather.tradingRules.maxPositions >= 4
      ? colors.brightGreen
      : weather.tradingRules.maxPositions >= 2
        ? colors.green
        : weather.tradingRules.maxPositions >= 1
          ? colors.yellow
          : colors.red;

  const confidenceColor =
    weather.tradingRules.minConfidence <= 75
      ? colors.brightGreen
      : weather.tradingRules.minConfidence <= 85
        ? colors.yellow
        : colors.red;

  const riskColor =
    weather.tradingRules.riskMultiplier >= 1.4
      ? colors.brightGreen
      : weather.tradingRules.riskMultiplier >= 1.1
        ? colors.green
        : weather.tradingRules.riskMultiplier >= 0.8
          ? colors.yellow
          : colors.red;

  let riskImpact = '';
  if (weather.tradingRules.riskMultiplier >= 1.2) {
    riskImpact = 'INCREASE position size by 20%';
  } else if (weather.tradingRules.riskMultiplier === 1.4) {
    riskImpact = 'Normal position sizing';
  } else if (weather.tradingRules.riskMultiplier >= 1.1) {
    riskImpact = 'Reduce size by 15-30%';
  } else if (weather.tradingRules.riskMultiplier >= 0.8) {
    riskImpact = 'CUT size by 50%';
  } else {
    riskImpact = 'MINIMAL size only';
  }

  rulesTable.push(
    [
      'Should Trade',
      colorize(shouldTradeText, shouldTradeColor),
      colorize(
        weather.shouldTrade
          ? 'Markets are open for business'
          : 'SHUTDOWN - Too dangerous',
        shouldTradeColor
      ),
    ],
    [
      'Max Positions',
      colorize(weather.tradingRules.maxPositions.toString(), positionsColor),
      colorize(
        `Can hold up to ${weather.tradingRules.maxPositions} concurrent trades`,
        positionsColor
      ),
    ],
    [
      'Min Confidence',
      colorize(`${weather.tradingRules.minConfidence}%`, confidenceColor),
      colorize(
        `Only take signals ≥${weather.tradingRules.minConfidence}% confidence`,
        confidenceColor
      ),
    ],
    [
      'Risk Multiplier',
      colorize(`${weather.tradingRules.riskMultiplier}x`, riskColor),
      colorize(riskImpact, riskColor),
    ]
  );

  if (weather.tradingRules.allowLongs !== undefined) {
    const longColor = weather.tradingRules.allowLongs
      ? colors.brightGreen
      : colors.red;
    const shortColor = weather.tradingRules.allowShorts
      ? colors.brightGreen
      : colors.red;

    rulesTable.push(
      [
        'LONG Positions',
        colorize(weather.tradingRules.allowLongs ? '✅' : '❌', longColor),
        colorize(
          weather.tradingRules.allowLongs
            ? 'Longs are allowed'
            : 'LONGS FORBIDDEN',
          longColor
        ),
      ],
      [
        'SHORT Positions',
        colorize(weather.tradingRules.allowShorts ? '✅' : '❌', shortColor),
        colorize(
          weather.tradingRules.allowShorts
            ? 'Shorts are allowed'
            : 'SHORTS FORBIDDEN',
          shortColor
        ),
      ]
    );
  }

  console.log(rulesTable.toString());
  console.log(colorize('═'.repeat(100), colors.cyan) + '\n');

  let recommendation = '';
  let recColor = colors.green;

  switch (weather.condition) {
    case 'HURRICANE':
      recommendation =
        '🚨 SHUT IT DOWN! Close all positions and wait for conditions to improve.';
      recColor = colors.brightRed;
      break;
    case 'STORMY':
      recommendation =
        '⚠️  HIGH RISK! Only take your best setups. Use wider stops. Cut position sizes.';
      recColor = colors.red;
      break;
    case 'CLOUDY':
      recommendation =
        '📊 NORMAL TRADING. Standard rules apply. Stay disciplined.';
      recColor = colors.yellow;
      break;
    case 'CLEAR':
      recommendation =
        '✅ GOOD CONDITIONS! Trade actively. Follow your signals.';
      recColor = colors.green;
      break;
    case 'GOLDEN':
      recommendation =
        '🥚 JACKPOT! Maximum aggression. Increase size. Let winners run!';
      recColor = colors.brightYellow;
      break;
  }

  console.log(colorize('💡 RECOMMENDATION:', colors.bright));
  console.log(colorize(`   ${recommendation}`, recColor));
  console.log();

  console.log('🎯 Trading Rules:');
  console.log(`   Should Trade: ${weather.shouldTrade ? '✅ YES' : '❌ NO'}`);
  console.log(`   Max Positions: ${weather.tradingRules.maxPositions}`);
  console.log(`   Min Confidence: ${weather.tradingRules.minConfidence}%`);
  console.log(`   Risk Multiplier: ${weather.tradingRules.riskMultiplier}x`);
  console.log('═'.repeat(80) + '\n');
}

/**
 * Extended Indicators interface - add these fields to your existing Indicators type
 */
export interface MomentumIndicators {
  macd?: MACDOutput[];
  stochastic?: StochasticOutput[];
  roc?: number[];
}

/**
 * Calculate MACD indicator
 */
export function calculateMACD(closes: number[]): MACDOutput[] | undefined {
  if (closes.length < 26) return undefined;

  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  return macdResult;
}

/**
 * Calculate Stochastic Oscillator
 */
export function calculateStochastic(
  highs: number[],
  lows: number[],
  closes: number[]
): StochasticOutput[] | undefined {
  if (closes.length < 14) return undefined;

  const stochasticResult = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
    signalPeriod: 3,
  });

  return stochasticResult;
}

/**
 * Calculate Rate of Change (ROC)
 */
export function calculateROC(
  closes: number[],
  period: number = 12
): number[] | undefined {
  if (closes.length < period + 1) return undefined;

  const rocResult = ROC.calculate({
    values: closes,
    period: period,
  });

  return rocResult;
}

/**
 * MACD Signal Analysis
 * Returns: { signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL', strength: number, description: string }
 */
export function analyzeMACDSignal(macd: MACDOutput[]): {
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number;
  description: string;
} {
  if (!macd || macd.length < 2) {
    return { signal: 'NEUTRAL', strength: 0, description: 'Insufficient data' };
  }

  const current = macd[macd.length - 1];
  const previous = macd[macd.length - 2];

  if (!current || !previous) {
    return { signal: 'NEUTRAL', strength: 0, description: 'Invalid data' };
  }

  const bullishCrossover =
    previous.MACD! <= previous.signal! && current.MACD! > current.signal!;

  const bearishCrossover =
    previous.MACD! >= previous.signal! && current.MACD! < current.signal!;

  const histogramStrength = Math.abs(current.histogram!);
  const normalizedStrength = Math.min(100, histogramStrength * 50);

  if (bullishCrossover) {
    return {
      signal: 'BULLISH',
      strength: normalizedStrength,
      description: 'MACD crossed above signal line (bullish crossover)',
    };
  }

  if (bearishCrossover) {
    return {
      signal: 'BEARISH',
      strength: normalizedStrength,
      description: 'MACD crossed below signal line (bearish crossover)',
    };
  }

  if (current.MACD! > current.signal! && current.histogram! > 0) {
    return {
      signal: 'BULLISH',
      strength: normalizedStrength * 0.7,
      description: 'MACD above signal line (bullish momentum)',
    };
  }

  if (current.MACD! < current.signal! && current.histogram! < 0) {
    return {
      signal: 'BEARISH',
      strength: normalizedStrength * 0.7,
      description: 'MACD below signal line (bearish momentum)',
    };
  }

  return {
    signal: 'NEUTRAL',
    strength: 0,
    description: 'No clear MACD signal',
  };
}

/**
 * Stochastic Signal Analysis
 * Returns: { signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL', strength: number, description: string }
 */
export function analyzeStochasticSignal(stochastic: StochasticOutput[]): {
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number;
  description: string;
  overbought: boolean;
  oversold: boolean;
} {
  if (!stochastic || stochastic.length < 2) {
    return {
      signal: 'NEUTRAL',
      strength: 0,
      description: 'Insufficient data',
      overbought: false,
      oversold: false,
    };
  }

  const current = stochastic[stochastic.length - 1];
  const previous = stochastic[stochastic.length - 2];

  if (!current || !previous) {
    return {
      signal: 'NEUTRAL',
      strength: 0,
      description: 'Invalid data',
      overbought: false,
      oversold: false,
    };
  }

  const k = current.k!;
  const d = current.d!;
  const prevK = previous.k!;
  const prevD = previous.d!;

  const overbought = k > 80;
  const oversold = k < 20;

  if (oversold && prevK <= prevD && k > d) {
    return {
      signal: 'BULLISH',
      strength: 90,
      description: 'Stochastic bullish crossover in oversold zone (strong buy)',
      overbought,
      oversold,
    };
  }

  if (overbought && prevK >= prevD && k < d) {
    return {
      signal: 'BEARISH',
      strength: 90,
      description:
        'Stochastic bearish crossover in overbought zone (strong sell)',
      overbought,
      oversold,
    };
  }

  if (prevK <= prevD && k > d) {
    return {
      signal: 'BULLISH',
      strength: 60,
      description: 'Stochastic bullish crossover',
      overbought,
      oversold,
    };
  }

  if (prevK >= prevD && k < d) {
    return {
      signal: 'BEARISH',
      strength: 60,
      description: 'Stochastic bearish crossover',
      overbought,
      oversold,
    };
  }

  if (oversold) {
    return {
      signal: 'BULLISH',
      strength: 40,
      description: 'Stochastic oversold (potential reversal)',
      overbought,
      oversold,
    };
  }

  if (overbought) {
    return {
      signal: 'BEARISH',
      strength: 40,
      description: 'Stochastic overbought (potential reversal)',
      overbought,
      oversold,
    };
  }

  return {
    signal: 'NEUTRAL',
    strength: 0,
    description: 'No clear Stochastic signal',
    overbought,
    oversold,
  };
}

/**
 * ROC Signal Analysis
 * Returns: { signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL', strength: number, description: string }
 */
export function analyzeROCSignal(roc: number[]): {
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number;
  description: string;
  momentum: 'ACCELERATING' | 'DECELERATING' | 'STABLE';
} {
  if (!roc || roc.length < 3) {
    return {
      signal: 'NEUTRAL',
      strength: 0,
      description: 'Insufficient data',
      momentum: 'STABLE',
    };
  }

  const current = roc[roc.length - 1]!;
  const previous = roc[roc.length - 2]!;
  const twoPrevious = roc[roc.length - 3]!;

  const isAccelerating = Math.abs(current) > Math.abs(previous);
  const momentum = isAccelerating ? 'ACCELERATING' : 'DECELERATING';

  if (current > 5 && isAccelerating) {
    return {
      signal: 'BULLISH',
      strength: Math.min(100, Math.abs(current) * 5),
      description: `Strong positive ROC (${current.toFixed(2)}%) - accelerating uptrend`,
      momentum: 'ACCELERATING',
    };
  }

  if (current < -5 && isAccelerating) {
    return {
      signal: 'BEARISH',
      strength: Math.min(100, Math.abs(current) * 5),
      description: `Strong negative ROC (${current.toFixed(2)}%) - accelerating downtrend`,
      momentum: 'ACCELERATING',
    };
  }

  if (current > 0 && !isAccelerating && previous > twoPrevious) {
    return {
      signal: 'BEARISH',
      strength: 50,
      description: `Positive ROC decelerating - momentum weakening`,
      momentum: 'DECELERATING',
    };
  }

  if (current < 0 && !isAccelerating && previous < twoPrevious) {
    return {
      signal: 'BULLISH',
      strength: 50,
      description: `Negative ROC decelerating - downward momentum weakening`,
      momentum: 'DECELERATING',
    };
  }

  if (current > 0) {
    return {
      signal: 'BULLISH',
      strength: Math.min(70, Math.abs(current) * 8),
      description: `Positive ROC (${current.toFixed(2)}%) - upward momentum`,
      momentum,
    };
  }

  if (current < 0) {
    return {
      signal: 'BEARISH',
      strength: Math.min(70, Math.abs(current) * 8),
      description: `Negative ROC (${current.toFixed(2)}%) - downward momentum`,
      momentum,
    };
  }

  return {
    signal: 'NEUTRAL',
    strength: 0,
    description: 'ROC near zero - no clear momentum',
    momentum: 'STABLE',
  };
}

/**
 * Combined Momentum Score
 * Combines MACD, Stochastic, and ROC into a single momentum assessment
 */
export function calculateMomentumScore(
  macd: MACDOutput[] | undefined,
  stochastic: StochasticOutput[] | undefined,
  roc: number[] | undefined
): {
  score: number;
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  details: string[];
  macdScore: number;
  stochasticScore: number;
  rocScore: number;
  overall: number;
} {
  const details: string[] = [];
  let bullishPoints = 0;
  let bearishPoints = 0;
  let totalWeight = 0;

  if (macd) {
    const macdAnalysis = analyzeMACDSignal(macd);
    const macdWeight = 35;
    totalWeight += macdWeight;

    if (macdAnalysis.signal === 'BULLISH') {
      bullishPoints += (macdAnalysis.strength / 100) * macdWeight;
      details.push(`✅ ${macdAnalysis.description}`);
    } else if (macdAnalysis.signal === 'BEARISH') {
      bearishPoints += (macdAnalysis.strength / 100) * macdWeight;
      details.push(`❌ ${macdAnalysis.description}`);
    }
  }

  if (stochastic) {
    const stochAnalysis = analyzeStochasticSignal(stochastic);
    const stochWeight = 30;
    totalWeight += stochWeight;

    if (stochAnalysis.signal === 'BULLISH') {
      bullishPoints += (stochAnalysis.strength / 100) * stochWeight;
      details.push(`✅ ${stochAnalysis.description}`);
    } else if (stochAnalysis.signal === 'BEARISH') {
      bearishPoints += (stochAnalysis.strength / 100) * stochWeight;
      details.push(`❌ ${stochAnalysis.description}`);
    }
  }

  if (roc) {
    const rocAnalysis = analyzeROCSignal(roc);
    const rocWeight = 35;
    totalWeight += rocWeight;

    if (rocAnalysis.signal === 'BULLISH') {
      bullishPoints += (rocAnalysis.strength / 100) * rocWeight;
      details.push(`✅ ${rocAnalysis.description}`);
    } else if (rocAnalysis.signal === 'BEARISH') {
      bearishPoints += (rocAnalysis.strength / 100) * rocWeight;
      details.push(`❌ ${rocAnalysis.description}`);
    }
  }

  if (totalWeight === 0) {
    return {
      score: 0,
      signal: 'NEUTRAL',
      confidence: 0,
      details: ['No momentum data available'],
      macdScore: 0,
      stochasticScore: 0,
      rocScore: 0,
      overall: 0,
    };
  }

  const netPoints = bullishPoints - bearishPoints;
  const score = (netPoints / totalWeight) * 100;

  let signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (score > 20) signal = 'BULLISH';
  else if (score < -20) signal = 'BEARISH';

  const confidence = Math.min(100, Math.abs(score));

  const macdScore = macd ? (analyzeMACDSignal(macd).strength / 100) * 35 : 0;
  const stochasticScore = stochastic
    ? (analyzeStochasticSignal(stochastic).strength / 100) * 30
    : 0;
  const rocScore = roc ? (analyzeROCSignal(roc).strength / 100) * 35 : 0;
  const overall = Math.round(
    (macdScore + stochasticScore + rocScore) / Math.max(totalWeight / 100, 1)
  );

  return {
    score: Math.round(score),
    signal,
    confidence: Math.round(confidence),
    details,
    macdScore: Math.round(macdScore),
    stochasticScore: Math.round(stochasticScore),
    rocScore: Math.round(rocScore),
    overall,
  };
}

/**
 * Example usage in your existing scanner:
 *
 *
 * const macd = calculateMACD(candles.closes);
 * const stochastic = calculateStochastic(candles.highs, candles.lows, candles.closes);
 * const roc = calculateROC(candles.closes, 12);
 *
 *
 * const momentumScore = calculateMomentumScore(macd, stochastic, roc);
 *
 *
 * const momentumBoost = momentumScore.signal === currentSignal ? momentumScore.confidence * 0.2 : 0;
 * finalConfidence += momentumBoost;
 */
