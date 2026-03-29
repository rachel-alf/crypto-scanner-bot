// // ════════════════════════════════════════════════════════════════
// // 🧠 MICKEY'S LEARNING SYSTEM
// // From Chimpanzee (IQ 40) to Warren Buffett (IQ 200)
// // ════════════════════════════════════════════════════════════════
// import fs from 'fs';
// import path from 'path';

// interface TradeLesson {
//   symbol: string;
//   strategy: string;
//   side: 'LONG' | 'SHORT';
//   entryPrice: number;
//   exitPrice: number;
//   pnl: number;
//   result: 'WIN' | 'LOSS';
//   marketCondition: 'VOLATILE' | 'TRENDING' | 'RANGING' | 'CHOPPY';
//   rsi: number;
//   volume: number;
//   timeOfDay: number; // Hour of day (0-23)
//   reason: string;
//   timestamp: Date;
// }

// interface SymbolProfile {
//   symbol: string;
//   trades: number;
//   wins: number;
//   losses: number;
//   winRate: number;
//   averageWin: number;
//   averageLoss: number;
//   bestStrategy: string;
//   worstStrategy: string;
//   preferredSide: 'LONG' | 'SHORT' | 'NEUTRAL';
//   bestTimeOfDay: number[]; // Hours that work best
//   avoidTimeOfDay: number[]; // Hours to avoid
//   bestMarketCondition: string;
//   worstMarketCondition: string;
//   confidenceAdjustment: number; // -20 to +20 (added to signal confidence)
//   notes: string[];
// }

// interface StrategyPerformance {
//   strategy: string;
//   trades: number;
//   wins: number;
//   losses: number;
//   winRate: number;
//   averageWin: number;
//   averageLoss: number;
//   profitFactor: number;
//   confidence: number; // How confident we are in this strategy
// }

// class LearningMickey {
//   // 🧠 Mickey's Brain
//   private tradeHistory: TradeLesson[] = [];
//   private symbolProfiles: Map<string, SymbolProfile> = new Map();
//   private strategyPerformance: Map<string, StrategyPerformance> = new Map();
//   private mickeyIQ: number = 40; // Starts as chimpanzee
//   private tradesNeededForGenius: number = 200;

//   // 📚 Learning configuration
//   private readonly MIN_TRADES_TO_LEARN = 5; // Need at least 5 trades to form opinion
//   private readonly CONFIDENCE_THRESHOLD = 70; // Only take trades above this after learning
//   private readonly IQ_PER_TRADE = 0.5; // IQ increases per trade (capped at 200)

//   // ════════════════════════════════════════════════════════════════
//   // 📝 RECORD TRADE (Mickey learns from this)
//   // ════════════════════════════════════════════════════════════════

//   async recordTrade(position: Position, marketData: any): Promise<void> {
//     const lesson: TradeLesson = {
//       symbol: position.symbol,
//       strategy: position.strategy,
//       side: position.side,
//       entryPrice: position.entryPrice,
//       exitPrice: position.exitPrice || position.entryPrice,
//       pnl: position.pnlUsd,
//       result: position.pnlUsd > 0 ? 'WIN' : 'LOSS',
//       marketCondition: this.detectMarketCondition(marketData),
//       rsi: marketData.rsi || 50,
//       volume: marketData.volume || 0,
//       timeOfDay: new Date().getHours(),
//       reason: position.closeReason || 'UNKNOWN',
//       timestamp: new Date(),
//     };

//     this.tradeHistory.push(lesson);

//     // 🧠 Mickey learns from this trade
//     await this.learnFromTrade(lesson);

//     // 📈 Increase IQ
//     this.mickeyIQ = Math.min(200, this.mickeyIQ + this.IQ_PER_TRADE);

//     // 💾 Save brain
//     this.saveBrain();

//     this.displayLearningProgress(lesson);
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 🧠 LEARN FROM TRADE
//   // ════════════════════════════════════════════════════════════════

//   private async learnFromTrade(lesson: TradeLesson): Promise<void> {
//     // 1. Update symbol profile
//     this.updateSymbolProfile(lesson);

//     // 2. Update strategy performance
//     this.updateStrategyPerformance(lesson);

//     // 3. Identify patterns
//     this.identifyPatterns(lesson);
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 📊 UPDATE SYMBOL PROFILE
//   // ════════════════════════════════════════════════════════════════

//   private updateSymbolProfile(lesson: TradeLesson): void {
//     let profile = this.symbolProfiles.get(lesson.symbol);

//     if (!profile) {
//       profile = {
//         symbol: lesson.symbol,
//         trades: 0,
//         wins: 0,
//         losses: 0,
//         winRate: 0,
//         averageWin: 0,
//         averageLoss: 0,
//         bestStrategy: '',
//         worstStrategy: '',
//         preferredSide: 'NEUTRAL',
//         bestTimeOfDay: [],
//         avoidTimeOfDay: [],
//         bestMarketCondition: '',
//         worstMarketCondition: '',
//         confidenceAdjustment: 0,
//         notes: [],
//       };
//     }

//     profile.trades++;

//     if (lesson.result === 'WIN') {
//       profile.wins++;
//       profile.averageWin =
//         (profile.averageWin * (profile.wins - 1) + lesson.pnl) / profile.wins;
//     } else {
//       profile.losses++;
//       profile.averageLoss =
//         (profile.averageLoss * (profile.losses - 1) + Math.abs(lesson.pnl)) /
//         profile.losses;
//     }

//     profile.winRate = (profile.wins / profile.trades) * 100;

//     // 🎯 Adjust confidence based on performance
//     if (profile.trades >= this.MIN_TRADES_TO_LEARN) {
//       if (profile.winRate > 60) {
//         profile.confidenceAdjustment = Math.min(20, (profile.winRate - 50) / 2);
//         profile.notes.push(
//           `✅ Strong performer! Win rate: ${profile.winRate.toFixed(1)}%`
//         );
//       } else if (profile.winRate < 35) {
//         profile.confidenceAdjustment = Math.max(
//           -20,
//           -(50 - profile.winRate) / 2
//         );
//         profile.notes.push(
//           `⚠️ Weak performer. Win rate: ${profile.winRate.toFixed(1)}%`
//         );
//       }
//     }

//     this.symbolProfiles.set(lesson.symbol, profile);
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 📈 UPDATE STRATEGY PERFORMANCE
//   // ════════════════════════════════════════════════════════════════

//   private updateStrategyPerformance(lesson: TradeLesson): void {
//     let perf = this.strategyPerformance.get(lesson.strategy);

//     if (!perf) {
//       perf = {
//         strategy: lesson.strategy,
//         trades: 0,
//         wins: 0,
//         losses: 0,
//         winRate: 0,
//         averageWin: 0,
//         averageLoss: 0,
//         profitFactor: 0,
//         confidence: 50,
//       };
//     }

//     perf.trades++;

