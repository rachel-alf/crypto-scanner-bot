// scanners/advanced-scanner/scanner.ts

import * as fs from 'fs/promises';

import { Exchange, type Market, type OHLCV } from 'ccxt';
import { ATR } from 'technicalindicators';

import { calculateHurstExponent } from '../core/advance/hurst.js';
import { calculateMicrostructure } from '../core/advance/microstructure.js';
import { calculateOrderFlow } from '../core/advance/order-flow.js';
import { calculateVPIN } from '../core/advance/vpin.js';

interface CandleData {
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
  timestamps: number[];
}

interface AdvancedSignal {
  type: 'SCALP';
  symbol: string;
  side: 'LONG' | 'SHORT';
  confidence: number;
  metrics: {
    orderFlowImbalance: number;
    cumulativeDelta: number;
    spreadPercent: number;
    hurstExponent: number;
    vpinToxicity: number;
    volume24h: number;
  };
  entry: number;
  stopLoss: number;
  takeProfit: number;
  timeframe: '1m' | '5m' | '15m';
  timestamp: number;
  strategy: 'ORDER_FLOW' | 'MEAN_REVERSION' | 'MOMENTUM';
  reason: string;
}

interface ScannerConfig {
  timeframe: '1m' | '5m' | '15m';
  minVolume: number;
  maxSpread: number;
  scanInterval: number;
  maxSignals: number;
  minHurst: number;
  maxHurst: number;
  minOrderFlowImbalance: number;
  maxVPIN: number;
}

export class AdvancedScanner {
  private exchange: Exchange;
  private config: ScannerConfig;
  private scanTimer: NodeJS.Timeout | undefined;
  private lastScanTime = 0;

  constructor(exchange: Exchange, config?: Partial<ScannerConfig>) {
    this.exchange = exchange;
    this.config = {
      timeframe: '5m',
      minVolume: 10_000_000, // $10M daily volume minimum
      maxSpread: 0.05, // 0.05% max spread
      scanInterval: 30_000, // 30 seconds
      maxSignals: 10, // Max signals per scan
      minHurst: 0.55, // Trending market threshold
      maxHurst: 0.75, // Too trending = risky
      minOrderFlowImbalance: 1.8, // Minimum buy/sell imbalance
      maxVPIN: 0.5, // Max toxicity
      ...config,
    };
  }

  /**
   * Main scan function - finds scalp opportunities
   */
  async scan(): Promise<AdvancedSignal[]> {
    const startTime = Date.now();
    console.log('\n' + '='.repeat(80));
    console.log('🔬 ADVANCED SCANNER - Scanning for scalp opportunities');
    console.log('='.repeat(80));

    try {
      // 1. Get high volume symbols
      const symbols = await this.getHighVolumeSymbols();
      console.log(`\n📊 Scanning ${symbols.length} high-volume symbols...`);

      const signals: AdvancedSignal[] = [];
      let checked = 0;
      let filtered = 0;

      // 2. Scan each symbol
      for (const symbol of symbols) {
        checked++;

        try {
          const signal = await this.analyzeSymbol(symbol);

          if (signal) {
            signals.push(signal);
            console.log(
              `   ✅ ${symbol}: ${signal.side} (${signal.strategy}) - Confidence: ${(signal.confidence * 100).toFixed(0)}%`
            );

            // Stop if we have enough signals
            if (signals.length >= this.config.maxSignals) {
              console.log(
                `\n⚠️  Max signals reached (${this.config.maxSignals}), stopping scan`
              );
              break;
            }
          } else {
            filtered++;
          }
        } catch (error: any) {
          console.log(`   ❌ ${symbol}: ${error.message}`);
        }
      }

      // 3. Sort by confidence
      signals.sort((a, b) => b.confidence - a.confidence);

      // 4. Save to JSON
      await this.saveSignals(signals);

      // 5. Summary
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log('\n' + '='.repeat(80));
      console.log(`✅ SCAN COMPLETE`);
      console.log(`   Checked: ${checked} symbols`);
      console.log(`   Filtered: ${filtered} symbols`);
      console.log(`   Signals: ${signals.length} opportunities found`);
      console.log(`   Time: ${elapsed}s`);
      console.log('='.repeat(80) + '\n');

      this.lastScanTime = Date.now();
      return signals;
    } catch (error: any) {
      console.error(`❌ SCAN FAILED: ${error.message}`);
      console.error(error.stack);
      return [];
    }
  }

