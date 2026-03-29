// // ============================================================================
// // ORDER MONITORING SYSTEM - Add to your FuturesTradingBot class
// // ============================================================================

import type { EntryType } from '../../lib/type.js';
import { SymbolValidator } from './symbol-validator.js';

// import type { BotInstance } from '@lib/type.js';
// import { CONFIG } from '@src/futures/future-config.js';
// import { getRequiredEnvVar } from '@src/futures/launcher-future.js';
// import ccxt, { Exchange, type Order } from 'ccxt';

// interface OrderMonitorConfig {
//   pollInterval: number; // ms between checks
//   maxRetries: number;
//   useWebSocket: boolean;
// }

// class OrderMonitor {
//   private exchange: Exchange;
//   private config: OrderMonitorConfig;
//   private isRunning: boolean = false;
//   private pollingInterval?: NodeJS.Timeout;
//   private wsConnection?: any;

//   constructor(exchange: Exchange, config?: Partial<OrderMonitorConfig>) {
//     this.exchange = exchange;
//     this.config = {
//       pollInterval: 5000, // 5 seconds
//       maxRetries: 3,
//       useWebSocket: true,
//       ...config,
//     };
//   }

//   // ============================================================================
//   // Method 1: WebSocket Monitoring (RECOMMENDED - Real-time)
//   // ============================================================================

//   async startWebSocketMonitoring(
//     onOrderFilled: (order: Order) => void,
//     onError: (error: Error) => void
//   ) {
//     if (!this.exchange.has['watchOrders']) {
//       console.warn(
//         '⚠️ Exchange does not support websocket orders, falling back to polling'
//       );
//       this.startPollingMonitoring(onOrderFilled, onError);
//       return;
//     }

//     this.isRunning = true;
//     console.log('🔌 Starting WebSocket order monitoring...');

//     try {
//       while (this.isRunning) {
//         try {
//           const orders = await this.exchange.watchOrders();

//           for (const order of orders) {
//             // Only process closed/filled orders
//             if (order.status === 'closed' || order.status === 'filled') {
//               console.log(
//                 `📨 Order filled: ${order.id} - ${order.symbol} - ${order.type}`
//               );
//               onOrderFilled(order);
//             }
//           }
//         } catch (error: any) {
//           if (this.isRunning) {
//             console.error('WebSocket error:', error.message);
//             onError(error);

//             // Wait before reconnecting
//             await this.sleep(5000);
//           }
//         }
//       }
//     } catch (error: any) {
//       console.error('Fatal WebSocket error:', error.message);
//       onError(error);
//     }
//   }

//   // ============================================================================
//   // Method 2: Polling Monitoring (BACKUP - Reliable but slower)
//   // ============================================================================

//   async startPollingMonitoring(
//     onOrderFilled: (order: Order) => void,
//     onError: (error: Error) => void
//   ) {
//     this.isRunning = true;
//     console.log(
//       `🔄 Starting polling order monitoring (every ${this.config.pollInterval}ms)...`
//     );

//     this.pollingInterval = setInterval(async () => {
//       try {
//         // Get all open orders
//         const openOrders = await this.exchange.fetchOpenOrders();

//         // Store current open order IDs
//         const openOrderIds = new Set(openOrders.map((o) => o.id));

//         // This will be called for each bot to check its orders
//         // (You'll need to pass tracked orders to this method)
//       } catch (error: any) {
//         console.error('Polling error:', error.message);
//         onError(error);
//       }
//     }, this.config.pollInterval);
//   }

//   // ============================================================================
//   // Check specific order status
//   // ============================================================================

//   async checkOrderStatus(
//     symbol: string,
//     orderId: string
//   ): Promise<Order | null> {
//     try {
//       const order = await this.exchange.fetchOrder(orderId, symbol);
//       return order;
//     } catch (error: any) {
//       console.error(`Error fetching order ${orderId}:`, error.message);
//       return null;
//     }
//   }

//   // ============================================================================
//   // Stop monitoring
//   // ============================================================================

