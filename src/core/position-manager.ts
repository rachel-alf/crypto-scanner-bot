import type {
  BotInstance,
  EntrySignal,
  EntryType,
  Indicators,
  MorayPosition,
  Position,
  StrategyId,
} from '../../lib/type.js';
import { CandleManager } from './candles.js';
import { SymbolValidator } from './symbol-validator.js';
import { WyckoffAnalyzer } from './wyckoff.js';

export class PositionManager {
  private wyckoffAnalyzer = new WyckoffAnalyzer();
  private candleManager: CandleManager;
  private allocatedCapital: number;
  private totalCapital: number;
  private moraySystem: any; // Your Moray implementation

  constructor(totalCapital: number, moraySystem: any) {
    this.totalCapital = totalCapital;
    this.allocatedCapital = 0;
    this.moraySystem = moraySystem;
    this.candleManager = new CandleManager('15m');
  }

  async evaluateEntry(signal: EntrySignal): Promise<boolean> {
    console.log(`\n🔍 Evaluating ${signal.symbol} entry with Wyckoff...`);

    // Get candles
    const candles = await this.candleManager.getCandles(
      signal.symbol,
      'FUTURES'
    );

    if (!candles) {
      log(`❌ ${signal.symbol}: No candle data`, 'error');
      return false;
    }

    // Wyckoff analysis
    const wyckoffPhase = this.wyckoffAnalyzer.analyze(candles);
    const tradeSignal = this.wyckoffAnalyzer.getTradeSignal(wyckoffPhase);

    console.log(`📊 Wyckoff Phase: ${wyckoffPhase.phase}`);
    console.log(`   Stage: ${wyckoffPhase.stage || 'N/A'}`);
    console.log(`   Confidence: ${wyckoffPhase.confidence}%`);

    // Require minimum 70% confidence
    if (wyckoffPhase.confidence < 70) {
      log(
        `⚠️ ${signal.symbol}: Wyckoff confidence too low (${wyckoffPhase.confidence}%)`,
        'warn'
      );
      return false;
    }

    // Check if Wyckoff agrees with signal direction
    if (!tradeSignal.shouldTrade) {
      log(
        `❌ ${signal.symbol}: Wyckoff says no trade - ${tradeSignal.reason}`,
        'warn'
      );
      return false;
    }

    if (tradeSignal.side !== signal.side) {
      log(
        `❌ ${signal.symbol}: Wyckoff direction mismatch (wants ${tradeSignal.side}, got ${signal.side})`,
        'warn'
      );
      return false;
    }

    log(
      `✅ ${signal.symbol}: Wyckoff validated - ${tradeSignal.reason}`,
      'success'
    );

    return true;
  }