//     if (lesson.result === 'WIN') {
//       perf.wins++;
//       perf.averageWin =
//         (perf.averageWin * (perf.wins - 1) + lesson.pnl) / perf.wins;
//     } else {
//       perf.losses++;
//       perf.averageLoss =
//         (perf.averageLoss * (perf.losses - 1) + Math.abs(lesson.pnl)) /
//         perf.losses;
//     }

//     perf.winRate = (perf.wins / perf.trades) * 100;
//     perf.profitFactor =
//       perf.averageLoss > 0
//         ? (perf.averageWin * perf.wins) / (perf.averageLoss * perf.losses)
//         : 0;

//     // Adjust strategy confidence
//     perf.confidence = Math.min(
//       100,
//       Math.max(0, 50 + (perf.winRate - 50) + (perf.profitFactor - 1) * 10)
//     );

//     this.strategyPerformance.set(lesson.strategy, perf);
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 🔍 IDENTIFY PATTERNS
//   // ════════════════════════════════════════════════════════════════

//   private identifyPatterns(lesson: TradeLesson): void {
//     const recentTrades = this.tradeHistory.slice(-20); // Last 20 trades

//     // Pattern 1: Time of day analysis
//     const hourlyPerformance = new Map<
//       number,
//       { wins: number; losses: number }
//     >();

//     for (const trade of recentTrades) {
//       const hour = trade.timeOfDay;
//       const perf = hourlyPerformance.get(hour) || { wins: 0, losses: 0 };

//       if (trade.result === 'WIN') perf.wins++;
//       else perf.losses++;

//       hourlyPerformance.set(hour, perf);
//     }

//     // Pattern 2: Market condition analysis
//     const conditionPerformance = new Map<
//       string,
//       { wins: number; losses: number }
//     >();

//     for (const trade of recentTrades) {
//       const cond = trade.marketCondition;
//       const perf = conditionPerformance.get(cond) || { wins: 0, losses: 0 };

//       if (trade.result === 'WIN') perf.wins++;
//       else perf.losses++;

//       conditionPerformance.set(cond, perf);
//     }

//     // Pattern 3: RSI range analysis
//     const rsiWins = recentTrades
//       .filter((t) => t.result === 'WIN')
//       .map((t) => t.rsi);
//     const rsiLosses = recentTrades
//       .filter((t) => t.result === 'LOSS')
//       .map((t) => t.rsi);

//     // Mickey learns: "I do better when RSI is between X and Y"
//     // (Implementation would analyze these patterns)
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 🎯 EVALUATE SIGNAL (Mickey applies his learning)
//   // ════════════════════════════════════════════════════════════════

//   evaluateSignal(
//     signal: any,
//     marketData: any
//   ): {
//     shouldTrade: boolean;
//     adjustedConfidence: number;
//     reason: string;
//   } {
//     let adjustedConfidence = signal.confidence;
//     const reasons: string[] = [];

//     // 🧠 Check if Mickey has learned about this symbol
//     const profile = this.symbolProfiles.get(signal.symbol);

//     if (profile && profile.trades >= this.MIN_TRADES_TO_LEARN) {
//       adjustedConfidence += profile.confidenceAdjustment;

//       if (profile.confidenceAdjustment > 0) {
//         reasons.push(
//           `📈 Mickey likes ${signal.symbol} (${profile.winRate.toFixed(0)}% win rate)`
//         );
//       } else if (profile.confidenceAdjustment < 0) {
//         reasons.push(
//           `⚠️ Mickey is cautious about ${signal.symbol} (${profile.winRate.toFixed(0)}% win rate)`
//         );
//       }
//     }

//     // 🧠 Check strategy performance
//     const stratPerf = this.strategyPerformance.get(signal.strategy);

//     if (stratPerf && stratPerf.trades >= this.MIN_TRADES_TO_LEARN) {
//       const stratAdjustment = (stratPerf.confidence - 50) / 5; // -10 to +10
//       adjustedConfidence += stratAdjustment;

//       if (stratPerf.winRate > 60) {
//         reasons.push(
//           `✅ ${signal.strategy} is working well (${stratPerf.winRate.toFixed(0)}% win rate)`
//         );
//       } else if (stratPerf.winRate < 40) {
//         reasons.push(
//           `❌ ${signal.strategy} struggling (${stratPerf.winRate.toFixed(0)}% win rate)`
//         );
//       }
//     }

//     // 🧠 Check time of day
//     const currentHour = new Date().getHours();
//     // (Would analyze hourly performance here)

//     // 🧠 Check market condition
//     const condition = this.detectMarketCondition(marketData);
//     // (Would analyze condition performance here)

//     // 🎓 Mickey's decision
//     const shouldTrade = adjustedConfidence >= this.CONFIDENCE_THRESHOLD;

//     const finalReason = shouldTrade
//       ? `🧠 Mickey (IQ ${this.mickeyIQ.toFixed(0)}): ${reasons.join(', ')}`
//       : `🤔 Mickey (IQ ${this.mickeyIQ.toFixed(0)}): Confidence too low (${adjustedConfidence.toFixed(0)}%)`;

//     return {
//       shouldTrade,
//       adjustedConfidence: Math.min(100, Math.max(0, adjustedConfidence)),
//       reason: finalReason,
//     };
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 📊 DISPLAY LEARNING PROGRESS
//   // ════════════════════════════════════════════════════════════════

//   private displayLearningProgress(lesson: TradeLesson): void {
//     const totalTrades = this.tradeHistory.length;
//     const progressToGenius = (totalTrades / this.tradesNeededForGenius) * 100;

//     log(``, 'info');
//     log(`═══════════════════════════════════════════════════════`, 'info');
//     log(`🧠 MICKEY'S LEARNING UPDATE`, 'info');
//     log(`═══════════════════════════════════════════════════════`, 'info');
//     log(
//       `   Trade: ${lesson.symbol} ${lesson.side} - ${lesson.result}`,
//       lesson.result === 'WIN' ? 'success' : 'error'
//     );
//     log(
//       `   P&L: ${lesson.pnl > 0 ? '+' : ''}${lesson.pnl.toFixed(2)} USDT`,
//       'info'
//     );
//     log(``, 'info');
//     log(`   Mickey's IQ: ${this.mickeyIQ.toFixed(1)} / 200`, 'info');
//     log(`   Total Trades: ${totalTrades}`, 'info');
//     log(`   Progress to Genius: ${progressToGenius.toFixed(1)}%`, 'info');

//     // Show what Mickey learned
//     const profile = this.symbolProfiles.get(lesson.symbol);
//     if (profile && profile.trades >= this.MIN_TRADES_TO_LEARN) {
//       log(``, 'info');
//       log(`   📚 Mickey's notes on ${lesson.symbol}:`, 'info');
//       log(`      Win Rate: ${profile.winRate.toFixed(1)}%`, 'info');
//       log(
//         `      Confidence Adjustment: ${profile.confidenceAdjustment > 0 ? '+' : ''}${profile.confidenceAdjustment.toFixed(1)}`,
//         'info'
//       );
//       if (profile.notes.length > 0) {
//         log(
//           `      Latest insight: ${profile.notes[profile.notes.length - 1]}`,
//           'info'
//         );
//       }
//     }

