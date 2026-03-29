import crypto from 'crypto';

import ccxt, { type Order } from 'ccxt';

import type { EntryType, Position, TradingStats } from '../../lib/type.js';
import { getRequiredEnvVar } from '../futures/launcher-future.js';
import { log } from './candles.js';
import type { BinanceSide, PositionSide } from './trade-processor.js';

interface ActivePosition {
  symbol: string;
  side: EntryType;
  entryPrice: number;
  markPrice: number;
  quantity: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  marginUsed: number;
  liquidationPrice: number;
  positionValue: number;
  marginType: 'ISOLATED' | 'CROSS';
  stopLoss?: number | undefined;
  takeProfit?: number | undefined;
  stopLossOrderId?: string | undefined;
  takeProfitOrderId?: string | undefined;
}

interface TradeRecord {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  marginUsed: number;
  stopLoss: number;
  takeProfit?: number; // Keep for backward compatibility
  pnlUsd: number;
  pnlPct: number;
  duration: number;
  strategy: string;
  exitReason: string;
  isWin: boolean;
  time: number;
  realizedPnl: string;
  commission: string;
  commissionAsset: string;
  id?: number;
  orderId?: number;
  price?: string;
  qty?: string;
  tp1?: number; // ADD THIS
  tp2?: number; // ADD THIS
  quoteQty?: string;
  side?: 'BUY' | 'SELL';
  positionSide?: string;
  maker?: boolean;
}

export class BinanceDataFetcher {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string = 'https://fapi.binance.com';
  private exchange = new ccxt.binance({
    apiKey: getRequiredEnvVar('BINANCE_FUTURE_API_KEY'),
    secret: getRequiredEnvVar('BINANCE_FUTURE_API_SECRET'),
    enableRateLimit: true,
    timeout: 60000,
    options: {
      defaultType: 'future',
      adjustForTimeDifference: true,
    },
  });

  private normalizePositionSide(binanceSide: BinanceSide): PositionSide {
    return binanceSide === 'BUY' ? 'LONG' : 'SHORT';
  }

