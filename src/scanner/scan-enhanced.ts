import fs from 'fs';

import Table from 'cli-table3';

// Import your existing modules
import { colors, getPriceDecimals } from '../../lib/helpers.js';
import { calculateIndicators, detectRegime } from '../../lib/trading-utils.js';
import {
  type EntrySignal,
  type EntryType,
  type Indicators,
  type ScanResult,
} from '../../lib/type.js';
import { CandleManager } from '../core/candles.js';
import { analyzeSMC, colorize, detectSignal } from './scan.js';

// ============================================================================
// POSITION SIZING (Integrated)
// ============================================================================

interface PositionSizeResult {
  quantity: number;
  dollarAmount: number;
  riskAmount: number;
  riskRewardRatio: number;
  method: 'FIXED_RISK' | 'VOLATILITY_ADJUSTED' | 'KELLY';
}

class PositionSizer {
  constructor(
    public config: {
      accountBalance: number;
      riskPerTrade: number;
      maxPositionSize: number;
      minPositionSize: number;
    }
  ) {}

  calculateVolatilityAdjusted(
    entryPrice: number,
    stopLoss: number,
    atr: number,
    takeProfit?: number
  ): PositionSizeResult {
    const dollarRisk = this.config.accountBalance * this.config.riskPerTrade;
    const priceRisk = Math.abs(entryPrice - stopLoss);
    const baseQuantity = dollarRisk / priceRisk;

    // Volatility adjustment
    const volatilityPct = atr / entryPrice;
    const volatilityMultiplier =
      volatilityPct > 0.03 ? 1 - (volatilityPct - 0.03) * 10 : 1;
    const adjustedMultiplier = Math.max(0.3, Math.min(1, volatilityMultiplier));

    const quantity = baseQuantity * adjustedMultiplier;
    const dollarAmount = quantity * entryPrice;

    // Apply max position constraint
    const maxDollars = this.config.accountBalance * this.config.maxPositionSize;
    const finalQuantity = Math.min(quantity, maxDollars / entryPrice);
    const finalDollarAmount = finalQuantity * entryPrice;

    const rr = takeProfit ? Math.abs(takeProfit - entryPrice) / priceRisk : 0;

    return {
      quantity: finalQuantity,
      dollarAmount: finalDollarAmount,
      riskAmount: dollarRisk,
      riskRewardRatio: rr,
      method: 'VOLATILITY_ADJUSTED',
    };
  }
}

// ============================================================================
// BACKTESTING ENGINE (Integrated)
// ============================================================================

interface BacktestTrade {
  symbol: string;
  entryDate: Date;
  exitDate: Date;
  entryPrice: number;
  exitPrice: number;
  side: EntryType;
  quantity: number;
  pnl: number;
  pnlPct: number;
  exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'END_OF_TEST';
}

interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  totalPnLPct: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  avgHoldingPeriod: number;
  expectancy: number;
}

class Backtester {
  private trades: BacktestTrade[] = [];
  private equity: number[];
  private dates: Date[];

  constructor(
    private config: {
      startDate: Date;
      endDate: Date;
      initialCapital: number;
      riskPerTrade: number;
      maxPositionSize: number;
      commissionPct: number;
    },
    private candleManager: CandleManager
  ) {
    this.equity = [config.initialCapital];
    this.dates = [config.startDate];
  }