//     log(`═══════════════════════════════════════════════════════`, 'info');
//     log(``, 'info');

//     // Milestone announcements
//     if (this.mickeyIQ === 80) {
//       log(
//         `🎓 MILESTONE: Mickey reached IQ 80 - No longer a chimpanzee!`,
//         'success'
//       );
//     } else if (this.mickeyIQ === 120) {
//       log(
//         `🎓 MILESTONE: Mickey reached IQ 120 - Above average trader!`,
//         'success'
//       );
//     } else if (this.mickeyIQ === 160) {
//       log(`🎓 MILESTONE: Mickey reached IQ 160 - Genius level!`, 'success');
//     } else if (this.mickeyIQ === 200) {
//       log(
//         `🏆 LEGENDARY: Mickey reached IQ 200 - WARREN BUFFETT LEVEL! 🏆`,
//         'success'
//       );
//     }
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 🎓 MICKEY'S REPORT CARD
//   // ════════════════════════════════════════════════════════════════

//   displayReportCard(): void {
//     console.log('\n════════════════════════════════════════════════════════');
//     console.log("🎓 MICKEY'S REPORT CARD");
//     console.log('════════════════════════════════════════════════════════');
//     console.log(`   IQ Level: ${this.mickeyIQ.toFixed(1)} / 200`);
//     console.log(`   Total Trades: ${this.tradeHistory.length}`);
//     console.log(`   Experience: ${this.getExperienceLevel()}`);
//     console.log('');

//     // Top performing symbols
//     console.log("📈 BEST SYMBOLS (Mickey's favorites):");
//     const topSymbols = Array.from(this.symbolProfiles.values())
//       .filter((p) => p.trades >= this.MIN_TRADES_TO_LEARN)
//       .sort((a, b) => b.winRate - a.winRate)
//       .slice(0, 5);

//     for (const symbol of topSymbols) {
//       console.log(
//         `   ✅ ${symbol.symbol.padEnd(12)} - ${symbol.winRate.toFixed(1)}% win rate (${symbol.trades} trades)`
//       );
//     }

//     // Worst performing symbols
//     console.log('');
//     console.log('📉 WORST SYMBOLS (Mickey avoids these):');
//     const worstSymbols = Array.from(this.symbolProfiles.values())
//       .filter((p) => p.trades >= this.MIN_TRADES_TO_LEARN)
//       .sort((a, b) => a.winRate - b.winRate)
//       .slice(0, 5);

//     for (const symbol of worstSymbols) {
//       console.log(
//         `   ❌ ${symbol.symbol.padEnd(12)} - ${symbol.winRate.toFixed(1)}% win rate (${symbol.trades} trades)`
//       );
//     }

//     // Best strategies
//     console.log('');
//     console.log('🎯 BEST STRATEGIES:');
//     const topStrats = Array.from(this.strategyPerformance.values())
//       .filter((s) => s.trades >= this.MIN_TRADES_TO_LEARN)
//       .sort((a, b) => b.winRate - a.winRate)
//       .slice(0, 5);

//     for (const strat of topStrats) {
//       console.log(
//         `   ✅ ${strat.strategy.padEnd(20)} - ${strat.winRate.toFixed(1)}% (PF: ${strat.profitFactor.toFixed(2)})`
//       );
//     }

//     console.log('════════════════════════════════════════════════════════\n');
//   }

//   // ════════════════════════════════════════════════════════════════
//   // 💾 SAVE/LOAD MICKEY'S BRAIN
//   // ════════════════════════════════════════════════════════════════

//   private saveBrain(): void {
//     const brain = {
//       iq: this.mickeyIQ,
//       tradeHistory: this.tradeHistory,
//       symbolProfiles: Array.from(this.symbolProfiles.entries()),
//       strategyPerformance: Array.from(this.strategyPerformance.entries()),
//       lastUpdate: new Date().toISOString(),
//     };

//     fs.writeFileSync('mickey_brain.json', JSON.stringify(brain, null, 2));
//   }

//   loadBrain(): void {
//     try {
//       if (fs.existsSync('mickey_brain.json')) {
//         const brain = JSON.parse(fs.readFileSync('mickey_brain.json', 'utf-8'));

//         this.mickeyIQ = brain.iq || 40;
//         this.tradeHistory = brain.tradeHistory || [];
//         this.symbolProfiles = new Map(brain.symbolProfiles || []);
//         this.strategyPerformance = new Map(brain.strategyPerformance || []);

//         log(
//           `🧠 Mickey's brain loaded: IQ ${this.mickeyIQ.toFixed(1)}, ${this.tradeHistory.length} trades remembered`,
//           'success'
//         );
//       }
//     } catch (error: any) {
//       log(`⚠️ Could not load Mickey's brain: ${error.message}`, 'warning');
//     }
//   }

//   // ════════════════════════════════════════════════════════════════
//   // HELPERS
//   // ════════════════════════════════════════════════════════════════

//   private detectMarketCondition(
//     marketData: any
//   ): 'VOLATILE' | 'TRENDING' | 'RANGING' | 'CHOPPY' {
//     // Simplified - would use actual market data
//     return 'RANGING';
//   }

//   private getExperienceLevel(): string {
//     if (this.mickeyIQ < 60) return '🐵 Chimpanzee Trader';
//     if (this.mickeyIQ < 90) return '📚 Learning Trader';
//     if (this.mickeyIQ < 120) return '🎓 Competent Trader';
//     if (this.mickeyIQ < 150) return '🧠 Smart Trader';
//     if (this.mickeyIQ < 180) return '💎 Expert Trader';
//     return '🏆 Warren Buffett Level';
//   }
// }

// // ════════════════════════════════════════════════════════════════
// // TYPES
// // ════════════════════════════════════════════════════════════════

// interface Position {
//   symbol: string;
//   strategy: string;
//   side: 'LONG' | 'SHORT';
//   entryPrice: number;
//   exitPrice?: number;
//   pnlUsd: number;
//   closeReason?: string;
// }

// function log(message: string, level: string): void {
//   console.log(message);
// }

// // ════════════════════════════════════════════════════════════════
// // USAGE
// // ════════════════════════════════════════════════════════════════

// /*
// const mickey = new LearningMickey();

// // Load Mickey's brain on startup
// mickey.loadBrain();

// // Before taking a trade, ask Mickey's opinion:
// const evaluation = mickey.evaluateSignal(signal, marketData);

// if (evaluation.shouldTrade) {
//   log(evaluation.reason, 'success');
//   // Take the trade
// } else {
//   log(evaluation.reason, 'warning');
//   // Skip the trade
// }

// // After closing a position, Mickey learns:
// await mickey.recordTrade(closedPosition, marketData);

// // View Mickey's progress:
// mickey.displayReportCard();
// */

// ════════════════════════════════════════════════════════════════
// 🧠 MICKEY'S LEARNING SYSTEM v2.0 - IMPROVED
// From Chimpanzee (IQ 40) to Warren Buffett (IQ 200)
// ════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

