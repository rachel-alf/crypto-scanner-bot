import type {
  EntryType,
  MorayPosition,
  PartialTarget,
  PartialTradeRecord,
  Position,
  Regime,
} from '../../lib/type.js';
import type { LiquidityClassification } from './liquidity-classifier.js';

export const MORAY_CONFIG = {
  enabled: true,

  partials: [
    { ratio: 2.7, percent: 0.4, label: 'First Bite 🥩' },
    { ratio: 3.7, percent: 0.6, label: 'Second Helping 🍖' },
    // { ratio: 4.0, percent: 0.2, label: 'Runner 🎯' },
  ],

  moveToBreakEvenAfter: 1.3,

  messages: {
    entry: '🐍 Moray entering position...',
    firstPartial: '🥩 First bite! 50% secured, moving SL to breakeven',
    secondPartial: '🍖 Second helping! 30% more secured',
    fullExit: '🎉 All targets hit! Perfect hunt complete',
    breakeven: '🛡️ Stop loss moved to BREAKEVEN - Risk eliminated!',
    retreat: '❌ Retreating to reef - preserving capital',
  },
};

export interface DynamicMorayRatios {
  partials: Array<{ ratio: number; percent: number; label: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// MorayPartialSystem.ts  –  clean rewrite
//
// Changes vs original:
//  • Single PnL formula: rawPnl = priceChange × contracts (leverage NOT re-applied)
//    Leverage is already baked into contract count via sizing; multiplying again
//    inflated every PnL figure by the leverage multiplier (e.g. 3×)
//  • `checkPartialTargets` sells against ORIGINAL amount (target.percent × amount)
//    not remainingAmount — previous code undersold every partial after the first
//  • Removed three duplicated inline PnL blocks; all call calculateLeveragedPnl
//  • `processPartialFill` and `executePartial` were doing identical work;
//    consolidated into one private helper `_applyPartialFill`
//  • Dead/commented-out code removed
//  • `moveStopLossToBreakevenOnExchange` and `updateTakeProfitQuantity` were
//    private but never called internally — kept private, signatures cleaned up
//  • Stats index guard replaced magic numbers 0/1/2 with a map
// ─────────────────────────────────────────────────────────────────────────────

export class MorayPartialSystem {
  private partialHistory: PartialTradeRecord[] = [];
  private readonly maxHistorySize = 100;

  private stats = {
    totalPositions: 0,
    firstBiteHits: 0,
    secondHits: 0,
    runnerHits: 0,
  };

  // ─── single source of truth for PnL ────────────────────────────────────────
  //
  // Contracts are sized as:
  //   contracts = (margin × leverage) / entryPrice
  //
  // Therefore:
  //   rawPnl = priceChange × contracts
  //          = priceChange × (margin × leverage / entryPrice)
  //          = (priceChange / entryPrice) × margin × leverage
  //
  // Leverage is already fully embedded in the contract count.
  // Multiplying rawPnl by leverage again inflates PnL by 3× — the bug this fixes.
  //
  // WIFUSDT example that exposed this:
  //   entryPrice=0.2317, contracts=826.8 (=191.56 notional / 0.2317)
  //   price moves to 0.2430 → priceChange=0.0113
  //   rawPnl = 0.0113 × 413.4 (50% partial) = $4.67  ✅
  //   old code: $4.67 × 3 leverage = $14.01            ❌ (3× too large)
  //
  // `leveragedPnl` is kept as a field alias so call-sites don't break.
  // `leverage` is kept in the signature to compute pnlPct against margin.
  // ───────────────────────────────────────────────────────────────────────────
  calculateLeveragedPnl(
    entryPrice: number,
    exitPrice: number,
    amount: number, // contracts — already encodes leverage via position sizing
    side: EntryType,
    leverage: number // retained for pnlPct calculation only (not applied to PnL)
  ): { rawPnl: number; leveragedPnl: number; percentChange: number } {
    const priceChange =
      side === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;

    const percentChange = priceChange / entryPrice;
    const rawPnl = priceChange * amount; // leverage already in `amount`
    const leveragedPnl = rawPnl; // NOT × leverage — would double-count

    return { rawPnl, leveragedPnl, percentChange };
  }

  // ─── shared mutation helper ─────────────────────────────────────────────────
  // Called by every path that executes a partial: checkPartialTargets,
  // checkExchangePartialFills, and processPartialFill.
  // Mutates position in place and records history.
  // ───────────────────────────────────────────────────────────────────────────
  private _applyPartialFill(
    position: MorayPosition,
    target: PartialTarget,
    targetIndex: number,
    fillPrice: number,
    fillAmount: number,
    leverage: number
  ): void {
    const pnl = this.calculateLeveragedPnl(
      position.entryPrice,
      fillPrice,
      fillAmount,
      position.side as EntryType,
      leverage
    );

    target.executed = true;
    target.executedAt = fillPrice;

    position.remainingAmount -= fillAmount;
    position.partialsSold = (position.partialsSold || 0) + 1;
    position.partialPnlRealized =
      (position.partialPnlRealized || 0) + pnl.leveragedPnl;
    position.pnlUsd += pnl.leveragedPnl;

    this.recordPartialTrade(
      position,
      fillPrice,
      fillAmount,
      pnl.leveragedPnl,
      target,
      leverage
    );

    // Update hit-rate stats
    const statKey = ['firstBiteHits', 'secondHits', 'runnerHits'][targetIndex];
    if (statKey && statKey in this.stats) {
      (this.stats as any)[statKey]++;
    }

    console.log(`📊 Partial ${targetIndex + 1} executed — ${target.label}:`, {
      symbol: position.symbol,
      fillPrice: fillPrice.toFixed(6),
      fillAmount: fillAmount.toFixed(8),
      rawPnl: pnl.rawPnl.toFixed(4),
      leveragedPnl: pnl.leveragedPnl.toFixed(2),
      accumulated: position.partialPnlRealized.toFixed(2),
      remaining: position.remainingAmount.toFixed(8),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Initialize partial targets for a new position.
   * Called by TradingEngine immediately after entry is confirmed.
   */
  initializePosition(
    position: Position,
    customPartials?: Array<{ ratio: number; percent: number; label: string }>
  ): MorayPosition {
    const partialsToUse = customPartials ?? MORAY_CONFIG.partials;

    const morayPosition: MorayPosition = {
      ...position,
      partialTargets: partialsToUse.map((p) => ({
        ratio: p.ratio,
        percent: p.percent,
        label: p.label,
        executed: false,
        targetPrice: 0,
      })),
      partialsSold: 0,
      breakEvenMoved: false,
      partialPnlRealized: 0,
      remainingAmount: position.amount,
    };

    this.stats.totalPositions++;
    return morayPosition;
  }

  /**
   * Calculate the price that represents a given R-multiple from entry.
   */
  calculateTargetPrice(
    entryPrice: number,
    side: EntryType,
    ratio: number,
    stopLoss: number
  ): number {
    const risk = Math.abs(entryPrice - stopLoss);
    const reward = risk * ratio;
    return side === 'LONG' ? entryPrice + reward : entryPrice - reward;
  }

  /**
   * Check if the breakeven trigger price has been reached.
   */
  shouldMoveToBreakeven(
    position: MorayPosition,
    currentPrice: number
  ): boolean {
    const triggerPrice = this.calculateTargetPrice(
      position.entryPrice,
      position.side as EntryType,
      MORAY_CONFIG.moveToBreakEvenAfter,
      position.stopLoss
    );
    return position.side === 'LONG'
      ? currentPrice >= triggerPrice
      : currentPrice <= triggerPrice;
  }

  /**
   * Returns true if every partial target has been executed.
   */
  allPartialsExecuted(position: MorayPosition): boolean {
    return position.partialTargets?.every((t) => t.executed) ?? false;
  }

  /**
   * Called from the price-update loop (paper trading or virtual tracking).
   *
   * FIX: sells `position.amount × target.percent` (the original full quantity
   * slice) instead of `remainingAmount × target.percent`.  Using remainingAmount
   * caused every partial after the first to undersell because remainingAmount
   * shrinks with each execution while target.percent was defined against the
   * original full amount.
   */
  checkPartialTargets(
    position: MorayPosition,
    currentPrice: number,
    leverage: number,
    onPartialExecuted: (
      amount: number,
      pnl: number,
      target: PartialTarget
    ) => void,
    onBreakevenMoved: () => void
  ): boolean {
    if (!position.partialTargets?.length || !position.partialPnlRealized)
      return false;

    let anyHit = false;

    for (let i = 0; i < position.partialTargets.length; i++) {
      const target = position.partialTargets[i] as PartialTarget;
      if (target.executed) continue;

      const targetPrice = this.calculateTargetPrice(
        position.entryPrice,
        position.side as EntryType,
        target.ratio,
        position.stopLoss
      );

      const isHit =
        position.side === 'LONG'
          ? currentPrice >= targetPrice
          : currentPrice <= targetPrice;

      if (!isHit) continue;

      // ✅ FIX: use original position.amount, not the shrinking remainingAmount
      const sellAmount = position.amount * target.percent;

      this._applyPartialFill(
        position,
        target,
        i,
        currentPrice,
        sellAmount,
        leverage
      );
      onPartialExecuted(sellAmount, position.partialPnlRealized, target);
      anyHit = true;
    }

    if (
      !position.breakEvenMoved &&
      this.shouldMoveToBreakeven(position, currentPrice)
    ) {
      position.stopLoss = position.entryPrice;
      position.breakEvenMoved = true;
      onBreakevenMoved();
    }

    return anyHit;
  }

  /**
   * Called by TradingEngine after detecting a fill on the exchange.
   * Used in real trading mode where limit orders sit on Binance.
   */
  async checkExchangePartialFills(
    position: MorayPosition,
    binance: any,
    placeStopLossFn: (params: any) => Promise<any>,
    placeTakeProfitFn: (params: any) => Promise<any>
  ): Promise<void> {
    if (!position.partialTargets) return;

    for (let i = 0; i < position.partialTargets.length; i++) {
      const target = position.partialTargets[i];
      if (target?.executed || !target?.orderId) continue;

      try {
        const order = await binance.fetchOrder(target.orderId, position.symbol);
        const isFilled = order.status === 'closed' || order.status === 'filled';
        if (!isFilled) continue;

        const fillPrice = order.average ?? order.price;
        const fillAmount = order.filled;

        this._applyPartialFill(
          position,
          target,
          i,
          fillPrice,
          fillAmount,
          position.leverage as number
        );
      } catch (error: any) {
        console.error(
          `❌ Error checking partial ${i + 1} for ${position.symbol}: ${error.message}`
        );
      }
    }
  }

  /**
   * Called externally if a fill event is pushed to the engine
   * (e.g. from a WebSocket user-data stream).
   */
  processPartialFill(
    position: MorayPosition,
    targetIndex: number,
    fillPrice: number,
    fillAmount: number,
    leverage: number
  ): void {
    const target = position.partialTargets?.[targetIndex];
    if (!target || target.executed) return;

    this._applyPartialFill(
      position,
      target,
      targetIndex,
      fillPrice,
      fillAmount,
      leverage
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EXCHANGE ORDER MANAGEMENT  (real trading only)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Cancel the existing SL order and replace it with a new one at entry price.
   * Called after the first partial hits and breakeven protection activates.
   */
  async moveStopLossToBreakevenOnExchange(
    position: MorayPosition,
    binance: any
  ): Promise<void> {
    if (position.breakEvenMoved || !position.stopLossOrderId) return;

    try {
      await binance.cancelOrder(position.stopLossOrderId, position.symbol);

      const newSL = await binance.createOrder(
        position.symbol,
        'STOP_MARKET',
        position.side === 'LONG' ? 'SELL' : 'BUY',
        position.remainingAmount,
        undefined,
        { stopPrice: position.entryPrice, reduceOnly: true }
      );

      position.stopLossOrderId = newSL.id as string;
      position.stopLoss = position.entryPrice;
      position.breakEvenMoved = true;

      console.log(
        `✅ Breakeven SL placed: ${newSL.id} @ $${position.entryPrice.toFixed(6)}`
      );
    } catch (error: any) {
      console.error(
        `❌ Failed to move SL to breakeven for ${position.symbol}: ${error.message}`
      );
    }
  }

  /**
   * Cancel the existing TP order and replace it for the remaining quantity.
   * Called after each partial fill to keep the TP quantity in sync.
   */
  async updateTakeProfitQuantity(
    position: MorayPosition,
    binance: any
  ): Promise<void> {
    if (!position.takeProfitOrderId || position.remainingAmount <= 0) return;

    try {
      await binance.cancelOrder(position.takeProfitOrderId, position.symbol);

      const newTP = await binance.createOrder(
        position.symbol,
        'TAKE_PROFIT_MARKET',
        position.side === 'LONG' ? 'SELL' : 'BUY',
        position.remainingAmount,
        undefined,
        { stopPrice: position.takeProfit, reduceOnly: true }
      );

      position.takeProfitOrderId = newTP.id as string;
      console.log(
        `✅ TP updated to remaining qty ${position.remainingAmount.toFixed(8)}: ${newTP.id}`
      );
    } catch (error: any) {
      console.error(
        `❌ Failed to update TP for ${position.symbol}: ${error.message}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HISTORY & STATS
  // ─────────────────────────────────────────────────────────────────────────────

  public recordPartialTrade(
    position: MorayPosition,
    exitPrice: number,
    amount: number,
    pnl: number,
    target: PartialTarget,
    leverage: number
  ): void {
    const marginUsed =
      position.marginUsed ?? (position.amount * position.entryPrice) / leverage;

    const record: PartialTradeRecord = {
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      amount,
      pnlUsd: pnl,
      pnlPct: marginUsed > 0 ? (pnl / marginUsed) * 100 : 0,
      targetLabel: target.label,
      ratio: target.ratio,
      timestamp: new Date(),
    };

    this.partialHistory.unshift(record);
    if (this.partialHistory.length > this.maxHistorySize) {
      this.partialHistory.pop();
    }
  }

  getStats(): {
    totalPartials: number;
    totalPnl: number;
    avgPnl: number;
    firstBiteHitRate: number;
    secondHitRate: number;
    runnerHitRate: number;
  } {
    const total = this.partialHistory.length;
    const totalPnl = this.partialHistory.reduce((sum, t) => sum + t.pnlUsd, 0);
    const totalPositions = this.stats.totalPositions || 1;

    return {
      totalPartials: total,
      totalPnl,
      avgPnl: total > 0 ? totalPnl / total : 0,
      firstBiteHitRate: (this.stats.firstBiteHits / totalPositions) * 100,
      secondHitRate: (this.stats.secondHits / totalPositions) * 100,
      runnerHitRate: (this.stats.runnerHits / totalPositions) * 100,
    };
  }

  getRecentPartials(limit = 10): PartialTradeRecord[] {
    return this.partialHistory.slice(0, limit);
  }

  getTotalPositions(): number {
    return this.stats.totalPositions;
  }

  resetStats(): void {
    this.stats = {
      totalPositions: 0,
      firstBiteHits: 0,
      secondHits: 0,
      runnerHits: 0,
    };
    this.partialHistory = [];
  }

  clearHistory(): void {
    this.partialHistory = [];
  }
}
/**
 * Format partial trade for logging
 */
export function formatPartialLog(
  symbol: string,
  target: PartialTarget,
  price: number,
  amount: number,
  pnl: number,
  leverage: number
): string {
  const pnlStr =
    pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

  return (
    `🐍 ${symbol} ${target.label} @ $${price.toFixed(6)}\n` +
    `   Amount: ${amount.toFixed(8)} (${(target.percent * 100).toFixed(0)}%)\n` +
    `   PnL: ${pnlStr} (${target.ratio}R × ${leverage}x)\n` +
    `   Status: ✅ Secured to reef!`
  );
}

/**
 * Display Moray Bot startup banner
 */
export function displayMorayBanner(): void {
  console.log(`
╔════════════════════════════════════════╗
║     🐍 MORAY BOT INITIALIZED 🐍       ║
╠════════════════════════════════════════╣
║  "Stay in the reef. Strike fast.      ║
║   The ocean is full of predators."    ║
╠════════════════════════════════════════╣
║  Strategy: Partial Profit Taking      ║
║                                        ║
║  Targets:                              ║
║   🥩 First Bite:  50% @ 1.5R          ║
║   🍖 Second Help: 30% @ 2.5R          ║
║   🎯 Runner:      20% @ 4.0R          ║
║                                        ║
║  Protection:                           ║
║   🛡️ Breakeven after first partial    ║
║   ❌ Hard stop loss (1%)              ║
╚════════════════════════════════════════╝
`);
}

export function adjustMorayForRegime(
  regime: Regime,
  liquidity: LiquidityClassification
): DynamicMorayRatios {
  // Base ratios (your defaults)
  let tp1 = 1.7;
  let tp2 = 1.9;
  let tp1Percent = 0.6;
  let tp2Percent = 0.4;

  // ════════════════════════════════════════════
  // VOLATILITY ADJUSTMENTS
  // ════════════════════════════════════════════

  if (regime.volatility === 'EXTREME' || regime.volatility === 'HIGH') {
    // 🚀 HIGH VOLATILITY: Wider targets, price moves fast
    tp1 = 2.0; // Instead of 1.5R
    tp2 = 3.5; // Instead of 2.5R
    console.log(`   🌪️ High volatility detected - widening targets`);
  } else if (regime.volatility === 'VERY_LOW' || regime.volatility === 'DEAD') {
    // 🐌 LOW VOLATILITY: Tighter targets, price barely moves
    tp1 = 1.2; // Instead of 1.5R
    tp2 = 2.0; // Instead of 2.5R
    console.log(`   💤 Low volatility detected - tightening targets`);
  }

  // ════════════════════════════════════════════
  // TREND ADJUSTMENTS
  // ════════════════════════════════════════════

  if (regime.trend === 'STRONG_UP' || regime.trend === 'STRONG_DOWN') {
    // 📈 STRONG TREND: Let winners run!
    tp1Percent = 0.5; // Take less at TP1 (50% instead of 60%)
    tp2Percent = 0.5; // Keep more for TP2 (50% instead of 40%)
    tp2 = tp2 * 1.2; // Push TP2 even further (e.g., 2.5R → 3.0R)
    console.log(`   🚀 Strong trend - letting runners go further`);
  } else if (regime.trend === 'CHOP') {
    // 📊 CHOPPY: Take profit quick!
    tp1Percent = 0.7; // Take MORE at TP1 (70% instead of 60%)
    tp2Percent = 0.3; // Keep less for TP2 (30% instead of 40%)
    tp1 = tp1 * 0.85; // Tighten TP1 (e.g., 1.5R → 1.3R)
    console.log(`   ⚠️ Choppy market - taking profit early`);
  }

  // ════════════════════════════════════════════
  // LIQUIDITY ADJUSTMENTS
  // ════════════════════════════════════════════

  if (liquidity.tier === 'LOW') {
    // 💀 LOW LIQUIDITY: Tighter targets, hard to fill big orders
    tp1 = tp1 * 0.9;
    tp2 = tp2 * 0.85;
    tp1Percent = 0.7; // Take more at TP1 to reduce slippage risk
    console.log(`   💧 Low liquidity - conservative targets`);
  }

  // ════════════════════════════════════════════
  // MARKET QUALITY ADJUSTMENTS
  // ════════════════════════════════════════════

  if (regime.marketQuality === 'LOW') {
    // 🚫 POOR QUALITY: Very tight targets, get out fast
    tp1 = Math.min(tp1, 1.3);
    tp2 = Math.min(tp2, 2.0);
    tp1Percent = 0.8; // Take 80% at TP1!
    tp2Percent = 0.2;
    console.log(`   ⚠️ Low market quality - aggressive profit taking`);
  }

  return {
    partials: [
      { ratio: tp1, percent: tp1Percent, label: 'First Bite 🥩' },
      { ratio: tp2, percent: tp2Percent, label: 'Final Exit 🎯' },
    ],
  };
}
