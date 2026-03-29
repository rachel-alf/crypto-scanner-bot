// export class PriceFetcher {
//   private spotBaseUrl = 'https://api4.binance.com/api/v3';
//   private futuresBaseUrl = 'https://fapi.binance.com/fapi/v1'; // ✅ FUTURES API

import WebSocket from 'ws';

//   async getCurrentPrice(
//     symbol: string,
//     market: 'SPOT' | 'FUTURES' = 'FUTURES' // ✅ Default to FUTURES
//   ): Promise<number | null> {
//     try {
//       const binanceSymbol = symbol.replace('/', '');

//       // ✅ Use correct endpoint based on market
//       const baseUrl =
//         market === 'FUTURES' ? this.futuresBaseUrl : this.spotBaseUrl;
//       const endpoint = market === 'FUTURES' ? '/ticker/price' : '/ticker/price';

//       const response = await fetch(
//         `${baseUrl}${endpoint}?symbol=${binanceSymbol}`
//       );
//       const data = await response.json();

//       if (data && data.price) {
//         return parseFloat(data.price);
//       }

//       return null;
//     } catch (err: any) {
//       console.error(
//         `Failed to fetch ${market} price for ${symbol}: ${err.message}`
//       );
//       return null;
//     }
//   }

//   async getMultiplePrices(
//     symbols: string[],
//     market: 'SPOT' | 'FUTURES' = 'FUTURES' // ✅ Default to FUTURES
//   ): Promise<Map<string, number>> {
//     const priceMap = new Map<string, number>();

//     try {
//       const binanceSymbols = symbols.map((s) => s.replace('/', ''));

//       // ✅ Use correct endpoint
//       const baseUrl =
//         market === 'FUTURES' ? this.futuresBaseUrl : this.spotBaseUrl;
//       const endpoint = '/ticker/price';

//       const promises = binanceSymbols.map(async (sym) => {
//         try {
//           const response = await fetch(`${baseUrl}${endpoint}?symbol=${sym}`);
//           const data = await response.json();

//           if (data && data.price) {
//             priceMap.set(sym, parseFloat(data.price));
//           }
//         } catch (err: any) {
//           console.error(`Failed to fetch ${market} ${sym}: ${err.message}`);
//         }
//       });

//       await Promise.all(promises);
//     } catch (err: any) {
//       console.error(
//         `Failed to fetch multiple ${market} prices: ${err.message}`
//       );
//     }

//     return priceMap;
//   }
// }

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * ✅ Live price data with timestamp for caching
//  */
// interface LivePriceData {
//   price: number;
//   timestamp: number;
//   source: 'binance' | 'cache';
// }

/**
 * ✅ Order book data interface
 */
// interface OrderBookData {
//   bidPrice: number;
//   bidQty: number;
//   askPrice: number;
//   askQty: number;
//   spread: number;
//   spreadPercent: number;
// }

// ============================================================================
// PRICE FETCHER CLASS REST API
// ============================================================================

// export class PriceFetcher {
//   private spotBaseUrl = 'https://api4.binance.com/api/v3';
//   private futuresBaseUrl = 'https://fapi.binance.com/fapi/v1'; // ✅ FUTURES API

//   // ✅ Cache for recent prices (max 6 tokens)
//   private priceCache: Map<string, LivePriceData> = new Map();

//   // ✅ Cache durations by use case
//   private readonly CACHE_AGE_ENTRY = 1000; // 1s max for entry
//   private readonly CACHE_AGE_MONITOR = 3000; // 3s for monitoring
//   private readonly CACHE_AGE_SCAN = 10000; // 10s for scanning

//   private readonly MAX_CACHED_SYMBOLS = 10;

//   // ✅ Rate limiting
//   private requestCount = 0;
//   private requestWindow = Date.now();
//   private readonly MAX_REQUESTS_PER_MINUTE = 1200; // Binance limit

