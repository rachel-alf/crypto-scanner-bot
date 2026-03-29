// // ============================================================================
// // 🎯 VIP SIGNAL SELECTION SYSTEM
// // "Scan the whole club, then pick the top 4"
// // ============================================================================

import type { ExtendedScanResult, StrategyId } from '../../lib/type.js';
import { TradingScanner } from '../scanner/scan.js';

// import { normalize } from '@lib/helpers.js';
// import type { ExtendedScanResult, StrategyId } from '@lib/type.js';
// import { SCAN_CONFIG, TradingScanner } from '@src/scanner/scan.js';

// interface RankedSignal extends ExtendedScanResult {
//   rawConfidence: number; // Original confidence
//   adjustedScore: number; // After boosts/penalties
//   ranking: number; // Position in queue
//   queueStatus: 'ACTIVE' | 'WAITING' | 'REJECTED';
//   reasons: string[]; // Why this score
// }

// interface SignalQueue {
//   active: RankedSignal[]; // Currently trading
//   waiting: RankedSignal[]; // Next in line
//   rejected: RankedSignal[]; // Didn't make the cut
//   lastScanTime: Date;
//   totalScanned: number;
// }

// // ============================================================================
// // CONFIGURATION
// // ============================================================================

// const SIGNAL_CONFIG = {
//   // Token quality tiers
//   BLUE_CHIP: ['BTC', 'ETH', 'SOL', 'AVAX', 'MATIC', 'LINK', 'UNI', 'AAVE'],
//   MID_CAP: ['ARB', 'OP', 'ATOM', 'DOT', 'FIL', 'NEAR', 'ICP', 'APT'],
//   MEMECOINS: ['PEPE', 'DOGE', 'SHIB', 'FLOKI', 'BONK', 'WIF'],
//   RISKY: ['LUNC', 'LUNA', 'FTT'], // Delisted/problematic

//   // Strategy tier rankings
//   PREMIUM_STRATEGIES: [
//     'SMC_LONG',
//     'SMC_SHORT',
//     'LIQUIDITY_SWEEP',
//     'EQUILIBRIUM',
//   ],
//   STRONG_STRATEGIES: ['BREAKOUT', 'BREAKDOWN', 'FVG_FILL', 'LIQUIDITY_RECLAIM'],
//   DECENT_STRATEGIES: ['EMA_PULLBACK', 'FIB_RETRACEMENT'],
//   WEAK_STRATEGIES: ['RSI_DIVERGENCE'],

//   // Scoring weights
//   BOOSTS: {
//     BLUE_CHIP: 10,
//     MID_CAP: 5,
//     PREMIUM_STRATEGY: 8,
//     STRONG_STRATEGY: 5,
//     DECENT_STRATEGY: 2,
//     CORRECT_ZONE: 7,
//     HIGH_SMC: 5, // SMC > 50
//     TRENDING_MARKET: 5,
//     HIGH_VOLUME: 3,
//   },

//   PENALTIES: {
//     MEMECOIN: -15,
//     RISKY_TOKEN: -25,
//     WEAK_STRATEGY: -5,
//     WRONG_ZONE: -10,
//     LOW_SMC: -8, // SMC < 35
//     RANGING_MARKET: -3,
//     LOW_VOLUME: -5,
//   },

//   // Cutoffs
//   MIN_SCORE_TO_TRADE: 65, // Don't trade below this
//   MIN_SCORE_FOR_QUEUE: 55, // Keep in waiting list
//   QUEUE_SIZE: 10, // Top 10 signals tracked
// };

// // ============================================================================
// // MAIN VIP SELECTOR CLASS
// // ============================================================================

// class VIPSignalSelector {
//   private scanner: TradingScanner;
//   private signalQueue: SignalQueue = {
//     active: [],
//     waiting: [],
//     rejected: [],
//     lastScanTime: new Date(),
//     totalScanned: 0,
//   };

//   constructor(scanner: TradingScanner) {
//     this.scanner = scanner;
//   }

//   /**
//    * 🎯 STEP 1: Scan entire market and collect ALL signals
//    */
//   async scanEntireMarket(symbols: string[]): Promise<ExtendedScanResult[]> {
//     console.log('\n🔍 ════════════════════════════════════════');
//     console.log('🔍 SCANNING ENTIRE MARKET');
//     console.log('🔍 ════════════════════════════════════════');
//     console.log(`Symbols to scan: ${symbols.length}`);

//     const allSignals: ExtendedScanResult[] = [];
//     let scanned = 0;

//     for (const symbol of symbols) {
//       try {
//         const signal = await this.scanner.scanSymbol(symbol); // Your existing scanner

//         if (signal) {
//           allSignals.push(signal);
//           console.log(
//             `✅ ${symbol}: ${signal.confidence}% ${signal.signal?.strategy}`
//           );
//         }

//         scanned++;

//         // Progress indicator
//         if (scanned % 20 === 0) {
//           console.log(
//             `   📊 Progress: ${scanned}/${symbols.length} (${allSignals.length} signals found)`
//           );
//         }
//       } catch (error: any) {
//         console.log(`❌ ${symbol}: ${error.message}`);
//       }
//     }

//     console.log('\n✅ Scan Complete!');
//     console.log(`   Scanned: ${scanned} symbols`);
//     console.log(`   Found: ${allSignals.length} signals`);

