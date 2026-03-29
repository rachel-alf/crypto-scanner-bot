import { delay, normalize, type MarketType } from '../../lib/helpers.js';
import type { CandleData } from '../../lib/type.js';

// ✅ Aggressive memory management
const MEMORY_CONFIG = {
  MAX_CANDLES_PER_SYMBOL: 150, // Reduced from 300
  MAX_HTF_CANDLES: 150, // Reduced from 300
  MAX_CACHE_ENTRIES: 30, // Reduced from 100
  CACHE_CLEANUP_INTERVAL: 2 * 60 * 1000, // Every 2 minutes (was 5)
  MEMORY_CHECK_INTERVAL: 20 * 1000, // Every 20s (was 30)
  MAX_MEMORY_MB: 800, // Lower threshold (was 1024)
  STALE_THRESHOLD_MS: 10 * 60 * 1000, // 10 minutes (was 30)
  AGGRESSIVE_THRESHOLD_MS: 3 * 60 * 1000, // 3 minutes when aggressive
};

function log(
  msg: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info'
) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [CANDLE-MGR] ${icons[type]} ${msg}`);
}

export class HTFCandleManager {
  private htfCandles: Map<string, Map<string, CandleData>> = new Map();
  private lastAccessTime: Map<string, number> = new Map();
  private memoryCheckTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private isDestroyed: boolean = false;

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
    this.startMemoryMonitoring();
    this.startPeriodicCleanup();
  }

  /**
   * ✅ Start periodic cleanup with proper timer tracking
   */
  private startPeriodicCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      if (this.isDestroyed) return;
      this.cleanupStaleData();
    }, MEMORY_CONFIG.CACHE_CLEANUP_INTERVAL);
  }

  /**
   * ✅ Monitor memory usage with proper tracking
   */
  private startMemoryMonitoring(): void {
    this.memoryCheckTimer = setInterval(() => {
      if (this.isDestroyed) return;

      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const rssUsedMB = Math.round(memUsage.rss / 1024 / 1024);

      if (heapUsedMB > MEMORY_CONFIG.MAX_MEMORY_MB) {
        log(
          `⚠️ HIGH MEMORY: Heap ${heapUsedMB}MB, RSS ${rssUsedMB}MB`,
          'warning'
        );
        log(
          `📊 HTF Data: ${this.htfCandles.size} symbols, ${this.getTotalCandleCount()} candles`,
          'warning'
        );

        // Force aggressive cleanup
        this.cleanupStaleData(true);

        // If still too high, clear oldest symbols
        if (heapUsedMB > MEMORY_CONFIG.MAX_MEMORY_MB * 1.2) {
          this.emergencyCleanup();
        }
      }
    }, MEMORY_CONFIG.MEMORY_CHECK_INTERVAL);
  }

  /**
   * 🚨 Emergency cleanup when memory is critical
   */
  private emergencyCleanup(): void {
    const entries = this.lastAccessTime?.entries() ?? [];
    const sorted = Array.from(entries).sort((a, b) => a[1] - b[1]);

    const toRemove = Math.ceil(sorted.length * 0.3);

    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const entry = sorted[i];
      if (!entry) continue;
      const symbol = entry[0];
      this.htfCandles?.delete(symbol);
      this.lastAccessTime?.delete(symbol);
    }

    log(`🚨 Emergency cleanup: Removed ${toRemove} oldest symbols`, 'warning');
  }

  /**
   * ✅ Get total candle count
   */
  private getTotalCandleCount(): number {
    let total = 0;
    for (const timeframeMap of this.htfCandles.values()) {
      for (const candles of timeframeMap.values()) {
        total += candles.closes.length;
      }
    }
    return total;
  }

  /**
   * ✅ Cleanup with proper thresholds
   */
  private cleanupStaleData(aggressive: boolean = false): void {
    if (this.isDestroyed) return;

    const now = Date.now();
    const staleThreshold = aggressive
      ? MEMORY_CONFIG.AGGRESSIVE_THRESHOLD_MS
      : MEMORY_CONFIG.STALE_THRESHOLD_MS;

    let removedSymbols = 0;
    let trimmedCandles = 0;

    for (const [symbol, timeframeMap] of this.htfCandles) {
      const lastAccess = this.lastAccessTime.get(symbol) || 0;

      if (now - lastAccess > staleThreshold) {
        this.htfCandles.delete(symbol);
        this.lastAccessTime.delete(symbol);
        removedSymbols++;
      } else {
        // Trim all timeframes for active symbols
        for (const [tf, candles] of timeframeMap) {
          const excess = candles.closes.length - MEMORY_CONFIG.MAX_HTF_CANDLES;
          if (excess > 0) {
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

    if (removedSymbols > 0 || trimmedCandles > 0) {
      log(
        `🗑️ HTF Cleanup: -${removedSymbols} symbols, -${trimmedCandles} candles`,
        'info'
      );
    }
  }

  async initializeHTFCandles(symbol: string): Promise<boolean> {
    if (this.isDestroyed) return false;

    const normalizedSymbol = normalize(symbol);

    // Enforce cache limit BEFORE adding
    if (this.htfCandles.size >= MEMORY_CONFIG.MAX_CACHE_ENTRIES) {
      this.cleanupStaleData(true);

      // If still at limit, remove oldest
      if (this.htfCandles.size >= MEMORY_CONFIG.MAX_CACHE_ENTRIES) {
        const oldest = Array.from(this.lastAccessTime.entries()).sort(
          (a, b) => a[1] - b[1]
        )[0];

        if (oldest) {
          this.htfCandles.delete(oldest[0]);
          this.lastAccessTime.delete(oldest[0]);
        }
      }
    }

    const timeframeData = new Map<string, CandleData>();
    let successCount = 0;
    let failCount = 0;

    for (const tf of this.htfTimeframes) {
      if (this.isDestroyed) break;

      try {
        const url = new URL('https://fapi.binance.com/fapi/v1/klines');
        url.searchParams.append('symbol', normalizedSymbol);
        url.searchParams.append('interval', tf);
        url.searchParams.append(
          'limit',
          MEMORY_CONFIG.MAX_HTF_CANDLES.toString()
        );

        const response = await fetch(url.toString());

        if (!response.ok) {
          failCount++;

          if (response.status === 418 || response.status === 429) {
            log(`⏸️ Rate limited on ${tf}, waiting 10s...`, 'warning');
            await delay(10000);
          } else if (response.status === 400) {
            log(`❌ Invalid symbol ${normalizedSymbol}`, 'error');
            return false;
          }

          if (failCount > 3) break; // Stop earlier
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
          if (validCandles >= MEMORY_CONFIG.MAX_HTF_CANDLES) break;

          try {
            const timestamp = kline[0];
            const high = parseFloat(kline[2]);
            const low = parseFloat(kline[3]);
            const close = parseFloat(kline[4]);
            const volume = parseFloat(kline[7]);

            if (isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume))
              continue;
            if (high <= 0 || low <= 0 || close <= 0 || high < low) continue;

            candleData.timestamps.push(timestamp);
            candleData.highs.push(high);
            candleData.lows.push(low);
            candleData.closes.push(close);
            candleData.volumes.push(volume);
            validCandles++;
          } catch {
            continue;
          }
        }

        if (validCandles >= 50) {
          timeframeData.set(tf, candleData);
          successCount++;
        }

        await delay(300);
      } catch (err: any) {
        log(`❌ HTF ${tf} error: ${err.message}`, 'error');
        failCount++;
        if (failCount > 3) break;
      }
    }

    if (successCount > 0) {
      this.htfCandles.set(normalizedSymbol, timeframeData);
      this.lastAccessTime.set(normalizedSymbol, Date.now());
      log(
        `✅ HTF init ${normalizedSymbol}: ${successCount}/${this.htfTimeframes.length} TFs`,
        'success'
      );
    }

    return successCount > 0;
  }

  updateHTFFromWebSocket(symbol: string, timeframe: string, kline: any) {
    if (this.isDestroyed) return;

    const normalizedSymbol = normalize(symbol);
    const symbolData = this.htfCandles.get(normalizedSymbol);

    if (!symbolData) return;

    const candleData = symbolData.get(timeframe);
    if (!candleData || !kline || typeof kline !== 'object') return;

    try {
      const timestamp = kline.t || kline.T;
      const high = parseFloat(kline.h || kline.H || '0');
      const low = parseFloat(kline.l || kline.L || '0');
      const close = parseFloat(kline.c || kline.C || '0');
      const volume = parseFloat(kline.v || kline.V || '0');

      if (!timestamp || high === 0 || low === 0 || close === 0) return;
      if (isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) return;
      if (high < low) return;

      // ✅ Check for duplicate timestamp
      const lastTimestamp =
        candleData.timestamps[candleData.timestamps.length - 1];
      if (lastTimestamp === timestamp) {
        // Update existing candle instead of adding
        const idx = candleData.timestamps.length - 1;
        candleData.highs[idx] = high;
        candleData.lows[idx] = low;
        candleData.closes[idx] = close;
        candleData.volumes[idx] = volume;
        return;
      }

      candleData.timestamps.push(timestamp);
      candleData.highs.push(high);
      candleData.lows.push(low);
      candleData.closes.push(close);
      candleData.volumes.push(volume);

      // Strict limit
      while (candleData.closes.length > MEMORY_CONFIG.MAX_HTF_CANDLES) {
        candleData.timestamps.shift();
        candleData.highs.shift();
        candleData.lows.shift();
        candleData.closes.shift();
        candleData.volumes.shift();
      }

      this.lastAccessTime.set(normalizedSymbol, Date.now());
    } catch (err: any) {
      log(`❌ HTF update error: ${err.message}`, 'error');
    }
  }

  getHTFCandles(symbol: string, timeframe: string): CandleData | null {
    if (this.isDestroyed) return null;

    const normalizedSymbol = normalize(symbol);
    const symbolData = this.htfCandles.get(normalizedSymbol);

    if (!symbolData) return null;

    const candleData = symbolData.get(timeframe);
    if (!candleData || candleData.closes.length < 50) return null;

    this.lastAccessTime.set(normalizedSymbol, Date.now());
    return candleData;
  }

  hasHTFData(symbol: string): boolean {
    return this.htfCandles.has(normalize(symbol));
  }

  getAvailableTimeframes(symbol: string): string[] {
    const symbolData = this.htfCandles.get(normalize(symbol));
    return symbolData ? Array.from(symbolData.keys()) : [];
  }

  getMemoryStats() {
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

  clearSymbol(symbol: string): void {
    const normalizedSymbol = normalize(symbol);
    this.htfCandles.delete(normalizedSymbol);
    this.lastAccessTime.delete(normalizedSymbol);
  }

  clearAll(): void {
    this.htfCandles.clear();
    this.lastAccessTime.clear();
  }

  /**
   * ✅ Proper cleanup
   */
  destroy(): void {
    this.isDestroyed = true;

    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.clearAll();
    log('🗑️ HTFCandleManager destroyed', 'info');
  }
}

export class CandleManager {
  private candles: Map<string, CandleData> = new Map();
  private lastAccessTime: Map<string, number> = new Map();
  private isInitialized = false;
  private timeframe: string;
  private maxRetries = 3;
  private retryDelay = 2000;
  private memoryCheckTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private isDestroyed: boolean = false;

  constructor(
    private symbols: string[],
    timeframe: string = '5m'
  ) {
    this.timeframe = timeframe;
    this.startMemoryMonitoring();
    this.startPeriodicCleanup();
  }

  /**
   * ✅ Start periodic cleanup
   */
  private startPeriodicCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      if (this.isDestroyed) return;
      this.cleanupStaleData();
    }, MEMORY_CONFIG.CACHE_CLEANUP_INTERVAL);
  }

  /**
   * ✅ Monitor memory
   */
  private startMemoryMonitoring(): void {
    this.memoryCheckTimer = setInterval(() => {
      if (this.isDestroyed) return;

      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);

      if (heapUsedMB > MEMORY_CONFIG.MAX_MEMORY_MB) {
        log(`⚠️ HIGH MEMORY: ${heapUsedMB}MB`, 'warning');
        this.cleanupStaleData(true);

        if (heapUsedMB > MEMORY_CONFIG.MAX_MEMORY_MB * 1.2) {
          this.emergencyCleanup();
        }
      }
    }, MEMORY_CONFIG.MEMORY_CHECK_INTERVAL);
  }

  /**
   * 🚨 Emergency cleanup
   */
  private emergencyCleanup(): void {
    const sorted = Array.from(this.lastAccessTime.entries()).sort(
      (a, b) => a[1] - b[1]
    );

    const toRemove = Math.ceil(sorted.length * 0.3);

    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const entry = sorted[i];
      if (!entry) continue;
      const symbol = entry[0];
      this.candles.delete(symbol);
      this.lastAccessTime.delete(symbol);
    }

    log(`🚨 Emergency: Removed ${toRemove} symbols`, 'warning');
  }

  private getTotalCandleCount(): number {
    let total = 0;
    for (const candles of this.candles.values()) {
      total += candles.closes.length;
    }
    return total;
  }

  /**
   * ✅ Aggressive cleanup
   */
  private cleanupStaleData(aggressive: boolean = false): void {
    if (this.isDestroyed) return;

    const now = Date.now();
    const staleThreshold = aggressive
      ? MEMORY_CONFIG.AGGRESSIVE_THRESHOLD_MS
      : MEMORY_CONFIG.STALE_THRESHOLD_MS;

    let removed = 0;
    let trimmed = 0;

    for (const [symbol, candles] of this.candles) {
      const lastAccess = this.lastAccessTime.get(symbol) || 0;

      if (now - lastAccess > staleThreshold) {
        this.candles.delete(symbol);
        this.lastAccessTime.delete(symbol);
        removed++;
      } else {
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
      log(`🗑️ Cleanup: -${removed} symbols, -${trimmed} candles`, 'info');
    }
  }

  async initializeHistoricalCandles(
    symbol: string,
    limit: number = 500,
    retryCount: number = 0
  ): Promise<boolean> {
    if (this.isDestroyed) return false;

    const normalizedSymbol = normalize(symbol);

    // Enforce limit BEFORE adding
    if (this.candles.size >= MEMORY_CONFIG.MAX_CACHE_ENTRIES) {
      this.cleanupStaleData(true);

      if (this.candles.size >= MEMORY_CONFIG.MAX_CACHE_ENTRIES) {
        const oldest = Array.from(this.lastAccessTime.entries()).sort(
          (a, b) => a[1] - b[1]
        )[0];
        if (oldest) {
          this.candles.delete(oldest[0]);
          this.lastAccessTime.delete(oldest[0]);
        }
      }
    }

    try {
      const url = new URL('https://fapi.binance.com/fapi/v1/klines');
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
        log(`⏸️ Rate limited, waiting ${waitTime / 1000}s...`, 'warning');

        if (retryCount < this.maxRetries) {
          await delay(waitTime);
          return this.initializeHistoricalCandles(
            symbol,
            limit,
            retryCount + 1
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
            retryCount + 1
          );
        }
        return false;
      }

      const klines = await response.json();

      if (!Array.isArray(klines) || klines.length === 0) {
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
        } catch {
          continue;
        }
      }

      if (validKlines < 50) {
        return false;
      }

      this.candles.set(normalizedSymbol, candleData);
      this.lastAccessTime.set(normalizedSymbol, Date.now());
      this.isInitialized = true;

      return true;
    } catch (err: any) {
      if (
        retryCount < this.maxRetries &&
        (err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('fetch failed'))
      ) {
        await delay(this.retryDelay * (retryCount + 1));
        return this.initializeHistoricalCandles(symbol, limit, retryCount + 1);
      }

      return false;
    }
  }

  updateFromWebSocket(symbol: string, kline: any) {
    if (this.isDestroyed) return;

    const normalizedSymbol = normalize(symbol);
    const candleData = this.candles.get(normalizedSymbol);

    if (!candleData || !kline || typeof kline !== 'object') return;

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

      // ✅ Check for duplicate timestamp
      const lastTimestamp =
        candleData.timestamps[candleData.timestamps.length - 1];
      if (lastTimestamp === timestamp) {
        // Update existing instead of adding
        const idx = candleData.timestamps.length - 1;
        candleData.highs[idx] = parsedHigh;
        candleData.lows[idx] = parsedLow;
        candleData.closes[idx] = parsedClose;
        candleData.volumes[idx] = parsedVolume;
        return;
      }

      candleData.timestamps.push(timestamp);
      candleData.highs.push(parsedHigh);
      candleData.lows.push(parsedLow);
      candleData.closes.push(parsedClose);
      candleData.volumes.push(parsedVolume);

      // Strict enforcement
      while (candleData.closes.length > MEMORY_CONFIG.MAX_CANDLES_PER_SYMBOL) {
        candleData.timestamps.shift();
        candleData.highs.shift();
        candleData.lows.shift();
        candleData.closes.shift();
        candleData.volumes.shift();
      }

      this.lastAccessTime.set(normalizedSymbol, Date.now());
    } catch (err: any) {
      log(`❌ Update error: ${err.message}`, 'error');
    }
  }

  getCandles(symbol: string, marketType: MarketType): CandleData | null {
    // if (this.isDestroyed) return null;

    // const normalizedSymbol = normalize(symbol);
    // const data = this.candles.get(normalizedSymbol);

    // if (!data || data.closes.length < 210) return null;

    // this.lastAccessTime.set(normalizedSymbol, Date.now());

    console.log('\n🔍 getCandles DEBUG:');
    console.log('   Input symbol:', symbol);
    console.log('   Input marketType:', marketType);

    const normalizedSymbol = normalize(symbol, marketType);
    console.log('   Normalized to:', normalizedSymbol);

    // Check what keys actually exist
    const allKeys = Array.from(this.candles.keys());
    console.log('   Total keys in map:', allKeys.length);

    // Look for similar keys
    const similar = allKeys.filter(
      (k) =>
        k.includes('CYS') ||
        k.toLowerCase().includes(symbol.toLowerCase().substring(0, 3))
    );
    console.log('   Similar keys found:', similar);

    const data = this.candles.get(normalizedSymbol);
    console.log('   Data found:', data ? 'YES' : 'NO');

    if (!data) {
      console.log('   ❌ Key not in map!');
      return null;
    }

    console.log('   Candle count:', data.closes.length);

    if (data.closes.length === 0) return null;
    if (data.closes.length < 50) return null;
    return data;
  }

  getCandleCount(symbol: string): number {
    return this.candles.get(normalize(symbol))?.closes.length || 0;
  }

  isReady(symbol: string): boolean {
    const data = this.candles.get(normalize(symbol));
    return !!data && data.closes.length >= 210;
  }

  getInitializedSymbols(): string[] {
    return Array.from(this.candles.keys());
  }

  hasSymbol(symbol: string): boolean {
    return this.candles.has(normalize(symbol));
  }

  clearSymbol(symbol: string): void {
    const normalizedSymbol = normalize(symbol);
    this.candles.delete(normalizedSymbol);
    this.lastAccessTime.delete(normalizedSymbol);
  }

  getMemoryStats() {
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
   * ✅ Proper cleanup
   */
  destroy(): void {
    this.isDestroyed = true;

    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.candles.clear();
    this.lastAccessTime.clear();
    log('🗑️ CandleManager destroyed', 'info');
  }
}