  /**
   * Analyze a single symbol
   */
  private async analyzeSymbol(symbol: string): Promise<AdvancedSignal | null> {
    // 1. Get ticker for volume check
    const ticker = await this.exchange.fetchTicker(symbol);

    if (!ticker.quoteVolume || ticker.quoteVolume < this.config.minVolume) {
      return null;
    }

    // 2. Get order book and trades
    const [orderBook, trades] = await Promise.all([
      this.exchange.fetchOrderBook(symbol, 50),
      this.exchange.fetchTrades(symbol, undefined, 1000),
    ]);

    // 3. Check spread (FAST FILTER)
    const spread = this.calculateSpread(orderBook);
    if (spread > this.config.maxSpread) {
      return null;
    }

    // 4. Calculate order flow
    const ofi = calculateOrderFlow(orderBook, trades);

    // Check if there's significant imbalance
    if (ofi.bidAskImbalance > 0.8 && ofi.bidAskImbalance < 1.2) {
      return null; // Balanced = no edge
    }

    // 5. Get candles for Hurst calculation
    const candles = await this.fetchCandles(symbol, this.config.timeframe, 500);

    if (!candles || candles.closes.length < 200) {
      return null;
    }

    // 6. Calculate Hurst exponent
    const hurst = calculateHurstExponent(candles.closes);

    // Check if market is trending (not random walk)
    if (hurst < this.config.minHurst || hurst > this.config.maxHurst) {
      return null;
    }

    // 7. Calculate VPIN (toxicity)
    const vpin = calculateVPIN(trades);

    if (vpin.vpin > this.config.maxVPIN) {
      return null; // Too toxic
    }

    // 8. Calculate microstructure metrics
    const micro = calculateMicrostructure(trades, orderBook);

    // 9. Generate signal based on all metrics
    return this.generateSignal({
      symbol,
      ticker,
      orderBook,
      trades,
      ofi,
      hurst,
      vpin,
      micro,
      spread,
      candles,
    });
  }

  /**
   * Generate trading signal from analysis
   */
  private generateSignal(data: any): AdvancedSignal | null {
    const {
      symbol,
      ticker,
      orderBook,
      ofi,
      hurst,
      vpin,
      micro,
      spread,
      candles,
    } = data;

    const currentPrice = orderBook.asks[0][0];

    // Calculate ATR for stop loss
    const atr = this.calculateATR(candles);

    // LONG SIGNAL: Strong buying pressure + trending market
    if (
      ofi.bidAskImbalance >= this.config.minOrderFlowImbalance &&
      ofi.cumulativeDelta > 0 &&
      hurst >= this.config.minHurst
    ) {
      const confidence = this.calculateConfidence({
        orderFlowImbalance: ofi.bidAskImbalance,
        hurst,
        vpin: vpin.vpin,
        spread,
        volume: ticker.quoteVolume,
      });

      return {
        type: 'SCALP',
        symbol,
        side: 'LONG',
        confidence,
        metrics: {
          orderFlowImbalance: ofi.bidAskImbalance,
          cumulativeDelta: ofi.cumulativeDelta,
          spreadPercent: spread * 100,
          hurstExponent: hurst,
          vpinToxicity: vpin.vpin,
          volume24h: ticker.quoteVolume,
        },
        entry: currentPrice,
        stopLoss: currentPrice - atr * 1.5,
        takeProfit: currentPrice + atr * 2,
        timeframe: this.config.timeframe,
        timestamp: Date.now(),
        strategy: 'ORDER_FLOW',
        reason: `Strong buy pressure (OFI: ${ofi.bidAskImbalance.toFixed(2)}) + Trending (H: ${hurst.toFixed(2)})`,
      };
    }

    // SHORT SIGNAL: Strong selling pressure + trending market
    if (
      ofi.bidAskImbalance <= 1 / this.config.minOrderFlowImbalance &&
      ofi.cumulativeDelta < 0 &&
      hurst >= this.config.minHurst
    ) {
      const confidence = this.calculateConfidence({
        orderFlowImbalance: 1 / ofi.bidAskImbalance, // Invert for short
        hurst,
        vpin: vpin.vpin,
        spread,
        volume: ticker.quoteVolume,
      });

      return {
        type: 'SCALP',
        symbol,
        side: 'SHORT',
        confidence,
        metrics: {
          orderFlowImbalance: ofi.bidAskImbalance,
          cumulativeDelta: ofi.cumulativeDelta,
          spreadPercent: spread * 100,
          hurstExponent: hurst,
          vpinToxicity: vpin.vpin,
          volume24h: ticker.quoteVolume,
        },
        entry: currentPrice,
        stopLoss: currentPrice + atr * 1.5,
        takeProfit: currentPrice - atr * 2,
        timeframe: this.config.timeframe,
        timestamp: Date.now(),
        strategy: 'ORDER_FLOW',
        reason: `Strong sell pressure (OFI: ${ofi.bidAskImbalance.toFixed(2)}) + Trending (H: ${hurst.toFixed(2)})`,
      };
    }

    return null;
  }