//     this.signalQueue.totalScanned = scanned;
//     this.signalQueue.lastScanTime = new Date();

//     return allSignals;
//   }

//   /**
//    * 🏆 STEP 2: Rank and score all signals
//    */
//   rankSignals(signals: ExtendedScanResult[]): RankedSignal[] {
//     console.log('\n🏆 ════════════════════════════════════════');
//     console.log('🏆 RANKING SIGNALS');
//     console.log('🏆 ════════════════════════════════════════');

//     const rankedSignals: RankedSignal[] = signals.map((signal) => {
//       const reasons: string[] = [];
//       let adjustedScore = signal.confidence;
//       const symbolBase = signal.symbol.replace('USDT', '');

//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//       // TOKEN QUALITY SCORING
//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

//       if (SIGNAL_CONFIG.BLUE_CHIP.includes(symbolBase)) {
//         adjustedScore += SIGNAL_CONFIG.BOOSTS.BLUE_CHIP;
//         reasons.push(`💎 Blue-chip (+${SIGNAL_CONFIG.BOOSTS.BLUE_CHIP})`);
//       } else if (SIGNAL_CONFIG.MID_CAP.includes(symbolBase)) {
//         adjustedScore += SIGNAL_CONFIG.BOOSTS.MID_CAP;
//         reasons.push(`📊 Mid-cap (+${SIGNAL_CONFIG.BOOSTS.MID_CAP})`);
//       }

//       if (SIGNAL_CONFIG.MEMECOINS.some((mc) => symbolBase.includes(mc))) {
//         adjustedScore += SIGNAL_CONFIG.PENALTIES.MEMECOIN;
//         reasons.push(`🎪 Memecoin (${SIGNAL_CONFIG.PENALTIES.MEMECOIN})`);
//       }

//       if (SIGNAL_CONFIG.RISKY.includes(symbolBase)) {
//         adjustedScore += SIGNAL_CONFIG.PENALTIES.RISKY_TOKEN;
//         reasons.push(`⚠️ Risky (${SIGNAL_CONFIG.PENALTIES.RISKY_TOKEN})`);
//       }

//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//       // STRATEGY QUALITY SCORING
//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

//       const strategy = signal.signal?.strategy as StrategyId;

//       if (SIGNAL_CONFIG.PREMIUM_STRATEGIES.includes(strategy)) {
//         adjustedScore += SIGNAL_CONFIG.BOOSTS.PREMIUM_STRATEGY;
//         reasons.push(
//           `⭐ Premium strategy (+${SIGNAL_CONFIG.BOOSTS.PREMIUM_STRATEGY})`
//         );
//       } else if (SIGNAL_CONFIG.STRONG_STRATEGIES.includes(strategy)) {
//         adjustedScore += SIGNAL_CONFIG.BOOSTS.STRONG_STRATEGY;
//         reasons.push(
//           `💪 Strong strategy (+${SIGNAL_CONFIG.BOOSTS.STRONG_STRATEGY})`
//         );
//       } else if (SIGNAL_CONFIG.DECENT_STRATEGIES.includes(strategy)) {
//         adjustedScore += SIGNAL_CONFIG.BOOSTS.DECENT_STRATEGY;
//         reasons.push(
//           `👍 Decent strategy (+${SIGNAL_CONFIG.BOOSTS.DECENT_STRATEGY})`
//         );
//       } else if (SIGNAL_CONFIG.WEAK_STRATEGIES.includes(strategy)) {
//         adjustedScore += SIGNAL_CONFIG.PENALTIES.WEAK_STRATEGY;
//         reasons.push(
//           `⚠️ Weak strategy (${SIGNAL_CONFIG.PENALTIES.WEAK_STRATEGY})`
//         );
//       }

//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//       // SMC ZONE ALIGNMENT
//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

//       if (signal.smc?.premiumDiscount) {
//         const zone = signal.smc.premiumDiscount;
//         const side = signal.signal?.side;

//         // Correct zone alignment
//         if (
//           (side === 'LONG' && zone === 'DISCOUNT') ||
//           (side === 'SHORT' && zone === 'PREMIUM')
//         ) {
//           adjustedScore += SIGNAL_CONFIG.BOOSTS.CORRECT_ZONE;
//           reasons.push(
//             `✅ Perfect zone (+${SIGNAL_CONFIG.BOOSTS.CORRECT_ZONE})`
//           );
//         }

//         // Wrong zone penalty
//         if (
//           (side === 'LONG' && zone === 'PREMIUM') ||
//           (side === 'SHORT' && zone === 'DISCOUNT')
//         ) {
//           adjustedScore += SIGNAL_CONFIG.PENALTIES.WRONG_ZONE;
//           reasons.push(`❌ Wrong zone (${SIGNAL_CONFIG.PENALTIES.WRONG_ZONE})`);
//         }
//       }

//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//       // SMC SCORE
//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

//       if (signal.smc) {
//         if (signal.smc.smcScore >= 50) {
//           adjustedScore += SIGNAL_CONFIG.BOOSTS.HIGH_SMC;
//           reasons.push(
//             `📈 High SMC ${signal.smc.smcScore} (+${SIGNAL_CONFIG.BOOSTS.HIGH_SMC})`
//           );
//         } else if (signal.smc.smcScore < 35) {
//           adjustedScore += SIGNAL_CONFIG.PENALTIES.LOW_SMC;
//           reasons.push(
//             `📉 Low SMC ${signal.smc.smcScore} (${SIGNAL_CONFIG.PENALTIES.LOW_SMC})`
//           );
//         }
//       }

