import { colors } from '../../lib/helpers.js';
import {
  type BotInstance,
  type EntrySignal,
  type WyckoffPhase,
} from '../../lib/type.js';
import type { CandleManager } from '../core/candles.js';
import { WyckoffAnalyzer } from '../core/wyckoff.js';

// ============================================================================
// SIGNAL VALIDATION & RISK MANAGEMENT MODULE
// Protects you from "Account Liquidation Syndrome" (ALS) 🦠
// ============================================================================

export interface ValidationConfig {
  maxSlippagePercent: number; // Max price drift from signal (e.g., 0.5%)
  minRiskRewardRatio: number; // Min R:R (e.g., 2.0 = 1:2)
  maxRiskPerTrade: number; // Max % risk per trade (e.g., 2%)
  minConfidenceAfterValidation: number; // Min confidence after all checks (e.g., 65%)
  maxCorrelatedPositions: number; // Max similar positions (e.g., 2)
  maxVolatilityPercent: number; // Max recent volatility (e.g., 5%)
  blacklistSymbols: string[]; // Symbols to never trade
  minLiquidityUSD: number; // Min 24h volume (e.g., 5M)
}

const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  maxSlippagePercent: 0.5,
  minRiskRewardRatio: 2.0,
  maxRiskPerTrade: 2.0,
  minConfidenceAfterValidation: 65,
  maxCorrelatedPositions: 2,
  maxVolatilityPercent: 5,
  blacklistSymbols: ['LUNA/USDT', 'FTT/USDT'], // RIP 💀
  minLiquidityUSD: 20_000_000,
};

export interface ValidationResult {
  isValid: boolean;
  score: number;
  reasons: string[];
  warnings: string[];
  adjustedConfidence: number;
}

// ============================================================================
// SIGNAL VALIDATOR CLASS - Your STD Protection 🛡️
// ============================================================================

export class SignalValidator {
  private wyckoffAnalyzer = new WyckoffAnalyzer();
  private candleManager: CandleManager;
  private config: ValidationConfig;
  private priceFetcher: any; // Your existing PriceFetcher
  private activeBots: Map<string, BotInstance>;