//   // ✅ Retry logic
//   private readonly MAX_RETRIES = 3;
//   private readonly RETRY_DELAY = 1000; // 1 second

//   /**
//    * ✅ CRITICAL: Get LIVE price for immediate trading
//    * Use RIGHT BEFORE placing an order
//    *
//    * @param symbol - Trading symbol
//    * @param purpose - What you need the price for (affects cache tolerance)
//    * @param forceRefresh - Skip cache entirely
//    */
//   async getCurrentPrice(
//     symbol: string,
//     purpose: 'entry' | 'monitor' | 'scan' = 'entry',
//     forceRefresh = false
//   ): Promise<PriceFetchResult | null> {
//     try {
//       const binanceSymbol = symbol.replace('/', '');

//       // ✅ Determine acceptable cache age based on purpose
//       const maxCacheAge =
//         purpose === 'entry'
//           ? this.CACHE_AGE_ENTRY
//           : purpose === 'monitor'
//             ? this.CACHE_AGE_MONITOR
//             : this.CACHE_AGE_SCAN;

//       // ✅ Check cache (unless force refresh or entry decision)
//       if (!forceRefresh && purpose !== 'entry') {
//         const cached = this.getCachedPrice(binanceSymbol, maxCacheAge);
//         if (cached) {
//           return cached;
//         }
//       }

//       // ✅ Fetch live price with retry logic
//       const price = await this.fetchPriceWithRetry(binanceSymbol);

//       if (!price) {
//         // ✅ Fallback to cache if live fetch fails
//         const fallback = this.getCachedPrice(binanceSymbol, 60000); // Accept up to 1 min old
//         if (fallback) {
//           console.log(
//             `⚠️ ${symbol}: Using stale cache (${(fallback.age / 1000).toFixed(1)}s old)`
//           );
//           return {
//             ...fallback,
//             confidence: 'low',
//           };
//         }
//         return null;
//       }

//       // ✅ Validate price is reasonable
//       const isValid = this.validatePrice(binanceSymbol, price);
//       if (!isValid) {
//         console.error(`❌ ${symbol}: Invalid price $${price} - rejecting`);
//         return null;
//       }

//       // ✅ Update cache
//       this.updateCache(binanceSymbol, price, 'high');

//       return {
//         price,
//         source: 'live',
//         age: 0,
//         confidence: 'high',
//       };
//     } catch (err: any) {
//       console.error(`❌ Failed to fetch price for ${symbol}: ${err.message}`);
//       return null;
//     }
//   }

//   /**
//    * ✅ Fetch price with exponential backoff retry
//    */
//   private async fetchPriceWithRetry(
//     symbol: string,
//     retries = 0
//   ): Promise<number | null> {
//     try {
//       // ✅ Check rate limit
//       if (!this.checkRateLimit()) {
//         console.log(`⏳ Rate limit reached, waiting...`);
//         await this.sleep(1000);
//       }

//       const response = await fetch(
//         `${this.futuresBaseUrl}/ticker/price?symbol=${symbol}`,
//         { signal: AbortSignal.timeout(5000) } // 5s timeout
//       );

//       this.requestCount++;

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}`);
//       }

//       const data = await response.json();

//       if (data && data.price) {
//         return parseFloat(data.price);
//       }

//       return null;
//     } catch (err: any) {
//       if (retries < this.MAX_RETRIES) {
//         const delay = this.RETRY_DELAY * Math.pow(2, retries); // Exponential backoff
//         console.log(
//           `⚠️ ${symbol}: Retry ${retries + 1}/${this.MAX_RETRIES} in ${delay}ms`
//         );
//         await this.sleep(delay);
//         return this.fetchPriceWithRetry(symbol, retries + 1);
//       }

//       console.error(`❌ ${symbol}: All retries failed`);
//       return null;
//     }
//   }

//   /**
//    * ✅ Get ORDER BOOK for best execution price
//    * Use this for large orders or when spread matters
//    */
//   async getOrderBookPrice(
//     symbol: string,
//     side: 'BUY' | 'SELL',
//     market: 'SPOT' | 'FUTURES' = 'FUTURES'
//   ): Promise<OrderBookData | null> {
//     try {
//       const binanceSymbol = symbol.replace('/', '');
//       const baseUrl =
//         market === 'FUTURES' ? this.futuresBaseUrl : this.spotBaseUrl;

//       // ✅ Check rate limit
//       if (!this.checkRateLimit()) {
//         await this.sleep(1000);
//       }

//       const response = await fetch(
//         `${baseUrl}/depth?symbol=${binanceSymbol}&limit=5`,
//         { signal: AbortSignal.timeout(5000) }
//       );

//       this.requestCount++;

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}`);
//       }