//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//       // MARKET REGIME
//       // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

//       if (
//         signal.regime === 'TRENDING_UP' ||
//         signal.regime === 'TRENDING_DOWN'
//       ) {
//         adjustedScore += SIGNAL_CONFIG.BOOSTS.TRENDING_MARKET;
//         reasons.push(`📊 Trending (+${SIGNAL_CONFIG.BOOSTS.TRENDING_MARKET})`);
//       } else if (signal.regime === 'RANGING') {
//         adjustedScore += SIGNAL_CONFIG.PENALTIES.RANGING_MARKET;
//         reasons.push(`⚡ Ranging (${SIGNAL_CONFIG.PENALTIES.RANGING_MARKET})`);
//       }

//       // Cap score at 100
//       adjustedScore = Math.min(100, adjustedScore);

//       return {
//         ...signal,
//         rawConfidence: signal.confidence,
//         adjustedScore: adjustedScore,
//         ranking: 0, // Will be set after sorting
//         queueStatus: 'WAITING',
//         reasons: reasons,
//       };
//     });

//     // Sort by adjusted score (descending)
//     rankedSignals.sort((a, b) => b.adjustedScore - a.adjustedScore);

//     // Assign rankings
//     rankedSignals.forEach((signal, index) => {
//       signal.ranking = index + 1;
//     });

//     return rankedSignals;
//   }

//   /**
//    * 🎯 STEP 3: Select best signals for trading
//    */
//   selectBestSignals(
//     rankedSignals: RankedSignal[],
//     maxBots: number,
//     currentActiveBots: number
//   ): SignalQueue {
//     console.log('\n📊 ════════════════════════════════════════');
//     console.log('📊 SELECTING BEST SIGNALS');
//     console.log('📊 ════════════════════════════════════════');

//     const slotsAvailable = maxBots - currentActiveBots;
//     console.log(`Slots available: ${slotsAvailable}/${maxBots}`);

//     // Filter by minimum score
//     const tradeable = rankedSignals.filter(
//       (s) => s.adjustedScore >= SIGNAL_CONFIG.MIN_SCORE_TO_TRADE
//     );

//     const queueable = rankedSignals.filter(
//       (s) =>
//         s.adjustedScore >= SIGNAL_CONFIG.MIN_SCORE_FOR_QUEUE &&
//         s.adjustedScore < SIGNAL_CONFIG.MIN_SCORE_TO_TRADE
//     );

//     const rejected = rankedSignals.filter(
//       (s) => s.adjustedScore < SIGNAL_CONFIG.MIN_SCORE_FOR_QUEUE
//     );

//     // Select top N for active trading
//     const active = tradeable.slice(0, slotsAvailable).map((s) => ({
//       ...s,
//       queueStatus: 'ACTIVE' as const,
//     }));

//     // Rest go to waiting list
//     const waiting = tradeable
//       .slice(slotsAvailable, SIGNAL_CONFIG.QUEUE_SIZE)
//       .map((s) => ({
//         ...s,
//         queueStatus: 'WAITING' as const,
//       }));

//     // Rejected signals
//     const rejectedList = rejected.map((s) => ({
//       ...s,
//       queueStatus: 'REJECTED' as const,
//     }));

//     this.signalQueue = {
//       active,
//       waiting,
//       rejected: rejectedList.slice(0, 5), // Keep top 5 rejected for display
//       lastScanTime: new Date(),
//       totalScanned: this.signalQueue.totalScanned,
//     };

//     return this.signalQueue as SignalQueue;
//   }

//   /**
//    * 📋 Display the signal queue in beautiful format
//    */
//   displayQueue(): void {
//     const queue = this.signalQueue;

//     console.log('\n');
//     console.log('═'.repeat(80));
//     console.log('🎯 VIP SIGNAL SELECTION RESULTS');
//     console.log('═'.repeat(80));
//     console.log(`Last scan: ${queue.lastScanTime.toLocaleTimeString()}`);
//     console.log(`Total scanned: ${queue.totalScanned} symbols`);
//     console.log(
//       `Found: ${queue.active.length + queue.waiting.length + queue.rejected.length} signals`
//     );
//     console.log('═'.repeat(80));

//     // Active trades
//     if (queue.active.length > 0) {
//       console.log('\n🟢 ACTIVE TRADES (Selected):');
//       console.log('─'.repeat(80));
//       queue.active.forEach((signal, i) => {
//         console.log(
//           `${i + 1}. 🟢 ${signal.symbol.padEnd(12)} | Score: ${signal.adjustedScore.toFixed(0).padStart(3)} | ${signal.signal?.strategy.padEnd(18)} | ${signal.signal?.side}`
//         );
//         console.log(
//           `   Raw: ${signal.rawConfidence.toFixed(0)}% → Adjusted: ${signal.adjustedScore.toFixed(0)}%`
//         );
//         console.log(`   ${signal.reasons.join(' | ')}`);
//         if (signal.smc) {
//           console.log(
//             `   SMC: ${signal.smc.smcScore} | Zone: ${signal.smc.premiumDiscount} | ${signal.regime}`
//           );
//         }
//         console.log('');
//       });
//     }

