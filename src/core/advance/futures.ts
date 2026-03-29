// Requires TensorFlow.js

// import * as tf from '@tensorflow/tfjs-node';
import type { OrderBook, Trade } from 'ccxt';

import { calculateRSI } from '../../futures/bf.js';

//! 1. Order Flow Imbalance (OFI) 🏆

interface OrderFlowMetrics {
  bidAskImbalance: number; // Ratio of bid volume to ask volume
  deltaVolume: number; // Buy volume - sell volume
  cumulativeDelta: number; // Running sum of delta
  volumeProfile: Map<number, number>; // Volume at each price
}

// async function calculateOrderFlow(symbol: string): Promise<OrderFlowMetrics> {
//   const orderBook = await binanceF.fetchOrderBook(symbol, 100);
//   const trades = await binanceF.fetchTrades(symbol, undefined, 1000);

//   // 1. Bid/Ask Imbalance
//   const bidVolume = orderBook.bids.reduce((sum, [price, vol]) => sum + vol, 0);
//   const askVolume = orderBook.asks.reduce((sum, [price, vol]) => sum + vol, 0);
//   const bidAskImbalance = bidVolume / askVolume;

//   // 2. Delta Volume (buying pressure)
//   let deltaVolume = 0;
//   let cumulativeDelta = 0;

//   for (const trade of trades) {
//     const delta = trade.side === 'buy' ? trade.amount : -trade.amount;
//     deltaVolume += delta;
//     cumulativeDelta += delta;
//   }

//   // 3. Volume Profile (TPO - Time Price Opportunity)
//   const volumeProfile = new Map<number, number>();
//   for (const trade of trades) {
//     const priceLevel = Math.round(trade.price * 100) / 100; // Round to 2 decimals
//     volumeProfile.set(
//       priceLevel,
//       (volumeProfile.get(priceLevel) || 0) + trade.amount
//     );
//   }

//   return {
//     bidAskImbalance,
//     deltaVolume,
//     cumulativeDelta,
//     volumeProfile,
//   };
// }

// Trading signal
// const ofi = await calculateOrderFlow('BTC/USDT');

// if (ofi.bidAskImbalance > 2.0 && ofi.cumulativeDelta > 0) {
//   // Strong buying pressure - GO LONG
//   enterLong();
// } else if (ofi.bidAskImbalance < 0.5 && ofi.cumulativeDelta < 0) {
//   // Strong selling pressure - GO SHORT
//   enterShort();
// }

//! 2. Market Microstructure (Spread Analysis)

interface MicrostructureMetrics {
  effectiveSpread: number;
  realizedSpread: number;
  priceImpact: number;
  rollMeasure: number; // Auto-correlation of price changes
  hasnerEstimator: number; // Adverse selection component
}

function calculateMicrostructure(
  trades: Trade[],
  orderBook: OrderBook
): MicrostructureMetrics {
  if (!orderBook.bids[0] || !orderBook.asks[0]) {
    throw new Error('Order book is missing top bid or ask.');
  }
  const bidPrice = orderBook.bids[0]?.[0];
  const askPrice = orderBook.asks[0]?.[0];
  if (bidPrice === undefined || askPrice === undefined) {
    throw new Error('Order book is missing top bid or ask price.');
  }
  const midPrice = (bidPrice + askPrice) / 2;

  // 1. Effective Spread (what traders actually pay)
  const effectiveSpread =
    trades
      .map((t) => (2 * Math.abs(t.price - midPrice)) / midPrice)
      .reduce((a, b) => a + b) / trades.length;

  // 2. Roll Measure (price bounce)
  const priceChanges: any[] = [];
  for (let i = 1; i < trades.length; i++) {
    if (
      trades[i] !== undefined &&
      trades[i - 1] !== undefined &&
      typeof trades[i]?.price === 'number' &&
      typeof trades[i - 1]?.price === 'number'
    ) {
      priceChanges.push(trades[i]!.price - trades[i - 1]!.price);
    }
  }

  const rollMeasure =
    -priceChanges
      .slice(0, -1)
      .reduce((sum, change, i) => sum + change * priceChanges[i + 1], 0) /
    (priceChanges.length - 1);

  // 3. Price Impact (how much market moves per $1M traded)
  const avgTradeSize =
    trades.reduce((sum, t) => sum + (t.amount ?? 0) * t.price, 0) /
    trades.length;
  const firstTrade = trades[0];
  const lastTrade = trades[trades.length - 1];
  if (
    !firstTrade ||
    !lastTrade ||
    typeof firstTrade.price !== 'number' ||
    typeof lastTrade.price !== 'number'
  ) {
    throw new Error('Not enough trade data to calculate price move.');
  }
  const priceMove = Math.abs(lastTrade.price - firstTrade.price);
  const priceImpact = priceMove / midPrice / (avgTradeSize / 1000000);

  return {
    effectiveSpread,
    realizedSpread: effectiveSpread * 0.5, // Simplified
    priceImpact,
    rollMeasure,
    hasnerEstimator: rollMeasure / effectiveSpread,
  };
}