  async runBacktest(
    symbols: string[],
    signalDetector: (
      symbol: string,
      indicators: Indicators,
      smc?: any
    ) => EntrySignal[]
  ): Promise<BacktestMetrics> {
    console.log('\n🔄 Starting backtest...\n');

    let currentCapital = this.config.initialCapital;
    const positionSizer = new PositionSizer({
      accountBalance: currentCapital,
      riskPerTrade: this.config.riskPerTrade,
      maxPositionSize: this.config.maxPositionSize,
      minPositionSize: 10,
    });

    let symbolsProcessed = 0;

    for (const symbol of symbols) {
      symbolsProcessed++;
      process.stdout.write(
        `\r📊 Processing: ${symbolsProcessed}/${symbols.length} symbols...`
      );

      const candles = this.candleManager.getCandles(symbol, 'FUTURES');
      if (!candles || candles.closes.length < 210) continue;

      for (let i = 210; i < candles.closes.length - 1; i++) {
        const historicalCandles = {
          opens: candles.opens.slice(0, i + 1),
          highs: candles.highs.slice(0, i + 1),
          lows: candles.lows.slice(0, i + 1),
          closes: candles.closes.slice(0, i + 1),
          volumes: candles.volumes.slice(0, i + 1),
          timestamps: candles.timestamps.slice(0, i + 1),
        };

        const indicators = calculateIndicators(historicalCandles);
        if (!indicators) continue;

        const smc = analyzeSMC(historicalCandles);
        const signals = signalDetector(symbol, indicators, smc);

        if (signals.length === 0) continue;

        const bestSignal = signals.reduce((a, b) =>
          a.confidence > b.confidence ? a : b
        );

        if (!bestSignal.stopLoss || !bestSignal.takeProfit) continue;

        const position = positionSizer.calculateVolatilityAdjusted(
          indicators.currentPrice,
          bestSignal.stopLoss,
          indicators.atr,
          bestSignal.takeProfit
        );

        const entryPrice = indicators.currentPrice;
        const entryDate = new Date(candles.timestamps[i] || Date.now());
        const entryCommission =
          position.dollarAmount * this.config.commissionPct;

        let exitPrice = entryPrice;
        let exitDate = entryDate;
        let exitReason: BacktestTrade['exitReason'] = 'END_OF_TEST';

        for (let j = i + 1; j < candles.closes.length; j++) {
          const currentHigh = candles.highs[j] || 0;
          const currentLow = candles.lows[j] || 0;

          if (bestSignal.side === 'LONG') {
            if (currentHigh >= bestSignal.takeProfit) {
              exitPrice = bestSignal.takeProfit;
              exitReason = 'TAKE_PROFIT';
              exitDate = new Date(candles.timestamps[j] || Date.now());
              break;
            }
            if (currentLow <= bestSignal.stopLoss) {
              exitPrice = bestSignal.stopLoss;
              exitReason = 'STOP_LOSS';
              exitDate = new Date(candles.timestamps[j] || Date.now());
              break;
            }
          } else {
            if (currentLow <= bestSignal.takeProfit) {
              exitPrice = bestSignal.takeProfit;
              exitReason = 'TAKE_PROFIT';
              exitDate = new Date(candles.timestamps[j] || Date.now());
              break;
            }
            if (currentHigh >= bestSignal.stopLoss) {
              exitPrice = bestSignal.stopLoss;
              exitReason = 'STOP_LOSS';
              exitDate = new Date(candles.timestamps[j] || Date.now());
              break;
            }
          }
        }

        const exitCommission =
          position.quantity * exitPrice * this.config.commissionPct;
        const grossPnL =
          bestSignal.side === 'LONG'
            ? (exitPrice - entryPrice) * position.quantity
            : (entryPrice - exitPrice) * position.quantity;

        const netPnL = grossPnL - entryCommission - exitCommission;
        const pnlPct = (netPnL / position.dollarAmount) * 100;

        this.trades.push({
          symbol,
          entryDate,
          exitDate,
          entryPrice,
          exitPrice,
          side: bestSignal.side,
          quantity: position.quantity,
          pnl: netPnL,
          pnlPct,
          exitReason,
        });

        currentCapital += netPnL;
        this.equity.push(currentCapital);
        this.dates.push(exitDate);

        positionSizer.config.accountBalance = currentCapital;

        if (currentCapital <= 0) {
          console.log('\n❌ Account blown - stopping backtest');
          break;
        }
      }
    }

    console.log('\n\n✅ Backtest complete!\n');
    return this.calculateMetrics();
  }