// ════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ════════════════════════════════════════════════════════════════

export interface TradingSignal {
  symbol: string;
  strategy: string;
  confidence: number;
  side: 'LONG' | 'SHORT';
  price?: number;
}

export interface MarketData {
  rsi?: number;
  volume?: number;
  volatility?: number;
  condition?: MarketCondition;
  price?: number;
  trend?: string;
}

export interface Position {
  symbol: string;
  strategy: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  pnlUsd: number;
  pnlPercent?: number;
  closeReason?: string;
  holdTime?: number; // Minutes
}

export type MarketCondition = 'VOLATILE' | 'TRENDING' | 'RANGING' | 'CHOPPY';
export type TradeResult = 'WIN' | 'LOSS';

export interface TradeLesson {
  symbol: string;
  strategy: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  result: TradeResult;
  marketCondition: MarketCondition;
  rsi: number;
  volume: number;
  timeOfDay: number;
  dayOfWeek: number;
  holdTime: number;
  reason: string;
  timestamp: Date;
}

export interface SymbolProfile {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  totalPnl: number;
  bestStrategy: string;
  worstStrategy: string;
  preferredSide: 'LONG' | 'SHORT' | 'NEUTRAL';
  bestTimeOfDay: number[];
  avoidTimeOfDay: number[];
  bestMarketCondition: MarketCondition | '';
  worstMarketCondition: MarketCondition | '';
  confidenceAdjustment: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  notes: string[];
  lastTradeDate: Date;
}

export interface StrategyPerformance {
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  confidence: number;
  avgHoldTime: number;
  totalPnl: number;
}

export interface EvaluationResult {
  shouldTrade: boolean;
  adjustedConfidence: number;
  reason: string;
  warnings: string[];
  strengths: string[];
}

export interface LearningConfig {
  minTradesToLearn: number;
  confidenceThreshold: number;
  iqPerTrade: number;
  maxIQ: number;
  startingIQ: number;
  maxHistorySize: number;
  brainFilePath: string;
  backupBrain: boolean;
  autoSave: boolean;
  recentTradesWindow: number;
}

export interface BrainData {
  version: string;
  iq: number;
  tradeHistory: TradeLesson[];
  symbolProfiles: [string, SymbolProfile][];
  strategyPerformance: [string, StrategyPerformance][];
  lastUpdate: string;
  totalTrades: number;
}

// ════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: LearningConfig = {
  minTradesToLearn: 5,
  confidenceThreshold: 70,
  iqPerTrade: 0.5,
  maxIQ: 200,
  startingIQ: 40,
  maxHistorySize: 1000,
  brainFilePath: 'mickey_brain.json',
  backupBrain: true,
  autoSave: true,
  recentTradesWindow: 50,
};

// ════════════════════════════════════════════════════════════════
// LEARNING MICKEY CLASS
// ════════════════════════════════════════════════════════════════

export class LearningMickey {
  private tradeHistory: TradeLesson[] = [];
  private symbolProfiles: Map<string, SymbolProfile> = new Map();
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();
  private mickeyIQ: number;
  private config: LearningConfig;

  constructor(config: Partial<LearningConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.mickeyIQ = this.config.startingIQ;
  }

  // ════════════════════════════════════════════════════════════════
  // 📝 RECORD TRADE (Mickey learns from this)
  // ════════════════════════════════════════════════════════════════

  recordTrade(position: Position, marketData: MarketData): void {
    const exitPrice = position.exitPrice || position.entryPrice;
    const pnlPercent =
      ((exitPrice - position.entryPrice) / position.entryPrice) * 100;

    const lesson: TradeLesson = {
      symbol: position.symbol,
      strategy: position.strategy,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl: position.pnlUsd,
      pnlPercent: position.side === 'LONG' ? pnlPercent : -pnlPercent,
      result: position.pnlUsd > 0 ? 'WIN' : 'LOSS',
      marketCondition: this.detectMarketCondition(marketData),
      rsi: marketData.rsi || 50,
      volume: marketData.volume || 0,
      timeOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
      holdTime: position.holdTime || 0,
      reason: position.closeReason || 'UNKNOWN',
      timestamp: new Date(),
    };

    // Add to history with size management
    this.tradeHistory.push(lesson);
    if (this.tradeHistory.length > this.config.maxHistorySize) {
      this.tradeHistory = this.tradeHistory.slice(-this.config.maxHistorySize);
    }

    // 🧠 Mickey learns from this trade
    this.learnFromTrade(lesson);

    // 📈 Increase IQ
    this.mickeyIQ = Math.min(
      this.config.maxIQ,
      this.mickeyIQ + this.config.iqPerTrade
    );

    // 💾 Auto-save brain
    if (this.config.autoSave) {
      this.saveBrain();
    }

    this.displayLearningProgress(lesson);
  }

  // ════════════════════════════════════════════════════════════════
  // 🧠 LEARN FROM TRADE
  // ════════════════════════════════════════════════════════════════

  private learnFromTrade(lesson: TradeLesson): void {
    this.updateSymbolProfile(lesson);
    this.updateStrategyPerformance(lesson);
    this.identifyPatterns(lesson);
  }

  // ════════════════════════════════════════════════════════════════
  // 📊 UPDATE SYMBOL PROFILE
  // ════════════════════════════════════════════════════════════════

  private updateSymbolProfile(lesson: TradeLesson): void {
    let profile = this.symbolProfiles.get(lesson.symbol);

    if (!profile) {
      profile = {
        symbol: lesson.symbol,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        averageWin: 0,
        averageLoss: 0,
        totalPnl: 0,
        bestStrategy: '',
        worstStrategy: '',
        preferredSide: 'NEUTRAL',
        bestTimeOfDay: [],
        avoidTimeOfDay: [],
        bestMarketCondition: '',
        worstMarketCondition: '',
        confidenceAdjustment: 0,
        riskLevel: 'MEDIUM',
        notes: [],
        lastTradeDate: new Date(),
      };
    }

    profile.trades++;
    profile.totalPnl += lesson.pnl;
    profile.lastTradeDate = lesson.timestamp;

    if (lesson.result === 'WIN') {
      profile.wins++;
      profile.averageWin =
        (profile.averageWin * (profile.wins - 1) + lesson.pnl) / profile.wins;
    } else {
      profile.losses++;
      profile.averageLoss =
        (profile.averageLoss * (profile.losses - 1) + Math.abs(lesson.pnl)) /
        profile.losses;
    }

    profile.winRate = (profile.wins / profile.trades) * 100;

    // 🎯 Adjust confidence based on performance
    if (profile.trades >= this.config.minTradesToLearn) {
      // Confidence adjustment based on win rate and profit factor
      const profitFactor =
        profile.averageLoss > 0
          ? (profile.averageWin * profile.wins) /
            (profile.averageLoss * profile.losses)
          : profile.wins > 0
            ? 999
            : 0;

      if (profile.winRate > 60 && profitFactor > 1.5) {
        profile.confidenceAdjustment = Math.min(
          20,
          (profile.winRate - 50) / 2 + (profitFactor - 1) * 5
        );
        profile.riskLevel = 'LOW';
        profile.notes.push(
          `✅ Strong performer! Win rate: ${profile.winRate.toFixed(1)}%, PF: ${profitFactor.toFixed(2)}`
        );
      } else if (profile.winRate > 55 && profitFactor > 1.2) {
        profile.confidenceAdjustment = Math.min(10, (profile.winRate - 50) / 3);
        profile.riskLevel = 'MEDIUM';
      } else if (profile.winRate < 40 || profitFactor < 0.8) {
        profile.confidenceAdjustment = Math.max(
          -20,
          -(50 - profile.winRate) / 2 - (1 - profitFactor) * 5
        );
        profile.riskLevel = 'HIGH';
        profile.notes.push(
          `⚠️ Weak performer. Win rate: ${profile.winRate.toFixed(1)}%, PF: ${profitFactor.toFixed(2)}`
        );
      }

      // Keep only recent notes
      if (profile.notes.length > 10) {
        profile.notes = profile.notes.slice(-10);
      }
    }

    this.symbolProfiles.set(lesson.symbol, profile);
  }

