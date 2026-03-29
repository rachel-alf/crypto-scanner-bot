import ccxt from 'ccxt';

import type { BotInstance, Position } from '../../lib/type.js';
import { getRequiredEnvVar } from '../futures/launcher-future.js';
import { log } from './candles.js';

interface PositionUpdate {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  unrealizedProfit: number;
  marginType: 'isolated' | 'cross';
  isolatedWallet: number;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  liquidationPrice: number;
  markPrice: number;
  leverage: number;
}

interface BalanceUpdate {
  asset: string;
  walletBalance: number;
  crossWalletBalance: number;
  balanceChange: number;
}

interface OrderUpdate {
  symbol: string;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  orderStatus: string;
  orderId: string;
  price: number;
  avgPrice: number;
  origQty: number;
  executedQty: number;
  cumQty: number;
  timeInForce: string;
  reduceOnly: boolean;
  closePosition: boolean;
  stopPrice: number;
}

interface AccountUpdate {
  eventType: 'ACCOUNT_UPDATE';
  eventTime: number;
  balances: BalanceUpdate[];
  positions: PositionUpdate[];
}

interface OrderUpdateEvent {
  eventType: 'ORDER_TRADE_UPDATE';
  eventTime: number;
  order: OrderUpdate;
}

export class BinanceWebSocketManager {
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

  private bots: Map<string, BotInstance>;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  private positionUpdateCallbacks: Map<string, Function[]> = new Map();
  private orderUpdateCallbacks: Function[] = [];
  private balanceUpdateCallbacks: Function[] = [];
  private lastHeartbeat: number = Date.now();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private restApiSyncInterval: NodeJS.Timeout | null = null;
  private lastRestSync: Map<string, number> = new Map();

  constructor(bots: Map<string, BotInstance>) {
    this.bots = bots;
  }

  /**
   * ✅ Main initialization - starts all WebSocket streams
   */
  async initialize(): Promise<void> {
    try {
      log('🔌 Initializing Binance WebSocket Manager...', 'info');

      // Start position updates stream
      await this.startPositionStream();

      // Start order updates stream
      await this.startOrderStream();

      // Start balance updates stream
      await this.startBalanceStream();

      // Start heartbeat monitoring
      this.startHeartbeatMonitoring();

      // Start fallback REST API sync (every 30 seconds)
      this.startRestApiSync();

      this.isConnected = true;
      this.reconnectAttempts = 0;

      log('✅ WebSocket Manager initialized successfully', 'success');
    } catch (error: any) {
      log(`❌ Failed to initialize WebSocket: ${error.message}`, 'error');
      await this.handleReconnect();
    }
  }