//       const data = await response.json();

//       if (data && data.bids && data.asks && data.bids[0] && data.asks[0]) {
//         const bidPrice = parseFloat(data.bids[0][0]);
//         const askPrice = parseFloat(data.asks[0][0]);
//         const spread = askPrice - bidPrice;
//         const spreadPercent = (spread / bidPrice) * 100;

//         // ✅ Validate order book makes sense
//         if (spreadPercent > 1.0) {
//           console.warn(
//             `⚠️ ${symbol}: Large spread ${spreadPercent.toFixed(2)}%`
//           );
//         }

//         return {
//           bidPrice,
//           bidQty: parseFloat(data.bids[0][1]),
//           askPrice,
//           askQty: parseFloat(data.asks[0][1]),
//           spread,
//           spreadPercent,
//           timestamp: Date.now(),
//         };
//       }

//       return null;
//     } catch (err: any) {
//       console.error(
//         `❌ Failed to fetch order book for ${symbol}: ${err.message}`
//       );
//       return null;
//     }
//   }

//   /**
//    * ✅ Batch fetch for scanning (NOT for trade execution)
//    */
//   async getMultiplePrices(
//     symbols: string[],
//     market: 'SPOT' | 'FUTURES' = 'FUTURES'
//   ): Promise<Map<string, number>> {
//     const priceMap = new Map<string, number>();

//     try {
//       const baseUrl =
//         market === 'FUTURES' ? this.futuresBaseUrl : this.spotBaseUrl;

//       // ✅ Check rate limit
//       if (!this.checkRateLimit()) {
//         await this.sleep(1000);
//       }

//       const response = await fetch(`${baseUrl}/ticker/price`, {
//         signal: AbortSignal.timeout(10000),
//       });

//       this.requestCount++;

//       if (!response.ok) {
//         throw new Error(`HTTP ${response.status}`);
//       }

//       const allPrices = await response.json();
//       const binanceSymbols = symbols.map((s) => s.replace('/', ''));

//       for (const ticker of allPrices) {
//         if (binanceSymbols.includes(ticker.symbol)) {
//           const price = parseFloat(ticker.price);

//           // ✅ Validate each price
//           if (this.validatePrice(ticker.symbol, price)) {
//             priceMap.set(ticker.symbol, price);
//             this.updateCache(ticker.symbol, price, 'medium');
//           }
//         }
//       }

//       console.log(`📊 Fetched ${priceMap.size}/${symbols.length} prices`);
//     } catch (err: any) {
//       console.error(`❌ Batch price fetch failed: ${err.message}`);
//     }

//     return priceMap;
//   }

//   /**
//    * ✅ Get cached price if within age limit
//    */
//   private getCachedPrice(
//     symbol: string,
//     maxAge: number
//   ): PriceFetchResult | null {
//     const cached = this.priceCache.get(symbol);

//     if (!cached) {
//       return null;
//     }

//     const age = Date.now() - cached.timestamp;

//     if (age <= maxAge) {
//       return {
//         price: cached.price,
//         source: 'cache',
//         age,
//         confidence: age < 2000 ? 'high' : 'medium',
//       };
//     }