  // ════════════════════════════════════════════════════════════════
  // 📈 UPDATE STRATEGY PERFORMANCE
  // ════════════════════════════════════════════════════════════════

  private updateStrategyPerformance(lesson: TradeLesson): void {
    let perf = this.strategyPerformance.get(lesson.strategy);

    if (!perf) {
      perf = {
        strategy: lesson.strategy,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        averageWin: 0,
        averageLoss: 0,
        profitFactor: 0,
        confidence: 50,
        avgHoldTime: 0,
        totalPnl: 0,
      };
    }

    perf.trades++;
    perf.totalPnl += lesson.pnl;
    perf.avgHoldTime =
      (perf.avgHoldTime * (perf.trades - 1) + lesson.holdTime) / perf.trades;

    if (lesson.result === 'WIN') {
      perf.wins++;
      perf.averageWin =
        (perf.averageWin * (perf.wins - 1) + lesson.pnl) / perf.wins;
    } else {
      perf.losses++;
      perf.averageLoss =
        (perf.averageLoss * (perf.losses - 1) + Math.abs(lesson.pnl)) /
        perf.losses;
    }

    perf.winRate = (perf.wins / perf.trades) * 100;

    // Calculate profit factor with safety checks
    perf.profitFactor =
      perf.averageLoss > 0 && perf.losses > 0
        ? (perf.averageWin * perf.wins) / (perf.averageLoss * perf.losses)
        : perf.wins > 0
          ? 999
          : 0;

    // Adjust strategy confidence
    const winRateBonus = perf.winRate - 50;
    const profitFactorBonus = (perf.profitFactor - 1) * 10;
    const sampleSizeMultiplier = Math.min(
      1,
      perf.trades / (this.config.minTradesToLearn * 4)
    );

    perf.confidence = Math.min(
      100,
      Math.max(
        0,
        50 + (winRateBonus + profitFactorBonus) * sampleSizeMultiplier
      )
    );

    this.strategyPerformance.set(lesson.strategy, perf);
  }

  // ════════════════════════════════════════════════════════════════
  // 🔍 IDENTIFY PATTERNS (Now actually works!)
  // ════════════════════════════════════════════════════════════════

  private identifyPatterns(lesson: TradeLesson): void {
    const recentTrades = this.tradeHistory.slice(
      -this.config.recentTradesWindow
    );

    // Get symbol-specific trades
    const symbolTrades = recentTrades.filter((t) => t.symbol === lesson.symbol);

    if (symbolTrades.length < this.config.minTradesToLearn) {
      return; // Not enough data yet
    }

    const profile = this.symbolProfiles.get(lesson.symbol);
    if (!profile) return;

    // ═══════════════════════════════════════════════════════════
    // PATTERN 1: Time of Day Analysis
    // ═══════════════════════════════════════════════════════════

    const hourlyPerformance = new Map<
      number,
      { wins: number; losses: number; totalPnl: number }
    >();

    for (const trade of symbolTrades) {
      const hour = trade.timeOfDay;
      const perf = hourlyPerformance.get(hour) || {
        wins: 0,
        losses: 0,
        totalPnl: 0,
      };

      if (trade.result === 'WIN') perf.wins++;
      else perf.losses++;
      perf.totalPnl += trade.pnl;

      hourlyPerformance.set(hour, perf);
    }

    // Find best and worst hours (need minimum sample size)
    let bestHours: number[] = [];
    let worstHours: number[] = [];
    let bestWinRate = 0;
    let worstWinRate = 100;

    for (const [hour, perf] of hourlyPerformance) {
      const total = perf.wins + perf.losses;
      if (total >= 3) {
        const winRate = (perf.wins / total) * 100;

        if (winRate >= 70) {
          bestHours.push(hour);
          if (winRate > bestWinRate) bestWinRate = winRate;
        }

        if (winRate <= 30) {
          worstHours.push(hour);
          if (winRate < worstWinRate) worstWinRate = winRate;
        }
      }
    }

    profile.bestTimeOfDay = bestHours;
    profile.avoidTimeOfDay = worstHours;

    // ═══════════════════════════════════════════════════════════
    // PATTERN 2: Market Condition Analysis
    // ═══════════════════════════════════════════════════════════

    const conditionPerformance = new Map<
      MarketCondition,
      { wins: number; losses: number; totalPnl: number }
    >();

    for (const trade of symbolTrades) {
      const cond = trade.marketCondition;
      const perf = conditionPerformance.get(cond) || {
        wins: 0,
        losses: 0,
        totalPnl: 0,
      };

      if (trade.result === 'WIN') perf.wins++;
      else perf.losses++;
      perf.totalPnl += trade.pnl;

      conditionPerformance.set(cond, perf);
    }

    // Find best and worst market conditions
    let bestCondition: MarketCondition | '' = '';
    let worstCondition: MarketCondition | '' = '';
    let bestCondWinRate = 0;
    let worstCondWinRate = 100;

    for (const [cond, perf] of conditionPerformance) {
      const total = perf.wins + perf.losses;
      if (total >= 3) {
        const winRate = (perf.wins / total) * 100;

        if (winRate > bestCondWinRate) {
          bestCondWinRate = winRate;
          bestCondition = cond;
        }

        if (winRate < worstCondWinRate) {
          worstCondWinRate = winRate;
          worstCondition = cond;
        }
      }
    }

    profile.bestMarketCondition = bestCondition;
    profile.worstMarketCondition = worstCondition;

    // ═══════════════════════════════════════════════════════════
    // PATTERN 3: Side Preference (LONG vs SHORT)
    // ═══════════════════════════════════════════════════════════

    const longTrades = symbolTrades.filter((t) => t.side === 'LONG');
    const shortTrades = symbolTrades.filter((t) => t.side === 'SHORT');

    const longWinRate =
      longTrades.length > 0
        ? (longTrades.filter((t) => t.result === 'WIN').length /
            longTrades.length) *
          100
        : 0;

    const shortWinRate =
      shortTrades.length > 0
        ? (shortTrades.filter((t) => t.result === 'WIN').length /
            shortTrades.length) *
          100
        : 0;

    if (longTrades.length >= 3 && shortTrades.length >= 3) {
      if (longWinRate > shortWinRate + 15) {
        profile.preferredSide = 'LONG';
      } else if (shortWinRate > longWinRate + 15) {
        profile.preferredSide = 'SHORT';
      } else {
        profile.preferredSide = 'NEUTRAL';
      }
    }

    // ═══════════════════════════════════════════════════════════
    // PATTERN 4: RSI Sweet Spots
    // ═══════════════════════════════════════════════════════════

    const rsiWins = symbolTrades
      .filter((t) => t.result === 'WIN')
      .map((t) => t.rsi);

    const rsiLosses = symbolTrades
      .filter((t) => t.result === 'LOSS')
      .map((t) => t.rsi);

    if (rsiWins.length >= 3) {
      const avgWinRsi = rsiWins.reduce((a, b) => a + b, 0) / rsiWins.length;
      const avgLossRsi =
        rsiLosses.length > 0
          ? rsiLosses.reduce((a, b) => a + b, 0) / rsiLosses.length
          : 50;

      // Add insight to notes
      if (Math.abs(avgWinRsi - avgLossRsi) > 10) {
        profile.notes.push(
          `📊 RSI insight: Wins avg ${avgWinRsi.toFixed(0)}, Losses avg ${avgLossRsi.toFixed(0)}`
        );
      }
    }

    this.symbolProfiles.set(lesson.symbol, profile);
  }