  private calculateMetrics(): BacktestMetrics {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnL: 0,
        totalPnLPct: 0,
        avgWin: 0,
        avgLoss: 0,
        largestWin: 0,
        largestLoss: 0,
        profitFactor: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        maxDrawdownPct: 0,
        avgHoldingPeriod: 0,
        expectancy: 0,
      };
    }

    const winningTrades = this.trades.filter((t) => t.pnl > 0);
    const losingTrades = this.trades.filter((t) => t.pnl <= 0);

    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalWins = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLosses = Math.abs(
      losingTrades.reduce((sum, t) => sum + t.pnl, 0)
    );

    const avgWin =
      winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
    const avgLoss =
      losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;

    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;

    let peak = this.equity[0] || 0;
    let maxDD = 0;
    let maxDDPct = 0;

    for (const equity of this.equity) {
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      const ddPct = (dd / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
    }

    const returns = this.equity
      .slice(1)
      .map(
        (e, i) => ((e - (this.equity[i] || 0)) / (this.equity[i] || 1)) * 100
      );
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdDev = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
        returns.length
    );
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    const holdingPeriods = this.trades.map(
      (t) => (t.exitDate.getTime() - t.entryDate.getTime()) / (1000 * 60 * 60)
    );
    const avgHoldingPeriod =
      holdingPeriods.reduce((a, b) => a + b, 0) / holdingPeriods.length;

    return {
      totalTrades: this.trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: (winningTrades.length / this.trades.length) * 100,
      totalPnL,
      totalPnLPct: (totalPnL / this.config.initialCapital) * 100,
      avgWin,
      avgLoss,
      largestWin: Math.max(...winningTrades.map((t) => t.pnl), 0),
      largestLoss: Math.min(...losingTrades.map((t) => t.pnl), 0),
      profitFactor,
      sharpeRatio,
      maxDrawdown: maxDD,
      maxDrawdownPct: maxDDPct,
      avgHoldingPeriod,
      expectancy: totalPnL / this.trades.length,
    };
  }

  getTrades(): BacktestTrade[] {
    return this.trades;
  }

  getEquityCurve(): { dates: Date[]; equity: number[] } {
    return { dates: this.dates, equity: this.equity };
  }
}

// ============================================================================
// PORTFOLIO RISK MANAGER (Integrated)
// ============================================================================

class PortfolioRiskManager {
  constructor(
    private config: {
      maxTotalExposure: number;
      maxCorrelatedExposure: number;
      maxSinglePosition: number;
      correlationThreshold: number;
    }
  ) {}

  calculateCorrelation(prices1: number[], prices2: number[]): number {
    const n = Math.min(prices1.length, prices2.length);
    if (n < 30) return 0;

    const returns1 = [];
    const returns2 = [];

    for (let i = 1; i < n; i++) {
      returns1.push((prices1[i]! - prices1[i - 1]!) / prices1[i - 1]!);
      returns2.push((prices2[i]! - prices2[i - 1]!) / prices2[i - 1]!);
    }

    const mean1 = returns1.reduce((a, b) => a + b, 0) / returns1.length;
    const mean2 = returns2.reduce((a, b) => a + b, 0) / returns2.length;

    let num = 0;
    let den1 = 0;
    let den2 = 0;

    for (let i = 0; i < returns1.length; i++) {
      const diff1 = returns1[i]! - mean1;
      const diff2 = returns2[i]! - mean2;
      num += diff1 * diff2;
      den1 += diff1 * diff1;
      den2 += diff2 * diff2;
    }

    return den1 > 0 && den2 > 0 ? num / Math.sqrt(den1 * den2) : 0;
  }

