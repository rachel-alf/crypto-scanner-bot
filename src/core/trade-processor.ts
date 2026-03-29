// Type definitions for clarity
export type BinanceSide = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT';

export interface BinanceTrade {
  symbol: string;
  side: BinanceSide;
  price: number;
  amount: number;
  timestamp: number;
  cost?: number;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  quantity: number;
  leverage: number;
  realizedPnl: number;
  realizedPnlPct: number;
  entryReason: string;
  exitReason: string;
  entryFee: number;
  exitFee: number;
  totalFees: number;
  marginUsed: number;
  durationMinutes: number;
}

class TradeProcessor {
  /**
   * Convert Binance side (BUY/SELL) to position side (LONG/SHORT)
   */
  private normalizePositionSide(binanceSide: BinanceSide): PositionSide {
    return binanceSide === 'BUY' ? 'LONG' : 'SHORT';
  }

  /**
   * Check if a trade is closing an existing position
   */
  private isClosingTrade(
    positionSide: PositionSide,
    tradeSide: BinanceSide
  ): boolean {
    return (
      (positionSide === 'LONG' && tradeSide === 'SELL') ||
      (positionSide === 'SHORT' && tradeSide === 'BUY')
    );
  }

  /**
   * Check if a trade is adding to an existing position
   */
  private isAddingToPosition(
    positionSide: PositionSide,
    tradeSide: BinanceSide
  ): boolean {
    return (
      (positionSide === 'LONG' && tradeSide === 'BUY') ||
      (positionSide === 'SHORT' && tradeSide === 'SELL')
    );
  }

  createTradeRecord(
    symbol: string,
    side: PositionSide,
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    leverage: number,
    marginUsed: number,
    entryTime: Date,
    exitTime: Date,
    exitReason: string,
    entryReason: string = 'SIGNAL'
  ): TradeRecord {
    // Calculate P&L based on position side
    let priceChange: number;
    if (side === 'LONG') {
      priceChange = exitPrice - entryPrice;
    } else {
      priceChange = entryPrice - exitPrice;
    }

    const realizedPnl = priceChange * quantity;
    const realizedPnlPct = (realizedPnl / marginUsed) * 100;

    const notional = quantity * entryPrice;
    const entryFee = notional * 0.0004; // 0.04% taker fee
    const exitFee = notional * 0.0004;
    const totalFees = entryFee + exitFee;

    // Safe duration calculation
    const durationMs = exitTime.getTime() - entryTime.getTime();
    const durationMinutes = Math.floor(durationMs / 60000);

    const trade: TradeRecord = {
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

    this.recordTrade(trade);
    return trade;
  }

  private processTradesIntoHistory(trades: BinanceTrade[]): void {
    // Group trades by symbol
    const tradesBySymbol = new Map<string, BinanceTrade[]>();

    for (const trade of trades) {
      const symbol = trade.symbol;
      if (!tradesBySymbol.has(symbol)) {
        tradesBySymbol.set(symbol, []);
      }
      tradesBySymbol.get(symbol)!.push(trade);
    }

    // Process each symbol's trades
    for (const [symbol, symbolTrades] of tradesBySymbol) {
      // Sort by timestamp
      symbolTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      let position: {
        side: PositionSide;
        entryPrice: number;
        entryTime: Date;
        quantity: number;
        entryTrades: BinanceTrade[];
      } | null = null;

      for (const trade of symbolTrades) {
        const binanceSide = trade.side; // "BUY" or "SELL"
        const price = trade.price || 0;
        const amount = trade.amount || 0;
        const time = new Date(trade.timestamp || Date.now());

        // Validate data
        if (!price || !amount) {
          console.warn(`⚠️ Invalid trade data for ${symbol}:`, trade);
          continue;
        }

        // No open position - this is an entry
        if (!position) {
          position = {
            side: this.normalizePositionSide(binanceSide),
            entryPrice: price,
            entryTime: time,
            quantity: amount,
            entryTrades: [trade],
          };
          console.log(
            `📈 Opened ${position.side} position: ${symbol} @ ${price}`
          );
          continue;
        }

        // Check if this trade closes the position
        if (this.isClosingTrade(position.side, binanceSide)) {
          // Calculate margin (assuming 3x leverage as default)
          const estimatedMargin = (amount * price) / 3;

          // Create completed trade record
          this.createTradeRecord(
            symbol,
            position.side,
            position.entryPrice,
            price, // exit price
            amount,
            3, // leverage
            estimatedMargin,
            position.entryTime,
            time, // exit time
            'CLOSED',
            'SIGNAL'
          );

          console.log(
            `📉 Closed ${position.side} position: ${symbol} @ ${price}`
          );

          // Reset position
          position = null;
        }
        // Check if this trade adds to existing position
        else if (this.isAddingToPosition(position.side, binanceSide)) {
          position.entryTrades.push(trade);

          // Recalculate average entry price
          const totalCost = position.entryTrades.reduce(
            (sum, t) => sum + (t.cost || t.price * t.amount),
            0
          );
          const totalAmount = position.entryTrades.reduce(
            (sum, t) => sum + (t.amount || 0),
            0
          );

          position.entryPrice = totalCost / totalAmount;
          position.quantity = totalAmount;

          console.log(
            `➕ Added to ${position.side} position: ${symbol} (new avg: ${position.entryPrice.toFixed(2)})`
          );
        }
        // Trade reverses direction (close + open opposite)
        else {
          console.log(
            `🔄 Position reversal detected for ${symbol} - closing and opening opposite`
          );

          // Close existing position at this price
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

          // Open new position in opposite direction
          position = {
            side: this.normalizePositionSide(binanceSide),
            entryPrice: price,
            entryTime: time,
            quantity: amount,
            entryTrades: [trade],
          };
        }
      }

      // Handle any remaining open position
      if (position) {
        console.log(
          `⚠️ Open position remaining for ${symbol}: ${position.side} ${position.quantity} @ ${position.entryPrice}`
        );
      }
    }
  }

  private recordTrade(trade: TradeRecord): void {
    // Your implementation to store the trade
    console.log(
      `💾 Recording trade: ${trade.symbol} ${trade.side} P&L: $${trade.realizedPnl.toFixed(2)}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// USAGE EXAMPLE
// ═══════════════════════════════════════════════════════════════

/*
const processor = new TradeProcessor();

// Example Binance trades
const binanceTrades: BinanceTrade[] = [
  { symbol: 'BTCUSDT', side: 'BUY', price: 50000, amount: 0.1, timestamp: 1000 },
  { symbol: 'BTCUSDT', side: 'BUY', price: 50100, amount: 0.05, timestamp: 2000 },
  { symbol: 'BTCUSDT', side: 'SELL', price: 51000, amount: 0.15, timestamp: 3000 },
];

processor.processTradesIntoHistory(binanceTrades);
*/

export default TradeProcessor;