  // ════════════════════════════════════════════════════════════════
  // 🎯 EVALUATE SIGNAL (Mickey applies his learning)
  // ════════════════════════════════════════════════════════════════

  evaluateSignal(
    signal: TradingSignal,
    marketData: MarketData
  ): EvaluationResult {
    let adjustedConfidence = signal.confidence;
    const warnings: string[] = [];
    const strengths: string[] = [];

    // ═══════════════════════════════════════════════════════════
    // 🧠 Check Symbol Profile
    // ═══════════════════════════════════════════════════════════

    const profile = this.symbolProfiles.get(signal.symbol);

    if (profile && profile.trades >= this.config.minTradesToLearn) {
      // Apply base confidence adjustment
      adjustedConfidence += profile.confidenceAdjustment;

      if (profile.confidenceAdjustment > 5) {
        strengths.push(
          `✅ ${signal.symbol}: ${profile.winRate.toFixed(0)}% WR, ${profile.riskLevel} risk`
        );
      } else if (profile.confidenceAdjustment < -5) {
        warnings.push(
          `⚠️ ${signal.symbol}: ${profile.winRate.toFixed(0)}% WR, ${profile.riskLevel} risk`
        );
      }

      // Check time of day
      const currentHour = new Date().getHours();
      if (profile.avoidTimeOfDay.includes(currentHour)) {
        adjustedConfidence -= 15;
        warnings.push(
          `⏰ Avoid ${signal.symbol} at ${currentHour}:00 (poor history)`
        );
      } else if (profile.bestTimeOfDay.includes(currentHour)) {
        adjustedConfidence += 8;
        strengths.push(`⏰ Good time for ${signal.symbol}`);
      }

      // Check market condition
      const currentCondition =
        marketData.condition || this.detectMarketCondition(marketData);

      if (
        profile.worstMarketCondition &&
        profile.worstMarketCondition === currentCondition
      ) {
        adjustedConfidence -= 12;
        warnings.push(
          `📊 Bad market condition (${currentCondition}) for ${signal.symbol}`
        );
      } else if (
        profile.bestMarketCondition &&
        profile.bestMarketCondition === currentCondition
      ) {
        adjustedConfidence += 8;
        strengths.push(
          `📊 Ideal market condition (${currentCondition}) for ${signal.symbol}`
        );
      }

      // Check side preference
      if (
        profile.preferredSide !== 'NEUTRAL' &&
        profile.preferredSide !== signal.side
      ) {
        adjustedConfidence -= 8;
        warnings.push(
          `🔄 ${signal.symbol} performs better on ${profile.preferredSide} side`
        );
      } else if (profile.preferredSide === signal.side) {
        adjustedConfidence += 5;
        strengths.push(`🔄 Preferred side for ${signal.symbol}`);
      }

      // Check if symbol was recently traded (avoid overtrading)
      const hoursSinceLastTrade =
        (Date.now() - profile.lastTradeDate.getTime()) / (1000 * 60 * 60);

      if (hoursSinceLastTrade < 1) {
        adjustedConfidence -= 10;
        warnings.push(
          `⚡ Recently traded ${signal.symbol} (${hoursSinceLastTrade.toFixed(1)}h ago)`
        );
      }
    }

    // ═══════════════════════════════════════════════════════════
    // 🧠 Check Strategy Performance
    // ═══════════════════════════════════════════════════════════

    const stratPerf = this.strategyPerformance.get(signal.strategy);

    if (stratPerf && stratPerf.trades >= this.config.minTradesToLearn) {
      const stratAdjustment = (stratPerf.confidence - 50) / 5; // -10 to +10
      adjustedConfidence += stratAdjustment;

      if (stratPerf.winRate > 60 && stratPerf.profitFactor > 1.5) {
        strengths.push(
          `✅ ${signal.strategy}: ${stratPerf.winRate.toFixed(0)}% WR, PF ${stratPerf.profitFactor.toFixed(2)}`
        );
      } else if (stratPerf.winRate < 40 || stratPerf.profitFactor < 0.8) {
        warnings.push(
          `❌ ${signal.strategy}: ${stratPerf.winRate.toFixed(0)}% WR, PF ${stratPerf.profitFactor.toFixed(2)}`
        );
      }
    }

    // ═══════════════════════════════════════════════════════════
    // 🎓 Mickey's Final Decision
    // ═══════════════════════════════════════════════════════════

    // Clamp confidence to 0-100
    adjustedConfidence = Math.min(100, Math.max(0, adjustedConfidence));

    const shouldTrade = adjustedConfidence >= this.config.confidenceThreshold;

    // Build reason string
    let reason = `🧠 Mickey (IQ ${this.mickeyIQ.toFixed(0)}): `;

    if (shouldTrade) {
      reason += `TAKE TRADE (${adjustedConfidence.toFixed(0)}% confidence)`;
      if (strengths.length > 0) {
        reason += ` | ${strengths.join(' | ')}`;
      }
      if (warnings.length > 0) {
        reason += ` | Cautions: ${warnings.join(', ')}`;
      }
    } else {
      reason += `SKIP TRADE (${adjustedConfidence.toFixed(0)}% confidence < ${this.config.confidenceThreshold}%)`;
      if (warnings.length > 0) {
        reason += ` | Reasons: ${warnings.join(', ')}`;
      }
    }

    return {
      shouldTrade,
      adjustedConfidence,
      reason,
      warnings,
      strengths,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 📊 DISPLAY LEARNING PROGRESS
  // ════════════════════════════════════════════════════════════════

  private displayLearningProgress(lesson: TradeLesson): void {
    const totalTrades = this.tradeHistory.length;
    const tradesNeededForGenius =
      (this.config.maxIQ - this.config.startingIQ) / this.config.iqPerTrade;
    const progressToGenius = (totalTrades / tradesNeededForGenius) * 100;

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log("🧠 MICKEY'S LEARNING UPDATE");
    console.log('═══════════════════════════════════════════════════════');
    console.log(
      `   Trade: ${lesson.symbol} ${lesson.side} ${lesson.strategy} - ${lesson.result}`
    );
    console.log(
      `   P&L: ${lesson.pnl > 0 ? '+' : ''}${lesson.pnl.toFixed(2)} USDT (${lesson.pnlPercent > 0 ? '+' : ''}${lesson.pnlPercent.toFixed(2)}%)`
    );
    console.log(`   Hold Time: ${lesson.holdTime} minutes`);
    console.log(
      `   Market: ${lesson.marketCondition}, RSI: ${lesson.rsi.toFixed(1)}`
    );
    console.log('');
    console.log(
      `   Mickey's IQ: ${this.mickeyIQ.toFixed(1)} / ${this.config.maxIQ}`
    );
    console.log(`   Total Trades: ${totalTrades}`);
    console.log(`   Progress to Genius: ${progressToGenius.toFixed(1)}%`);

    // Show what Mickey learned
    const profile = this.symbolProfiles.get(lesson.symbol);
    if (profile && profile.trades >= this.config.minTradesToLearn) {
      console.log('');
      console.log(`   📚 Mickey's notes on ${lesson.symbol}:`);
      console.log(`      Win Rate: ${profile.winRate.toFixed(1)}%`);
      console.log(
        `      Total P&L: ${profile.totalPnl > 0 ? '+' : ''}${profile.totalPnl.toFixed(2)} USDT`
      );
      console.log(
        `      Confidence Adjustment: ${profile.confidenceAdjustment > 0 ? '+' : ''}${profile.confidenceAdjustment.toFixed(1)}`
      );
      console.log(`      Risk Level: ${profile.riskLevel}`);

      if (profile.bestTimeOfDay.length > 0) {
        console.log(`      Best Hours: ${profile.bestTimeOfDay.join(', ')}`);
      }

      if (profile.avoidTimeOfDay.length > 0) {
        console.log(`      Avoid Hours: ${profile.avoidTimeOfDay.join(', ')}`);
      }

      if (profile.preferredSide !== 'NEUTRAL') {
        console.log(`      Preferred Side: ${profile.preferredSide}`);
      }

      if (profile.notes.length > 0) {
        console.log(
          `      Latest Insight: ${profile.notes[profile.notes.length - 1]}`
        );
      }
    }

    console.log('═══════════════════════════════════════════════════════');
    console.log('');

    // Milestone announcements
    this.checkMilestones();
  }

  // ════════════════════════════════════════════════════════════════
  // 🏆 CHECK MILESTONES
  // ════════════════════════════════════════════════════════════════

  private checkMilestones(): void {
    const iq = this.mickeyIQ;

    if (iq === 80) {
      console.log(
        '🎓 MILESTONE: Mickey reached IQ 80 - No longer a chimpanzee!'
      );
    } else if (iq === 100) {
      console.log('🎓 MILESTONE: Mickey reached IQ 100 - Average human!');
    } else if (iq === 120) {
      console.log(
        '🎓 MILESTONE: Mickey reached IQ 120 - Above average trader!'
      );
    } else if (iq === 140) {
      console.log('🎓 MILESTONE: Mickey reached IQ 140 - Highly gifted!');
    } else if (iq === 160) {
      console.log('🎓 MILESTONE: Mickey reached IQ 160 - Genius level!');
    } else if (iq === 180) {
      console.log('🎓 MILESTONE: Mickey reached IQ 180 - Near legendary!');
    } else if (iq === 200) {
      console.log(
        '🏆 LEGENDARY: Mickey reached IQ 200 - WARREN BUFFETT LEVEL! 🏆'
      );
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 🎓 MICKEY'S REPORT CARD
  // ════════════════════════════════════════════════════════════════

  displayReportCard(): void {
    console.log('\n════════════════════════════════════════════════════════');
    console.log("🎓 MICKEY'S REPORT CARD");
    console.log('════════════════════════════════════════════════════════');
    console.log(
      `   IQ Level: ${this.mickeyIQ.toFixed(1)} / ${this.config.maxIQ}`
    );
    console.log(`   Experience: ${this.getExperienceLevel()}`);
    console.log(`   Total Trades: ${this.tradeHistory.length}`);
    console.log(`   Symbols Learned: ${this.symbolProfiles.size}`);
    console.log(`   Strategies Tested: ${this.strategyPerformance.size}`);
    console.log('');

    // Overall performance
    const wins = this.tradeHistory.filter((t) => t.result === 'WIN').length;
    const losses = this.tradeHistory.filter((t) => t.result === 'LOSS').length;
    const totalPnl = this.tradeHistory.reduce((sum, t) => sum + t.pnl, 0);
    const overallWinRate =
      this.tradeHistory.length > 0
        ? (wins / this.tradeHistory.length) * 100
        : 0;

    console.log('📊 OVERALL PERFORMANCE:');
    console.log(
      `   Win Rate: ${overallWinRate.toFixed(1)}% (${wins}W / ${losses}L)`
    );
    console.log(
      `   Total P&L: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT`
    );
    console.log('');

    // Top performing symbols
    console.log("📈 BEST SYMBOLS (Mickey's favorites):");
    const topSymbols = Array.from(this.symbolProfiles.values())
      .filter((p) => p.trades >= this.config.minTradesToLearn)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 5);

    if (topSymbols.length === 0) {
      console.log('   (Not enough data yet)');
    } else {
      for (const symbol of topSymbols) {
        console.log(
          `   ✅ ${symbol.symbol.padEnd(12)} - ${symbol.winRate.toFixed(1)}% WR | ${symbol.trades} trades | ${symbol.totalPnl > 0 ? '+' : ''}${symbol.totalPnl.toFixed(2)} USDT`
        );
      }
    }

    // Worst performing symbols
    console.log('');
    console.log('📉 WORST SYMBOLS (Mickey avoids these):');
    const worstSymbols = Array.from(this.symbolProfiles.values())
      .filter((p) => p.trades >= this.config.minTradesToLearn)
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 5);

    if (worstSymbols.length === 0) {
      console.log('   (Not enough data yet)');
    } else {
      for (const symbol of worstSymbols) {
        console.log(
          `   ❌ ${symbol.symbol.padEnd(12)} - ${symbol.winRate.toFixed(1)}% WR | ${symbol.trades} trades | ${symbol.totalPnl > 0 ? '+' : ''}${symbol.totalPnl.toFixed(2)} USDT`
        );
      }
    }

    // Best strategies
    console.log('');
    console.log('🎯 BEST STRATEGIES:');
    const topStrats = Array.from(this.strategyPerformance.values())
      .filter((s) => s.trades >= this.config.minTradesToLearn)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    if (topStrats.length === 0) {
      console.log('   (Not enough data yet)');
    } else {
      for (const strat of topStrats) {
        console.log(
          `   ✅ ${strat.strategy.padEnd(20)} - ${strat.winRate.toFixed(1)}% WR | PF: ${strat.profitFactor.toFixed(2)} | Conf: ${strat.confidence.toFixed(0)}%`
        );
      }
    }

    // Worst strategies
    console.log('');
    console.log('🚫 WORST STRATEGIES:');
    const worstStrats = Array.from(this.strategyPerformance.values())
      .filter((s) => s.trades >= this.config.minTradesToLearn)
      .sort((a, b) => a.confidence - b.confidence)
      .slice(0, 5);

    if (worstStrats.length === 0) {
      console.log('   (Not enough data yet)');
    } else {
      for (const strat of worstStrats) {
        console.log(
          `   ❌ ${strat.strategy.padEnd(20)} - ${strat.winRate.toFixed(1)}% WR | PF: ${strat.profitFactor.toFixed(2)} | Conf: ${strat.confidence.toFixed(0)}%`
        );
      }
    }

    console.log('════════════════════════════════════════════════════════\n');
  }

  // ════════════════════════════════════════════════════════════════
  // 📈 GET STATISTICS
  // ════════════════════════════════════════════════════════════════

  getStatistics(): {
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    iq: number;
    experienceLevel: string;
  } {
    const wins = this.tradeHistory.filter((t) => t.result === 'WIN').length;
    const winRate =
      this.tradeHistory.length > 0
        ? (wins / this.tradeHistory.length) * 100
        : 0;
    const totalPnl = this.tradeHistory.reduce((sum, t) => sum + t.pnl, 0);

    return {
      totalTrades: this.tradeHistory.length,
      winRate,
      totalPnl,
      iq: this.mickeyIQ,
      experienceLevel: this.getExperienceLevel(),
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 🔍 GET SYMBOL INSIGHTS
  // ════════════════════════════════════════════════════════════════

  getSymbolInsights(symbol: string): SymbolProfile | null {
    return this.symbolProfiles.get(symbol) || null;
  }

  // ════════════════════════════════════════════════════════════════
  // 🔍 GET STRATEGY INSIGHTS
  // ════════════════════════════════════════════════════════════════

  getStrategyInsights(strategy: string): StrategyPerformance | null {
    return this.strategyPerformance.get(strategy) || null;
  }

  // ════════════════════════════════════════════════════════════════
  // 💾 SAVE MICKEY'S BRAIN
  // ════════════════════════════════════════════════════════════════

  saveBrain(): void {
    try {
      const brainPath = this.config.brainFilePath;

      // Create backup if enabled
      if (this.config.backupBrain && fs.existsSync(brainPath)) {
        const backupPath = brainPath.replace('.json', '.backup.json');
        fs.copyFileSync(brainPath, backupPath);
      }

      const brain: BrainData = {
        version: '2.0',
        iq: this.mickeyIQ,
        tradeHistory: this.tradeHistory,
        symbolProfiles: Array.from(this.symbolProfiles.entries()),
        strategyPerformance: Array.from(this.strategyPerformance.entries()),
        lastUpdate: new Date().toISOString(),
        totalTrades: this.tradeHistory.length,
      };

      fs.writeFileSync(brainPath, JSON.stringify(brain, null, 2));
    } catch (error: any) {
      console.error(`❌ Failed to save Mickey's brain: ${error.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 💾 LOAD MICKEY'S BRAIN
  // ════════════════════════════════════════════════════════════════

  loadBrain(): boolean {
    try {
      const brainPath = this.config.brainFilePath;

      if (!fs.existsSync(brainPath)) {
        console.log('🧠 No existing brain found. Starting fresh!');
        return false;
      }

      const data = fs.readFileSync(brainPath, 'utf-8');
      const brain: BrainData = JSON.parse(data);

      // Version check
      if (brain.version !== '2.0') {
        console.log(
          `⚠️ Brain version mismatch (${brain.version}). Starting fresh.`
        );
        return false;
      }

      // Load data
      this.mickeyIQ = brain.iq || this.config.startingIQ;
      this.tradeHistory = brain.tradeHistory || [];

      // Convert dates back to Date objects
      this.tradeHistory = this.tradeHistory.map((lesson) => ({
        ...lesson,
        timestamp: new Date(lesson.timestamp),
      }));

      this.symbolProfiles = new Map(
        (brain.symbolProfiles || []).map(([symbol, profile]) => [
          symbol,
          {
            ...profile,
            lastTradeDate: new Date(profile.lastTradeDate),
          },
        ])
      );

      this.strategyPerformance = new Map(brain.strategyPerformance || []);

      console.log(
        `🧠 Mickey's brain loaded successfully!\n` +
          `   IQ: ${this.mickeyIQ.toFixed(1)}\n` +
          `   Trades: ${this.tradeHistory.length}\n` +
          `   Symbols: ${this.symbolProfiles.size}\n` +
          `   Strategies: ${this.strategyPerformance.size}`
      );

      return true;
    } catch (error: any) {
      console.error(`⚠️ Could not load Mickey's brain: ${error.message}`);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 🔄 RESET BRAIN (for testing)
  // ════════════════════════════════════════════════════════════════

  resetBrain(): void {
    this.tradeHistory = [];
    this.symbolProfiles.clear();
    this.strategyPerformance.clear();
    this.mickeyIQ = this.config.startingIQ;

    console.log("🔄 Mickey's brain has been reset!");

    if (this.config.autoSave) {
      this.saveBrain();
    }
  }

  // ════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════

  private detectMarketCondition(marketData: MarketData): MarketCondition {
    // Use provided condition or detect based on volatility
    if (marketData.condition) {
      return marketData.condition;
    }

    const volatility = marketData.volatility || 0;

    if (volatility > 3) return 'VOLATILE';
    if (volatility > 1.5) return 'CHOPPY';
    if (marketData.trend === 'UP' || marketData.trend === 'DOWN')
      return 'TRENDING';

    return 'RANGING';
  }

  private getExperienceLevel(): string {
    const iq = this.mickeyIQ;

    if (iq < 60) return '🐵 Chimpanzee Trader';
    if (iq < 90) return '📚 Learning Trader';
    if (iq < 110) return '🎓 Competent Trader';
    if (iq < 130) return '🧠 Smart Trader';
    if (iq < 150) return '💡 Advanced Trader';
    if (iq < 170) return '💎 Expert Trader';
    if (iq < 190) return '🌟 Master Trader';
    return '🏆 Warren Buffett Level';
  }
}

// ════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════

export default LearningMickey;