//     return null;
//   }

//   /**
//    * ✅ Validate price is reasonable
//    * Prevents corrupted data from causing bad trades
//    */
//   private validatePrice(symbol: string, price: number): boolean {
//     // Check 1: Price is positive
//     if (price <= 0) {
//       return false;
//     }

//     // Check 2: Price isn't absurdly different from cache
//     const cached = this.priceCache.get(symbol);
//     if (cached) {
//       const change = Math.abs((price - cached.price) / cached.price);

//       // If price changed >20% in <1 minute, probably bad data
//       const age = Date.now() - cached.timestamp;
//       if (age < 60000 && change > 0.2) {
//         console.warn(
//           `⚠️ ${symbol}: Suspicious price change ${(change * 100).toFixed(1)}% ` +
//             `($${cached.price} → $${price})`
//         );
//         return false;
//       }
//     }

//     return true;
//   }

//   /**
//    * ✅ Update cache with LRU eviction
//    */
//   private updateCache(
//     symbol: string,
//     price: number,
//     confidence: 'high' | 'medium' | 'low'
//   ): void {
//     // Remove oldest if cache full
//     if (
//       this.priceCache.size >= this.MAX_CACHED_SYMBOLS &&
//       !this.priceCache.has(symbol)
//     ) {
//       const oldestKey = this.priceCache.keys().next().value as string;
//       this.priceCache.delete(oldestKey);
//     }

//     this.priceCache.set(symbol, {
//       price,
//       timestamp: Date.now(),
//       source: 'binance',
//       confidence,
//     });
//   }

//   /**
//    * ✅ Check if we're within rate limits
//    */
//   private checkRateLimit(): boolean {
//     const now = Date.now();

//     // Reset counter every minute
//     if (now - this.requestWindow > 60000) {
//       this.requestCount = 0;
//       this.requestWindow = now;
//     }

//     return this.requestCount < this.MAX_REQUESTS_PER_MINUTE;
//   }

//   /**
//    * ✅ Sleep utility
//    */
//   private sleep(ms: number): Promise<void> {
//     return new Promise((resolve) => setTimeout(resolve, ms));
//   }

//   /**
//    * ✅ Get cache info for debugging
//    */
//   getCacheInfo(): string[] {
//     const info: string[] = [];
//     this.priceCache.forEach((data, symbol) => {
//       const age = ((Date.now() - data.timestamp) / 1000).toFixed(1);
//       info.push(
//         `${symbol}: $${data.price.toFixed(6)} ` +
//           `(${age}s old, ${data.confidence})`
//       );
//     });
//     return info;
//   }

//   /**
//    * ✅ Clear cache
//    */
//   clearCache(): void {
//     this.priceCache.clear();
//   }

//   /**
//    * ✅ Get stats
//    */
//   getStats(): {
//     cacheSize: number;
//     requestCount: number;
//     requestsPerMinute: number;
//   } {
//     return {
//       cacheSize: this.priceCache.size,
//       requestCount: this.requestCount,
//       requestsPerMinute: this.MAX_REQUESTS_PER_MINUTE,
//     };
//   }
// }

// ============================================
// WEBSOCKET PRICE FETCHER
// ============================================

interface LivePriceData {
  price: number;
  timestamp: number;
  source: 'websocket' | 'rest' | 'cache';
  confidence: 'high' | 'medium' | 'low';
  volume24h?: number;
  priceChange24h?: number;
}

interface PriceFetchResult {
  price: number;
  source: 'websocket' | 'rest' | 'cache';
  age: number; // milliseconds
  confidence: 'high' | 'medium' | 'low';
}

interface OrderBookData {
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  spread: number;
  spreadPercent: number;
  timestamp: number;
}

interface WebSocketSubscription {
  symbol: string;
  stream: string;
  lastUpdate: number;
  reconnectAttempts: number;
}