//     // Waiting list
//     if (queue.waiting.length > 0) {
//       console.log('\n⏳ WAITING LIST (Next in line):');
//       console.log('─'.repeat(80));
//       queue.waiting.forEach((signal, i) => {
//         console.log(
//           `${i + queue.active.length + 1}. ⏳ ${signal.symbol.padEnd(12)} | Score: ${signal.adjustedScore.toFixed(0).padStart(3)} | ${signal.signal?.strategy.padEnd(18)} | ${signal.signal?.side}`
//         );
//         console.log(`   ${signal.reasons.slice(0, 2).join(' | ')}`);
//       });
//     }

//     // Rejected
//     if (queue.rejected.length > 0) {
//       console.log('\n🚫 REJECTED (Low quality):');
//       console.log('─'.repeat(80));
//       queue.rejected.forEach((signal, i) => {
//         console.log(
//           `❌ ${signal.symbol.padEnd(12)} | Score: ${signal.adjustedScore.toFixed(0).padStart(3)} | ${signal.signal?.strategy.padEnd(18)}`
//         );
//         console.log(
//           `   ${signal.reasons.filter((r) => r.includes('-')).join(' | ')}`
//         );
//       });
//     }

//     console.log('\n' + '═'.repeat(80));
//   }

//   /**
//    * 🔄 Get next signal when a bot closes
//    */
//   getNextSignal(): RankedSignal | null {
//     if (this.signalQueue.waiting.length > 0) {
//       const nextSignal = this.signalQueue.waiting.shift()!;
//       nextSignal.queueStatus = 'ACTIVE';
//       this.signalQueue.active.push(nextSignal);

//       console.log(`\n🔄 ROTATION: Taking next signal from queue`);
//       console.log(
//         `   ${nextSignal.symbol}: ${nextSignal.adjustedScore.toFixed(0)}% ${nextSignal.signal?.strategy}`
//       );

//       return nextSignal;
//     }
//     return null;
//   }

//   /**
//    * 📊 Get current queue status
//    */
//   getQueueStatus() {
//     return {
//       active: this.signalQueue.active.length,
//       waiting: this.signalQueue.waiting.length,
//       rejected: this.signalQueue.rejected.length,
//       total: this.signalQueue.active.length + this.signalQueue.waiting.length,
//       lastScan: this.signalQueue.lastScanTime,
//     };
//   }
// }

// // ============================================================================
// // USAGE EXAMPLE
// // ============================================================================

// async function main() {
//   const scanner = new TradingScanner('FUTURES');
//   const selector = new VIPSignalSelector(scanner);

//   const sym = SCAN_CONFIG.symbols;
//   const normalizedSymbol = sym.map((s) => normalize(s, 'FUTURES'));

//   // STEP 1: Scan entire market
//   const allSignals = await selector.scanEntireMarket(normalizedSymbol);

//   // STEP 2: Rank all signals
//   const rankedSignals = selector.rankSignals(allSignals);

//   // STEP 3: Select best for trading
//   const maxBots = 4;
//   const currentActiveBots = 0; // None active yet
//   const queue = selector.selectBestSignals(
//     rankedSignals,
//     maxBots,
//     currentActiveBots
//   );

//   // STEP 4: Display results
//   selector.displayQueue();

//   // STEP 5: Trade the active signals
//   console.log('\n🚀 Starting trades...');
//   for (const signal of queue.active) {
//     console.log(
//       `✅ Trading ${signal.symbol} at ${signal.adjustedScore.toFixed(0)}%`
//     );
//     // await startBot(signal);
//   }

//   // Later, when a bot closes:
//   // const nextSignal = selector.getNextSignal();
//   // if (nextSignal) {
//   //   await startBot(nextSignal);
//   // }
// }

// main();

// export {
//   VIPSignalSelector,
//   type RankedSignal,
//   type SignalQueue,
//   SIGNAL_CONFIG,
// };

// ============================================================================
// 🎯 VIP SIGNAL SELECTION SYSTEM
// "Scan the whole club, then pick the top 4"
// ============================================================================

interface RankedSignal extends ExtendedScanResult {
  rawConfidence: number; // Original confidence
  adjustedScore: number; // After boosts/penalties
  ranking: number; // Position in queue
  queueStatus: 'ACTIVE' | 'WAITING' | 'REJECTED';
  reasons: string[]; // Why this score
  attractivenessScore?: number;
  riskScore?: number;
  momentumScore?: number;
}