// Example usage for microstructure metrics
// Note: You need to provide actual trades and orderBook data from your exchange
// const trades = await binanceF.fetchTrades(symbol, undefined, 1000);
// const orderBook = await binanceF.fetchOrderBook(symbol, 100);
// const micro = calculateMicrostructure(trades, orderBook);

// Signal: High price impact = whale activity
// Uncomment the following lines after defining 'micro' as above
// if (micro.priceImpact > 0.001) {
//   console.log('🐋 Whale detected - large order moving market');
// }

//! 3. Hurst Exponent (Mean Reversion vs Trending)
function calculateHurstExponent(prices: number[]): number {
  const n = prices.length;
  const lags = [10, 20, 50, 100];
  const rsByLag: number[] = [];

  for (const lag of lags) {
    // Calculate mean
    const mean = prices.slice(-lag).reduce((a, b) => a + b) / lag;

    // Calculate cumulative deviation
    let cumDev = 0;
    const deviations: number[] = [];
    for (let i = n - lag; i < n; i++) {
      const price = prices[i];
      if (price !== undefined) {
        cumDev += price - mean;
        deviations.push(cumDev);
      }
    }

    // Calculate range
    const range = Math.max(...deviations) - Math.min(...deviations);

    // Calculate standard deviation
    const variance = deviations.reduce((sum, d) => sum + d * d, 0) / lag;
    const stdDev = Math.sqrt(variance);

    // R/S ratio
    rsByLag.push(range / stdDev);
  }

  // Linear regression to find Hurst exponent
  const logLags = lags.map(Math.log);
  const logRS = rsByLag.map(Math.log);

  const n_points = logLags.length;
  const sum_x = logLags.reduce((a, b) => a + b);
  const sum_y = logRS.reduce((a, b) => a + b);
  const sum_xy = logLags.reduce((sum, x, i) => {
    const y = logRS[i] !== undefined ? logRS[i] : 0;
    return sum + x * y;
  }, 0);
  const sum_xx = logLags.reduce((sum, x) => sum + x * x, 0);

  const hurst =
    (n_points * sum_xy - sum_x * sum_y) / (n_points * sum_xx - sum_x * sum_x);

  return hurst;
}

// Interpretation:
// Note: candles object should be fetched from exchange
// Example: const candles = await binanceF.fetchOHLCV(symbol, '1h', undefined, limit);
// const hurst = calculateHurstExponent(candles.closes);

// if (hurst > 0.5 && hurst < 0.6) {
//   console.log('📈 Trending market - use trend-following strategies');
//   // Use EMA crossovers, breakouts
// } else if (hurst < 0.5) {
//   console.log('🔄 Mean-reverting market - use reversion strategies');
//   // Use Bollinger Bands, RSI oversold/overbought
// } else if (hurst === 0.5) {
//   console.log('🎲 Random walk - avoid trading');
// }

//! 4. Kalman Filter (Adaptive Moving Average)

class KalmanFilter {
  private x: number = 0; // State estimate
  private P: number = 1; // Estimate error
  private Q: number = 0.01; // Process noise
  private R: number = 0.1; // Measurement noise