  checkPositionAllowed(
    newSymbol: string,
    newPositionSize: number,
    currentPositions: Map<string, number>,
    candleManager: CandleManager
  ): { allowed: boolean; reason?: string; correlation?: number } {
    const totalExposure = Array.from(currentPositions.values()).reduce(
      (a, b) => a + b,
      0
    );

    if (totalExposure + newPositionSize > this.config.maxTotalExposure) {
      return {
        allowed: false,
        reason: `Total exposure would exceed ${this.config.maxTotalExposure * 100}%`,
      };
    }

    if (newPositionSize > this.config.maxSinglePosition) {
      return {
        allowed: false,
        reason: `Position size exceeds ${this.config.maxSinglePosition * 100}%`,
      };
    }

    const newCandles = candleManager.getCandles(newSymbol, 'FUTURES');
    if (!newCandles) return { allowed: true };

    for (const [symbol, size] of currentPositions.entries()) {
      const existingCandles = candleManager.getCandles(symbol, 'FUTURES');
      if (!existingCandles) continue;

      const correlation = this.calculateCorrelation(
        newCandles.closes,
        existingCandles.closes
      );

      if (Math.abs(correlation) >= this.config.correlationThreshold) {
        const correlatedExposure = size + newPositionSize;
        if (correlatedExposure > this.config.maxCorrelatedExposure) {
          return {
            allowed: false,
            reason: `Correlated with ${symbol} (${(correlation * 100).toFixed(0)}%)`,
            correlation,
          };
        }
      }
    }

    return { allowed: true };
  }
}

// ============================================================================
// ENHANCED TRADING SCANNER
// ============================================================================

interface EnhancedScanResult extends ScanResult {
  positionSize?: PositionSizeResult;
  riskCheck?: { allowed: boolean; reason?: string };
}

class EnhancedTradingScanner {
  private candleManager: CandleManager;
  private positionSizer: PositionSizer;
  private riskManager: PortfolioRiskManager;
  private currentPositions: Map<string, number> = new Map();

  constructor(
    private config: {
      accountBalance: number;
      riskPerTrade: number;
      maxPositionSize: number;
      maxTotalExposure: number;
      enablePositionSizing: boolean;
      enableRiskManagement: boolean;
    }
  ) {
    this.candleManager = new CandleManager('15m');

    this.positionSizer = new PositionSizer({
      accountBalance: config.accountBalance,
      riskPerTrade: config.riskPerTrade,
      maxPositionSize: config.maxPositionSize,
      minPositionSize: 10,
    });

    this.riskManager = new PortfolioRiskManager({
      maxTotalExposure: config.maxTotalExposure,
      maxCorrelatedExposure: 0.3,
      maxSinglePosition: config.maxPositionSize,
      correlationThreshold: 0.7,
    });
  }

  async scanSymbol(symbol: string): Promise<EnhancedScanResult | null> {
    const candles = this.candleManager.getCandles(symbol, 'FUTURES');
    if (!candles || candles.closes.length < 210) return null;

    const indicators = calculateIndicators(candles);
    if (!indicators) return null;

    const smc = analyzeSMC(candles);
    const signals = detectSignal(symbol, indicators, candles, smc);

    if (signals.length === 0) return null;

    const bestSignal = signals.reduce((a, b) =>
      a.confidence > b.confidence ? a : b
    );

    const result: EnhancedScanResult = {
      symbol,
      signal: bestSignal,
      confidence: bestSignal.confidence,
      price: indicators.currentPrice,
      indicators,
      regime: detectRegime(indicators, candles),
      rsi: indicators.rsi,
      timestamp: new Date(),
    };

    // Add position sizing
    if (
      this.config.enablePositionSizing &&
      bestSignal.stopLoss &&
      bestSignal.takeProfit
    ) {
      result.positionSize = this.positionSizer.calculateVolatilityAdjusted(
        indicators.currentPrice,
        bestSignal.stopLoss,
        indicators.atr,
        bestSignal.takeProfit
      );
    }

    // Add risk check
    if (this.config.enableRiskManagement && result.positionSize) {
      const positionSizePct =
        result.positionSize.dollarAmount / this.config.accountBalance;
      result.riskCheck = this.riskManager.checkPositionAllowed(
        symbol,
        positionSizePct,
        this.currentPositions,
        this.candleManager
      );
    }

    return result;
  }