  /**
   * 🔥 FIXED: Enter position with full validation
   */
  enterPosition(
    bot: BotInstance,
    side: EntryType,
    price: number,
    strategy: StrategyId,
    stopLoss: number,
    takeProfit: number
  ): boolean {
    // ============================================
    // 1. PRE-CHECKS
    // ============================================

    if (bot.position) {
      log(`⚠️ ${bot.symbol} already has an active position`, 'warn');
      return false;
    }

    // ============================================
    // 2. SYMBOL VALIDATION
    // ============================================

    if (!SymbolValidator.isSymbolAllowed(bot.symbol)) {
      log(`🚫 ${bot.symbol} is not allowed for trading`, 'error');
      return false;
    }

    // ============================================
    // 3. ENTRY VALIDATION
    // ============================================

    console.log(`\n🔍 ${bot.symbol} Entry Validation:`);
    console.log(`   Entry Price: $${price}`);
    console.log(`   Stop Loss: $${stopLoss}`);
    console.log(`   Take Profit: $${takeProfit}`);

    // Validate price levels make sense
    if (side === 'LONG') {
      if (stopLoss >= price) {
        log(
          `❌ ${bot.symbol} LONG: Stop loss ($${stopLoss}) must be below entry ($${price})`,
          'error'
        );
        return false;
      }
      if (takeProfit <= price) {
        log(
          `❌ ${bot.symbol} LONG: Take profit ($${takeProfit}) must be above entry ($${price})`,
          'error'
        );
        return false;
      }
    } else {
      if (stopLoss <= price) {
        log(
          `❌ ${bot.symbol} SHORT: Stop loss ($${stopLoss}) must be above entry ($${price})`,
          'error'
        );
        return false;
      }
      if (takeProfit >= price) {
        log(
          `❌ ${bot.symbol} SHORT: Take profit ($${takeProfit}) must be below entry ($${price})`,
          'error'
        );
        return false;
      }
    }

    // Calculate risk metrics
    const riskDistance = Math.abs(price - stopLoss);
    const rewardDistance = Math.abs(takeProfit - price);
    const riskPct = (riskDistance / price) * 100;
    const rewardPct = (rewardDistance / price) * 100;
    const riskRewardRatio = rewardDistance / riskDistance;

    console.log(`\n📊 ${bot.symbol} Position Setup:`);
    console.log(`   Entry: $${price}`);
    console.log(`   Risk: ${riskPct.toFixed(2)}%`);
    console.log(`   Reward: ${rewardPct.toFixed(2)}%`);
    console.log(`   R:R = 1:${riskRewardRatio.toFixed(2)}`);

    // Validate risk/reward ratio
    if (riskRewardRatio < 1.5) {
      log(
        `⚠️ ${bot.symbol} R:R ratio ${riskRewardRatio.toFixed(2)} is below minimum 1.5`,
        'warn'
      );
      // Continue but warn - some strategies might have lower R:R
    }

    // ============================================
    // 4. POSITION SIZE VALIDATION
    // ============================================

    const positionSizeUSD = configForLogging.positionSize; // e.g., 300 USDT
    const leverageMultiplier = configForLogging.leverageMultiplier; // e.g., 3x

    const validation = SymbolValidator.validatePosition(
      bot.symbol,
      price,
      positionSizeUSD,
      leverageMultiplier
    );

    if (!validation.valid) {
      log(
        `❌ ${bot.symbol} Position validation failed: ${validation.reason}`,
        'error'
      );
      return false;
    }

    const { notionalValue, tokenQuantity, marginRequired } = validation;

    // Round to proper precision
    const roundedQuantity = SymbolValidator.roundQuantity(
      bot.symbol,
      tokenQuantity,
      price
    );
    const roundedPrice = SymbolValidator.roundPrice(bot.symbol, price);
    const roundedSL = SymbolValidator.roundPrice(bot.symbol, stopLoss);
    const roundedTP = SymbolValidator.roundPrice(bot.symbol, takeProfit);

    console.log(`\n💰 Position Sizing:`);
    console.log(`   Margin Required: $${marginRequired.toFixed(2)}`);
    console.log(`   Leverage: ${leverageMultiplier}x`);
    console.log(`   Notional Value: $${notionalValue.toFixed(2)}`);
    console.log(
      `   Token Quantity: ${roundedQuantity} ${bot.symbol.replace('USDT', '')}`
    );
    console.log(`   Entry (rounded): $${roundedPrice}`);

    // ============================================
    // 5. CAPITAL ALLOCATION CHECK
    // ============================================

    if (!this.reserveCapital(marginRequired)) {
      log(`❌ ${bot.symbol} Insufficient capital to open position`, 'error');
      log(`   Required: $${marginRequired.toFixed(2)}`, 'error');
      log(
        `   Available: $${(this.totalCapital - this.allocatedCapital).toFixed(2)}`,
        'error'
      );
      return false;
    }

    // ============================================
    // 6. CREATE POSITION
    // ============================================

    const position: Position = {
      positionId: `${bot.symbol}-${Date.now()}`,
      symbol: bot.symbol,
      side: side,
      entryPrice: roundedPrice,
      currentPrice: roundedPrice,
      amount: roundedQuantity,
      remainingAmount: roundedQuantity, // 🐍 Important for Moray
      stopLoss: roundedSL,
      takeProfit: roundedTP,
      pnlUsd: 0,
      pnlPct: 0,
      leverage: leverageMultiplier,
      marginUsed: marginRequired,
      notionalValue: notionalValue,
      entryTime: new Date(),
      strategy: strategy,
      partialsSold: 0, // 🐍 Initialize for Moray
    };

    // ============================================
    // 7. INITIALIZE MORAY (if enabled)
    // ============================================

    if (
      MORAY_CONFIG.enabled &&
      this.moraySystem &&
      this.moraySystem.initializePosition
    ) {
      bot.position = this.moraySystem.initializePosition(position);

      const morayPos = bot.position as MorayPosition;

      log(
        `🐍 ${bot.symbol} Moray initialized:\n` +
          `   Targets: ${morayPos.partialTargets?.map((t) => `${t.label} @ ${t.ratio}R`).join(', ')}\n` +
          `   Breakeven after: ${MORAY_CONFIG.moveToBreakEvenAfter}R`,
        'info'
      );

      // Log target prices for visibility
      morayPos.partialTargets?.forEach((target) => {
        const targetPrice = this.moraySystem.calculateTargetPrice(
          roundedPrice,
          side,
          target.ratio,
          roundedSL
        );
        console.log(
          `   ${target.label}: $${targetPrice.toFixed(6)} (${(target.percent * 100).toFixed(0)}% of position)`
        );
      });
    } else {
      bot.position = position;
    }

    // ============================================
    // 8. UPDATE STATE
    // ============================================

    this.allocatedCapital += notionalValue;
    bot.status = 'running';

    // ============================================
    // 9. SUCCESS LOGGING
    // ============================================

    log(
      `💰 Capital Update: +$${notionalValue.toFixed(2)} allocated | Total: $${this.allocatedCapital.toFixed(2)}/$${this.totalCapital.toFixed(2)}`,
      'info'
    );
    log(
      `🚀 ${bot.symbol} ${side} OPENED at $${roundedPrice} (${strategy})`,
      'success'
    );
    log(`   Quantity: ${roundedQuantity} tokens`, 'info');
    log(
      `   Notional: $${notionalValue.toFixed(2)} (${leverageMultiplier}x leverage)`,
      'info'
    );
    log(`   SL: $${roundedSL} | TP: $${roundedTP}`, 'info');
    log(
      `   Risk: ${riskPct.toFixed(2)}% | Reward: ${rewardPct.toFixed(2)}% | R:R = 1:${riskRewardRatio.toFixed(2)}`,
      'info'
    );

    // ============================================
    // 10. FINAL VERIFICATION (Critical for debugging)
    // ============================================

    const verifyNotional = roundedQuantity * roundedPrice;
    const notionalDiff = Math.abs(verifyNotional - notionalValue);

    if (notionalDiff > 1) {
      log(`⚠️ VERIFICATION WARNING: Notional mismatch`, 'warn');
      log(`   Expected: $${notionalValue.toFixed(2)}`, 'warn');
      log(`   Actual: $${verifyNotional.toFixed(2)}`, 'warn');
      log(`   Difference: $${notionalDiff.toFixed(2)}`, 'warn');
    } else {
      log(
        `✅ Position verification passed: ${roundedQuantity} × $${roundedPrice} = $${verifyNotional.toFixed(2)}`,
        'success'
      );
    }

    return true;
  }

