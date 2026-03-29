// ════════════════════════════════════════════════════════════════
// 🧠 LEARNING MICKEY - USAGE EXAMPLES
// ════════════════════════════════════════════════════════════════

import {
  LearningMickey,
  type LearningConfig,
  type MarketData,
  type Position,
  type TradingSignal,
} from './learning-bot.js';

// ════════════════════════════════════════════════════════════════
// EXAMPLE 1: Basic Setup
// ════════════════════════════════════════════════════════════════

function example1_BasicSetup() {
  console.log('\n=== EXAMPLE 1: Basic Setup ===\n');

  // Initialize Mickey with default config
  const mickey = new LearningMickey();

  // Load previous brain data (if exists)
  mickey.loadBrain();

  // Display current stats
  const stats = mickey.getStatistics();
  console.log('Current Stats:', stats);
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 2: Custom Configuration
// ════════════════════════════════════════════════════════════════

function example2_CustomConfig() {
  console.log('\n=== EXAMPLE 2: Custom Configuration ===\n');

  // Custom configuration
  const customConfig: Partial<LearningConfig> = {
    minTradesToLearn: 10, // Need 10 trades before forming opinions
    confidenceThreshold: 75, // Only take trades above 75% confidence
    iqPerTrade: 1.0, // Learn faster
    maxHistorySize: 2000, // Keep more history
    brainFilePath: 'mickey_brain_custom.json',
    backupBrain: true,
    autoSave: true,
  };

  const mickey = new LearningMickey(customConfig);
  mickey.loadBrain();

  console.log('Mickey initialized with custom config!');
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 3: Evaluating a Signal Before Trading
// ════════════════════════════════════════════════════════════════

function example3_EvaluateSignal() {
  console.log('\n=== EXAMPLE 3: Evaluating a Signal ===\n');

  const mickey = new LearningMickey();
  mickey.loadBrain();

  // You have a trading signal
  const signal: TradingSignal = {
    symbol: 'BTCUSDT',
    strategy: 'RSI_OVERSOLD',
    confidence: 72,
    side: 'LONG',
    price: 50000,
  };

  // Current market data
  const marketData: MarketData = {
    rsi: 28,
    volume: 1500000,
    volatility: 2.5,
    condition: 'VOLATILE',
    price: 50000,
    trend: 'DOWN',
  };

  // Ask Mickey's opinion
  const evaluation = mickey.evaluateSignal(signal, marketData);

  console.log('Signal Evaluation:');
  console.log(`  Should Trade: ${evaluation.shouldTrade}`);
  console.log(
    `  Adjusted Confidence: ${evaluation.adjustedConfidence.toFixed(1)}%`
  );
  console.log(`  Reason: ${evaluation.reason}`);

  if (evaluation.warnings.length > 0) {
    console.log('\n  Warnings:');
    evaluation.warnings.forEach((w) => console.log(`    ${w}`));
  }

  if (evaluation.strengths.length > 0) {
    console.log('\n  Strengths:');
    evaluation.strengths.forEach((s) => console.log(`    ${s}`));
  }

  // Decision
  if (evaluation.shouldTrade) {
    console.log('\n✅ Taking the trade!');
    // executeTrade(signal);
  } else {
    console.log('\n❌ Skipping this trade.');
  }
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 4: Recording a Completed Trade
// ════════════════════════════════════════════════════════════════

function example4_RecordTrade() {
  console.log('\n=== EXAMPLE 4: Recording a Trade ===\n');

  const mickey = new LearningMickey();
  mickey.loadBrain();

  // Winning trade
  const winningPosition: Position = {
    symbol: 'BTCUSDT',
    strategy: 'RSI_OVERSOLD',
    side: 'LONG',
    entryPrice: 50000,
    exitPrice: 51500,
    pnlUsd: 150,
    pnlPercent: 3.0,
    closeReason: 'TAKE_PROFIT',
    holdTime: 45, // minutes
  };

  const marketData: MarketData = {
    rsi: 28,
    volume: 1500000,
    volatility: 2.5,
    condition: 'VOLATILE',
  };

  // Mickey learns from this trade
  mickey.recordTrade(winningPosition, marketData);

  // Losing trade
  const losingPosition: Position = {
    symbol: 'ETHUSDT',
    strategy: 'BREAKOUT',
    side: 'SHORT',
    entryPrice: 3000,
    exitPrice: 3090,
    pnlUsd: -45,
    pnlPercent: -3.0,
    closeReason: 'STOP_LOSS',
    holdTime: 15,
  };

  const marketData2: MarketData = {
    rsi: 65,
    volume: 800000,
    volatility: 1.8,
    condition: 'TRENDING',
  };

  mickey.recordTrade(losingPosition, marketData2);

  console.log('\nTrades recorded! Mickey has learned from both.');
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 5: Full Trading Bot Integration
// ════════════════════════════════════════════════════════════════

async function example5_FullIntegration() {
  console.log('\n=== EXAMPLE 5: Full Bot Integration ===\n');

  const mickey = new LearningMickey({
    confidenceThreshold: 70,
    minTradesToLearn: 5,
    autoSave: true,
  });

  mickey.loadBrain();

  // Simulated trading loop
  const signals: TradingSignal[] = [
    {
      symbol: 'BTCUSDT',
      strategy: 'RSI_OVERSOLD',
      confidence: 75,
      side: 'LONG',
    },
    {
      symbol: 'ETHUSDT',
      strategy: 'MACD_CROSS',
      confidence: 68,
      side: 'SHORT',
    },
    {
      symbol: 'SOLUSDT',
      strategy: 'SUPPORT_BOUNCE',
      confidence: 82,
      side: 'LONG',
    },
  ];

  for (const signal of signals) {
    console.log(`\n--- Evaluating ${signal.symbol} ---`);

    // Get market data (simulated)
    const marketData: MarketData = {
      rsi: Math.random() * 100,
      volume: Math.random() * 2000000,
      volatility: Math.random() * 5,
      condition: ['VOLATILE', 'TRENDING', 'RANGING', 'CHOPPY'][
        Math.floor(Math.random() * 4)
      ] as any,
    };

    // Ask Mickey
    const evaluation = mickey.evaluateSignal(signal, marketData);

    console.log(
      `Confidence: ${evaluation.adjustedConfidence.toFixed(1)}% | Should Trade: ${evaluation.shouldTrade}`
    );

    if (evaluation.shouldTrade) {
      console.log('✅ Opening position...');

      // Simulate trade execution and result
      const position: Position = {
        symbol: signal.symbol,
        strategy: signal.strategy,
        side: signal.side,
        entryPrice: 50000,
        exitPrice: Math.random() > 0.5 ? 51000 : 49500,
        pnlUsd: Math.random() > 0.5 ? 100 : -50,
        closeReason: Math.random() > 0.5 ? 'TAKE_PROFIT' : 'STOP_LOSS',
        holdTime: Math.floor(Math.random() * 120),
      };

      // Wait for position to close (simulated)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mickey learns
      mickey.recordTrade(position, marketData);
    } else {
      console.log('❌ Skipping trade');
    }
  }

  // Show report card
  mickey.displayReportCard();
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 6: Analyzing Symbol Performance
// ════════════════════════════════════════════════════════════════

function example6_AnalyzeSymbol() {
  console.log('\n=== EXAMPLE 6: Analyzing Symbol Performance ===\n');

  const mickey = new LearningMickey();
  mickey.loadBrain();

  const symbolToAnalyze = 'BTCUSDT';
  const insights = mickey.getSymbolInsights(symbolToAnalyze);

  if (insights) {
    console.log(`📊 Insights for ${symbolToAnalyze}:`);
    console.log(`  Total Trades: ${insights.trades}`);
    console.log(`  Win Rate: ${insights.winRate.toFixed(1)}%`);
    console.log(
      `  Total P&L: ${insights.totalPnl > 0 ? '+' : ''}${insights.totalPnl.toFixed(2)} USDT`
    );
    console.log(`  Risk Level: ${insights.riskLevel}`);
    console.log(
      `  Confidence Adjustment: ${insights.confidenceAdjustment > 0 ? '+' : ''}${insights.confidenceAdjustment}`
    );

    if (insights.preferredSide !== 'NEUTRAL') {
      console.log(`  Preferred Side: ${insights.preferredSide}`);
    }

    if (insights.bestTimeOfDay.length > 0) {
      console.log(`  Best Trading Hours: ${insights.bestTimeOfDay.join(', ')}`);
    }

    if (insights.avoidTimeOfDay.length > 0) {
      console.log(
        `  Avoid Trading Hours: ${insights.avoidTimeOfDay.join(', ')}`
      );
    }

    if (insights.bestMarketCondition) {
      console.log(`  Best Market Condition: ${insights.bestMarketCondition}`);
    }

    if (insights.worstMarketCondition) {
      console.log(`  Worst Market Condition: ${insights.worstMarketCondition}`);
    }

    if (insights.notes.length > 0) {
      console.log('\n  Recent Insights:');
      insights.notes.slice(-3).forEach((note) => console.log(`    ${note}`));
    }
  } else {
    console.log(`No data available for ${symbolToAnalyze} yet.`);
  }
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 7: Strategy Performance Analysis
// ════════════════════════════════════════════════════════════════

function example7_AnalyzeStrategy() {
  console.log('\n=== EXAMPLE 7: Analyzing Strategy Performance ===\n');

  const mickey = new LearningMickey();
  mickey.loadBrain();

  const strategyToAnalyze = 'RSI_OVERSOLD';
  const insights = mickey.getStrategyInsights(strategyToAnalyze);

  if (insights) {
    console.log(`🎯 Performance of ${strategyToAnalyze}:`);
    console.log(`  Total Trades: ${insights.trades}`);
    console.log(`  Win Rate: ${insights.winRate.toFixed(1)}%`);
    console.log(`  Profit Factor: ${insights.profitFactor.toFixed(2)}`);
    console.log(`  Confidence Score: ${insights.confidence.toFixed(0)}%`);
    console.log(`  Avg Hold Time: ${insights.avgHoldTime.toFixed(0)} minutes`);
    console.log(
      `  Total P&L: ${insights.totalPnl > 0 ? '+' : ''}${insights.totalPnl.toFixed(2)} USDT`
    );
    console.log(`  Avg Win: +${insights.averageWin.toFixed(2)} USDT`);
    console.log(`  Avg Loss: -${insights.averageLoss.toFixed(2)} USDT`);

    // Recommendation
    if (insights.confidence > 70) {
      console.log('\n  ✅ Highly recommended strategy!');
    } else if (insights.confidence > 50) {
      console.log('\n  ⚠️ Use with caution');
    } else {
      console.log('\n  ❌ Consider avoiding this strategy');
    }
  } else {
    console.log(`No data available for ${strategyToAnalyze} yet.`);
  }
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 8: Manual Save/Load
// ════════════════════════════════════════════════════════════════

function example8_ManualSaveLoad() {
  console.log('\n=== EXAMPLE 8: Manual Save/Load ===\n');

  // Create Mickey with auto-save disabled
  const mickey = new LearningMickey({
    autoSave: false,
    brainFilePath: 'mickey_manual.json',
  });

  // Simulate some trades
  for (let i = 0; i < 5; i++) {
    const position: Position = {
      symbol: 'BTCUSDT',
      strategy: 'TEST',
      side: 'LONG',
      entryPrice: 50000,
      exitPrice: 50500,
      pnlUsd: 50,
    };

    const marketData: MarketData = {
      rsi: 50,
      volume: 1000000,
    };

    mickey.recordTrade(position, marketData);
  }

  // Manually save
  console.log('Saving brain manually...');
  mickey.saveBrain();

  // Create new instance and load
  console.log('\nCreating new Mickey instance...');
  const mickey2 = new LearningMickey({
    brainFilePath: 'mickey_manual.json',
  });

  mickey2.loadBrain();

  const stats = mickey2.getStatistics();
  console.log('Loaded Stats:', stats);
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 9: Reset Brain (for testing)
// ════════════════════════════════════════════════════════════════

function example9_ResetBrain() {
  console.log('\n=== EXAMPLE 9: Reset Brain ===\n');

  const mickey = new LearningMickey();
  mickey.loadBrain();

  console.log('Before reset:');
  console.log(mickey.getStatistics());

  console.log('\nResetting brain...');
  mickey.resetBrain();

  console.log('\nAfter reset:');
  console.log(mickey.getStatistics());
}

// ════════════════════════════════════════════════════════════════
// EXAMPLE 10: Real-World Bot Integration Template
// ════════════════════════════════════════════════════════════════

class TradingBot {
  private mickey: LearningMickey;

  constructor() {
    this.mickey = new LearningMickey({
      confidenceThreshold: 70,
      minTradesToLearn: 5,
      autoSave: true,
      backupBrain: true,
    });

    this.mickey.loadBrain();
  }

  async evaluateAndTrade(signal: TradingSignal, marketData: MarketData) {
    // Ask Mickey's opinion
    const evaluation = this.mickey.evaluateSignal(signal, marketData);

    console.log(
      `\n🤔 Evaluating ${signal.symbol} ${signal.side} (${signal.strategy})`
    );
    console.log(evaluation.reason);

    if (!evaluation.shouldTrade) {
      console.log('❌ Mickey advises to skip this trade');
      return null;
    }

    console.log('✅ Mickey approves! Opening position...');

    // Execute trade (your implementation)
    const position = await this.openPosition(signal);

    // Wait for position to close (your implementation)
    const closedPosition = await this.waitForClose(position);

    // Mickey learns
    this.mickey.recordTrade(closedPosition, marketData);

    return closedPosition;
  }

  private async openPosition(signal: TradingSignal): Promise<Position> {
    // Your trade execution logic
    return {
      symbol: signal.symbol,
      strategy: signal.strategy,
      side: signal.side,
      entryPrice: 50000,
      pnlUsd: 0,
    };
  }

  private async waitForClose(position: Position): Promise<Position> {
    // Your position monitoring logic
    return {
      ...position,
      exitPrice: 51000,
      pnlUsd: 100,
      closeReason: 'TAKE_PROFIT',
      holdTime: 45,
    };
  }

  showReportCard() {
    this.mickey.displayReportCard();
  }

  getStats() {
    return this.mickey.getStatistics();
  }
}

// ════════════════════════════════════════════════════════════════
// RUN EXAMPLES
// ════════════════════════════════════════════════════════════════

async function runAllExamples() {
  console.log('\n');
  console.log('════════════════════════════════════════════════════════');
  console.log('🧠 LEARNING MICKEY - USAGE EXAMPLES');
  console.log('════════════════════════════════════════════════════════');

  // Run examples
  example1_BasicSetup();
  example2_CustomConfig();
  example3_EvaluateSignal();
  example4_RecordTrade();
  await example5_FullIntegration();
  example6_AnalyzeSymbol();
  example7_AnalyzeStrategy();
  example8_ManualSaveLoad();
  example9_ResetBrain();

  console.log('\n');
  console.log('════════════════════════════════════════════════════════');
  console.log('✅ All examples completed!');
  console.log('════════════════════════════════════════════════════════\n');
}

// Uncomment to run examples
runAllExamples();

// Export for use in your bot
export { TradingBot, runAllExamples };