  constructor(
    config: Partial<ValidationConfig> = {},
    priceFetcher: any,
    activeBots: Map<string, BotInstance>,
    candleManager: CandleManager
  ) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config };
    this.priceFetcher = priceFetcher;
    this.activeBots = activeBots;
    this.candleManager = candleManager;
  }

  async validateSignalWithWyckoff(
    symbol: string,
    side: 'LONG' | 'SHORT',
    price: number
  ): Promise<{
    valid: boolean;
    wyckoffPhase?: WyckoffPhase;
    reason: string;
    confidence: number;
  }> {
    try {
      // Get candles for analysis
      const candles = await this.candleManager.getCandles(symbol, 'FUTURES');

      if (!candles) {
        return {
          valid: false,
          reason: 'No candle data available',
          confidence: 0,
        };
      }

      // Perform Wyckoff analysis
      const wyckoffPhase = this.wyckoffAnalyzer.analyze(candles);
      const tradeSignal = this.wyckoffAnalyzer.getTradeSignal(wyckoffPhase);

      // console.log(`\n📊 ${symbol} Wyckoff Analysis:`);
      // console.log(`   Phase: ${wyckoffPhase.phase}`);
      // console.log(`   Stage: ${wyckoffPhase.stage || 'N/A'}`);
      // console.log(`   Signal: ${wyckoffPhase.signal}`);
      // console.log(`   Confidence: ${wyckoffPhase.confidence}%`);
      // console.log(`   Description: ${wyckoffPhase.description}`);

      // Check if Wyckoff agrees with the signal
      if (!tradeSignal.shouldTrade) {
        return {
          valid: false,
          wyckoffPhase,
          reason: `Wyckoff: ${tradeSignal.reason}`,
          confidence: wyckoffPhase.confidence,
        };
      }

      // Check if direction matches
      if (tradeSignal.side !== side) {
        return {
          valid: false,
          wyckoffPhase,
          reason: `Wyckoff suggests ${tradeSignal.side} but signal is ${side}`,
          confidence: wyckoffPhase.confidence,
        };
      }

      // All checks passed
      return {
        valid: true,
        wyckoffPhase,
        reason: tradeSignal.reason,
        confidence: wyckoffPhase.confidence,
      };
    } catch (error: any) {
      console.error(`❌ Wyckoff validation failed: ${error.message}`);
      return {
        valid: false,
        reason: `Wyckoff analysis error: ${error.message}`,
        confidence: 0,
      };
    }
  }

  /**
   * 🔍 COMPREHENSIVE SIGNAL VALIDATION
   * Protects against Account Liquidation Syndrome (ALS)
   */
  async validateSignal(signal: EntrySignal): Promise<ValidationResult> {
    const result: ValidationResult = {
      isValid: true,
      score: signal.confidence,
      reasons: [],
      warnings: [],
      adjustedConfidence: signal.confidence,
    };

    console.log(`\n🔍 VALIDATING: ${signal.symbol} ${signal.side}`);
    console.log(`   Scanner Confidence: ${signal.confidence.toFixed(1)}%`);

    // ========================================================================
    // TEST 1: Blacklist Check (Instant Rejection)
    // ========================================================================
    if (this.config.blacklistSymbols.includes(signal.symbol)) {
      result.isValid = false;
      result.reasons.push('⛔ Symbol is blacklisted');
      this.log(signal.symbol, '⛔ BLACKLISTED', 'error');
      return result;
    }

    // ========================================================================
    // TEST 2: Price Slippage Check
    // ========================================================================
    const currentPrice = await this.priceFetcher.getCurrentPrice(signal.symbol);
    if (!currentPrice) {
      result.isValid = false;
      result.reasons.push('❌ Cannot fetch current price');
      return result;
    }

    const entryPrice = signal.entryPrice as number;
    const slippage = Math.abs((currentPrice - entryPrice) / entryPrice) * 100;

    if (slippage > this.config.maxSlippagePercent) {
      result.isValid = false;
      result.reasons.push(
        `📉 Slippage too high: ${slippage.toFixed(2)}% (max: ${this.config.maxSlippagePercent}%)`
      );
      this.log(signal.symbol, `SLIPPAGE: ${slippage.toFixed(2)}%`, 'error');
    } else if (slippage > this.config.maxSlippagePercent * 0.5) {
      result.warnings.push(`⚠️ Moderate slippage: ${slippage.toFixed(2)}%`);
      result.score -= 5; // Penalty
    }

    // ========================================================================
    // TEST 3: Risk/Reward Ratio Validation
    // ========================================================================

    const sl = signal.stopLoss as number;
    const tp = signal.takeProfit as number;
    const risk = Math.abs(currentPrice - sl);
    const reward = Math.abs(tp - currentPrice);
    const rrRatio = reward / risk;

    console.log(
      `   Risk: $${risk.toFixed(6)} | Reward: $${reward.toFixed(6)} | R:R = 1:${rrRatio.toFixed(2)}`
    );

    if (rrRatio < this.config.minRiskRewardRatio) {
      result.isValid = false;
      result.reasons.push(
        `📊 R:R too low: 1:${rrRatio.toFixed(2)} (min: 1:${this.config.minRiskRewardRatio})`
      );
      this.log(signal.symbol, `R:R TOO LOW: 1:${rrRatio.toFixed(2)}`, 'error');
    } else if (rrRatio > 3) {
      result.score += 10; // Bonus for great R:R
      result.warnings.push(`✅ Excellent R:R: 1:${rrRatio.toFixed(2)}`);
    }

    // ========================================================================
    // TEST 4: Maximum Risk Per Trade
    // ========================================================================
    const riskPercent = (risk / currentPrice) * 100;

    if (riskPercent > this.config.maxRiskPerTrade) {
      result.isValid = false;
      result.reasons.push(
        `🚨 Risk too high: ${riskPercent.toFixed(2)}% (max: ${this.config.maxRiskPerTrade}%)`
      );
      this.log(
        signal.symbol,
        `RISK TOO HIGH: ${riskPercent.toFixed(2)}%`,
        'error'
      );
    }

    // ========================================================================
    // TEST 5: Stop Loss Sanity Check (not too tight, not too wide)
    // ========================================================================
    if (riskPercent < 0.5) {
      result.warnings.push(
        '⚠️ Stop loss very tight - may get stopped out easily'
      );
      result.score -= 5;
    }

    // ========================================================================
    // TEST 6: Correlation Check (avoid too many similar positions)
    // ========================================================================
    const correlatedCount = this.countCorrelatedPositions(signal.symbol);

    if (correlatedCount >= this.config.maxCorrelatedPositions) {
      result.isValid = false;
      result.reasons.push(
        `🔗 Too many correlated positions (${correlatedCount}/${this.config.maxCorrelatedPositions})`
      );
      this.log(signal.symbol, 'TOO MANY CORRELATED POSITIONS', 'warning');
    } else if (correlatedCount > 0) {
      result.warnings.push(
        `⚠️ ${correlatedCount} correlated position(s) exist`
      );
      result.score -= 10;
    }

    // ========================================================================
    // TEST 7: Strategy-Specific Bonuses
    // ========================================================================
    if (['SMC_LONG', 'SMC_SHORT'].includes(signal.strategy)) {
      result.score += 5;
      result.warnings.push('✅ Premium strategy detected');
    }

    if (signal.strategy === 'LIQUIDITY_SWEEP') {
      result.score += 8;
      result.warnings.push('✅ High-probability liquidity sweep');
    }

    // ========================================================================
    // TEST 8: Market Condition Check (Future: Add volatility/trend filters)
    // ========================================================================
    // TODO: Implement volatility check using recent price history
    // const volatility = await this.calculateVolatility(signal.symbol);
    // if (volatility > this.config.maxVolatilityPercent) {
    //   result.score -= 15;
    //   result.warnings.push(`⚠️ High volatility: ${volatility.toFixed(2)}%`);
    // }

    // ========================================================================
    // FINAL SCORE ADJUSTMENT
    // ========================================================================
    result.adjustedConfidence = Math.max(0, Math.min(100, result.score));

    if (result.adjustedConfidence < this.config.minConfidenceAfterValidation) {
      result.isValid = false;
      result.reasons.push(
        `📉 Adjusted confidence too low: ${result.adjustedConfidence.toFixed(1)}% (min: ${this.config.minConfidenceAfterValidation}%)`
      );
    }

    // ========================================================================
    // FINAL VERDICT
    // ========================================================================
    console.log(
      `   Adjusted Confidence: ${result.adjustedConfidence.toFixed(1)}%`
    );

    if (result.isValid) {
      console.log(
        `   ✅ SIGNAL PASSED (Score: ${result.adjustedConfidence.toFixed(1)}%)`
      );
    } else {
      console.log(`   ❌ SIGNAL REJECTED`);
      result.reasons.forEach((r) => console.log(`      ${r}`));
    }

    if (result.warnings.length > 0) {
      result.warnings.forEach((w) => console.log(`      ${w}`));
    }

    return result;
  }

  /**
   * 🔗 Count correlated positions
   * (e.g., BTC/USDT, BTCDOM, ETHBTC all correlate with BTC)
   */
  private countCorrelatedPositions(symbol: string): number {
    const baseAsset = this.getBaseAsset(symbol);
    let count = 0;

    this.activeBots.forEach((bot) => {
      if (bot.position) {
        const botBase = this.getBaseAsset(bot.symbol);

        // Same base asset = correlated
        if (botBase === baseAsset) {
          count++;
        }

        // BTC-related pairs (BTCDOM, ETHBTC, etc.)
        if (
          baseAsset === 'BTC' &&
          (botBase.includes('BTC') || bot.symbol.includes('BTC'))
        ) {
          count++;
        }

        // ETH-related pairs
        if (
          baseAsset === 'ETH' &&
          (botBase.includes('ETH') || bot.symbol.includes('ETH'))
        ) {
          count++;
        }
      }
    });

    return count;
  }

  /**
   * Extract base asset from symbol (e.g., BTC/USDT -> BTC)
   */
  private getBaseAsset(symbol: string): string {
    return symbol.split('/')[0] || symbol.replace('USDT', '');
  }

  /**
   * 🎯 BATCH VALIDATION - Score and filter multiple signals
   */
  async validateAndRankSignals(signals: EntrySignal[]): Promise<{
    valid: Array<{ signal: EntrySignal; validation: ValidationResult }>;
    rejected: Array<{ signal: EntrySignal; validation: ValidationResult }>;
  }> {
    const results = await Promise.all(
      signals.map(async (signal) => ({
        signal,
        validation: await this.validateSignal(signal),
      }))
    );

    const valid = results
      .filter((r) => r.validation.isValid)
      .sort(
        (a, b) =>
          b.validation.adjustedConfidence - a.validation.adjustedConfidence
      );

    const rejected = results.filter((r) => !r.validation.isValid);

    console.log(`\n📊 VALIDATION SUMMARY:`);
    console.log(`   Valid: ${valid.length}`);
    console.log(`   Rejected: ${rejected.length}`);

    if (valid.length > 0) {
      console.log(`\n✅ TOP VALID SIGNALS:`);
      valid.slice(0, 5).forEach((r, i) => {
        console.log(
          `   ${i + 1}. ${r.signal.symbol} ${r.signal.side} ` +
            `(${r.validation.adjustedConfidence.toFixed(1)}%) - ${r.signal.strategy}`
        );
      });
    }

    if (rejected.length > 0) {
      console.log(`\n❌ REJECTED SIGNALS:`);
      rejected.forEach((r) => {
        console.log(
          `   ${r.signal.symbol}: ${r.validation.reasons.join(', ')}`
        );
      });
    }

    return { valid, rejected };
  }

  /**
   * Logging helper
   */
  private log(
    symbol: string,
    message: string,
    level: 'info' | 'warning' | 'error' = 'info'
  ) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = level === 'error' ? '❌' : level === 'warning' ? '⚠️' : 'ℹ️';
    const color =
      level === 'error'
        ? colors.brightRed
        : level === 'warning'
          ? colors.yellow
          : colors.cyan;

    console.log(
      `${color}[${timestamp}] ${prefix} ${symbol}: ${message}${colors.reset}`
    );
  }
}