  /**
   * ✅ Start watching positions via WebSocket
   */
  private async startPositionStream(): Promise<void> {
    try {
      log('📊 Starting position update stream...', 'info');

      // CCXT's watchPositions uses Binance's USER_DATA stream
      const watchLoop = async () => {
        while (this.isConnected) {
          try {
            const ccxtPositions = await this.exchange.watchPositions();
            const myPositions = ccxtPositions as unknown as Position[];
            this.handlePositionUpdates(myPositions);
            this.lastHeartbeat = Date.now();
          } catch (error: any) {
            if (error.message?.includes('closed')) {
              log('🔄 Position stream closed, reconnecting...', 'warning');
              await this.handleReconnect();
              break;
            }
            console.error('❌ Position stream error:', error.message);
            await this.sleep(1000);
          }
        }
      };

      watchLoop(); // Start async loop
      log('✅ Position stream started', 'success');
    } catch (error: any) {
      log(`❌ Failed to start position stream: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * ✅ Start watching orders via WebSocket
   */
  private async startOrderStream(): Promise<void> {
    try {
      log('📋 Starting order update stream...', 'info');

      const watchLoop = async () => {
        while (this.isConnected) {
          try {
            const orders = await this.exchange.watchOrders();
            this.handleOrderUpdates(orders);
            this.lastHeartbeat = Date.now();
          } catch (error: any) {
            if (error.message?.includes('closed')) {
              log('🔄 Order stream closed, reconnecting...', 'warning');
              await this.handleReconnect();
              break;
            }
            console.error('❌ Order stream error:', error.message);
            await this.sleep(1000);
          }
        }
      };

      watchLoop();
      log('✅ Order stream started', 'success');
    } catch (error: any) {
      log(`❌ Failed to start order stream: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * ✅ Start watching balance via WebSocket
   */
  private async startBalanceStream(): Promise<void> {
    try {
      log('💰 Starting balance update stream...', 'info');

      const watchLoop = async () => {
        while (this.isConnected) {
          try {
            const balance = await this.exchange.watchBalance();
            this.handleBalanceUpdate(balance);
            this.lastHeartbeat = Date.now();
          } catch (error: any) {
            if (error.message?.includes('closed')) {
              log('🔄 Balance stream closed, reconnecting...', 'warning');
              await this.handleReconnect();
              break;
            }
            console.error('❌ Balance stream error:', error.message);
            await this.sleep(1000);
          }
        }
      };

      watchLoop();
      log('✅ Balance stream started', 'success');
    } catch (error: any) {
      log(`❌ Failed to start balance stream: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * ✅ Handle position updates from WebSocket
   */
  private handlePositionUpdates(positions: Position[]): void {
    for (const position of positions) {
      const symbol = position.symbol;
      const bot = this.bots.get(symbol);

      if (!bot || !bot.position) continue;

      // ✅ Update position with real Binance data
      const unrealizedProfit = position.unrealizedPnl || 0;
      const liquidationPrice = position.liquidationPrice || 0;
      const markPrice = position.markPrice || position.entryPrice;
      const positionAmt = Math.abs(position.contracts || 0);

      // Update bot position
      bot.position.unrealizedPnl = unrealizedProfit;
      bot.position.liquidationPrice = liquidationPrice;
      bot.position.markPrice = markPrice;
      bot.position._lastWebSocketUpdate = Date.now();

      // Calculate PnL percentage
      if (Number(bot.position.marginUsed) > 0) {
        bot.position.unrealizedPnlPct =
          (unrealizedProfit / Number(bot.position.marginUsed)) * 100;
      }

      // ✅ Check for liquidation risk
      this.checkLiquidationRisk(bot, markPrice, liquidationPrice);

      // ✅ Trigger callbacks
      const callbacks = this.positionUpdateCallbacks.get(symbol) || [];
      for (const callback of callbacks) {
        try {
          callback(bot.position, position);
        } catch (error: any) {
          console.error(`❌ Position callback error: ${error.message}`);
        }
      }

      console.log(
        `🔄 ${symbol} WS Update: ` +
          `Mark: $${markPrice.toFixed(6)}, ` +
          `PnL: ${unrealizedProfit >= 0 ? '+' : ''}$${unrealizedProfit.toFixed(2)} ` +
          `(${bot.position.unrealizedPnlPct?.toFixed(2) || '0.00'}%)`
      );
    }
  }

  /**
   * ✅ Handle order updates from WebSocket
   */
  private handleOrderUpdates(orders: any[]): void {
    for (const order of orders) {
      const symbol = order.symbol;
      const bot = this.bots.get(symbol);

      console.log(
        `📋 ${symbol} Order Update: ` +
          `${order.side} ${order.type} - ` +
          `Status: ${order.status}, ` +
          `Filled: ${order.filled}/${order.amount}`
      );

      // ✅ Handle filled stop loss
      if (
        order.status === 'closed' &&
        order.type?.includes('STOP') &&
        bot?.position
      ) {
        log(`🛑 ${symbol} STOP LOSS HIT via WebSocket!`, 'warning');

        // Trigger your exit logic
        if (bot.position.stopLossOrderId === order.id) {
          // Your exitPosition method will be called
          log(`✅ Position will be closed by main bot logic`, 'info');
        }
      }

      // ✅ Handle filled take profit
      if (
        order.status === 'closed' &&
        order.type?.includes('TAKE_PROFIT') &&
        bot?.position
      ) {
        log(`🎯 ${symbol} TAKE PROFIT HIT via WebSocket!`, 'success');

        if (bot.position.takeProfitOrderId === order.id) {
          log(`✅ Position will be closed by main bot logic`, 'info');
        }
      }

      // ✅ Trigger callbacks
      for (const callback of this.orderUpdateCallbacks) {
        try {
          callback(order, bot);
        } catch (error: any) {
          console.error(`❌ Order callback error: ${error.message}`);
        }
      }
    }
  }

  /**
   * ✅ Handle balance updates from WebSocket
   */
  private handleBalanceUpdate(balance: any): void {
    const usdtBalance = balance.USDT || {};
    const free = usdtBalance.free || 0;
    const used = usdtBalance.used || 0;
    const total = usdtBalance.total || 0;

    console.log(
      `💰 Balance Update: ` +
        `Free: $${free.toFixed(2)}, ` +
        `Used: $${used.toFixed(2)}, ` +
        `Total: $${total.toFixed(2)}`
    );

    // ✅ Trigger callbacks
    for (const callback of this.balanceUpdateCallbacks) {
      try {
        callback(balance);
      } catch (error: any) {
        console.error(`❌ Balance callback error: ${error.message}`);
      }
    }
  }

  /**
   * ✅ Check liquidation risk
   */
  private checkLiquidationRisk(
    bot: BotInstance,
    markPrice: number,
    liquidationPrice: number
  ): void {
    if (!bot.position || liquidationPrice === 0) return;

    const side = bot.position.side;
    let distanceToLiquidation: number;

    if (side === 'LONG') {
      distanceToLiquidation =
        ((markPrice - liquidationPrice) / markPrice) * 100;
    } else {
      distanceToLiquidation =
        ((liquidationPrice - markPrice) / markPrice) * 100;
    }

    // ⚠️ Warning at 20% distance to liquidation
    if (distanceToLiquidation < 20 && distanceToLiquidation > 10) {
      log(
        `⚠️  ${bot.symbol} LIQUIDATION WARNING: ${distanceToLiquidation.toFixed(1)}% away!`,
        'warning'
      );
    }

    // 🚨 Critical at 10% distance to liquidation
    if (distanceToLiquidation < 10 && distanceToLiquidation > 0) {
      log(
        `🚨 ${bot.symbol} LIQUIDATION CRITICAL: ${distanceToLiquidation.toFixed(1)}% away!`,
        'error'
      );
      log(`   Mark Price: $${markPrice.toFixed(6)}`, 'error');
      log(`   Liquidation: $${liquidationPrice.toFixed(6)}`, 'error');
    }
  }

  /**
   * ✅ Fallback REST API sync (runs every 30 seconds)
   */
  private startRestApiSync(): void {
    this.restApiSyncInterval = setInterval(async () => {
      for (const [symbol, bot] of this.bots.entries()) {
        if (!bot.position) continue;

        const lastSync = this.lastRestSync.get(symbol) || 0;
        const now = Date.now();

        // Only sync if WebSocket hasn't updated in 30 seconds
        const lastWsUpdate = bot.position._lastWebSocketUpdate || 0;
        const wsStale = now - lastWsUpdate > 30000;

        if (wsStale && now - lastSync > 30000) {
          try {
            await this.syncPositionFromREST(bot);
            this.lastRestSync.set(symbol, now);
          } catch (error: any) {
            console.error(
              `❌ Failed to sync ${symbol} via REST: ${error.message}`
            );
          }
        }
      }
    }, 30000); // Every 30 seconds

    log('✅ REST API fallback sync started (30s interval)', 'info');
  }

  /**
   * ✅ Sync position from REST API (fallback)
   */
  private async syncPositionFromREST(bot: BotInstance): Promise<void> {
    try {
      const positions = await this.exchange.fetchPositions([bot.symbol]);
      // Cast to CCXT's position type to avoid confusion
      const ccxtPosition = positions.find((p: any) => p.symbol === bot.symbol);

      if (ccxtPosition && bot.position) {
        const ccxtPos = ccxtPosition as any;
        bot.position.unrealizedPnl = ccxtPos.unrealizedPnl || 0;
        bot.position.liquidationPrice = ccxtPos.liquidationPrice || 0;
        bot.position.markPrice = ccxtPos.markPrice || bot.position.currentPrice;
        (bot.position as any)._lastRestSync = Date.now();

        console.log(
          `🔄 ${bot.symbol} REST Sync: PnL $${(bot.position.unrealizedPnl as number).toFixed(2)}`
        );
      }
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * ✅ Heartbeat monitoring (detect dead connections)
   */
  private startHeartbeatMonitoring(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastUpdate = now - this.lastHeartbeat;

      // If no updates for 60 seconds, reconnect
      if (timeSinceLastUpdate > 60000) {
        log(
          '💔 WebSocket appears dead (no updates for 60s), reconnecting...',
          'warning'
        );
        this.handleReconnect();
      }
    }, 10000); // Check every 10 seconds

    log('✅ Heartbeat monitoring started', 'info');
  }

  /**
   * ✅ Handle reconnection with exponential backoff
   */
  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log(
        '❌ Max reconnection attempts reached. Manual intervention required.',
        'error'
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    log(
      `🔄 Reconnecting WebSocket (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
      'warning'
    );
    log(`   Waiting ${delay / 1000}s before retry...`, 'info');

    await this.sleep(delay);

    try {
      // Close existing connections
      await this.close();

      // Reinitialize
      await this.initialize();

      log('✅ WebSocket reconnected successfully', 'success');
    } catch (error: any) {
      log(`❌ Reconnection failed: ${error.message}`, 'error');
      await this.handleReconnect();
    }
  }

  /**
   * ✅ Register callback for position updates
   */
  onPositionUpdate(
    symbol: string,
    callback: (position: any, rawData: any) => void
  ): void {
    if (!this.positionUpdateCallbacks.has(symbol)) {
      this.positionUpdateCallbacks.set(symbol, []);
    }
    this.positionUpdateCallbacks.get(symbol)!.push(callback);
  }

  /**
   * ✅ Register callback for order updates
   */
  onOrderUpdate(callback: (order: any, bot?: BotInstance) => void): void {
    this.orderUpdateCallbacks.push(callback);
  }

  /**
   * ✅ Register callback for balance updates
   */
  onBalanceUpdate(callback: (balance: any) => void): void {
    this.balanceUpdateCallbacks.push(callback);
  }

  /**
   * ✅ Get connection status
   */
  getStatus(): {
    connected: boolean;
    reconnectAttempts: number;
    lastHeartbeat: Date;
    uptime: number;
  } {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      lastHeartbeat: new Date(this.lastHeartbeat),
      uptime: Date.now() - this.lastHeartbeat,
    };
  }

  /**
   * ✅ Graceful shutdown
   */
  async close(): Promise<void> {
    log('🔌 Closing WebSocket connections...', 'info');

    this.isConnected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.restApiSyncInterval) {
      clearInterval(this.restApiSyncInterval);
      this.restApiSyncInterval = null;
    }

    try {
      await this.exchange.close();
      log('✅ WebSocket connections closed', 'success');
    } catch (error: any) {
      log(`⚠️  Error closing WebSocket: ${error.message}`, 'warning');
    }
  }

  /**
   * ✅ Helper: Sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ================================================================
// USAGE EXAMPLE
// ================================================================

/*
// In your main bot file:

import { BinanceWebSocketManager } from './websocket-manager.js';

class FuturesTradingBot {
  private wsManager: BinanceWebSocketManager;

  async initialize() {
    // ... your existing initialization

    // Initialize WebSocket Manager
    this.wsManager = new BinanceWebSocketManager(this.binance, this.bots);
    await this.wsManager.initialize();

    // Register callbacks
    this.wsManager.onPositionUpdate('BTCUSDT', (position, rawData) => {
      console.log('Position updated:', position);
      // Your custom logic here
    });

    this.wsManager.onOrderUpdate((order, bot) => {
      console.log('Order updated:', order);
      // Your custom logic here
    });

    this.wsManager.onBalanceUpdate((balance) => {
      console.log('Balance updated:', balance);
      // Your custom logic here
    });
  }

  async shutdown() {
    await this.wsManager.close();
  }
}
*/
