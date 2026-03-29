export interface OrderBookLevel {
  price: number;
  volume: number;
}

export interface OrderBookData {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface OrderBookImbalanceConfig {
  // Number of levels to analyze (e.g., top 10 levels)
  levels: number;

  // Minimum imbalance ratio to generate signal (e.g., 1.5 = 50% more volume on one side)
  minImbalanceRatio: number;

  // Minimum total volume to consider (filter out low liquidity)
  minTotalVolume: number;

  // Weighted depth analysis (give more weight to levels closer to mid price)
  useWeightedDepth: boolean;

  // Consider volume-weighted average price in calculation
  useVWAP: boolean;
}

export interface OrderBookImbalanceResult {
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  imbalanceRatio: number; // > 1 = more bids, < 1 = more asks
  bidVolume: number;
  askVolume: number;
  bidPressure: number; // 0-100 scale
  askPressure: number; // 0-100 scale
  confidence: number; // 0-100 based on volume and ratio
  vwapBid: number | undefined;
  vwapAsk: number | undefined;
  spread: number;
  spreadPercent: number;
}

export class OrderBookImbalanceSignal {
  private config: OrderBookImbalanceConfig;

  constructor(config: Partial<OrderBookImbalanceConfig> = {}) {
    this.config = {
      levels: config.levels || 10,
      minImbalanceRatio: config.minImbalanceRatio || 1.5,
      minTotalVolume: config.minTotalVolume || 1000,
      useWeightedDepth: config.useWeightedDepth ?? true,
      useVWAP: config.useVWAP ?? true,
    };
  }

  /**
   * Calculate order book imbalance from order book data
   */
  public calculate(orderBook: OrderBookData): OrderBookImbalanceResult {
    const topBids = orderBook.bids.slice(
      0,
      this.config.levels
    ) as OrderBookLevel[];
    const topAsks = orderBook.asks.slice(
      0,
      this.config.levels
    ) as OrderBookLevel[];

    // Calculate basic metrics
    const bidVolume = this.calculateVolume(topBids);
    const askVolume = this.calculateVolume(topAsks);
    const totalVolume = bidVolume + askVolume;

    // Calculate spread
    const bestBid = orderBook.bids[0]?.price || 0;
    const bestAsk = orderBook.asks[0]?.price || 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPercent = (spread / midPrice) * 100;

    // Calculate VWAP if enabled
    let vwapBid: number | undefined;
    let vwapAsk: number | undefined;
    if (this.config.useVWAP) {
      vwapBid = this.calculateVWAP(topBids) as number;
      vwapAsk = this.calculateVWAP(topAsks) as number;
    }

    // Calculate weighted volumes if enabled
    let effectiveBidVolume = bidVolume;
    let effectiveAskVolume = askVolume;

    if (this.config.useWeightedDepth) {
      effectiveBidVolume = this.calculateWeightedVolume(
        topBids,
        bestBid,
        'bid'
      );
      effectiveAskVolume = this.calculateWeightedVolume(
        topAsks,
        bestAsk,
        'ask'
      );
    }

    // Calculate imbalance ratio
    const imbalanceRatio = effectiveBidVolume / effectiveAskVolume;

    // Calculate pressure (normalized 0-100)
    const bidPressure = (effectiveBidVolume / totalVolume) * 100;
    const askPressure = (effectiveAskVolume / totalVolume) * 100;

    // Determine signal
    let signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (totalVolume >= this.config.minTotalVolume) {
      if (imbalanceRatio >= this.config.minImbalanceRatio) {
        signal = 'BULLISH';
      } else if (imbalanceRatio <= 1 / this.config.minImbalanceRatio) {
        signal = 'BEARISH';
      }
    }

    // Calculate confidence (0-100)
    const confidence = this.calculateConfidence(
      imbalanceRatio,
      totalVolume,
      spreadPercent
    );

    return {
      signal,
      imbalanceRatio,
      bidVolume,
      askVolume,
      bidPressure,
      askPressure,
      confidence,
      vwapBid,
      vwapAsk,
      spread,
      spreadPercent,
    };
  }

  /**
   * Calculate total volume from order book levels
   */
  private calculateVolume(levels: OrderBookLevel[]): number {
    return levels.reduce((sum, level) => sum + level.volume, 0);
  }

  /**
   * Calculate Volume Weighted Average Price
   */
  private calculateVWAP(levels: OrderBookLevel[]): number {
    const totalValue = levels.reduce(
      (sum, level) => sum + level.price * level.volume,
      0
    );
    const totalVolume = this.calculateVolume(levels);
    return totalVolume > 0 ? totalValue / totalVolume : 0;
  }

  /**
   * Calculate weighted volume (closer levels have more weight)
   */
  private calculateWeightedVolume(
    levels: OrderBookLevel[],
    referencePrice: number,
    side: 'bid' | 'ask'
  ): number {
    return levels.reduce((sum, level, index) => {
      // Weight decreases with distance from best price
      const weight = 1 / (index + 1);

      // Additional weight based on price proximity
      const priceDistance = Math.abs(level.price - referencePrice);
      const priceWeight = 1 / (1 + priceDistance / referencePrice);

      const combinedWeight = weight * priceWeight;
      return sum + level.volume * combinedWeight;
    }, 0);
  }