  displayEnhancedResults(results: EnhancedScanResult[]): void {
    console.clear();

    console.log(colorize('═'.repeat(150), colors.cyan));
    console.log(
      colorize(
        '🚀 ENHANCED QUANT TRADING SCANNER - WITH POSITION SIZING & RISK MANAGEMENT',
        colors.brightCyan
      )
    );
    console.log(colorize('═'.repeat(150), colors.cyan));

    const table = new Table({
      head: [
        'Symbol',
        'Signal',
        'Price',
        'Conf%',
        'Position $',
        'Qty',
        'Risk $',
        'R:R',
        'Risk Check',
      ],
      colWidths: [12, 10, 12, 8, 12, 10, 10, 8, 40],
      style: { head: [], border: ['gray'] },
    });

    results.forEach((r) => {
      const signalText =
        r.signal?.side === 'LONG'
          ? colorize('🚀 LONG', colors.brightGreen)
          : colorize('📉 SHORT', colors.brightRed);

      const priceText = colorize(
        `$${r.price.toFixed(getPriceDecimals(r.price))}`,
        colors.cyan
      );

      const confColor = r.confidence >= 70 ? colors.brightGreen : colors.yellow;
      const confText = colorize(`${r.confidence.toFixed(0)}%`, confColor);

      let positionText = colorize('─', colors.gray);
      let qtyText = colorize('─', colors.gray);
      let riskText = colorize('─', colors.gray);
      let rrText = colorize('─', colors.gray);

      if (r.positionSize) {
        positionText = colorize(
          `$${r.positionSize.dollarAmount.toFixed(0)}`,
          colors.yellow
        );
        qtyText = colorize(r.positionSize.quantity.toFixed(4), colors.yellow);
        riskText = colorize(
          `$${r.positionSize.riskAmount.toFixed(0)}`,
          colors.brightRed
        );
        rrText = colorize(
          r.positionSize.riskRewardRatio.toFixed(1),
          colors.green
        );
      }

      let riskCheckText = colorize('─', colors.gray);
      if (r.riskCheck) {
        if (r.riskCheck.allowed) {
          riskCheckText = colorize('✅ OK', colors.brightGreen);
        } else {
          riskCheckText = colorize(
            `❌ ${r.riskCheck.reason}`,
            colors.brightRed
          );
        }
      }

      table.push([
        r.symbol,
        signalText,
        priceText,
        confText,
        positionText,
        qtyText,
        riskText,
        rrText,
        riskCheckText,
      ]);
    });

    console.log(table.toString());

    // Summary
    const totalRisk = results
      .filter((r) => r.positionSize)
      .reduce((sum, r) => sum + (r.positionSize?.riskAmount || 0), 0);

    const totalExposure = results
      .filter((r) => r.positionSize)
      .reduce((sum, r) => sum + (r.positionSize?.dollarAmount || 0), 0);

    console.log(colorize('═'.repeat(150), colors.cyan));
    console.log(
      colorize(
        `Total Risk: $${totalRisk.toFixed(2)} (${((totalRisk / this.config.accountBalance) * 100).toFixed(2)}%)`,
        colors.brightRed
      )
    );
    console.log(
      colorize(
        `Total Exposure: $${totalExposure.toFixed(2)} (${((totalExposure / this.config.accountBalance) * 100).toFixed(2)}%)`,
        colors.yellow
      )
    );
    console.log(
      colorize(
        `Account Balance: $${this.config.accountBalance.toFixed(2)}`,
        colors.brightGreen
      )
    );
    console.log(colorize('═'.repeat(150), colors.cyan));
  }