export class PriceFetcher {
  private spotBaseUrl = 'https://api4.binance.com/api/v3';
  private futuresBaseUrl = 'https://fapi.binance.com/fapi/v1';

  // 🔌 WebSocket connections
  private ws: WebSocket | null = null;
  private wsUrl = 'wss://fstream.binance.com/ws'; // Futures WebSocket
  private subscriptions: Map<string, WebSocketSubscription> = new Map();

  // 💾 Price cache (updated via WebSocket)
  private priceCache: Map<string, LivePriceData> = new Map();

  // ⚙️ Configuration
  private readonly MAX_CACHED_SYMBOLS = 50;
  private readonly CACHE_AGE_ENTRY = 1000; // 1s for entry
  private readonly CACHE_AGE_MONITOR = 5000; // 5s for monitoring
  private readonly WS_RECONNECT_DELAY = 5000; // 5s
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  // 📊 Stats
  private messageCount = 0;
  private lastMessageTime = Date.now();
  private reconnectAttempts = 0;

  // 🔒 State
  private isConnected = false;
  private isConnecting = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.setupWebSocket();
  }

  // ============================================
  // WEBSOCKET SETUP & MANAGEMENT
  // ============================================

  private setupWebSocket(): void {
    if (this.isConnecting || this.isConnected) {
      console.log('⚠️ WebSocket already connected or connecting');
      return;
    }

    this.isConnecting = true;

    try {
      console.log('🔌 Connecting to Binance Futures WebSocket...');
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        console.log('✅ WebSocket connected');

        // Start heartbeat
        this.startHeartbeat();

        // Resubscribe to symbols
        this.resubscribeAll();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        console.log(`🔌 WebSocket closed (${code}): ${reason}`);
        this.stopHeartbeat();
        this.attemptReconnect();
      });
    } catch (error: any) {
      this.isConnecting = false;
      console.error('❌ Failed to setup WebSocket:', error.message);
      this.attemptReconnect();
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      this.messageCount++;
      this.lastMessageTime = Date.now();

      // Handle ticker updates
      if (message.e === 'aggTrade' || message.e === '24hrMiniTicker') {
        const symbol = message.s;
        const price = parseFloat(message.p || message.c);

        if (price && price > 0) {
          this.updateCache(symbol, price, 'high');
        }
      }

      // Handle mark price updates (specific to futures)
      if (message.e === 'markPriceUpdate') {
        const symbol = message.s;
        const price = parseFloat(message.p);

        if (price && price > 0) {
          this.updateCache(symbol, price, 'high');
        }
      }
    } catch (error: any) {
      console.error('❌ Failed to parse WebSocket message:', error.message);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        // Check if we're receiving messages
        const timeSinceLastMessage = Date.now() - this.lastMessageTime;

        if (timeSinceLastMessage > 60000) {
          // No message for 1 minute
          console.log('⚠️ WebSocket appears stale, reconnecting...');
          this.reconnect();
        } else {
          // Send ping
          try {
            this.ws.ping();
          } catch (error: any) {
            console.error('❌ Ping failed:', error.message);
          }
        }
      }
    }, 30000); // Check every 30 seconds
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('❌ Max reconnect attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.WS_RECONNECT_DELAY * this.reconnectAttempts;

    console.log(
      `🔄 Reconnecting in ${delay / 1000}s ` +
        `(attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`
    );

    setTimeout(() => {
      this.reconnect();
    }, delay);
  }

  private reconnect(): void {
    this.disconnect();
    setTimeout(() => {
      this.setupWebSocket();
    }, 1000);
  }

  // ============================================
  // SUBSCRIPTION MANAGEMENT
  // ============================================

  /**
   * ✅ Subscribe to a symbol's price updates
   */
  subscribeToSymbol(symbol: string): void {
    if (!this.ws || !this.isConnected) {
      console.log(`⏳ ${symbol}: WebSocket not ready, queuing subscription`);
      return;
    }

    const binanceSymbol = symbol.replace('/', '').toLowerCase();

    if (this.subscriptions.has(binanceSymbol)) {
      console.log(`⚠️ ${symbol}: Already subscribed`);
      return;
    }

    try {
      // Subscribe to mark price stream (best for futures)
      const stream = `${binanceSymbol}@markPrice@1s`;

      const subscribeMsg = {
        method: 'SUBSCRIBE',
        params: [stream],
        id: Date.now(),
      };

      this.ws.send(JSON.stringify(subscribeMsg));

      this.subscriptions.set(binanceSymbol, {
        symbol: binanceSymbol,
        stream,
        lastUpdate: Date.now(),
        reconnectAttempts: 0,
      });

      console.log(`✅ Subscribed to ${symbol} price updates`);
    } catch (error: any) {
      console.error(`❌ Failed to subscribe to ${symbol}:`, error.message);
    }
  }

  /**
   * ✅ Unsubscribe from a symbol
   */
  unsubscribeFromSymbol(symbol: string): void {
    if (!this.ws || !this.isConnected) {
      return;
    }

    const binanceSymbol = symbol.replace('/', '').toLowerCase();
    const subscription = this.subscriptions.get(binanceSymbol);

    if (!subscription) {
      return;
    }

    try {
      const unsubscribeMsg = {
        method: 'UNSUBSCRIBE',
        params: [subscription.stream],
        id: Date.now(),
      };

      this.ws.send(JSON.stringify(unsubscribeMsg));
      this.subscriptions.delete(binanceSymbol);

      console.log(`✅ Unsubscribed from ${symbol}`);
    } catch (error: any) {
      console.error(`❌ Failed to unsubscribe from ${symbol}:`, error.message);
    }
  }

  /**
   * ✅ Subscribe to multiple symbols at once
   */
  subscribeToMultiple(symbols: string[]): void {
    console.log(`📡 Subscribing to ${symbols.length} symbols...`);

    symbols.forEach((symbol) => {
      this.subscribeToSymbol(symbol);
    });
  }

  /**
   * ✅ Resubscribe to all symbols after reconnect
   */
  private resubscribeAll(): void {
    const symbols = Array.from(this.subscriptions.keys());

    if (symbols.length > 0) {
      console.log(`🔄 Resubscribing to ${symbols.length} symbols...`);
      this.subscriptions.clear();
      symbols.forEach((symbol) => this.subscribeToSymbol(symbol));
    }
  }

  // ============================================
  // PRICE FETCHING
  // ============================================

  /**
   * ✅ Get current price (WebSocket first, REST fallback)
   */
  async getCurrentPrice(
    symbol: string,
    purpose: 'entry' | 'monitor' | 'scan' = 'entry',
    forceRefresh = false
  ): Promise<PriceFetchResult | null> {
    const binanceSymbol = symbol.replace('/', '');

    // Subscribe if not already subscribed
    if (!this.subscriptions.has(binanceSymbol.toLowerCase())) {
      this.subscribeToSymbol(symbol);
    }

    // Determine max cache age
    const maxCacheAge =
      purpose === 'entry' ? this.CACHE_AGE_ENTRY : this.CACHE_AGE_MONITOR;

    // ✅ Try WebSocket cache first
    if (!forceRefresh) {
      const cached = this.getCachedPrice(binanceSymbol, maxCacheAge);

      if (cached && cached.source === 'websocket') {
        return cached;
      }
    }

    // ✅ Fallback to REST API
    console.log(`🔄 ${symbol}: Fetching via REST API...`);
    return this.fetchViaREST(binanceSymbol);
  }

  /**
   * ✅ Get multiple prices (batch)
   */
  async getMultiplePrices(symbols: string[]): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();

    // Subscribe to all symbols
    this.subscribeToMultiple(symbols);

    // Wait a bit for WebSocket updates
    await this.sleep(1000);

    // Collect prices
    for (const symbol of symbols) {
      const binanceSymbol = symbol.replace('/', '');
      const cached = this.priceCache.get(binanceSymbol);

      if (cached) {
        priceMap.set(symbol, cached.price);
      }
    }

    // Fetch missing prices via REST
    const missingSymbols = symbols.filter((s) => !priceMap.has(s));

    if (missingSymbols.length > 0) {
      console.log(
        `🔄 Fetching ${missingSymbols.length} missing prices via REST...`
      );
      const restPrices = await this.batchFetchViaREST(missingSymbols);
      restPrices.forEach((price, symbol) => priceMap.set(symbol, price));
    }

    return priceMap;
  }

  // ============================================
  // REST API FALLBACK
  // ============================================

  // private async fetchViaREST(symbol: string): Promise<PriceFetchResult | null> {
  //   try {
  //     const response = await fetch(
  //       `${this.futuresBaseUrl}/ticker/price?symbol=${symbol}`,
  //       { signal: AbortSignal.timeout(5000) }
  //     );

  //     if (!response.ok) {
  //       throw new Error(`HTTP ${response.status}`);
  //     }

  //     const data = await response.json();

  //     if (data && data.price) {
  //       const price = parseFloat(data.price);
  //       this.updateCache(symbol, price, 'medium');

  //       return {
  //         price,
  //         source: 'rest',
  //         age: 0,
  //         confidence: 'medium',
  //       };
  //     }

  //     return null;
  //   } catch (error: any) {
  //     console.error(`❌ REST fetch failed for ${symbol}:`, error.message);
  //     return null;
  //   }
  // }

  private async fetchViaREST(symbol: string): Promise<PriceFetchResult | null> {
    try {
      const response = await fetch(
        `${this.futuresBaseUrl}/ticker/price?symbol=${symbol}`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Runtime type checking
      if (
        data &&
        typeof data === 'object' &&
        'price' in data &&
        typeof (data as any).price === 'string'
      ) {
        const price = parseFloat((data as any).price);

        // Additional validation
        if (isNaN(price)) {
          console.error(
            `Invalid price received for ${symbol}:`,
            (data as any).price
          );
          return null;
        }

        this.updateCache(symbol, price, 'medium');

        return {
          price,
          source: 'rest',
          age: 0,
          confidence: 'medium',
        };
      }

      console.warn(`Unexpected response format for ${symbol}:`, data);
      return null;
    } catch (error: any) {
      console.error(`❌ REST fetch failed for ${symbol}:`, error.message);
      return null;
    }
  }
  // private async batchFetchViaREST(
  //   symbols: string[]
  // ): Promise<Map<string, number>> {
  //   const priceMap = new Map<string, number>();

  //   try {
  //     const response = await fetch(`${this.futuresBaseUrl}/ticker/price`, {
  //       signal: AbortSignal.timeout(10000),
  //     });

  //     if (!response.ok) {
  //       throw new Error(`HTTP ${response.status}`);
  //     }

  //     const allPrices = await response.json();
  //     const binanceSymbols = symbols.map((s) => s.replace('/', ''));

  //     for (const ticker of allPrices) {
  //       if (binanceSymbols.includes(ticker.symbol)) {
  //         const price = parseFloat(ticker.price);
  //         priceMap.set(ticker.symbol, price);
  //         this.updateCache(ticker.symbol, price, 'medium');
  //       }
  //     }
  //   } catch (error: any) {
  //     console.error(`❌ Batch REST fetch failed:`, error.message);
  //   }

  //   return priceMap;
  // }

  private async batchFetchViaREST(
    symbols: string[]
  ): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();

    try {
      const response = await fetch(`${this.futuresBaseUrl}/ticker/price`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const allPrices = await response.json();
      const binanceSymbols = symbols.map((s) => s.replace('/', ''));

      // Use type guard
      if (isBinanceTickerArray(allPrices)) {
        for (const ticker of allPrices) {
          if (binanceSymbols.includes(ticker.symbol)) {
            const price = parseFloat(ticker.price);
            priceMap.set(ticker.symbol, price);
            this.updateCache(ticker.symbol, price, 'medium');
          }
        }
      } else {
        console.warn('Unexpected response format from batch endpoint');
      }
    } catch (error: any) {
      console.error(`❌ Batch REST fetch failed:`, error.message);
    }

    return priceMap;
  }

  // ============================================
  // CACHE MANAGEMENT
  // ============================================

  private getCachedPrice(
    symbol: string,
    maxAge: number
  ): PriceFetchResult | null {
    const cached = this.priceCache.get(symbol);

    if (!cached) {
      return null;
    }

    const age = Date.now() - cached.timestamp;

    if (age <= maxAge) {
      return {
        price: cached.price,
        source: cached.source,
        age,
        confidence: age < 2000 ? 'high' : 'medium',
      };
    }

    return null;
  }

  private updateCache(
    symbol: string,
    price: number,
    confidence: 'high' | 'medium' | 'low'
  ): void {
    // Validate price
    if (!this.validatePrice(symbol, price)) {
      return;
    }

    // LRU eviction
    if (
      this.priceCache.size >= this.MAX_CACHED_SYMBOLS &&
      !this.priceCache.has(symbol)
    ) {
      const oldestKey = this.priceCache.keys().next().value as string;
      this.priceCache.delete(oldestKey);
    }

    this.priceCache.set(symbol, {
      price,
      timestamp: Date.now(),
      source: this.isConnected ? 'websocket' : 'rest',
      confidence,
    });
  }

  private validatePrice(symbol: string, price: number): boolean {
    if (price <= 0) {
      return false;
    }

    const cached = this.priceCache.get(symbol);
    if (cached) {
      const change = Math.abs((price - cached.price) / cached.price);
      const age = Date.now() - cached.timestamp;

      // Reject >20% change in <1 minute
      if (age < 60000 && change > 0.2) {
        console.warn(
          `⚠️ ${symbol}: Suspicious ${(change * 100).toFixed(1)}% change ` +
            `($${cached.price} → $${price})`
        );
        return false;
      }
    }

    return true;
  }

  // ============================================
  // CLEANUP
  // ============================================

  disconnect(): void {
    this.stopHeartbeat();

    if (this.ws) {
      try {
        this.ws.close();
      } catch (error: any) {
        console.error('❌ Error closing WebSocket:', error.message);
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.subscriptions.clear();
    console.log('🔌 WebSocket disconnected');
  }

  // ============================================
  // UTILITIES
  // ============================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStats(): {
    connected: boolean;
    subscriptions: number;
    cacheSize: number;
    messagesReceived: number;
    lastMessageAge: number;
  } {
    return {
      connected: this.isConnected,
      subscriptions: this.subscriptions.size,
      cacheSize: this.priceCache.size,
      messagesReceived: this.messageCount,
      lastMessageAge: Date.now() - this.lastMessageTime,
    };
  }

  getCacheInfo(): string[] {
    const info: string[] = [];
    this.priceCache.forEach((data, symbol) => {
      const age = ((Date.now() - data.timestamp) / 1000).toFixed(1);
      info.push(
        `${symbol}: $${data.price.toFixed(6)} ` +
          `(${age}s old, ${data.source}, ${data.confidence})`
      );
    });
    return info;
  }

  clearCache(): void {
    this.priceCache.clear();
  }
}

function isBinanceTickerArray(data: unknown): data is BinanceTicker[] {
  if (!Array.isArray(data)) return false;

  return data.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      'symbol' in item &&
      typeof (item as any).symbol === 'string' &&
      'price' in item &&
      typeof (item as any).price === 'string'
  );
}

export interface BinanceTicker {
  symbol: string;
  price: string;
  // Add other fields if available in the API response
  // time?: number;
  // etc.
}