//   stop() {
//     this.isRunning = false;
//     if (this.pollingInterval) {
//       clearInterval(this.pollingInterval);
//     }
//     console.log('⏹️ Order monitoring stopped');
//   }

//   private sleep(ms: number): Promise<void> {
//     return new Promise((resolve) => setTimeout(resolve, ms));
//   }
// }

// // ============================================================================
// // INTEGRATION INTO YOUR FuturesTradingBot CLASS
// // ============================================================================

// export class FuturesTradingBot {
//   private orderMonitor?: OrderMonitor;
//   private bots: Map<string, BotInstance> = new Map();
//   private trackedOrders: Map<
//     string,
//     {
//       // orderId -> bot symbol
//       symbol: string;
//       orderType: 'STOP_LOSS' | 'TAKE_PROFIT' | 'ENTRY';
//     }
//   > = new Map();

//   // ✅ ADD: Binance Futures Client
//   private binance = new ccxt.binance({
//     apiKey: getRequiredEnvVar('BINANCE_FUTURE_API_KEY'),
//     secret: getRequiredEnvVar('BINANCE_FUTURE_API_SECRET'),
//     enableRateLimit: true,
//     timeout: 60000,
//     options: {
//       defaultType: 'future',
//       adjustForTimeDifference: true,
//     },
//   });

//   // ============================================================================
//   // Initialize monitoring (call in constructor or start method)
//   // ============================================================================

//   private async initializeOrderMonitoring() {
//     if (CONFIG.paperTrading) {
//       console.log('📄 Paper trading mode - order monitoring disabled');
//       return;
//     }

//     this.orderMonitor = new OrderMonitor(this.binance, {
//       pollInterval: 5000,
//       useWebSocket: true,
//     });

//     // Start monitoring
//     this.orderMonitor.startWebSocketMonitoring(
//       (order) => this.handleOrderFilled(order),
//       (error) => this.handleMonitoringError(error)
//     );

//     console.log('✅ Order monitoring initialized');
//   }

//   // ============================================================================
//   // Handle order filled event
//   // ============================================================================

//   private async handleOrderFilled(order: Order) {
//     const trackedOrder = this.trackedOrders.get(order.id);

//     if (!trackedOrder) {
//       // Not one of our tracked orders
//       return;
//     }

//     const bot = this.bots.get(trackedOrder.symbol);

//     if (!bot || !bot.position) {
//       console.warn(
//         `⚠️ Order filled but bot/position not found: ${trackedOrder.symbol}`
//       );
//       this.trackedOrders.delete(order.id);
//       return;
//     }

//     console.log(`\n🎯 Order Filled Event:`);
//     console.log(`   Symbol: ${order.symbol}`);
//     console.log(`   Type: ${trackedOrder.orderType}`);
//     console.log(`   Order ID: ${order.id}`);
//     console.log(`   Price: $${order.price}`);
//     console.log(`   Amount: ${order.filled}`);

//     // Handle different order types
//     switch (trackedOrder.orderType) {
//       case 'STOP_LOSS':
//         console.log(`🛑 Stop Loss triggered by exchange for ${bot.symbol}`);

//         // Cancel remaining orders
//         await this.cancelRemainingOrders(bot);

//         // Update position with actual exit price
//         if (bot.position) {
//           bot.position.currentPrice = order.price || bot.position.stopLoss;
//         }

//         // Process exit
//         this.exitPosition(bot, 'STOP_LOSS');
//         break;

//       case 'TAKE_PROFIT':
//         console.log(`🎯 Take Profit triggered by exchange for ${bot.symbol}`);

//         // Cancel remaining orders
//         await this.cancelRemainingOrders(bot);

//         // Update position with actual exit price
//         if (bot.position) {
//           bot.position.currentPrice = order.price || bot.position.takeProfit;
//         }

//         // Process exit
//         this.exitPosition(bot, 'TAKE_PROFIT');
//         break;

//       case 'ENTRY':
//         console.log(`✅ Entry order filled for ${bot.symbol}`);
//         // Entry already handled in enterPosition
//         break;
//     }

//     // Remove from tracking
//     this.trackedOrders.delete(order.id);
//   }

