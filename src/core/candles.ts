import type { EnhancedMarketData } from '../../lib/btc-market-data.js';
import { delay, normalize, type MarketType } from '../../lib/helpers.js';
// import type { EnhancedMarketData } from '../../lib/trading-utils.js';
import type { CandleData } from '../../lib/type.js';

export function log(
  msg: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info'
) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${icons[type]} ${msg}`);
}

// ✅ Memory management configuration
const MEMORY_CONFIG = {
  MAX_CANDLES_PER_SYMBOL: 500, // Hard limit per symbol
  MAX_HTF_CANDLES: 500, // Hard limit per HTF timeframe
  MAX_CACHE_ENTRIES: 100, // Max cached symbols
  CACHE_CLEANUP_INTERVAL: 5 * 60 * 1000, // Cleanup every 5 minutes
  MEMORY_CHECK_INTERVAL: 30 * 1000, // Check memory every 30s
  MAX_MEMORY_MB: 1024, // Alert if > 1GB
};

export class HTFCandleManager {
  private htfCandles: Map<string, Map<string, CandleData>> = new Map();
  private lastAccessTime: Map<string, number> = new Map();
  private memoryCheckTimer: NodeJS.Timeout | null = null;

  private htfTimeframes: string[] = [
    '1m',
    '3m',
    '5m',
    '15m',
    '30m',
    '1h',
    '2h',
    '4h',
    '6h',
    '8h',
    '12h',
    '1d',
    '3d',
    '1w',
    '1M',
  ];

  constructor() {
    // ✅ Start memory monitoring
    this.startMemoryMonitoring();

    // ✅ Periodic cleanup
    setInterval(
      () => this.cleanupStaleData(),
      MEMORY_CONFIG.CACHE_CLEANUP_INTERVAL
    );
  }

  /**
   * ✅ Monitor memory usage
   */
  private startMemoryMonitoring(): void {
    this.memoryCheckTimer = setInterval(() => {
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const rssUsedMB = Math.round(memUsage.rss / 1024 / 1024);

      if (heapUsedMB > MEMORY_CONFIG.MAX_MEMORY_MB) {
        log(
          `⚠️ HIGH MEMORY USAGE: Heap ${heapUsedMB}MB, RSS ${rssUsedMB}MB`,
          'warning'
        );
        log(
          `📊 HTF Data: ${this.htfCandles.size} symbols, ${this.getTotalCandleCount()} total candles`,
          'warning'
        );

        // ✅ Force cleanup if memory is too high
        this.cleanupStaleData(true);
      }
    }, MEMORY_CONFIG.MEMORY_CHECK_INTERVAL);
  }

  /**
   * ✅ Get total candle count across all symbols/timeframes
   */
  private getTotalCandleCount(): number {
    let total = 0;
    for (const [_, timeframeMap] of this.htfCandles) {
      for (const [_, candles] of timeframeMap) {
        total += candles.closes.length;
      }
    }
    return total;
  }

  /**
   * ✅ Cleanup stale or excessive data
   */
  private cleanupStaleData(aggressive: boolean = false): void {
    const now = Date.now();
    const staleThreshold = aggressive ? 5 * 60 * 1000 : 30 * 60 * 1000; // 5min or 30min

    let removedSymbols = 0;
    let trimmedCandles = 0;

    // ✅ Remove symbols not accessed recently
    for (const [symbol, _] of this.htfCandles) {
      const lastAccess = this.lastAccessTime.get(symbol) || 0;

      if (now - lastAccess > staleThreshold) {
        this.htfCandles.delete(symbol);
        this.lastAccessTime.delete(symbol);
        removedSymbols++;
      } else {
        // ✅ Trim candles even for active symbols
        const timeframeMap = this.htfCandles.get(symbol);
        if (timeframeMap) {
          for (const [tf, candles] of timeframeMap) {
            const excess =
              candles.closes.length - MEMORY_CONFIG.MAX_HTF_CANDLES;
            if (excess > 0) {
              // Remove oldest candles
              candles.timestamps.splice(0, excess);
              candles.highs.splice(0, excess);
              candles.lows.splice(0, excess);
              candles.closes.splice(0, excess);
              candles.volumes.splice(0, excess);
              trimmedCandles += excess;
            }
          }
        }
      }
    }

    if (removedSymbols > 0 || trimmedCandles > 0) {
      log(
        `🗑️ Cleanup: Removed ${removedSymbols} symbols, trimmed ${trimmedCandles} candles`,
        'info'
      );
    }
  }

  async initializeHTFCandles(symbol: string): Promise<boolean> {
    const normalizedSymbol = normalize(symbol);
    console.log(
      '🥑 ~ HTFCandleManager ~ initializeHTFCandles ~ normalizedSymbol:',
      normalizedSymbol
    );

    const timeframeData = new Map<string, CandleData>();
    let successCount = 0;
    let failCount = 0;

    for (const tf of this.htfTimeframes) {
      try {
        const url = new URL('https://fapi.binance.com/fapi/v1/klines');
        url.searchParams.append('symbol', normalizedSymbol);
        url.searchParams.append('interval', tf);
        url.searchParams.append('limit', '500');

        const response = await fetch(url.toString());

        if (!response.ok) {
          failCount++;

          if (response.status === 418 || response.status === 429) {
            log(`⏸️ Rate limited on ${tf}, waiting 10s...`, 'warning');
            await delay(10000);
          } else if (response.status === 400) {
            log(`❌ Invalid symbol ${normalizedSymbol}, aborting`, 'error');
            return false; // Don't continue with invalid symbols
          }

          // ✅ Stop after too many failures
          if (failCount > 5) {
            log(
              `❌ Too many failures for ${normalizedSymbol}, aborting`,
              'error'
            );
            break;
          }

          continue;
        }

        const klines = await response.json();

        if (!Array.isArray(klines) || klines.length === 0) {
          failCount++;
          continue;
        }

        const candleData: CandleData = {
          closes: [],
          highs: [],
          lows: [],
          opens: [],
          volumes: [],
          timestamps: [],
        };

        let validCandles = 0;
        for (const kline of klines) {
          if (!Array.isArray(kline) || kline.length < 8) continue;

          try {
            const timestamp = kline[0];
            const open = parseFloat(kline[1]);
            const high = parseFloat(kline[2]);
            const low = parseFloat(kline[3]);
            const close = parseFloat(kline[4]);
            const volume = parseFloat(kline[7]);

            if (
              isNaN(open) ||
              isNaN(high) ||
              isNaN(low) ||
              isNaN(close) ||
              isNaN(volume)
            )
              continue;
            if (high <= 0 || low <= 0 || close <= 0 || high < low) continue;

            // ✅ Enforce max candles during initialization
            if (validCandles >= MEMORY_CONFIG.MAX_HTF_CANDLES) break;

            candleData.timestamps.push(timestamp);
            candleData.opens.push(open);
            candleData.highs.push(high);
            candleData.lows.push(low);
            candleData.closes.push(close);
            candleData.volumes.push(volume);
            validCandles++;
          } catch (parseErr: any) {
            continue;
          }
        }

        if (validCandles >= 50) {
          timeframeData.set(tf, candleData);
          successCount++;
        }

        await delay(300);
      } catch (err: any) {
        log(
          `❌ HTF ${tf} error for ${normalizedSymbol}: ${err.message}`,
          'error'
        );
        failCount++;

        // ✅ Stop if errors are catastrophic
        if (failCount > 5) break;
      }
    }

    if (successCount > 0) {
      this.htfCandles.set(normalizedSymbol, timeframeData);
      this.lastAccessTime.set(normalizedSymbol, Date.now());
      log(
        `✅ HTF init for ${normalizedSymbol}: ${successCount}/${this.htfTimeframes.length} timeframes`,
        'success'
      );
    } else {
      log(`❌ HTF init failed for ${normalizedSymbol}`, 'error');
    }

    // ✅ Enforce max cache size
    if (this.htfCandles.size > MEMORY_CONFIG.MAX_CACHE_ENTRIES) {
      this.cleanupStaleData(true);
    }

    return successCount > 0;
  }

  updateHTFFromWebSocket(symbol: string, timeframe: string, kline: any) {
    const normalizedSymbol = normalize(symbol);
    const symbolData = this.htfCandles.get(normalizedSymbol);

    if (!symbolData) {
      // ✅ Don't spam logs for missing data
      return;
    }

    const candleData = symbolData.get(timeframe);
    if (!candleData) return;

    if (!kline || typeof kline !== 'object') return;

    try {
      const timestamp = kline.t || kline.T;
      const high = parseFloat(kline.h || kline.H || '0');
      const low = parseFloat(kline.l || kline.L || '0');
      const close = parseFloat(kline.c || kline.C || '0');
      const volume = parseFloat(kline.v || kline.V || '0');

      if (!timestamp || high === 0 || low === 0 || close === 0) return;
      if (isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) return;
      if (high < low) return;

      candleData.timestamps.push(timestamp);
      candleData.highs.push(high);
      candleData.lows.push(low);
      candleData.closes.push(close);
      candleData.volumes.push(volume);

      // ✅ Strict limit enforcement
      if (candleData.closes.length > MEMORY_CONFIG.MAX_HTF_CANDLES) {
        candleData.timestamps.shift();
        candleData.highs.shift();
        candleData.lows.shift();
        candleData.closes.shift();
        candleData.volumes.shift();
      }

      // ✅ Update access time
      this.lastAccessTime.set(normalizedSymbol, Date.now());
    } catch (err: any) {
      log(`❌ Error updating HTF ${normalizedSymbol}: ${err.message}`, 'error');
    }
  }

  getHTFCandles(symbol: string, timeframe: string): CandleData | null {
    const normalizedSymbol = normalize(symbol);
    const symbolData = this.htfCandles.get(normalizedSymbol);

    if (!symbolData) return null;

    const candleData = symbolData.get(timeframe);
    if (!candleData) return null;
    if (candleData.closes.length < 50) return null;

    // ✅ Update access time
    this.lastAccessTime.set(normalizedSymbol, Date.now());

    return candleData;
  }

  hasHTFData(symbol: string): boolean {
    const normalizedSymbol = normalize(symbol);
    return this.htfCandles.has(normalizedSymbol);
  }

  getAvailableTimeframes(symbol: string): string[] {
    const normalizedSymbol = normalize(symbol);
    const symbolData = this.htfCandles.get(normalizedSymbol);
    return symbolData ? Array.from(symbolData.keys()) : [];
  }

  /**
   * ✅ Get memory statistics
   */
  getMemoryStats(): {
    symbolCount: number;
    totalCandles: number;
    memoryMB: number;
    rssMB: number;
    oldestAccess: string | null;
  } {
    const memUsage = process.memoryUsage();
    const oldestSymbol = Array.from(this.lastAccessTime.entries()).sort(
      (a, b) => a[1] - b[1]
    )[0];

    return {
      symbolCount: this.htfCandles.size,
      totalCandles: this.getTotalCandleCount(),
      memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
      oldestAccess: oldestSymbol
        ? `${oldestSymbol[0]} (${Math.round((Date.now() - oldestSymbol[1]) / 60000)}m ago)`
        : null,
    };
  }

  /**
   * ✅ Manual cleanup
   */
  clearSymbol(symbol: string): void {
    const normalizedSymbol = normalize(symbol);
    this.htfCandles.delete(normalizedSymbol);
    this.lastAccessTime.delete(normalizedSymbol);
    log(`🗑️ Cleared HTF data for ${normalizedSymbol}`, 'info');
  }

  /**
   * ✅ Clear all data
   */
  clearAll(): void {
    this.htfCandles.clear();
    this.lastAccessTime.clear();
    log('🗑️ Cleared all HTF data', 'info');
  }

  /**
   * ✅ Cleanup on destruction
   */
  destroy(): void {
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }
    this.clearAll();
  }
}

export class CandleManager {
  private candles: Map<string, CandleData> = new Map();
  private lastAccessTime: Map<string, number> = new Map();
  // private isInitialized = false;
  private maxRetries = 3;
  private retryDelay = 2000;
  private memoryCheckTimer: NodeJS.Timeout | null = null;

  constructor(private timeframe: string = '15m') {
    // ✅ Start memory monitoring
    this.startMemoryMonitoring();

    // ✅ Periodic cleanup
    setInterval(
      () => this.cleanupStaleData(),
      MEMORY_CONFIG.CACHE_CLEANUP_INTERVAL
    );
  }

  private getKlinesEndpoint(marketType: MarketType): string {
    switch (marketType) {
      case 'FUTURES':
        return 'https://fapi.binance.com/fapi/v1/klines';
      case 'SPOT':
        return 'https://api.binance.com/api/v1/klines';
      default:
        throw new Error(`Unsupported marketType: ${marketType}`);
    }
  }

  /**
   * ✅ Monitor memory usage
   */
  private startMemoryMonitoring(): void {
    this.memoryCheckTimer = setInterval(() => {
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const rssUsedMB = Math.round(memUsage.rss / 1024 / 1024);

      if (heapUsedMB > MEMORY_CONFIG.MAX_MEMORY_MB) {
        log(
          `⚠️ HIGH MEMORY: Heap ${heapUsedMB}MB, RSS ${rssUsedMB}MB`,
          'warning'
        );
        log(
          `📊 Candle Data: ${this.candles.size} symbols, ${this.getTotalCandleCount()} candles`,
          'warning'
        );
        this.cleanupStaleData(true);
      }
    }, MEMORY_CONFIG.MEMORY_CHECK_INTERVAL);
  }

  /**
   * ✅ Get total candle count
   */
  private getTotalCandleCount(): number {
    let total = 0;
    for (const [_, candles] of this.candles) {
      total += candles.closes.length;
    }
    return total;
  }

  /**
   * ✅ Cleanup stale data
   */
  private cleanupStaleData(aggressive: boolean = false): void {
    const now = Date.now();
    const staleThreshold = aggressive ? 5 * 60 * 1000 : 30 * 60 * 1000;

    let removed = 0;
    let trimmed = 0;

    for (const [symbol, candles] of this.candles) {
      const lastAccess = this.lastAccessTime.get(symbol) || 0;

      if (now - lastAccess > staleThreshold) {
        this.candles.delete(symbol);
        this.lastAccessTime.delete(symbol);
        removed++;
      } else {
        // ✅ Trim excess candles
        const excess =
          candles.closes.length - MEMORY_CONFIG.MAX_CANDLES_PER_SYMBOL;
        if (excess > 0) {
          candles.timestamps.splice(0, excess);
          candles.highs.splice(0, excess);
          candles.lows.splice(0, excess);
          candles.closes.splice(0, excess);
          candles.volumes.splice(0, excess);
          trimmed += excess;
        }
      }
    }

    if (removed > 0 || trimmed > 0) {
      log(
        `🗑️ Cleanup: Removed ${removed} symbols, trimmed ${trimmed} candles`,
        'info'
      );
    }
  }

  async initializeWithFilters(
    symbol: string,
    filters: {
      minLiquidity?: number;
      minPrice?: number;
      maxPrice?: number;
      minVolatility?: number;
    },
    marketType: MarketType = 'FUTURES'
  ): Promise<boolean> {
    const normalized = normalize(symbol);

    // Fetch historical data first
    if (!(await this.initializeHistoricalCandles(symbol, 500, 0, marketType))) {
      return false;
    }

    const data = this.candles.get(normalized);
    if (!data) return false;

    // ✅ Volume filter
    if (filters.minLiquidity) {
      const avgVol = data.volumes.slice(-100).reduce((a, b) => a + b, 0) / 100;
      if (avgVol < filters.minLiquidity) {
        log(`⏭️ ${symbol}: Low volume ${avgVol.toFixed(0)}`, 'info');
        this.clearSymbol(symbol);
        return false;
      }
    }

    // ✅ Price filter
    const lastPrice = data.closes[data.closes.length - 1] as number;
    if (filters.minPrice && lastPrice < filters.minPrice) {
      log(`⏭️ ${symbol}: Price too low ${lastPrice}`, 'info');
      this.clearSymbol(symbol);
      return false;
    }

    if (filters.maxPrice && lastPrice > filters.maxPrice) {
      log(`⏭️ ${symbol}: Price too high ${lastPrice}`, 'info');
      this.clearSymbol(symbol);
      return false;
    }

    // ✅ Volatility filter (optional)
    if (filters.minVolatility) {
      const recent = data.closes.slice(-20);
      const avgClose = recent.reduce((a, b) => a + b, 0) / recent.length;
      const volatility =
        Math.sqrt(
          recent.reduce(
            (sum, close) => sum + Math.pow(close - avgClose, 2),
            0
          ) / recent.length
        ) / avgClose;

      if (volatility < filters.minVolatility) {
        log(
          `⏭️ ${symbol}: Low volatility ${(volatility * 100).toFixed(2)}%`,
          'info'
        );
        this.clearSymbol(symbol);
        return false;
      }
    }

    log(`✅ ${symbol} passed all filters`, 'success');
    return true;
  }

  // Add this method to CandleManager class
  async initializeWithLiquidityFilter(
    symbol: string,
    minLiquidity: number = 5_000_000, // $5M minimum
    marketType: MarketType
  ): Promise<boolean> {
    const normalizedSymbol = normalize(symbol);

    // First, initialize historical candles
    const initialized = await this.initializeHistoricalCandles(
      symbol,
      500,
      0,
      marketType
    );

    if (!initialized) {
      return false;
    }

    // Get the candle data we just fetched
    const candleData = this.candles.get(normalizedSymbol);
    if (!candleData || candleData.volumes.length === 0) {
      return false;
    }

    // ✅ Calculate average volume from historical data
    const recentCandles = Math.min(100, candleData.volumes.length); // Last 100 candles
    const recentVolumes = candleData.volumes.slice(-recentCandles);

    const avgVolume =
      recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentCandles;

    // ✅ Filter: Remove if liquidity too low
    if (avgVolume < minLiquidity) {
      log(
        `⏭️ Removing ${normalizedSymbol}: avg volume ${avgVolume.toFixed(0)} < ${minLiquidity}`,
        'info'
      );

      // Clean up - remove from memory
      this.clearSymbol(symbol);
      return false;
    }

    log(
      `✅ ${normalizedSymbol} passed liquidity: ${avgVolume.toFixed(0)} (${this.timeframe})`,
      'success'
    );

    return true;
  }

  /**
   * ✅ Fetch and update the latest candle for a symbol
   */
  async updateCandles(
    symbol: string,
    marketType: MarketType
  ): Promise<boolean> {
    const normalizedSymbol = normalize(symbol, marketType);
    const candleData = this.candles.get(normalizedSymbol);

    if (normalizedSymbol === 'NEXOUSDT') {
      return true;
    }

    if (!candleData) {
      console.log(
        '🥑 ~ CandleManager ~ updateCandles ~ marketType:',
        marketType
      );
      log(`⚠️ Cannot update ${normalizedSymbol}: not initialized`, 'warning');
      return false;
    }

    try {
      // Fetch only the latest candles (last 2 candles to ensure we get the most recent)
      // const url = new URL('https://fapi.binance.com/fapi/v1/klines');
      const url = new URL(this.getKlinesEndpoint(marketType));

      url.searchParams.append('symbol', normalizedSymbol);
      url.searchParams.append('interval', this.timeframe);
      url.searchParams.append('limit', '2'); // Just get the latest 2 candles

      const response = await fetch(url.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!response.ok) {
        if (response.status === 418 || response.status === 429) {
          log(`⏸️ Rate limited when updating ${normalizedSymbol}`, 'warning');
        }
        return false;
      }

      const klines = await response.json();

      if (!Array.isArray(klines) || klines.length === 0) {
        return false;
      }

      // Get the most recent complete candle
      const latestKline = klines[klines.length - 1];

      if (!Array.isArray(latestKline) || latestKline.length < 6) {
        return false;
      }

      const timestamp = latestKline[0];
      const high = parseFloat(latestKline[2]);
      const low = parseFloat(latestKline[3]);
      const close = parseFloat(latestKline[4]);
      const volume = parseFloat(latestKline[5]);

      // Validate data
      if (isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
        return false;
      }
      if (high <= 0 || low <= 0 || close <= 0 || volume < 0 || high < low) {
        return false;
      }

      // Check if this is a new candle (different timestamp from last)
      const lastTimestamp =
        candleData.timestamps[candleData.timestamps.length - 1];

      if (timestamp !== lastTimestamp) {
        // New candle - append it
        candleData.timestamps.push(timestamp);
        candleData.highs.push(high);
        candleData.lows.push(low);
        candleData.closes.push(close);
        candleData.volumes.push(volume);

        // ✅ Enforce max candles
        if (candleData.closes.length > MEMORY_CONFIG.MAX_CANDLES_PER_SYMBOL) {
          candleData.timestamps.shift();
          candleData.highs.shift();
          candleData.lows.shift();
          candleData.closes.shift();
          candleData.volumes.shift();
        }
      } else {
        // Same candle - update the last values (candle is still forming)
        const lastIndex = candleData.closes.length - 1;
        candleData.highs[lastIndex] = high;
        candleData.lows[lastIndex] = low;
        candleData.closes[lastIndex] = close;
        candleData.volumes[lastIndex] = volume;
      }

      // ✅ Update access time
      this.lastAccessTime.set(normalizedSymbol, Date.now());

      return true;
    } catch (err: any) {
      log(`❌ Error updating ${normalizedSymbol}: ${err.message}`, 'error');
      return false;
    }
  }

  async initializeHistoricalCandles(
    symbol: string,
    limit: number = 500,
    retryCount: number = 0,
    marketType: MarketType
  ): Promise<boolean> {
    const normalizedSymbol = normalize(symbol, marketType);

    if (
      marketType === 'FUTURES' &&
      (symbol === 'NEXOUSDT' || symbol === 'NEXO/USDT')
    ) {
      return false;
    }

    try {
      const url = new URL(this.getKlinesEndpoint(marketType));
      // const url = new URL('https://fapi.binance.com/fapi/v1/klines');
      url.searchParams.append('symbol', normalizedSymbol);
      url.searchParams.append('interval', this.timeframe);
      url.searchParams.append(
        'limit',
        Math.min(limit, MEMORY_CONFIG.MAX_CANDLES_PER_SYMBOL).toString()
      );

      const response = await fetch(url.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (response.status === 418 || response.status === 429) {
        const waitTime = retryCount === 0 ? 5000 : 10000 * retryCount;
        log(
          `⏸️ Rate limited (${response.status}), waiting ${waitTime / 1000}s...`,
          'warning'
        );

        if (retryCount < this.maxRetries) {
          await delay(waitTime);
          return this.initializeHistoricalCandles(
            symbol,
            limit,
            retryCount + 1,
            marketType
          );
        }
        return false;
      }

      if (response.status === 400) {
        log(`❌ Invalid symbol: ${normalizedSymbol}`, 'error');
        return false;
      }

      if (!response.ok) {
        if (response.status >= 500 && retryCount < this.maxRetries) {
          await delay(this.retryDelay);
          return this.initializeHistoricalCandles(
            symbol,
            limit,
            retryCount + 1,
            marketType
          );
        }
        return false;
      }

      const klines = await response.json();

      if (!Array.isArray(klines) || klines.length === 0) {
        log(`❌ No data for ${normalizedSymbol}`, 'error');
        return false;
      }

      const candleData: CandleData = {
        closes: [],
        highs: [],
        lows: [],
        opens: [],
        volumes: [],
        timestamps: [],
      };

      let validKlines = 0;
      for (const kline of klines) {
        if (!Array.isArray(kline) || kline.length < 6) continue;

        // ✅ Enforce max during init
        if (validKlines >= MEMORY_CONFIG.MAX_CANDLES_PER_SYMBOL) break;

        try {
          const timestamp = kline[0];
          const high = parseFloat(kline[2]);
          const low = parseFloat(kline[3]);
          const close = parseFloat(kline[4]);
          const volume = parseFloat(kline[5]);

          if (isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume))
            continue;
          if (high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
          if (high < low) continue;

          candleData.timestamps.push(timestamp);
          candleData.highs.push(high);
          candleData.lows.push(low);
          candleData.closes.push(close);
          candleData.volumes.push(volume);
          validKlines++;
        } catch (parseErr: any) {
          continue;
        }
      }

      if (validKlines < 50) {
        log(
          `❌ Insufficient valid candles for ${normalizedSymbol}: ${validKlines}/50`,
          'error'
        );
        return false;
      }

      this.candles.set(normalizedSymbol, candleData);
      this.lastAccessTime.set(normalizedSymbol, Date.now());
      // this.isInitialized = true;

      // ✅ Enforce cache limit
      if (this.candles.size > MEMORY_CONFIG.MAX_CACHE_ENTRIES) {
        this.cleanupStaleData(true);
      }

      return true;
    } catch (err: any) {
      if (
        retryCount < this.maxRetries &&
        (err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('fetch failed'))
      ) {
        await delay(this.retryDelay * (retryCount + 1));
        return this.initializeHistoricalCandles(
          symbol,
          limit,
          retryCount + 1,
          marketType
        );
      }

      return false;
    }
  }

  updateFromWebSocket(symbol: string, kline: any) {
    const normalizedSymbol = normalize(symbol);
    const candleData = this.candles.get(normalizedSymbol);

    if (!candleData) return;
    if (!kline || typeof kline !== 'object') return;

    try {
      const timestamp = kline.t || kline.T;
      const high = kline.h || kline.H;
      const low = kline.l || kline.L;
      const close = kline.c || kline.C;
      const volume = kline.v || kline.V;

      if (!timestamp || !high || !low || !close || !volume) return;

      const parsedHigh = parseFloat(high);
      const parsedLow = parseFloat(low);
      const parsedClose = parseFloat(close);
      const parsedVolume = parseFloat(volume);

      if (
        isNaN(parsedHigh) ||
        isNaN(parsedLow) ||
        isNaN(parsedClose) ||
        isNaN(parsedVolume)
      )
        return;
      if (
        parsedHigh <= 0 ||
        parsedLow <= 0 ||
        parsedClose <= 0 ||
        parsedVolume < 0
      )
        return;
      if (parsedHigh < parsedLow) return;

      candleData.timestamps.push(timestamp);
      candleData.highs.push(parsedHigh);
      candleData.lows.push(parsedLow);
      candleData.closes.push(parsedClose);
      candleData.volumes.push(parsedVolume);

      // ✅ Strict enforcement
      if (candleData.closes.length > MEMORY_CONFIG.MAX_CANDLES_PER_SYMBOL) {
        candleData.timestamps.shift();
        candleData.highs.shift();
        candleData.lows.shift();
        candleData.closes.shift();
        candleData.volumes.shift();
      }

      // ✅ Update access time
      this.lastAccessTime.set(normalizedSymbol, Date.now());
    } catch (err: any) {
      log(`❌ Error updating ${normalizedSymbol}: ${err.message}`, 'error');
    }
  }

  // Add to your candleManager or scanner
  async getBTCMarketData(): Promise<EnhancedMarketData> {
    try {
      // Get funding rate
      const fundingResponse = await fetch(
        'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'
      );
      const fundingData = await fundingResponse.json();

      // Get open interest
      const oiResponse = await fetch(
        'https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'
      );
      const oiData = await oiResponse.json();

      // Get long/short ratio (optional)
      const ratioResponse = await fetch(
        'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m'
      );
      const ratioData = await ratioResponse.json();

      return {
        fundingRate: parseFloat(fundingData.lastFundingRate),
        openInterest: parseFloat(oiData.openInterest),
        longShortRatio: parseFloat(ratioData[0]?.longShortRatio || 1),
      };
    } catch (error) {
      console.log('⚠️ Failed to get market data, using defaults');
      return {
        fundingRate: 0,
        openInterest: 0,
        longShortRatio: 1,
      };
    }
  }

  getCandles(symbol: string, marketType?: MarketType): CandleData | null {
    // console.log('🔍 Input symbol:', symbol);
    // console.log('🔍 Market type:', marketType);

    const normalizedSymbol = normalize(symbol, marketType);
    // console.log('🔍 Normalized to:', normalizedSymbol);
    // console.log(
    //   '🔍 Available symbols:',
    //   Array.from(this.candles.keys()).slice(0, 3)
    // );

    const data = this.candles.get(normalizedSymbol);
    // console.log('🔍 Data found:', !!data);
    // console.log('🔍 Candle count:', data?.closes.length || 0);

    if (!data || data.closes.length === 0) return null;
    if (data.closes.length < 210) return null;

    // ✅ Update access time
    this.lastAccessTime.set(normalizedSymbol, Date.now());

    return data;
  }

  getCandleCount(symbol: string, marketType?: MarketType): number {
    const normalizedSymbol = normalize(symbol, marketType);
    return this.candles.get(normalizedSymbol)?.closes.length || 0;
  }

  isReady(symbol: string): boolean {
    const normalizedSymbol = normalize(symbol);
    const data = this.candles.get(normalizedSymbol);
    return !!data && data.closes.length >= 210;
  }

  getInitializedSymbols(): string[] {
    return Array.from(this.candles.keys());
  }

  hasSymbol(symbol: string): boolean {
    const normalizedSymbol = normalize(symbol);
    return this.candles.has(normalizedSymbol);
  }

  clearSymbol(symbol: string): void {
    const normalizedSymbol = normalize(symbol);
    this.candles.delete(normalizedSymbol);
    this.lastAccessTime.delete(normalizedSymbol);
  }

  /**
   * ✅ Get memory statistics
   */
  getMemoryStats(): {
    symbolCount: number;
    totalCandles: number;
    memoryMB: number;
    rssMB: number;
    oldestAccess: string | null;
  } {
    const memUsage = process.memoryUsage();
    const oldestSymbol = Array.from(this.lastAccessTime.entries()).sort(
      (a, b) => a[1] - b[1]
    )[0];

    return {
      symbolCount: this.candles.size,
      totalCandles: this.getTotalCandleCount(),
      memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
      oldestAccess: oldestSymbol
        ? `${oldestSymbol[0]} (${Math.round((Date.now() - oldestSymbol[1]) / 60000)}m ago)`
        : null,
    };
  }

  /**
   * ✅ Cleanup on destruction
   */
  destroy(): void {
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }
    this.candles.clear();
    this.lastAccessTime.clear();
  }
}