interface SignalQueue {
  active: RankedSignal[]; // Currently trading
  waiting: RankedSignal[]; // Next in line
  rejected: RankedSignal[]; // Didn't make the cut
  lastScanTime: Date;
  totalScanned: number;
  scanDuration?: number;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const SIGNAL_CONFIG = {
  // Token quality tiers
  BLUE_CHIP: ['BTC', 'ETH', 'SOL', 'AVAX', 'MATIC', 'LINK', 'UNI', 'AAVE'],
  MID_CAP: ['ARB', 'OP', 'ATOM', 'DOT', 'FIL', 'NEAR', 'ICP', 'APT'],
  MEMECOINS: ['PEPE', 'DOGE', 'SHIB', 'FLOKI', 'BONK', 'WIF'],
  RISKY: ['LUNC', 'LUNA', 'FTT'], // Delisted/problematic

  // Strategy tier rankings
  PREMIUM_STRATEGIES: [
    'SMC_LONG',
    'SMC_SHORT',
    'LIQUIDITY_SWEEP',
    'EQUILIBRIUM',
  ],
  STRONG_STRATEGIES: ['BREAKOUT', 'BREAKDOWN', 'FVG_FILL', 'LIQUIDITY_RECLAIM'],
  DECENT_STRATEGIES: ['EMA_PULLBACK', 'FIB_RETRACEMENT'],
  WEAK_STRATEGIES: ['RSI_DIVERGENCE'],

  // Scoring weights
  BOOSTS: {
    BLUE_CHIP: 10,
    MID_CAP: 5,
    PREMIUM_STRATEGY: 8,
    STRONG_STRATEGY: 5,
    DECENT_STRATEGY: 2,
    CORRECT_ZONE: 7,
    HIGH_SMC: 5, // SMC > 50
    TRENDING_MARKET: 5,
    HIGH_VOLUME: 3,
  },

  PENALTIES: {
    MEMECOIN: -15,
    RISKY_TOKEN: -25,
    WEAK_STRATEGY: -5,
    WRONG_ZONE: -10,
    LOW_SMC: -8, // SMC < 35
    RANGING_MARKET: -3,
    LOW_VOLUME: -5,
  },

  // Cutoffs
  MIN_SCORE_TO_TRADE: 65, // Don't trade below this
  MIN_SCORE_FOR_QUEUE: 55, // Keep in waiting list
  QUEUE_SIZE: 10, // Top 10 signals tracked
};

// ============================================================================
// MAIN VIP SELECTOR CLASS
// ============================================================================

class VIPSignalSelector {
  private scanner: TradingScanner;
  private signalQueue: SignalQueue = {
    active: [],
    waiting: [],
    rejected: [],
    lastScanTime: new Date(),
    totalScanned: 0,
  };

  constructor(scanner: TradingScanner) {
    this.scanner = scanner;
  }