//   // ============================================================================
//   // Handle monitoring errors
//   // ============================================================================

//   private handleMonitoringError(error: Error) {
//     console.error('❌ Order monitoring error:', error.message);

//     // Log but don't crash - polling will continue
//     // Implement alerting here if needed
//   }

//   // ============================================================================
//   // Cancel remaining orders for a position
//   // ============================================================================

//   private async cancelRemainingOrders(bot: BotInstance): Promise<void> {
//     if (!bot.position) return;

//     const ordersToCancel = [
//       bot.position.stopLossOrderId,
//       bot.position.takeProfitOrderId,
//     ].filter(Boolean);

//     for (const orderId of ordersToCancel) {
//       try {
//         await this.binance.cancelOrder(orderId as string, bot.symbol);
//         console.log(`🗑️ Cancelled order: ${orderId}`);

//         // Remove from tracking
//         this.trackedOrders.delete(orderId as string);
//       } catch (error: any) {
//         // Order might already be filled or cancelled
//         if (!error.message.includes('Order does not exist')) {
//           console.error(`Error cancelling order ${orderId}:`, error.message);
//         }
//       }
//     }
//   }

//   // ============================================================================
//   // UPDATE: Modified enterPosition to track orders
//   // ============================================================================

//   private async enterPosition(
//     bot: BotInstance,
//     side: EntryType,
//     price: number,
//     strategy: StrategyId,
//     stopLoss: number,
//     takeProfit: number
//   ): Promise<boolean> {
//     // ... existing validation code ...

//     if (!CONFIG.paperTrading) {
//       try {
//         // ... existing order placement code ...

//         // ✅ TRACK THE ORDERS
//         if (stopLossOrderId) {
//           this.trackedOrders.set(stopLossOrderId, {
//             symbol: bot.symbol,
//             orderType: 'STOP_LOSS',
//           });
//           console.log(`📍 Tracking SL order: ${stopLossOrderId}`);
//         }

//         if (takeProfitOrderId) {
//           this.trackedOrders.set(takeProfitOrderId, {
//             symbol: bot.symbol,
//             orderType: 'TAKE_PROFIT',
//           });
//           console.log(`📍 Tracking TP order: ${takeProfitOrderId}`);
//         }
//       } catch (error: any) {
//         console.error(`❌ Real trade failed: ${error.message}`);
//         releaseCapital(marginRequired, bot.pnl);
//         return false;
//       }
//     }

//     // ... rest of existing code ...

//     return true;
//   }

//   // ============================================================================
//   // UPDATE: Modified updatePosition with software backup
//   // ============================================================================

//   private async updatePosition(bot: BotInstance, currentPrice: number) {
//     if (!bot.position) return;

//     const pos = bot.position;
//     pos.currentPrice = currentPrice;

//     // ... existing Moray logic ...

//     // ============================================================================
//     // 🛡️ SOFTWARE BACKUP MONITORING (for safety)
//     // ============================================================================

//     if (!CONFIG.paperTrading) {
//       // Check if position should have been closed by exchange
//       // This is a backup in case websocket/polling misses something

//       const slTriggered =
//         (pos.side === 'LONG' && currentPrice <= pos.stopLoss * 0.998) ||
//         (pos.side === 'SHORT' && currentPrice >= pos.stopLoss * 1.002);

//       const tpTriggered =
//         (pos.side === 'LONG' && currentPrice >= pos.takeProfit * 1.002) ||
//         (pos.side === 'SHORT' && currentPrice <= pos.takeProfit * 0.998);

//       if (slTriggered || tpTriggered) {
//         const reason = slTriggered ? 'STOP_LOSS' : 'TAKE_PROFIT';
//         console.warn(`⚠️ ${bot.symbol} ${reason} backup trigger activated!`);
//         console.warn(
//           `   Current: ${currentPrice}, SL: ${pos.stopLoss}, TP: ${pos.takeProfit}`
//         );

//         // Verify order status
//         const stillOpen = await this.verifyOrdersStillOpen(bot);

//         if (!stillOpen) {
//           console.log(`✅ Orders already filled - waiting for event`);
//           return;
//         }