  /**
   * 🚨 PANIC PROTECTIONS & VOLATILITY-BASED BREAKEVEN
   * Call this every time the price updates for an active bot.
   */
  public checkPanicProtections(bot: BotInstance, indicators: Indicators): void {
    const pos = bot.position;
    if (!pos || !indicators.atr) return;

    const { entryPrice, side, stopLoss } = pos;
    const currentPrice = indicators.currentPrice;
    const atr = indicators.atr;

    // --- 1. VOLATILITY-BASED BREAKEVEN (1.5x ATR) ---
    // If we are up by 1.5 times the average volatility, the trade is "working."
    // We move SL to entry to ensure a "free trade."
    const volatilityTarget =
      side === 'LONG' ? entryPrice + atr * 1.5 : entryPrice - atr * 1.5;

    const isProfitTargetMet =
      side === 'LONG'
        ? currentPrice >= volatilityTarget
        : currentPrice <= volatilityTarget;

    // Only move if we haven't already moved SL past entry
    const isStopStillInRisk =
      side === 'LONG' ? stopLoss < entryPrice : stopLoss > entryPrice;

    if (isProfitTargetMet && isStopStillInRisk) {
      const breakevenPrice =
        side === 'LONG' ? entryPrice * 1.001 : entryPrice * 0.999;
      pos.stopLoss = SymbolValidator.roundPrice(bot.symbol, breakevenPrice);

      log(
        `🛡️ ${bot.symbol}: Volatility target hit (${(atr * 1.5).toFixed(4)}). SL moved to Breakeven.`,
        'success'
      );
    }

    // --- 2. THE "FLASH CRASH" PANIC (UNCONVENTIONAL) ---
    // If the current candle low/high is a massive outlier (3x ATR),
    // it's likely a scam wick or a dump. Exit or tighten SL immediately.
    const candleChange = Math.abs(currentPrice - pos.currentPrice);
    if (candleChange > atr * 3) {
      log(
        `🚨 ${bot.symbol}: Extreme volatility detected (3x ATR). Tightening Stop Loss to current price.`,
        'warn'
      );
      pos.stopLoss = currentPrice;
    }
  }

  /**
   * Reserve capital for a position
   */
  private reserveCapital(amount: number): boolean {
    const available = this.totalCapital - this.allocatedCapital;

    if (amount > available) {
      log(
        `❌💰 Insufficient capital: Need $${amount.toFixed(2)}, have $${available.toFixed(2)}`,
        'error'
      );
      return false;
    }

    return true;
  }

  /**
   * Release capital when position closes
   */
  releaseCapital(amount: number): void {
    this.allocatedCapital -= amount;
    if (this.allocatedCapital < 0) {
      this.allocatedCapital = 0;
    }
  }
}

// ============================================
// HELPER: Log function (adapt to your logger)
// ============================================

function log(
  message: string,
  level: 'info' | 'success' | 'warn' | 'error' = 'info'
): void {
  const timestamp = new Date().toISOString();
  const prefix = {
    info: 'ℹ️',
    success: '✅',
    warn: '⚠️',
    error: '❌',
  }[level];

  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// ============================================
// DUMMY CONFIG (replace with your actual config)
// ============================================

const configForLogging = {
  positionSize: 300,
  leverageMultiplier: 3,
};

const MORAY_CONFIG = {
  enabled: true,
  moveToBreakEvenAfter: 1.5,
};