  /**
   * 🎯 STEP 1: Scan entire market and collect ALL signals
   */
  async scanEntireMarket(symbols: string[]): Promise<ExtendedScanResult[]> {
    const startTime = Date.now();
    console.log('\n🔍 ════════════════════════════════════════');
    console.log('🔍 SCANNING ENTIRE MARKET');
    console.log('🔍 ════════════════════════════════════════');
    console.log(`Symbols to scan: ${symbols.length}`);

    const allSignals: ExtendedScanResult[] = [];
    let scanned = 0;

    for (const symbol of symbols) {
      try {
        const signal = await this.scanner.scanSymbol(symbol); // Your existing scanner

        if (signal) {
          allSignals.push(signal);
          console.log(
            `✅ ${symbol}: ${signal.confidence}% ${signal.signal?.strategy}`
          );
        }

        scanned++;

        // Progress indicator
        if (scanned % 20 === 0) {
          const progress = ((scanned / symbols.length) * 100).toFixed(0);
          console.log(
            `   📊 Progress: ${progress}% (${scanned}/${symbols.length}) | Found: ${allSignals.length} qualified girls`
          );
        }
      } catch (error: any) {
        console.log(`❌ ${symbol}: ${error.message}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n✅ All girls have arrived!');
    console.log(`   ⏱️  Time: ${duration}s`);
    console.log(`   👯‍♀️ Scanned: ${scanned} girls`);
    console.log(`   ✨ Qualified: ${allSignals.length} girls ready to impress`);
    console.log('');

    this.signalQueue.totalScanned = scanned;
    this.signalQueue.lastScanTime = new Date();
    this.signalQueue.scanDuration = parseFloat(duration);

    return allSignals;
  }

  /**
   * 🏆 STEP 2: Rank signals with ENHANCED scoring
   */
  rankSignals(signals: ExtendedScanResult[]): RankedSignal[] {
    console.log('🏆 ════════════════════════════════════════');
    console.log('🏆 JUDGING THE BEAUTY CONTEST');
    console.log('🏆 ════════════════════════════════════════');
    console.log(`   Contestants: ${signals.length} girls 💃\n`);

    const rankedSignals: RankedSignal[] = signals.map((signal) => {
      const reasons: string[] = [];
      let adjustedScore = signal.confidence;
      let attractivenessScore = signal.confidence;
      let riskScore = 50; // Base risk
      let momentumScore = 0;

      const symbolBase = signal.symbol.replace('USDT', '');
      const strategy = signal.signal?.strategy as StrategyId;
      const side = signal.signal?.side;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // TOKEN QUALITY (Same as yours, but enhanced)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (SIGNAL_CONFIG.BLUE_CHIP.includes(symbolBase)) {
        adjustedScore += SIGNAL_CONFIG.BOOSTS.BLUE_CHIP;
        attractivenessScore += 15;
        riskScore -= 20; // Less risky
        reasons.push(
          `💎 Blue-chip princess (+${SIGNAL_CONFIG.BOOSTS.BLUE_CHIP})`
        );
      } else if (SIGNAL_CONFIG.MID_CAP.includes(symbolBase)) {
        adjustedScore += SIGNAL_CONFIG.BOOSTS.MID_CAP;
        attractivenessScore += 8;
        riskScore -= 10;
        reasons.push(`📊 Mid-cap beauty (+${SIGNAL_CONFIG.BOOSTS.MID_CAP})`);
      }

      if (SIGNAL_CONFIG.MEMECOINS.some((mc) => symbolBase.includes(mc))) {
        adjustedScore += SIGNAL_CONFIG.PENALTIES.MEMECOIN;
        attractivenessScore -= 10;
        riskScore += 30; // Much riskier!
        reasons.push(
          `🎪 Memecoin (wild card ${SIGNAL_CONFIG.PENALTIES.MEMECOIN})`
        );
      }

      if (SIGNAL_CONFIG.RISKY.includes(symbolBase)) {
        adjustedScore += SIGNAL_CONFIG.PENALTIES.RISKY_TOKEN;
        attractivenessScore -= 20;
        riskScore += 50; // VERY risky!
        reasons.push(`⚠️ Risky girl (${SIGNAL_CONFIG.PENALTIES.RISKY_TOKEN})`);
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // STRATEGY QUALITY (Your existing logic)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (SIGNAL_CONFIG.PREMIUM_STRATEGIES.includes(strategy)) {
        adjustedScore += SIGNAL_CONFIG.BOOSTS.PREMIUM_STRATEGY;
        attractivenessScore += 12;
        reasons.push(`⭐ VIP move (+${SIGNAL_CONFIG.BOOSTS.PREMIUM_STRATEGY})`);
      } else if (SIGNAL_CONFIG.STRONG_STRATEGIES.includes(strategy)) {
        adjustedScore += SIGNAL_CONFIG.BOOSTS.STRONG_STRATEGY;
        attractivenessScore += 7;
        reasons.push(
          `💪 Strong technique (+${SIGNAL_CONFIG.BOOSTS.STRONG_STRATEGY})`
        );
      } else if (SIGNAL_CONFIG.DECENT_STRATEGIES.includes(strategy)) {
        adjustedScore += SIGNAL_CONFIG.BOOSTS.DECENT_STRATEGY;
        attractivenessScore += 3;
        reasons.push(
          `👍 Decent approach (+${SIGNAL_CONFIG.BOOSTS.DECENT_STRATEGY})`
        );
      } else if (SIGNAL_CONFIG.WEAK_STRATEGIES.includes(strategy)) {
        adjustedScore += SIGNAL_CONFIG.PENALTIES.WEAK_STRATEGY;
        attractivenessScore -= 5;
        reasons.push(
          `⚠️ Basic strategy (${SIGNAL_CONFIG.PENALTIES.WEAK_STRATEGY})`
        );
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SMC ZONE ALIGNMENT (Your existing logic)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (signal.smc?.premiumDiscount) {
        const zone = signal.smc.premiumDiscount;

        if (
          (side === 'LONG' && zone === 'DISCOUNT') ||
          (side === 'SHORT' && zone === 'PREMIUM')
        ) {
          adjustedScore += SIGNAL_CONFIG.BOOSTS.CORRECT_ZONE;
          attractivenessScore += 10;
          reasons.push(
            `✅ Perfect timing (+${SIGNAL_CONFIG.BOOSTS.CORRECT_ZONE})`
          );
        }

        if (
          (side === 'LONG' && zone === 'PREMIUM') ||
          (side === 'SHORT' && zone === 'DISCOUNT')
        ) {
          adjustedScore += SIGNAL_CONFIG.PENALTIES.WRONG_ZONE;
          attractivenessScore -= 12;
          reasons.push(`❌ Bad timing (${SIGNAL_CONFIG.PENALTIES.WRONG_ZONE})`);
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SMC SCORE (Your existing logic)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (signal.smc?.smcScore) {
        const smcScore = signal.smc.smcScore;

        if (smcScore >= 50) {
          adjustedScore += SIGNAL_CONFIG.BOOSTS.HIGH_SMC;
          momentumScore += 15;
          reasons.push(`🔥 Strong SMC (${smcScore.toFixed(0)})`);
        } else if (smcScore < 35) {
          adjustedScore += SIGNAL_CONFIG.PENALTIES.LOW_SMC;
          momentumScore -= 10;
          reasons.push(`📉 Weak SMC (${smcScore.toFixed(0)})`);
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // MARKET REGIME (Your existing logic)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (signal.regime === 'TRENDING') {
        adjustedScore += SIGNAL_CONFIG.BOOSTS.TRENDING_MARKET;
        momentumScore += 20;
        reasons.push(`📈 Trending (+${SIGNAL_CONFIG.BOOSTS.TRENDING_MARKET})`);
      } else if (signal.regime === 'RANGING') {
        adjustedScore += SIGNAL_CONFIG.PENALTIES.RANGING_MARKET;
        momentumScore -= 5;
        reasons.push(`😴 Ranging (${SIGNAL_CONFIG.PENALTIES.RANGING_MARKET})`);
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // VOLUME ANALYSIS (Your existing logic)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (signal.indicators?.volume) {
        const volRatio = signal.indicators.volume;

        if (volRatio > 1.5) {
          adjustedScore += SIGNAL_CONFIG.BOOSTS.HIGH_VOLUME;
          momentumScore += 10;
          reasons.push(`📊 High volume (+${SIGNAL_CONFIG.BOOSTS.HIGH_VOLUME})`);
        } else if (volRatio < 0.5) {
          adjustedScore += SIGNAL_CONFIG.PENALTIES.LOW_VOLUME;
          momentumScore -= 8;
          reasons.push(`🔇 Low volume (${SIGNAL_CONFIG.PENALTIES.LOW_VOLUME})`);
        }
      }

      // Clamp scores
      adjustedScore = Math.max(0, Math.min(100, adjustedScore));
      attractivenessScore = Math.max(0, Math.min(100, attractivenessScore));
      riskScore = Math.max(0, Math.min(100, riskScore));
      momentumScore = Math.max(-50, Math.min(50, momentumScore));

      return {
        ...signal,
        rawConfidence: signal.confidence,
        adjustedScore,
        attractivenessScore,
        riskScore,
        momentumScore,
        ranking: 0, // Will be set later
        queueStatus: 'WAITING' as const,
        reasons,
      };
    });

    // Sort by adjusted score (best first)
    rankedSignals.sort((a, b) => b.adjustedScore - a.adjustedScore);

    // Assign rankings
    rankedSignals.forEach((signal, index) => {
      signal.ranking = index + 1;
    });

    console.log('✅ Judging complete!\n');

    return rankedSignals;
  }

  /**
   * 🎯 STEP 3: Select best signals for trading
   */
  selectBestSignals(
    rankedSignals: RankedSignal[],
    maxBots: number,
    currentActiveBots: number
  ): SignalQueue {
    console.log('\n📊 ════════════════════════════════════════');
    console.log('📊 SELECTING BEST SIGNALS');
    console.log('📊 ════════════════════════════════════════');

    const slotsAvailable = maxBots - currentActiveBots;
    console.log(`Slots available: ${slotsAvailable}/${maxBots}`);

    // Filter by minimum score
    const tradeable = rankedSignals.filter(
      (s) => s.adjustedScore >= SIGNAL_CONFIG.MIN_SCORE_TO_TRADE
    );

    const queueable = rankedSignals.filter(
      (s) =>
        s.adjustedScore >= SIGNAL_CONFIG.MIN_SCORE_FOR_QUEUE &&
        s.adjustedScore < SIGNAL_CONFIG.MIN_SCORE_TO_TRADE
    );

    const rejected = rankedSignals.filter(
      (s) => s.adjustedScore < SIGNAL_CONFIG.MIN_SCORE_FOR_QUEUE
    );

    console.log(`   Tradeable: ${tradeable.length}`); // ✅ ADD DEBUG
    console.log(`   Queueable: ${queueable.length}`);
    console.log(`   Rejected: ${rejected.length}`);

    // Select top N for active trading
    const active = tradeable.slice(0, slotsAvailable).map((s) => ({
      ...s,
      queueStatus: 'ACTIVE' as const,
    }));

    // Rest go to waiting list
    const waiting = tradeable
      .slice(slotsAvailable, SIGNAL_CONFIG.QUEUE_SIZE)
      .map((s) => ({
        ...s,
        queueStatus: 'WAITING' as const,
      }));

    // Rejected signals
    const rejectedList = rejected.map((s) => ({
      ...s,
      queueStatus: 'REJECTED' as const,
    }));

    console.log(
      `   ✅ Selected: ${active.length} active, ${waiting.length} waiting`
    ); // ✅ ADD DEBUG

    this.signalQueue = {
      active,
      waiting,
      rejected: rejectedList.slice(0, 5),
      lastScanTime: new Date(),
      totalScanned: this.signalQueue.totalScanned,
    };

    // ✅ ADD VERIFICATION BEFORE RETURN
    if (!this.signalQueue.active) {
      console.error('❌ CRITICAL: signalQueue.active is undefined!');
      this.signalQueue.active = [];
    }
    if (!this.signalQueue.waiting) {
      console.error('❌ CRITICAL: signalQueue.waiting is undefined!');
      this.signalQueue.waiting = [];
    }

    console.log(`   🔍 Returning queue:`, {
      active: this.signalQueue.active.length,
      waiting: this.signalQueue.waiting.length,
      rejected: this.signalQueue.rejected.length,
    }); // ✅ ADD DEBUG

    return this.signalQueue;
  }

  /**
   * 📋 Display queue in nightclub theme!
   */
  displayQueue(): void {
    const queue = this.signalQueue;

    console.log('\n');
    console.log('═'.repeat(100));
    console.log('🎪 THE NIGHTCLUB - FINAL SELECTION 🎪');
    console.log('═'.repeat(100));
    console.log(`🕐 Time: ${queue.lastScanTime.toLocaleTimeString()}`);
    console.log(`⏱️  Scan duration: ${queue.scanDuration}s`);
    console.log(`👯‍♀️ Girls checked: ${queue.totalScanned}`);
    console.log(
      `✨ Total qualified: ${queue.active.length + queue.waiting.length + queue.rejected.length}`
    );
    console.log('═'.repeat(100));

    // Active (Your dates tonight!)
    if (queue.active.length > 0) {
      console.log('\n💃 YOUR DATES TONIGHT (Trading now):');
      console.log('─'.repeat(100));

      queue.active.forEach((signal, i) => {
        const sigAtt = signal.attractivenessScore as number;
        const sigRiskScore = signal.riskScore as number;
        const sigMom = signal.momentumScore as number;
        const emoji = sigAtt >= 80 ? '🔥' : '💃';
        const risk =
          sigRiskScore > 70
            ? '⚠️ HIGH RISK'
            : sigRiskScore > 40
              ? '⚡ MED RISK'
              : '✅ LOW RISK';

        console.log(
          `${i + 1}. ${emoji} ${signal.symbol.padEnd(12)} | Score: ${signal.adjustedScore.toFixed(0).padStart(3)} | ` +
            `${signal.signal?.strategy.padEnd(18)} | ${signal.signal?.side.padEnd(5)} | ${risk}`
        );
        console.log(
          `   💰 Confidence: ${signal.rawConfidence.toFixed(0)}% → ${signal.adjustedScore.toFixed(0)}% | ` +
            `💖 Hotness: ${sigAtt.toFixed(0)} | ` +
            `🚀 Momentum: ${sigMom > 0 ? '+' : ''}${sigMom.toFixed(0)}`
        );
        console.log(`   📝 ${signal.reasons.join(' | ')}`);

        if (signal.smc) {
          console.log(
            `   🎯 SMC: ${signal.smc.smcScore.toFixed(0)} | Zone: ${signal.smc.premiumDiscount} | Market: ${signal.regime}`
          );
        }
        console.log('');
      });
    } else {
      console.log(
        '\n💃 No dates selected (all slots full or no qualified signals)'
      );
    }

    // Waiting (Next in line!)
    if (queue.waiting.length > 0) {
      console.log('\n⏳ WAITING LIST (Next when a date leaves):');
      console.log('─'.repeat(100));

      queue.waiting.slice(0, 5).forEach((signal, i) => {
        console.log(
          `${i + queue.active.length + 1}. ⏳ ${signal.symbol.padEnd(12)} | ` +
            `Score: ${signal.adjustedScore.toFixed(0).padStart(3)} | ` +
            `${signal.signal?.strategy.padEnd(18)} | ${signal.signal?.side}`
        );
        console.log(`   ${signal.reasons.slice(0, 2).join(' | ')}`);
      });

      if (queue.waiting.length > 5) {
        console.log(`   ... and ${queue.waiting.length - 5} more in waitlist`);
      }
    }

    // Rejected
    if (queue.rejected.length > 0) {
      console.log('\n🚫 NOT TONIGHT (Low quality):');
      console.log('─'.repeat(100));

      queue.rejected.forEach((signal) => {
        console.log(
          `❌ ${signal.symbol.padEnd(12)} | Score: ${signal.adjustedScore.toFixed(0).padStart(3)} | ${signal.signal?.strategy}`
        );
        const negatives = signal.reasons.filter(
          (r) => r.includes('-') || r.includes('❌')
        );
        if (negatives.length > 0) {
          console.log(`   Reasons: ${negatives.join(' | ')}`);
        }
      });
    }

    console.log('\n' + '═'.repeat(100));
  }

  /**
   * 🔄 Get next signal when a slot opens (a date leaves)
   */
  getNextSignal(): RankedSignal | null {
    if (this.signalQueue.waiting.length > 0) {
      const nextSignal = this.signalQueue.waiting.shift()!;
      nextSignal.queueStatus = 'ACTIVE';
      this.signalQueue.active.push(nextSignal);

      console.log(`\n🔄 NEW DATE ARRIVES!`);
      console.log(
        `   💃 ${nextSignal.symbol} joins the party! ` +
          `Score: ${nextSignal.adjustedScore.toFixed(0)} | ${nextSignal.signal?.strategy}`
      );

      return nextSignal;
    }

    console.log('\n⏳ No one left in waitlist');
    return null;
  }

  /**
   * 📊 Get queue stats
   */
  getQueueStatus() {
    return {
      active: this.signalQueue.active.length,
      waiting: this.signalQueue.waiting.length,
      rejected: this.signalQueue.rejected.length,
      total: this.signalQueue.active.length + this.signalQueue.waiting.length,
      lastScan: this.signalQueue.lastScanTime,
      scanDuration: this.signalQueue.scanDuration,
    };
  }
}
// ============================================================================
// USAGE EXAMPLE
// ============================================================================

async function main() {
  const scanner = new TradingScanner();
  const selector = new VIPSignalSelector(scanner);

  // Your symbol list
  const symbols = [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'AVAXUSDT',
    'PEPEUSDT',
    'DOGEUSDT',
    'SHIBUSDT',
    'LINKUSDT',
    'MATICUSDT',
    'ADAUSDT',
    // ... all your symbols
  ];

  // STEP 1: Scan entire market
  const allSignals = await selector.scanEntireMarket(symbols);

  // STEP 2: Rank all signals
  const rankedSignals = selector.rankSignals(allSignals);

  // STEP 3: Select best for trading
  const maxBots = 4;
  const currentActiveBots = 0; // None active yet
  const queue = selector.selectBestSignals(
    rankedSignals,
    maxBots,
    currentActiveBots
  );

  // STEP 4: Display results
  selector.displayQueue();

  // STEP 5: Trade the active signals
  console.log('\n🚀 Starting trades...');
  for (const signal of queue.active) {
    console.log(
      `✅ Trading ${signal.symbol} at ${signal.adjustedScore.toFixed(0)}%`
    );
    // await startBot(signal);
  }

  // Later, when a bot closes:
  // const nextSignal = selector.getNextSignal();
  // if (nextSignal) {
  //   await startBot(nextSignal);
  // }
}

export {
  VIPSignalSelector,
  type RankedSignal,
  type SignalQueue,
  SIGNAL_CONFIG,
};