  /**
   * Calculate confidence score (0-100)
   */
  private calculateConfidence(
    imbalanceRatio: number,
    totalVolume: number,
    spreadPercent: number
  ): number {
    let confidence = 0;

    // Confidence from imbalance strength (0-50 points)
    const imbalanceStrength = Math.abs(Math.log(imbalanceRatio));
    confidence += Math.min(imbalanceStrength * 20, 50);

    // Confidence from volume (0-30 points)
    const volumeScore = Math.min(
      (totalVolume / (this.config.minTotalVolume * 10)) * 30,
      30
    );
    confidence += volumeScore;

    // Confidence from spread (0-20 points) - tighter spread = more confidence
    const spreadScore = Math.max(0, 20 - spreadPercent * 10);
    confidence += spreadScore;

    return Math.min(Math.round(confidence), 100);
  }

  /**
   * Get a time series of imbalance to detect trends
   */
  public calculateTrend(
    recentResults: OrderBookImbalanceResult[],
    periods: number = 5
  ): {
    trend: 'INCREASING_BID' | 'INCREASING_ASK' | 'STABLE';
    momentum: number;
  } {
    if (recentResults.length < periods) {
      return { trend: 'STABLE', momentum: 0 };
    }

    const recent = recentResults.slice(-periods);
    const ratios = recent.map((r) => r.imbalanceRatio);

    // Calculate linear regression slope
    const n = ratios.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const avgX = x.reduce((a, b) => a + b) / n;
    const avgY = ratios.reduce((a, b) => a + b) / n;

    const numerator = x.reduce(
      (sum, xi, i) => sum + (xi - avgX) * ((ratios[i] as number) - avgY),
      0
    );
    const denominator = x.reduce((sum, xi) => sum + Math.pow(xi - avgX, 2), 0);
    const slope = numerator / denominator;

    // Determine trend
    let trend: 'INCREASING_BID' | 'INCREASING_ASK' | 'STABLE' = 'STABLE';
    if (slope > 0.1) trend = 'INCREASING_BID';
    else if (slope < -0.1) trend = 'INCREASING_ASK';

    return { trend, momentum: slope };
  }

  /**
   * Combine with price action for stronger signal
   */
  public combineWithPriceAction(
    imbalanceResult: OrderBookImbalanceResult,
    priceChange: number,
    priceChangePercent: number
  ): {
    combinedSignal:
      | 'STRONG_BULLISH'
      | 'BULLISH'
      | 'NEUTRAL'
      | 'BEARISH'
      | 'STRONG_BEARISH';
    divergence: boolean;
    confidence: number;
  } {
    const { signal, confidence } = imbalanceResult;

    // Check for divergence (imbalance doesn't match price action)
    const divergence =
      (signal === 'BULLISH' && priceChangePercent < -0.1) ||
      (signal === 'BEARISH' && priceChangePercent > 0.1);

    // Determine combined signal
    let combinedSignal:
      | 'STRONG_BULLISH'
      | 'BULLISH'
      | 'NEUTRAL'
      | 'BEARISH'
      | 'STRONG_BEARISH' = 'NEUTRAL';
    let combinedConfidence = confidence;

    if (signal === 'BULLISH' && priceChangePercent > 0) {
      combinedSignal = 'STRONG_BULLISH';
      combinedConfidence = Math.min(confidence + 20, 100);
    } else if (signal === 'BULLISH') {
      combinedSignal = 'BULLISH';
    } else if (signal === 'BEARISH' && priceChangePercent < 0) {
      combinedSignal = 'STRONG_BEARISH';
      combinedConfidence = Math.min(confidence + 20, 100);
    } else if (signal === 'BEARISH') {
      combinedSignal = 'BEARISH';
    }

    return {
      combinedSignal,
      divergence,
      confidence: combinedConfidence,
    };
  }
}

// Example usage
export async function exampleUsage() {
  const signal = new OrderBookImbalanceSignal({
    levels: 10,
    minImbalanceRatio: 1.5,
    minTotalVolume: 5000,
    useWeightedDepth: true,
    useVWAP: true,
  });

  // Mock order book data (in real implementation, fetch from exchange)
  const orderBook: OrderBookData = {
    bids: [
      { price: 100.5, volume: 1000 },
      { price: 100.4, volume: 800 },
      { price: 100.3, volume: 1200 },
      { price: 100.2, volume: 900 },
      { price: 100.1, volume: 700 },
      { price: 100.0, volume: 600 },
      { price: 99.9, volume: 500 },
      { price: 99.8, volume: 450 },
      { price: 99.7, volume: 400 },
      { price: 99.6, volume: 350 },
    ],
    asks: [
      { price: 100.6, volume: 500 },
      { price: 100.7, volume: 600 },
      { price: 100.8, volume: 550 },
      { price: 100.9, volume: 650 },
      { price: 101.0, volume: 700 },
      { price: 101.1, volume: 750 },
      { price: 101.2, volume: 800 },
      { price: 101.3, volume: 850 },
      { price: 101.4, volume: 900 },
      { price: 101.5, volume: 950 },
    ],
    timestamp: Date.now(),
  };

  const result = signal.calculate(orderBook);

  console.log('Order Book Imbalance Analysis:');
  console.log(`Signal: ${result.signal}`);
  console.log(`Imbalance Ratio: ${result.imbalanceRatio.toFixed(2)}`);
  console.log(`Bid Volume: ${result.bidVolume.toFixed(2)}`);
  console.log(`Ask Volume: ${result.askVolume.toFixed(2)}`);
  console.log(`Bid Pressure: ${result.bidPressure.toFixed(2)}%`);
  console.log(`Ask Pressure: ${result.askPressure.toFixed(2)}%`);
  console.log(`Confidence: ${result.confidence}%`);
  console.log(
    `Spread: ${result.spread.toFixed(4)} (${result.spreadPercent.toFixed(3)}%)`
  );
}
