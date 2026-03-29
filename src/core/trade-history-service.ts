import crypto from 'crypto';
import fs from 'fs';

import type { Position, TradeRecord } from '../../lib/type.js';

export class TradeHistoryService {
  private trades: TradeRecord[] = [];

  /**
   * Save a closed position to history
   */
  saveClosedPosition(
    position: Position,
    exitPrice: number,
    exitReason: TradeRecord['exitReason']
  ): void {
    if (!position.marginUsed || !position.leverage) {
      throw new Error('error');
    }
    const pnlUsd = this.calculatePnL(position, exitPrice) as number;
    const pnlPct = (pnlUsd / position.marginUsed) * 100;

    const record: TradeRecord = {
      id: position.positionId,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: exitPrice,
      entryTime: position.entryTime,
      exitTime: new Date(),
      realizedPnl: pnlUsd,
      realizedPnlPct: pnlPct,
      quantity: position.amount,
      leverage: position.leverage,
      strategy: position.strategy,
      exitReason: exitReason,
      marginUsed: position.marginUsed,
    };

    this.trades.push(record);
    this.persistToFile(record); // Optional: save to file
  }

  private calculatePnL(position: Position, exitPrice: number): number {
    const priceChange =
      position.side === 'LONG'
        ? exitPrice - position.entryPrice
        : position.entryPrice - exitPrice;

    if (!position.leverage) {
      throw new Error('no leverage');
    }

    return priceChange * position.amount * position.leverage;
  }

  /**
   * Get all trades
   */
  getAllTrades(): TradeRecord[] {
    return this.trades;
  }

  /**
   * Get trades filtered by criteria
   */
  getFilteredTrades(filters: {
    symbol?: string;
    side?: 'LONG' | 'SHORT';
    startDate?: Date;
    endDate?: Date;
    minPnl?: number;
  }): TradeRecord[] {
    return this.trades.filter((trade) => {
      if (filters.symbol && trade.symbol !== filters.symbol) return false;
      if (filters.side && trade.side !== filters.side) return false;
      if (filters.startDate && trade.exitTime < filters.startDate) return false;
      if (filters.endDate && trade.exitTime > filters.endDate) return false;
      if (filters.minPnl && trade.realizedPnl < filters.minPnl) return false;
      return true;
    });
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const totalTrades = this.trades.length;
    const winningTrades = this.trades.filter((t) => t.realizedPnl > 0);
    const losingTrades = this.trades.filter((t) => t.realizedPnl < 0);

    const totalPnL = this.trades.reduce((sum, t) => sum + t.realizedPnl, 0);
    const winRate = (winningTrades.length / totalTrades) * 100;

    const avgWin =
      winningTrades.length > 0
        ? winningTrades.reduce((sum, t) => sum + t.realizedPnl, 0) /
          winningTrades.length
        : 0;

    const avgLoss =
      losingTrades.length > 0
        ? losingTrades.reduce((sum, t) => sum + t.realizedPnl, 0) /
          losingTrades.length
        : 0;

    return {
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate,
      totalPnL,
      avgWin,
      avgLoss,
      profitFactor: Math.abs(avgWin / avgLoss),
    };
  }

  /**
   * Persist to JSON file (optional)
   */
  private persistToFile(record: TradeRecord): void {
    const path = './data/trade_history.json';

    let history: TradeRecord[] = [];
    if (fs.existsSync(path)) {
      history = JSON.parse(fs.readFileSync(path, 'utf-8'));
    }

    history.push(record);
    fs.writeFileSync(path, JSON.stringify(history, null, 2));
  }

  /**
   * Load from file on startup
   */
  loadFromFile(): void {
    const path = './data/trade_history.json';

    if (fs.existsSync(path)) {
      this.trades = JSON.parse(fs.readFileSync(path, 'utf-8'));
      console.log(`📚 Loaded ${this.trades.length} historical trades`);
    }
  }
}

export class BinanceTradeHistory {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl = 'https://fapi.binance.com'; // futures
  // private baseUrl = 'https://api.binance.com'; // spot

  constructor(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  /**
   * Generate signature for Binance API
   */
  private createSignature(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Fetch account trades for a symbol
   */
  async getAccountTrades(symbol: string, limit: number = 500) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&limit=${limit}&timestamp=${timestamp}`;
    const signature = this.createSignature(queryString);

    const url = `${this.baseUrl}/fapi/v1/userTrades?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Binance API error: ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * Fetch all income history (PnL, funding, etc)
   */
  async getIncomeHistory(
    symbol?: string,
    incomeType?: 'REALIZED_PNL' | 'FUNDING_FEE' | 'COMMISSION',
    limit: number = 1000
  ) {
    const timestamp = Date.now();
    let queryString = `timestamp=${timestamp}&limit=${limit}`;

    if (symbol) queryString += `&symbol=${symbol}`;
    if (incomeType) queryString += `&incomeType=${incomeType}`;

    const signature = this.createSignature(queryString);
    const url = `${this.baseUrl}/fapi/v1/income?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Binance API error: ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * Get all closed positions (realized PnL)
   */
  async getClosedPositions(symbol?: string) {
    const income = await this.getIncomeHistory(symbol, 'REALIZED_PNL');

    return income.map((record: any) => ({
      symbol: record.symbol,
      income: parseFloat(record.income),
      asset: record.asset,
      time: new Date(record.time),
      info: record.info,
      tradeId: record.tradeId,
    }));
  }

  /**
   * Calculate statistics from income history
   */
  async getStatistics(symbol?: string) {
    const pnlHistory = await this.getIncomeHistory(symbol, 'REALIZED_PNL');

    const totalPnL = pnlHistory.reduce(
      (sum: number, record: any) => sum + parseFloat(record.income),
      0
    );

    const wins = pnlHistory.filter((r: any) => parseFloat(r.income) > 0);
    const losses = pnlHistory.filter((r: any) => parseFloat(r.income) < 0);

    const avgWin =
      wins.length > 0
        ? wins.reduce((sum: number, r: any) => sum + parseFloat(r.income), 0) /
          wins.length
        : 0;

    const avgLoss =
      losses.length > 0
        ? losses.reduce(
            (sum: number, r: any) => sum + parseFloat(r.income),
            0
          ) / losses.length
        : 0;

    return {
      totalTrades: pnlHistory.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: (wins.length / pnlHistory.length) * 100,
      totalPnL,
      avgWin,
      avgLoss,
      profitFactor: Math.abs(avgWin / avgLoss),
    };
  }
}