  /**
   * Calculate confidence score (0-1)
   */
  private calculateConfidence(metrics: any): number {
    let score = 0;

    // Order flow strength (0-40 points)
    const ofiScore = Math.min(((metrics.orderFlowImbalance - 1) / 2) * 40, 40);
    score += ofiScore;

    // Hurst strength (0-30 points)
    const hurstScore = Math.min(((metrics.hurst - 0.55) / 0.2) * 30, 30);
    score += hurstScore;

    // Low VPIN (0-15 points)
    const vpinScore = Math.max(15 - (metrics.vpin / 0.05) * 15, 0);
    score += vpinScore;

    // Low spread (0-10 points)
    const spreadScore = Math.max(10 - (metrics.spread / 0.01) * 10, 0);
    score += spreadScore;

    // High volume (0-5 points)
    const volumeScore = Math.min((metrics.volume / 50_000_000) * 5, 5);
    score += volumeScore;

    // Convert to 0-1 scale
    return Math.min(score / 100, 0.99);
  }

  /**
   * Get high volume futures symbols
   */
  private async getHighVolumeSymbols(): Promise<string[]> {
    try {
      const markets = await this.exchange.fetchMarkets();
      const tickers = await this.exchange.fetchTickers();

      // Filter for USDT futures with high volume
      const symbols = markets
        .filter(
          (m: Market) => m?.type === 'swap' && m.quote === 'USDT' && m.active
        )
        .map((m: Market) => m?.symbol)
        .filter((symbol: string | undefined) => {
          if (!symbol) return false;
          const ticker = tickers[symbol];
          return (
            ticker &&
            ticker.quoteVolume &&
            ticker.quoteVolume >= this.config.minVolume
          );
        })
        .sort((a: string | undefined, b: string | undefined) => {
          if (!a || !b) return 0;
          const volA = tickers[a]?.quoteVolume || 0;
          const volB = tickers[b]?.quoteVolume || 0;
          return volB - volA;
        })
        .slice(0, 50); // Top 50 by volume

      return symbols as string[];
    } catch (error: any) {
      console.error('Failed to get symbols:', error.message);
      // Fallback to common pairs
      return [
        'BTC/USDT:USDT',
        'ETH/USDT:USDT',
        'SOL/USDT:USDT',
        'BNB/USDT:USDT',
        'XRP/USDT:USDT',
      ];
    }
  }

  /**
   * Fetch candles for a symbol
   */
  private async fetchCandles(
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<CandleData | null> {
    try {
      const ohlcv = (await this.exchange.fetchOHLCV(
        symbol,
        timeframe,
        undefined,
        limit
      )) as OHLCV[];

      return {
        opens: ohlcv.map((c) => c[1]),
        highs: ohlcv.map((c) => c[2]),
        lows: ohlcv.map((c) => c[3]),
        closes: ohlcv.map((c) => c[4]),
        volumes: ohlcv.map((c) => c[5]),
        timestamps: ohlcv.map((c) => c[0]),
      } as CandleData;
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate bid-ask spread
   */
  private calculateSpread(orderBook: any): number {
    const bestBid = orderBook.bids[0]?.[0] || 0;
    const bestAsk = orderBook.asks[0]?.[0] || 0;

    if (!bestBid || !bestAsk) return 1; // Invalid = filter out

    return (bestAsk - bestBid) / bestAsk;
  }

  /**
   * Calculate ATR for stop loss
   */
  private calculateATR(candles: CandleData): number {
    try {
      const atrArray = ATR.calculate({
        high: candles.highs,
        low: candles.lows,
        close: candles.closes,
        period: 14,
      });

      return atrArray[atrArray.length - 1] || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Save signals to JSON file
   */
  private async saveSignals(signals: AdvancedSignal[]): Promise<void> {
    const output = {
      scanner: 'ADVANCED',
      scanTime: new Date().toISOString(),
      timestamp: Date.now(),
      count: signals.length,
      config: this.config,
      signals,
    };

    try {
      await fs.writeFile(
        './data/advanced-signals.json',
        JSON.stringify(output, null, 2),
        'utf-8'
      );

      console.log(`\n💾 Signals saved to: ./data/advanced-signals.json`);
    } catch (error: any) {
      console.error(`Failed to save signals: ${error.message}`);
    }
  }

  /**
   * Start continuous scanning
   */
  start(): void {
    console.log('\n🚀 Advanced Scanner Starting...');
    console.log(`   Timeframe: ${this.config.timeframe}`);
    console.log(`   Interval: ${this.config.scanInterval / 1000}s`);
    console.log(
      `   Min Volume: $${(this.config.minVolume / 1_000_000).toFixed(1)}M`
    );
    console.log(`   Max Spread: ${(this.config.maxSpread * 100).toFixed(2)}%`);

    // Initial scan
    this.scan();

    // Schedule recurring scans
    this.scanTimer = setInterval(() => {
      this.scan();
    }, this.config.scanInterval);
  }

  /**
   * Stop scanning
   */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
      console.log('\n🛑 Advanced Scanner Stopped');
    }
  }

  /**
   * Get last scan time
   */
  getLastScanTime(): number {
    return this.lastScanTime;
  }
}