  async runBacktest(symbols: string[]): Promise<void> {
    const backtester = new Backtester(
      {
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
        initialCapital: this.config.accountBalance,
        riskPerTrade: this.config.riskPerTrade,
        maxPositionSize: this.config.maxPositionSize,
        commissionPct: 0.001,
      },
      this.candleManager
    );

    const metrics = await backtester.runBacktest(symbols, detectSignal);

    // Display results
    console.log(colorize('═'.repeat(80), colors.brightCyan));
    console.log(colorize('📊 BACKTEST RESULTS', colors.brightCyan));
    console.log(colorize('═'.repeat(80), colors.brightCyan));

    const table = new Table({
      head: ['Metric', 'Value'],
      colWidths: [40, 40],
      style: { head: [] },
    });

    table.push(
      ['Total Trades', metrics.totalTrades.toString()],
      [
        'Win Rate',
        colorize(
          `${metrics.winRate.toFixed(2)}%`,
          metrics.winRate >= 50 ? colors.brightGreen : colors.brightRed
        ),
      ],
      [
        'Total P&L',
        colorize(
          `$${metrics.totalPnL.toFixed(2)} (${metrics.totalPnLPct.toFixed(2)}%)`,
          metrics.totalPnL >= 0 ? colors.brightGreen : colors.brightRed
        ),
      ],
      [
        'Profit Factor',
        colorize(
          metrics.profitFactor.toFixed(2),
          metrics.profitFactor >= 1.5 ? colors.brightGreen : colors.yellow
        ),
      ],
      [
        'Sharpe Ratio',
        colorize(
          metrics.sharpeRatio.toFixed(2),
          metrics.sharpeRatio >= 1 ? colors.brightGreen : colors.yellow
        ),
      ],
      [
        'Max Drawdown',
        colorize(`${metrics.maxDrawdownPct.toFixed(2)}%`, colors.brightRed),
      ],
      ['Expectancy', `$${metrics.expectancy.toFixed(2)}`],
      ['Avg Win', `$${metrics.avgWin.toFixed(2)}`],
      ['Avg Loss', `$${metrics.avgLoss.toFixed(2)}`],
      ['Avg Holding Time', `${metrics.avgHoldingPeriod.toFixed(1)} hours`]
    );

    console.log(table.toString());
    console.log(colorize('═'.repeat(80), colors.brightCyan));

    // Export trades
    const trades = backtester.getTrades();
    fs.writeFileSync(
      './signals/backtest-trades.json',
      JSON.stringify(trades, null, 2)
    );
    console.log(
      colorize(
        '✅ Trades exported to ./signals/backtest-trades.json',
        colors.green
      )
    );

    // Export equity curve
    const equity = backtester.getEquityCurve();
    fs.writeFileSync(
      './signals/equity-curve.json',
      JSON.stringify(equity, null, 2)
    );
    console.log(
      colorize(
        '✅ Equity curve exported to ./signals/equity-curve.json',
        colors.green
      )
    );
  }
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const scanner = new EnhancedTradingScanner({
    accountBalance: 10000,
    riskPerTrade: 0.02,
    maxPositionSize: 0.2,
    maxTotalExposure: 0.8,
    enablePositionSizing: true,
    enableRiskManagement: true,
  });

  const symbols = process.env.ENABLED_SYMBOLS?.split(',') || [];

  switch (command) {
    case 'backtest':
      console.log('🚀 Running backtest mode...\n');
      await scanner.runBacktest(symbols);
      break;

    case 'scan':
      console.log('🔍 Running live scan with position sizing...\n');
      // Add your scan logic here
      break;

    default:
      console.log('Available commands:');
      console.log('  npm run backtest - Run historical backtest');
      console.log('  npm run scan - Live scan with position sizing');
      break;
  }

  process.exit(0);
}

// Add to package.json scripts:
// "backtest": "tsx src/scanner/enhanced-scanner.ts backtest"
// "scan": "tsx src/scanner/enhanced-scanner.ts scan"

main();