  update(measurement: number): number {
    // Prediction
    const x_pred = this.x;
    const P_pred = this.P + this.Q;

    // Update
    const K = P_pred / (P_pred + this.R); // Kalman gain
    this.x = x_pred + K * (measurement - x_pred);
    this.P = (1 - K) * P_pred;

    return this.x;
  }

  getState(): number {
    return this.x;
  }
}

// Usage: Adaptive trendline
// Note: candles object should be passed as a parameter or fetched from exchange
// Example: const candles = await binanceF.fetchOHLCV(symbol, '1h', undefined, limit);
const kf = new KalmanFilter();
const filteredPrices: number[] = [];

// for (const price of candles.closes) {
//   const filtered = kf.update(price);
//   filteredPrices.push(filtered);
// }

// Signal: Price crosses Kalman filter
// const currentPrice = candles.closes[candles.closes.length - 1];
// const kalmanPrice = filteredPrices[filteredPrices.length - 1];

// if (
//   currentPrice > kalmanPrice &&
//   candles.closes[candles.closes.length - 2] <=
//     filteredPrices[filteredPrices.length - 2]
// ) {
//   console.log('🚀 Bullish cross - price above adaptive filter');
//   enterLong();
// }

//! 5. Entropy (Market Randomness)
function calculateEntropy(prices: number[], bins: number = 10): number {
  // 1. Create histogram
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const binSize = (max - min) / bins;

  const histogram = new Array(bins).fill(0);
  for (const price of prices) {
    const binIndex = Math.min(Math.floor((price - min) / binSize), bins - 1);
    histogram[binIndex]++;
  }

  // 2. Calculate probabilities
  const probabilities = histogram.map((count) => count / prices.length);

  // 3. Calculate Shannon entropy
  let entropy = 0;
  for (const p of probabilities) {
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

// Usage
// const entropy = calculateEntropy(candles.closes.slice(-100));

// if (entropy < 2.0) {
//   console.log('📊 Low entropy - market is predictable/trending');
//   // Use trend-following
// } else if (entropy > 3.0) {
//   console.log('🎲 High entropy - market is chaotic/random');
//   // Reduce position size or don't trade
// }

//! 6. Volume-Synchronized Probability of Informed Trading (VPIN)
interface VPINMetrics {
  vpin: number;
  toxicity: 'LOW' | 'MEDIUM' | 'HIGH';
  flowToxicity: number;
}

function calculateVPIN(trades: Trade[], buckets: number = 50): VPINMetrics {
  // 1. Calculate volume buckets
  const totalVolume = trades.reduce((sum, t) => sum + (t.amount || 0), 0);
  const volumePerBucket = totalVolume / buckets;

  // 2. Classify trades as buy or sell
  const bucketImbalances: number[] = [];
  let currentBucketVolume = 0;
  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of trades) {
    currentBucketVolume += trade.amount || 0;

    if (trade.side === 'buy') {
      buyVolume += trade.amount || 0;
    } else {
      sellVolume += trade.amount || 0;
    }

    // Bucket full
    if (currentBucketVolume >= volumePerBucket) {
      const imbalance = Math.abs(buyVolume - sellVolume);
      bucketImbalances.push(imbalance);

      currentBucketVolume = 0;
      buyVolume = 0;
      sellVolume = 0;
    }
  }

  // 3. Calculate VPIN
  const avgImbalance =
    bucketImbalances.reduce((a, b) => a + b) / bucketImbalances.length;
  const vpin = avgImbalance / volumePerBucket;

  // 4. Classify toxicity
  let toxicity: 'LOW' | 'MEDIUM' | 'HIGH';
  if (vpin < 0.3) toxicity = 'LOW';
  else if (vpin < 0.5) toxicity = 'MEDIUM';
  else toxicity = 'HIGH';

  return {
    vpin,
    toxicity,
    flowToxicity: vpin,
  };
}

// Signal: High VPIN = informed trading happening
// Note: recentTrades should be fetched from exchange, e.g., await binanceF.fetchTrades(symbol, undefined, 1000);
// const recentTrades = await binanceF.fetchTrades(symbol, undefined, 1000);
// const vpin = calculateVPIN(recentTrades);

// if (vpin.toxicity === 'HIGH') {
//   console.log('⚠️ HIGH VPIN - Informed traders active, expect volatility');
//   // Widen stops, reduce size
// }

//! 7. LSTM Price Prediction (Deep Learning)

// async function trainLSTM(prices: number[]): Promise<tf.LayersModel> {
//   // Normalize data
//   const normalized = prices.map(
//     (p) =>
//       (p - Math.min(...prices)) / (Math.max(...prices) - Math.min(...prices))
//   );

//   // Create sequences
//   const sequenceLength = 60;
//   const X: number[][] = [];
//   const y: number[] = [];

//   for (let i = sequenceLength; i < normalized.length; i++) {
//     X.push(normalized.slice(i - sequenceLength, i));
//     const value = normalized[i];
//     if (value !== undefined) {
//       y.push(value);
//     }
//   }

//   // Build model
//   const model = tf.sequential({
//     layers: [
//       tf.layers.lstm({
//         units: 50,
//         returnSequences: true,
//         inputShape: [sequenceLength, 1],
//       }),
//       tf.layers.dropout({ rate: 0.2 }),
//       tf.layers.lstm({ units: 50, returnSequences: false }),
//       tf.layers.dropout({ rate: 0.2 }),
//       tf.layers.dense({ units: 25 }),
//       tf.layers.dense({ units: 1 }),
//     ],
//   });

//   model.compile({
//     optimizer: 'adam',
//     loss: 'meanSquaredError',
//   });

//   // Train
//   const xs = tf.tensor3d(X.map((seq) => seq.map((val) => [val])));
//   const ys = tf.tensor2d(y, [y.length, 1]);

//   await model.fit(xs, ys, {
//     epochs: 50,
//     batchSize: 32,
//     validationSplit: 0.2,
//   });

//   return model;
// }

// Predict next price
// const model = await trainLSTM(candles.closes);
// const lastSequence = candles.closes.slice(-60);
// const prediction = model.predict(tf.tensor3d([lastSequence.map((p) => [p])]));

//! 8. Reinforcement Learning Agent
// Using Q-Learning (simplified)
class TradingAgent {
  private qTable: Map<string, Map<string, number>> = new Map();
  private learningRate = 0.1;
  private discountFactor = 0.95;
  private epsilon = 0.1; // Exploration rate

  getState(candles: any): string {
    const rsi = calculateRSI(candles.closes, 14);
    const trend =
      candles.closes[candles.closes.length - 1] >
      candles.closes[candles.closes.length - 10]
        ? 'UP'
        : 'DOWN';

    return `RSI:${Math.floor(rsi / 10)}_TREND:${trend}`;
  }

  chooseAction(state: string): 'BUY' | 'SELL' | 'HOLD' {
    // Epsilon-greedy strategy
    if (Math.random() < this.epsilon) {
      return ['BUY', 'SELL', 'HOLD'][Math.floor(Math.random() * 3)] as any;
    }

    const actions = this.qTable.get(state) || new Map();
    let bestAction: string = 'HOLD';
    let bestValue = -Infinity;

    for (const [action, value] of actions) {
      if (value > bestValue) {
        bestValue = value;
        bestAction = action;
      }
    }

    return bestAction as any;
  }

  learn(
    state: string,
    action: string,
    reward: number,
    nextState: string
  ): void {
    if (!this.qTable.has(state)) {
      this.qTable.set(state, new Map());
    }

    const currentQ = this.qTable.get(state)!.get(action) || 0;
    const nextStateActions = this.qTable.get(nextState) || new Map();
    const maxNextQ = Math.max(...Array.from(nextStateActions.values()), 0);

    const newQ =
      currentQ +
      this.learningRate * (reward + this.discountFactor * maxNextQ - currentQ);
    this.qTable.get(state)!.set(action, newQ);
  }
}