//         // Force close if orders are still open but price breached
//         console.error(`🚨 EMERGENCY: Force closing ${bot.symbol}`);
//         await this.forceClosePosition(bot);
//         this.exitPosition(bot, reason);
//         return;
//       }
//     }

//     // ... rest of existing position update logic ...
//   }

//   // ============================================================================
//   // Verify if stop/tp orders are still open
//   // ============================================================================

//   private async verifyOrdersStillOpen(bot: BotInstance): Promise<boolean> {
//     if (!bot.position) return false;

//     try {
//       const openOrders = await this.binance.fetchOpenOrders(bot.symbol);
//       const openOrderIds = openOrders.map((o) => o.id);

//       const slOpen =
//         bot.position.stopLossOrderId &&
//         openOrderIds.includes(bot.position.stopLossOrderId);
//       const tpOpen =
//         bot.position.takeProfitOrderId &&
//         openOrderIds.includes(bot.position.takeProfitOrderId);

//       return slOpen || tpOpen;
//     } catch (error) {
//       console.error('Error verifying orders:', error);
//       return true; // Assume open on error
//     }
//   }

//   // ============================================================================
//   // Force close position (emergency)
//   // ============================================================================

//   private async forceClosePosition(bot: BotInstance): Promise<void> {
//     if (!bot.position) return;

//     try {
//       console.log(`🚨 Force closing position: ${bot.symbol}`);

//       // Cancel all orders first
//       await this.cancelRemainingOrders(bot);

//       // Close position with market order
//       const side = bot.position.side === 'LONG' ? 'SELL' : 'BUY';
//       const closeOrder = await this.binance.createMarketOrder(
//         bot.symbol,
//         side,
//         bot.position.remainingAmount
//       );

//       console.log(
//         `✅ Force close executed: ${closeOrder.id} @ ${closeOrder.average}`
//       );

//       // Update position price
//       bot.position.currentPrice = closeOrder.average || closeOrder.price;
//     } catch (error: any) {
//       console.error(`❌ Force close failed: ${error.message}`);
//       throw error;
//     }
//   }

//   // ============================================================================
//   // Cleanup on shutdown
//   // ============================================================================

//   private async shutdown() {
//     console.log('\n🛑 Shutting down trading bot...');

//     // Stop order monitoring
//     if (this.orderMonitor) {
//       this.orderMonitor.stop();
//     }

//     // Close all positions
//     for (const [symbol, bot] of this.bots) {
//       if (bot.position) {
//         console.log(`Closing position: ${symbol}`);
//         await this.forceClosePosition(bot);
//         this.exitPosition(bot, 'SHUTDOWN');
//       }
//     }

//     console.log('✅ Shutdown complete');
//   }
// }

// // ============================================================================
// // USAGE EXAMPLE
// // ============================================================================

// /*
// In your main bot initialization:

// async start() {
//   // ... existing initialization ...

//   // Initialize order monitoring
//   await this.initializeOrderMonitoring();

//   // ... rest of your start logic ...
// }

// // Handle graceful shutdown
// process.on('SIGINT', async () => {
//   await this.shutdown();
//   process.exit(0);
// });

// process.on('SIGTERM', async () => {
//   await this.shutdown();
//   process.exit(0);
// });
// */

// ============================================
// LIMIT ORDER HELPER METHODS
// ============================================