  private tradeHistory: TradeRecord[] = [];

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = getRequiredEnvVar('BINANCE_FUTURE_API_KEY');
    this.apiSecret = getRequiredEnvVar('BINANCE_FUTURE_API_SECRET');
  }

  private isClosingTrade(
    positionSide: EntryType,
    tradeSide: 'BUY' | 'SELL'
  ): boolean {
    return (
      (positionSide === 'LONG' && tradeSide === 'SELL') ||
      (positionSide === 'SHORT' && tradeSide === 'BUY')
    );
  }

  private isAddingToPosition(
    positionSide: EntryType,
    tradeSide: 'BUY' | 'SELL'
  ): boolean {
    return (
      (positionSide === 'LONG' && tradeSide === 'BUY') ||
      (positionSide === 'SHORT' && tradeSide === 'SELL')
    );
  }

  /**
   * Generate HMAC SHA256 signature for Binance API
   */
  private generateSignature(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Make signed request to Binance API using fetch
   */
  private async signedRequest(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    params: Record<string, any> = {}
  ): Promise<any> {
    const timestamp = Date.now();
    const queryString = new URLSearchParams({
      ...params,
      timestamp: timestamp.toString(),
    }).toString();

    const signature = this.generateSignature(queryString);
    const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Binance API Error (${response.status}): ${errorData.msg || response.statusText}`
        );
      }

      return await response.json();
    } catch (error: any) {
      throw new Error(`Binance API Error: ${error.message}`);
    }
  }

  /**
   * Fetch trade history in 7-day chunks (Binance limit)
   */
  private async fetchTradesBatch(
    symbol: string,
    startTime: number,
    endTime: number
  ): Promise<any[]> {
    const allTrades: any[] = [];
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    let currentStart = startTime;

    while (currentStart < endTime) {
      // Calculate end of this chunk (max 7 days)
      const currentEnd = Math.min(currentStart + SEVEN_DAYS, endTime);

      console.log(
        `   📦 Fetching ${new Date(currentStart).toISOString().split('T')[0]} to ${new Date(currentEnd).toISOString().split('T')[0]}`
      );

      try {
        const params: Record<string, any> = {
          symbol: symbol,
          startTime: currentStart,
          endTime: currentEnd,
          limit: 1000,
        };

        const batch = await this.signedRequest(
          '/fapi/v1/userTrades',
          'GET',
          params
        );

        if (batch && batch.length > 0) {
          allTrades.push(...batch);
          console.log(`      ✅ Got ${batch.length} trades`);
        }

        // Rate limit protection
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error: any) {
        console.error(`      ❌ Error: ${error.message}`);
      }

      // Move to next 7-day chunk
      currentStart = currentEnd;
    }

    return allTrades;
  }
  /**
   * Fetch all symbols you've traded
   */
  private async getActiveSymbols(): Promise<string[]> {
    try {
      const accountInfo = await this.signedRequest('/fapi/v2/account', 'GET');

      const symbols = accountInfo.positions
        .filter((pos: Position) => {
          // Convert to string first to handle numbers, and check for undefined/null
          const initialAmount = pos.initialAmount?.toString() || '0';
          const pnlUsd = pos.pnlUsd?.toString() || '0';

          return parseFloat(initialAmount) !== 0 || parseFloat(pnlUsd) !== 0;
        })
        .map((pos: Position) => pos.symbol);

      return [...new Set(symbols)] as string[];
    } catch (error: any) {
      console.error(`❌ Error getting symbols: ${error.message}`);
      return [];
    }
  }

  /**
   * Main method: Fetch old history
   */
  async fetchOldHistory(daysBack: number = 7): Promise<void> {
    try {
      console.log(`\n📥 Fetching ${daysBack} days of history...\n`);

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      const startTime = startDate.getTime();
      const endTime = endDate.getTime();

      console.log(`   From: ${startDate.toISOString()}`);
      console.log(`   To: ${endDate.toISOString()}\n`);

      // Get symbols
      console.log('📊 Finding active symbols...');
      let symbols = await this.getActiveSymbols();
      console.log('🥑 Active symbols from API:', symbols);

      if (!symbols || symbols.length === 0) {
        console.log('⚠️ No active symbols found. Trying default symbols...');
        symbols = ['DUSKUSDT', 'CYSUSDT', 'STXUSDT']; // Add more symbols you've traded
      }

      console.log('🥑 Symbols to fetch:', symbols);

      let allTrades: any[] = [];

      for (const symbol of symbols) {
        console.log(`\n📥 Fetching ${symbol} history...`);
        console.log(
          `   StartTime: ${startTime} (${new Date(startTime).toISOString()})`
        );
        console.log(
          `   EndTime: ${endTime} (${new Date(endTime).toISOString()})`
        );

        try {
          const trades = await this.fetchTradesBatch(
            symbol,
            startTime,
            endTime
          );
          console.log(`🥑 Raw trades response for ${symbol}:`, trades.length);

          if (trades && Array.isArray(trades)) {
            allTrades.push(...trades);
            console.log(`   ✅ ${symbol}: ${trades.length} total trades\n`);
          }
        } catch (error: any) {
          console.error(`   ❌ ${symbol}: ${error.message}\n`);
        }
      }

      this.tradeHistory = allTrades.sort((a, b) => a.time - b.time);

      console.log(`\n✅ Loaded ${this.tradeHistory.length} total trades`);
      console.log('🥑 Sample trade:', this.tradeHistory[0]);

      this.printStats();
    } catch (error: any) {
      console.error(`❌ Failed to fetch history: ${error.message}`);
    }
  }

  async testFetchTrades(): Promise<void> {
    try {
      console.log('\n🧪 Testing trade fetch with CCXT...\n');

      const symbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT']; // CCXT format for futures
      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

      for (const symbol of symbols) {
        console.log(`Testing ${symbol}...`);
        const trades = await this.exchange.fetchMyTrades(symbol, since);
        console.log(`   Found ${trades.length} trades`);
        if (trades.length > 0) {
          console.log('   Sample:', trades[0]);
        }
      }
    } catch (error: any) {
      console.error('Error:', error.message);
    }
  }

  /**
   * Alternative: Fetch specific symbol history
   */
  async fetchSymbolHistory(
    symbol: string,
    daysBack: number = 180
  ): Promise<any[]> {
    console.log(`\n📥 Fetching ${symbol} history (${daysBack} days)...\n`);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const startTime = startDate.getTime();
    const endTime = endDate.getTime();

    const trades = await this.fetchTradesBatch(symbol, startTime, endTime);

    console.log(`\n✅ Loaded ${trades.length} ${symbol} trades`);

    return trades;
  }

  /**
   * Fetch ALL trades across all symbols (no need to specify symbols)
   */
  async fetchAllTrades(daysBack: number = 30): Promise<void> {
    try {
      console.log(`\n📥 Fetching ALL trades (last ${daysBack} days)...\n`);

      const endTime = Date.now();
      const startTime = endTime - daysBack * 24 * 60 * 60 * 1000;
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

      let allTrades: any[] = [];
      let currentStart = startTime;

      // Break into 7-day chunks
      while (currentStart < endTime) {
        const currentEnd = Math.min(currentStart + SEVEN_DAYS, endTime);

        console.log(
          `📦 Fetching ${new Date(currentStart).toISOString().split('T')[0]} to ${new Date(currentEnd).toISOString().split('T')[0]}`
        );

        try {
          // This endpoint gets ALL symbols at once - no need to specify!
          const params = {
            startTime: currentStart,
            endTime: currentEnd,
            limit: 1000,
          };

          const trades = await this.signedRequest(
            '/fapi/v1/userTrades', // Note: NO symbol parameter!
            'GET',
            params
          );

          if (trades && trades.length > 0) {
            allTrades.push(...trades);
            console.log(`   ✅ Got ${trades.length} trades`);

            // Show unique symbols found
            const symbols = [...new Set(trades.map((t: any) => t.symbol))];
            console.log(`   📊 Symbols: ${symbols.join(', ')}`);
          } else {
            console.log(`   ⚠️  No trades in this period`);
          }

          // Rate limit
          await this.sleep(250);
        } catch (error: any) {
          console.error(`   ❌ Error: ${error.message}`);
        }

        currentStart = currentEnd;
      }

      // Sort and store
      this.tradeHistory = allTrades.sort((a, b) => a.time - b.time);

      console.log(`\n✅ Total trades loaded: ${this.tradeHistory.length}`);

      if (this.tradeHistory.length > 0) {
        const uniqueSymbols = [
          ...new Set(this.tradeHistory.map((t) => t.symbol)),
        ];
        console.log(`📊 You traded: ${uniqueSymbols.join(', ')}`);
        this.printStats();
      } else {
        console.log('⚠️  No trades found in this period');
      }
    } catch (error: any) {
      console.error(`❌ Failed to fetch trades: ${error.message}`);
    }
  }

  /**
   * ✅ Fetch positions using raw Binance API (has leverage!)
   */

  async fetchActivePositions(): Promise<ActivePosition[]> {
    try {
      console.log('📊 Fetching active positions from Binance...\n');

      const positionsRaw = await (
        this.exchange as any
      ).fapiPrivateV2GetPositionRisk();

      const activePositions: ActivePosition[] = [];

      for (const pos of positionsRaw) {
        const amount = parseFloat(pos.positionAmt);
        if (amount === 0) continue;

        const symbol = pos.symbol;
        const entryPrice = parseFloat(pos.entryPrice);
        const markPrice = parseFloat(pos.markPrice);
        const unrealizedPnl = parseFloat(pos.unRealizedProfit);
        const leverage = parseInt(pos.leverage);
        const liquidationPrice = parseFloat(pos.liquidationPrice);
        const marginType = pos.marginType === 'isolated' ? 'ISOLATED' : 'CROSS';

        const side: 'LONG' | 'SHORT' = amount > 0 ? 'LONG' : 'SHORT';
        const quantity = Math.abs(amount);
        const positionValue = quantity * entryPrice;
        const marginUsed = positionValue / leverage;
        const unrealizedPnlPct = (unrealizedPnl / marginUsed) * 100;

        console.log(`\n🔍 Fetching orders for ${symbol} (${side} position)...`);
        // const orders = await this.exchange.fetchOpenOrders(symbol);
        const orders = await this.exchange.fetchOpenOrders(
          symbol,
          undefined,
          undefined,
          {
            type: 'future', // or 'swap' depending on your contract
          }
        );

        console.log(
          `📋 Total orders found: ${JSON.stringify(orders, null, 2)}`
        );

        if (orders.length > 0) {
          orders.forEach((order, idx) => {});
        } else {
          console.log(`⚠️  No open orders found for ${symbol}`);
        }

        let stopLoss: number | undefined;
        let takeProfit: number | undefined;
        let stopLossOrderId: string | undefined;
        let takeProfitOrderId: string | undefined;

        for (const order of orders) {
          console.log(
            '🥑 ~ BinanceDataFetcher ~ fetchActivePositions ~ orders:',
            JSON.stringify(orders, null, 2)
          );
          const orderSide = order.side?.toUpperCase();
          const orderType = order.type?.toUpperCase();
          const orderPrice = (order.price || order.stopPrice) as number;

          console.log(`\n🔎 Analyzing order ${order.id}:`);
          console.log(`   Type: ${orderType}`);
          console.log(`   Side: ${orderSide}`);
          console.log(`   Price: ${order.price}`);
          console.log(`   Stop Price: ${order.stopPrice}`);

          // Check if this is a closing order
          const isClosingSide =
            (side === 'LONG' && orderSide === 'SELL') ||
            (side === 'SHORT' && orderSide === 'BUY');

          console.log(
            `   Is Closing Side: ${isClosingSide} (Position: ${side}, Order: ${orderSide})`
          );

          if (!isClosingSide) {
            console.log(`   ⏭️  SKIPPED - Not a closing order`);
            continue;
          }

          // 🔥 FIX: Check if it's a stop loss order
          const isStopLoss =
            orderType === 'STOP_MARKET' ||
            orderType === 'STOP' ||
            orderType === 'STOP_LOSS' ||
            orderType === 'STOP_LOSS_LIMIT' ||
            // 🔥 NEW: Check if LIMIT order is below entry (for LONG) or above entry (for SHORT)
            (orderType === 'LIMIT' &&
              ((side === 'LONG' && orderPrice < entryPrice) ||
                (side === 'SHORT' && orderPrice > entryPrice)));

          if (isStopLoss) {
            stopLoss = orderPrice;
            stopLossOrderId = order.id;
            console.log(`   ✅ STOP LOSS FOUND: ${stopLoss}`);
            continue; // Skip to next order
          }

          // 🔥 FIX: Check if it's a take profit order
          const isTakeProfit =
            orderType === 'TAKE_PROFIT_MARKET' ||
            orderType === 'TAKE_PROFIT' ||
            orderType === 'TAKE_PROFIT_LIMIT' ||
            // 🔥 NEW: Check if LIMIT order is above entry (for LONG) or below entry (for SHORT)
            (orderType === 'LIMIT' &&
              ((side === 'LONG' && orderPrice > entryPrice) ||
                (side === 'SHORT' && orderPrice < entryPrice)));

          if (isTakeProfit) {
            // 🔥 NEW: Support multiple TPs
            if (!takeProfit) {
              takeProfit = orderPrice;
              takeProfitOrderId = order.id;
              console.log(`   ✅ TAKE PROFIT 1 FOUND: ${takeProfit}`);
            } else {
              // This is TP2
              console.log(`   ✅ TAKE PROFIT 2 FOUND: ${orderPrice}`);
              // Store TP2 if you need it
            }
            continue;
          }

          console.log(`   ⚠️  Unknown order configuration`);
        }

        console.log(`\n📊 Final SL/TP for ${symbol}:`);
        console.log(`   Stop Loss: ${stopLoss} (ID: ${stopLossOrderId})`);
        console.log(`   Take Profit: ${takeProfit} (ID: ${takeProfitOrderId})`);

        activePositions.push({
          symbol,
          side,
          entryPrice,
          markPrice,
          quantity,
          leverage,
          unrealizedPnl,
          unrealizedPnlPct,
          marginUsed,
          liquidationPrice,
          positionValue,
          marginType,
          stopLoss,
          takeProfit,
          stopLossOrderId,
          takeProfitOrderId,
        });
      }

      return activePositions;
    } catch (error: any) {
      log(`❌ Failed to fetch positions: ${error.message}`, 'error');
      return [];
    }
  }

  /**
   * Fetch open orders (SL/TP orders)
   */
  async fetchOpenOrders(symbol?: string): Promise<any[]> {
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol);
      console.log(
        '🥑 ~ BinanceDataFetcher ~ fetchOpenOrders ~ orders:',
        orders
      );
      return orders;
    } catch (error: any) {
      log(`❌ Failed to fetch orders: ${error.message}`, 'error');
      return [];
    }
  }

  async fetchFromBinance_Recent(days: number = 90): Promise<void> {
    if (days > 90) {
      console.log('⚠️  Regular endpoints only support last 90 days');
      console.log('   Use fetchFromBinance_Async() for older data');
      days = 90;
    }

    try {
      const since = Date.now() - days * 24 * 60 * 60 * 1000;

      console.log(`📥 Fetching last ${days} days (Regular method)...\n`);

      const trades = await this.fetchAllSymbolTrades(since);

      console.log(`✅ Found ${trades.length} trades`);

      if (trades.length > 0) {
        this.processTradesIntoHistory(trades);
        console.log(
          `✅ Processed ${this.tradeHistory.length} completed trades`
        );
      }
    } catch (error: any) {
      console.error('❌ Failed to fetch recent history:', error.message);
      throw error;
    }
  }

  /**
   * ✅ NEW: Fetch trades for all symbols
   */
  private async fetchAllSymbolTrades(since: number): Promise<any[]> {
    try {
      console.log('📥 Fetching trades from all symbols...');

      // Get active positions to know which symbols to fetch
      const positions = await this.exchange.fetchPositions();
      const symbols = [...new Set(positions.map((p) => p.symbol))];

      // Add common symbols in case you closed positions
      const commonSymbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
      const allSymbols = [...new Set([...symbols, ...commonSymbols])];

      const allTrades: any[] = [];

      for (const symbol of allSymbols) {
        try {
          const trades = await this.exchange.fetchMyTrades(symbol, since);
          if (trades.length > 0) {
            allTrades.push(...trades);
            console.log(`   ✅ ${symbol}: ${trades.length} trades`);
          }
        } catch (error) {
          // Skip symbols with no trades
          console.log(`   ⏭️  ${symbol}: No trades`);
        }

        // Rate limit protection
        await this.sleep(100);
      }

      return allTrades;
    } catch (error: any) {
      console.error('❌ Failed to fetch trades:', error.message);
      return [];
    }
  }

  /**
   * ✅ NEW: Fallback method - fetch trades for known symbols
   */
  private async fetchTradesForKnownSymbols(since: number): Promise<any[]> {
    const allTrades: any[] = [];

    const positions = await this.exchange.fetchPositions();
    const symbols = positions.map((p) => p.symbol);

    const commonSymbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    const uniqueSymbols = [...new Set([...symbols, ...commonSymbols])];

    console.log(`📊 Fetching trades for ${uniqueSymbols.length} symbols...`);

    for (const symbol of uniqueSymbols) {
      try {
        const trades = await this.exchange.fetchMyTrades(symbol, since);
        allTrades.push(...trades);
        console.log(`   ✅ ${symbol}: ${trades.length} trades`);
      } catch (error: any) {
        console.log(`   ⏭️  ${symbol}: No trades`);
      }
    }

    return allTrades;
  }

  /**
   * Fetch trade history for ANY time range using Binance async endpoints
   * This creates a download link that you can retrieve
   */

  async fetchFromBinance_Async(
    startDate: Date,
    endDate: Date
  ): Promise<string> {
    try {
      console.log(`📥 Requesting async download...`);
      console.log(`   From: ${startDate.toISOString()}`);
      console.log(`   To: ${endDate.toISOString()}`);

      const downloadId = await this.requestAsyncDownloadFixed(
        startDate,
        endDate
      );

      console.log(`✅ Download requested: ${downloadId}`);
      console.log(`⏳ Waiting for file to be ready...`);

      const downloadUrl = await this.pollAsyncDownloadFixed(downloadId);

      console.log(`✅ Download ready!`);
      console.log(`📥 URL: ${downloadUrl}`);

      return downloadUrl;
    } catch (error: any) {
      console.error('❌ Async fetch failed:', error.message);
      throw error;
    }
  }

  /**
   * ✅ Request async download using raw API
   */
  private async requestAsyncDownloadFixed(
    startDate: Date,
    endDate: Date
  ): Promise<string> {
    try {
      const timestamp = Date.now();
      const params = {
        startTime: startDate.getTime(),
        endTime: endDate.getTime(),
        timestamp: timestamp,
      };

      const response = await (
        this.exchange as any
      ).fapiPrivatePostIncomeTradingDataLinkGenerateDownloadLink(params);

      if (!response || !response.downloadId) {
        throw new Error('No download ID in response');
      }

      return response.downloadId;
    } catch (error: any) {
      console.error('❌ Failed to request download:', error.message);

      try {
        const timestamp = Date.now();
        const params = {
          startTime: startDate.getTime(),
          endTime: endDate.getTime(),
          timestamp: timestamp,
        };

        const response = await (
          this.exchange as any
        ).privatePostFapiV1IncomeTradingDataLinkGenerateDownloadLink(params);

        return response.downloadId;
      } catch (altError: any) {
        console.error('❌ Alternative endpoint also failed:', altError.message);
        throw new Error(
          'Cannot request async download - endpoint not available'
        );
      }
    }
  }

  /**
   * ✅ Poll download status using raw API
   */
  private async pollAsyncDownloadFixed(
    downloadId: string,
    maxAttempts: number = 30
  ): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const timestamp = Date.now();
        const params = {
          downloadId: downloadId,
          timestamp: timestamp,
        };

        const response = await (
          this.exchange as any
        ).fapiPrivateGetIncomeTradingDataLinkQueryDownloadLink(params);

        const status = response.status;

        console.log(`   Attempt ${attempt}/${maxAttempts}: ${status}`);

        if (status === 'completed') {
          return response.link;
        } else if (status === 'failed') {
          throw new Error('Download generation failed');
        }

        await this.sleep(2000);
      } catch (error: any) {
        console.error(`   Error checking status: ${error.message}`);

        if (attempt === maxAttempts) {
          throw new Error('Download timeout - took too long');
        }

        await this.sleep(2000);
      }
    }

    throw new Error('Download timeout - max attempts reached');
  }

  /**
   * Request an async download (creates a download task)
   */

  /**
   * Poll the download status until ready
   */

  /**
   * Download and parse the CSV file from the async endpoint
   */
  async downloadAndParseCSV(downloadUrl: string): Promise<void> {
    try {
      console.log(`📥 Downloading CSV from URL...`);

      const response = await fetch(downloadUrl);
      const csvText = await response.text();

      console.log(`✅ Downloaded ${csvText.length} bytes`);

      const lines = csvText.split('\n');
      const headers = lines[0]?.split(',');

      console.log(`📊 CSV Headers: ${headers?.join(', ')}`);
      console.log(`📊 Total rows: ${lines.length - 1}`);

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim() as string;
        if (!line) continue;

        const values = line.split(',') as string[];
        if (
          !values[2] ||
          !values[3] ||
          !values[4] ||
          !values[5] ||
          !values[6]
        ) {
          throw new Error('Error');
        }

        const trade = {
          symbol: values[0],
          side: values[1],
          price: parseFloat(values[2]),
          quantity: parseFloat(values[3]),
          realizedPnl: parseFloat(values[4]),
          commission: parseFloat(values[5]),
          time: new Date(parseInt(values[6])),
        };

        console.log(
          `  ${trade.symbol} ${trade.side} ${trade.quantity} @ ${trade.price}`
        );
      }
    } catch (error: any) {
      console.error('❌ Failed to download/parse CSV:', error.message);
      throw error;
    }
  }

  getRecentTrades(count: number = 10): TradeRecord[] {
    if (!this.tradeHistory || this.tradeHistory.length === 0) {
      return [];
    }

    return [...this.tradeHistory]
      .sort((a, b) => b.time - a.time)
      .slice(0, count);
  }

  async fetchFromBinance(days: number = 30): Promise<void> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📥 FETCHING TRADE HISTORY (${days} days)`);
    console.log('='.repeat(60) + '\n');

    try {
      if (days <= 90) {
        console.log('✅ Using regular sync method (within 3 months)\n');
        await this.fetchFromBinance_Recent(days);
      } else {
        console.log('⚠️  Requested period > 90 days');
        console.log('✅ Using async download method\n');

        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const downloadUrl = await this.fetchFromBinance_Async(
          startDate,
          endDate
        );

        console.log('\n📥 Download URL:', downloadUrl);
        console.log('💡 You can download this file manually or:');
        console.log('   await fetcher.downloadAndParseCSV(url)');
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ FETCH COMPLETE`);
      console.log(`   Trades in memory: ${this.tradeHistory.length}`);
      console.log('='.repeat(60) + '\n');
    } catch (error: any) {
      console.error('❌ Fetch failed:', error.message);
      throw error;
    }
  }

  /**
   * ✅ NEW: Fetch trades for all symbols
   */

  /**
   * ✅ NEW: Fallback method - fetch trades for known symbols
   */

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  recordTrade(trade: TradeRecord): void {
    this.tradeHistory.push(trade);
    console.log(
      `📝 Trade recorded: ${trade.symbol} ${Number(trade.realizedPnl) >= 0 ? '✅' : '❌'} $${Number(trade.realizedPnl).toFixed(2)}`
    );
  }

  private processTradesIntoHistory(trades: any[]): void {
    const tradesBySymbol = new Map<string, any[]>();

    for (const trade of trades) {
      const symbol = trade.symbol;
      if (!tradesBySymbol.has(symbol)) {
        tradesBySymbol.set(symbol, []);
      }
      tradesBySymbol.get(symbol)!.push(trade);
    }

    for (const [symbol, symbolTrades] of tradesBySymbol) {
      symbolTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      let position: {
        side: EntryType;
        entryPrice: number;
        entryTime: Date;
        quantity: number;
        entryTrades: any[];
      } | null = null;

      for (const trade of symbolTrades) {
        const binanceSide = trade.side;
        const price = trade.price || 0;
        const amount = trade.amount || 0;
        const time = new Date(trade.timestamp || Date.now());

        if (!position) {
          position = {
            side: this.normalizePositionSide(binanceSide),
            entryPrice: price,
            entryTime: time,
            quantity: amount,
            entryTrades: [trade],
          };
        } else {
          const isClosing = this.isClosingTrade(position.side, binanceSide);

          if (isClosing) {
            const estimatedMargin = (amount * price) / 3;

            this.createTradeRecord(
              symbol,
              position.side,
              position.entryPrice,
              price,
              amount,
              3,
              estimatedMargin,
              position.entryTime,
              time,
              'CLOSED',
              'SIGNAL'
            );

            position = null;
          } else {
            if (this.isAddingToPosition(position.side, binanceSide)) {
              position.entryTrades.push(trade);
              const totalCost = position.entryTrades.reduce(
                (sum, t) => sum + (t.cost || 0),
                0
              );
              const totalAmount = position.entryTrades.reduce(
                (sum, t) => sum + (t.amount || 0),
                0
              );
              position.entryPrice = totalCost / totalAmount;
              position.quantity = totalAmount;
            } else {
              const estimatedMargin = (position.quantity * price) / 3;

              this.createTradeRecord(
                symbol,
                position.side,
                position.entryPrice,
                price,
                position.quantity,
                3,
                estimatedMargin,
                position.entryTime,
                time,
                'REVERSED',
                'SIGNAL'
              );

              position = {
                side: this.normalizePositionSide(binanceSide),
                entryPrice: price,
                entryTime: time,
                quantity: amount,
                entryTrades: [trade],
              };
            }
          }
        }
      }
    }
  }

  createTradeRecord(
    symbol: string,
    side: EntryType,
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    leverage: number,
    marginUsed: number,
    entryTime: Date,
    exitTime: Date,
    exitReason: string,
    entryReason: string = 'SIGNAL'
  ): any {
    let priceChange: number;
    if (side === 'LONG') {
      priceChange = exitPrice - entryPrice;
    } else {
      priceChange = entryPrice - exitPrice;
    }

    const realizedPnl = priceChange * quantity;
    const realizedPnlPct = (realizedPnl / marginUsed) * 100;

    const notional = quantity * entryPrice;
    const entryFee = notional * 0.0004;
    const exitFee = notional * 0.0004;
    const totalFees = entryFee + exitFee;

    const durationMs = exitTime.getTime() - entryTime.getTime();
    const durationMinutes = Math.floor(durationMs / 60000);

    const trade = {
      id: `${symbol}-${entryTime.getTime()}`,
      symbol,
      side,
      entryPrice,
      exitPrice,
      entryTime,
      exitTime,
      quantity,
      leverage,
      realizedPnl,
      realizedPnlPct,
      entryReason,
      exitReason,
      entryFee,
      exitFee,
      totalFees,
      marginUsed,
      durationMinutes,
    };

    return trade;
  }

  /**
   * Print statistics about the loaded trades
   */
  private printStats(): void {
    if (!this.tradeHistory || this.tradeHistory.length === 0) {
      console.log('\n📊 No trades to display');
      return;
    }

    const trades = this.tradeHistory as TradeRecord[];

    const symbols = [...new Set(trades.map((t) => t.symbol))];

    const totalPnL = trades.reduce(
      (sum, t) => sum + (parseFloat(t.realizedPnl) || 0),
      0
    );

    const totalCommission = trades.reduce(
      (sum, t) => sum + (parseFloat(t.commission) || 0),
      0
    );

    const firstTrade = trades[0];
    const lastTrade = trades[trades.length - 1];

    console.log('\n📊 Trade Statistics:');
    console.log(`   Total Trades: ${trades.length}`);
    console.log(`   Unique Symbols: ${symbols.length}`);
    console.log(`   Symbols: ${symbols.join(', ')}`);
    console.log(`   Total PnL: $${totalPnL.toFixed(2)}`);
    console.log(`   Total Commission: $${totalCommission.toFixed(2)}`);

    if (firstTrade && firstTrade.time) {
      console.log(`   First Trade: ${new Date(firstTrade.time).toISOString()}`);
    }

    if (lastTrade && lastTrade.time) {
      console.log(`   Last Trade: ${new Date(lastTrade.time).toISOString()}`);
    }
  }

  async testConnection(): Promise<void> {
    console.log('\n🔍 Testing Binance API Connection...\n');

    try {
      const balance = await this.exchange.fetchBalance();
      console.log(`✅ Balance fetched`);

      const positions = await this.exchange.fetchPositions();
      console.log(`✅ Found ${positions.length} open positions`);

      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const trades = await this.exchange.fetchMyTrades(undefined, since);
      console.log(`✅ Found ${trades.length} trades (last 7 days)`);

      console.log('\n✅ Connection test passed!\n');
    } catch (error: any) {
      console.error('\n ꧁ᬊᬁᴀɴɢᴇʟᬊ᭄꧂ Connection test failed:', error.message);
    }
  }

  getStats(days?: number): TradingStats {
    let trades = this.tradeHistory;

    // Filter by days if specified
    if (days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      trades = trades.filter((t) => t.time >= cutoff);
    }

    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        largestWin: 0,
        largestLoss: 0,
        avgTradeDuration: 0,
        totalFeesPaid: 0,
      };
    }

    // Calculate stats
    const totalPnl = trades.reduce(
      (sum, t) => sum + parseFloat(t.realizedPnl),
      0
    );
    const totalFees = trades.reduce(
      (sum, t) => sum + parseFloat(t.commission),
      0
    );

    const winners = trades.filter((t) => parseFloat(t.realizedPnl) > 0);
    const losers = trades.filter((t) => parseFloat(t.realizedPnl) < 0);

    const totalWinAmount = winners.reduce(
      (sum, t) => sum + parseFloat(t.realizedPnl),
      0
    );
    const totalLossAmount = Math.abs(
      losers.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0)
    );

    const avgWin = winners.length > 0 ? totalWinAmount / winners.length : 0;
    const avgLoss = losers.length > 0 ? totalLossAmount / losers.length : 0;

    const profitFactor =
      totalLossAmount > 0 ? totalWinAmount / totalLossAmount : 0;

    const largestWin =
      winners.length > 0
        ? Math.max(...winners.map((t) => parseFloat(t.realizedPnl)))
        : 0;

    const largestLoss =
      losers.length > 0
        ? Math.min(...losers.map((t) => parseFloat(t.realizedPnl)))
        : 0;

    const winRate = (winners.length / trades.length) * 100;

    return {
      totalTrades: trades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate,
      totalPnl,
      totalPnlPct: 0, // You'd need initial capital to calculate this
      avgWin,
      avgLoss,
      profitFactor,
      largestWin,
      largestLoss,
      avgTradeDuration: 0, // Add if you track trade duration
      totalFeesPaid: totalFees,
    };
  }

  printRecentTrades(count: number = 10): void {}

  getAllTrades(): TradeRecord[] {
    return [...this.tradeHistory];
  }

  clearHistory(): void {
    this.tradeHistory = [];
  }
}

if (
  !process.env.BINANCE_FUTURE_API_KEY ||
  !process.env.BINANCE_FUTURE_API_SECRET
) {
  throw Error('Missing BINANCE_FUTURE_API_KEY or BINANCE_FUTURE_API_SECRET');
}

const api = process.env.BINANCE_FUTURE_API_KEY;
const secret = process.env.BINANCE_FUTURE_API_SECRET;