export class LimitOrderHelpers {
  /**
   * Calculate optimal limit price for entry
   * Strategies:
   * - AGGRESSIVE: Join best bid/ask (high fill rate, no discount)
   * - MODERATE: Place inside spread (balanced)
   * - PASSIVE: Place beyond best price (lower fill rate, better price)
   */
  static calculateLimitPrice(
    side: EntryType,
    orderBook: any,
    currentPrice: number,
    strategy: 'AGGRESSIVE' | 'MODERATE' | 'PASSIVE' = 'MODERATE'
  ): number {
    const bestBid = orderBook.bids[0]?.[0] || currentPrice;
    const bestAsk = orderBook.asks[0]?.[0] || currentPrice;
    const spread = bestAsk - bestBid;

    if (side === 'LONG') {
      // Buying - want lower price
      switch (strategy) {
        case 'AGGRESSIVE':
          return bestAsk; // Join ask, fills immediately
        case 'MODERATE':
          return bestBid + spread * 0.5; // Middle of spread
        case 'PASSIVE':
          return bestBid; // Join bid, wait for seller
        default:
          return bestBid + spread * 0.5;
      }
    } else {
      // Selling - want higher price
      switch (strategy) {
        case 'AGGRESSIVE':
          return bestBid; // Join bid, fills immediately
        case 'MODERATE':
          return bestAsk - spread * 0.5; // Middle of spread
        case 'PASSIVE':
          return bestAsk; // Join ask, wait for buyer
        default:
          return bestAsk - spread * 0.5;
      }
    }
  }

  /**
   * Wait for limit order to fill
   * Returns filled order or throws timeout error
   */
  static async waitForOrderFill(
    exchange: any,
    symbol: string,
    orderId: string,
    timeoutMs: number = 30000,
    pollIntervalMs: number = 1000
  ): Promise<any> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const order = await exchange.fetchOrder(orderId, symbol);

      if (order.status === 'closed' || order.status === 'filled') {
        console.log(
          `✅ Order ${orderId} filled at $${order.average?.toFixed(6)}`
        );
        return order;
      }

      if (order.status === 'canceled' || order.status === 'expired') {
        throw new Error(`Order ${orderId} was ${order.status}`);
      }

      console.log(
        `⏳ Waiting for fill... ${order.filled}/${order.amount} (${((order.filled / order.amount) * 100).toFixed(1)}%)`
      );

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout - cancel order
    console.warn(`⚠️ Order ${orderId} timed out after ${timeoutMs}ms`);
    try {
      await exchange.cancelOrder(orderId, symbol);
      console.log(`🗑️ Canceled unfilled order ${orderId}`);
    } catch (e: any) {
      console.error(`❌ Failed to cancel order: ${e.message}`);
    }

    throw new Error(`Order ${orderId} timed out and was canceled`);
  }

  /**
   * Place limit order with automatic fallback to market if timeout
   */
  static async placeEntryOrderWithFallback(
    exchange: any,
    symbol: string,
    side: EntryType,
    quantity: number,
    orderBook: any,
    currentPrice: number,
    strategy: 'AGGRESSIVE' | 'MODERATE' | 'PASSIVE' = 'MODERATE',
    timeoutMs: number = 30000
  ): Promise<{
    price: number;
    quantity: number;
    orderId: string;
    method: 'LIMIT' | 'MARKET';
  }> {
    const orderSide = side === 'LONG' ? 'BUY' : 'SELL';

    // Try limit order first
    try {
      const limitPrice = this.calculateLimitPrice(
        side,
        orderBook,
        currentPrice,
        strategy
      );
      const roundedPrice = SymbolValidator.roundPrice(symbol, limitPrice);

      console.log(
        `🎯 Placing LIMIT ${orderSide} @ $${roundedPrice.toFixed(6)}`
      );

      const limitOrder = await exchange.createLimitOrder(
        symbol,
        orderSide,
        quantity,
        roundedPrice,
        { timeInForce: 'GTC' }
      );

      console.log(`📋 Limit Order ID: ${limitOrder.id}`);

      // Wait for fill
      const filledOrder = await this.waitForOrderFill(
        exchange,
        symbol,
        limitOrder.id as string,
        timeoutMs
      );

      return {
        price: filledOrder.average || filledOrder.price,
        quantity: filledOrder.filled,
        orderId: filledOrder.id,
        method: 'LIMIT',
      };
    } catch (error: any) {
      console.warn(`⚠️ Limit order failed: ${error.message}`);
      console.log(`🔄 Falling back to MARKET order...`);

      // Fallback to market order
      const marketOrder = await exchange.createMarketOrder(
        symbol,
        orderSide,
        quantity
      );

      return {
        price: marketOrder.average || marketOrder.price,
        quantity: marketOrder.filled,
        orderId: marketOrder.id,
        method: 'MARKET',
      };
    }
  }
}
