import type { CandleData, EntryType, WyckoffPhase } from '../../lib/type.js';

export interface WyckoffEvent {
  type:
    | 'PS' // Preliminary Support
    | 'SC' // Selling Climax
    | 'AR' // Automatic Rally
    | 'ST' // Secondary Test
    | 'SOS' // Sign of Strength
    | 'LPS' // Last Point of Support
    | 'PSY' // Preliminary Supply
    | 'BC' // Buying Climax
    | 'UD' // Upthrust Distribution
    | 'LPSY' // Last Point of Supply
    | 'SOW'; // Sign of Weakness
  timestamp: Date;
  price: number;
  volume: number;
  significance: number; // 0-100
}

export class WyckoffAnalyzer {
  private minCandlesRequired = 50;

  /**
   * Main analysis function
   */
  analyze(candles: CandleData): WyckoffPhase {
    if (!this.hasEnoughData(candles)) {
      return this.createNeutralPhase('Insufficient data');
    }

    // Calculate key metrics
    const volumeProfile = this.analyzeVolume(candles);
    const priceAction = this.analyzePriceAction(candles);
    const events = this.detectWyckoffEvents(candles);

    // Determine current phase
    const phase = this.determinePhase(volumeProfile, priceAction, events);

    return phase;
  }

  /**
   * Check if we have enough data
   */
  private hasEnoughData(candles: CandleData): boolean {
    return (
      candles.closes.length >= this.minCandlesRequired &&
      candles.volumes.length >= this.minCandlesRequired
    );
  }

  /**
   * Analyze volume patterns
   */
  private analyzeVolume(candles: CandleData): {
    avgVolume: number;
    recentVolume: number;
    volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
    climaxDetected: boolean;
  } {
    const volumes = candles.volumes;
    const len = volumes.length;

    // Average volume (50 periods)
    const avgVolume =
      volumes.slice(-50).reduce((sum, v) => sum + v, 0) / Math.min(50, len);

    // Recent volume (last 10 periods)
    const recentVolume =
      volumes.slice(-10).reduce((sum, v) => sum + v, 0) / Math.min(10, len);

    // Volume trend
    const recentAvg =
      volumes.slice(-20, -10).reduce((sum, v) => sum + v, 0) / 10;
    const currentAvg = volumes.slice(-10).reduce((sum, v) => sum + v, 0) / 10;

    let volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
    if (currentAvg > recentAvg * 1.2) {
      volumeTrend = 'INCREASING';
    } else if (currentAvg < recentAvg * 0.8) {
      volumeTrend = 'DECREASING';
    } else {
      volumeTrend = 'STABLE';
    }

    // Climax detection (volume spike > 2x average)
    const maxRecentVolume = Math.max(...volumes.slice(-5));
    const climaxDetected = maxRecentVolume > avgVolume * 2;

    return {
      avgVolume,
      recentVolume,
      volumeTrend,
      climaxDetected,
    };
  }

  /**
   * Analyze price action
   */
  private analyzePriceAction(candles: CandleData): {
    trend: 'UP' | 'DOWN' | 'SIDEWAYS';
    volatility: number;
    priceRange: { high: number; low: number };
    compression: boolean;
  } {
    const closes = candles.closes;
    const highs = candles.highs;
    const lows = candles.lows;
    const len = closes.length;

    // Trend determination (20-period SMA comparison)
    const sma20 =
      closes.slice(-20).reduce((sum, c) => sum + c, 0) / Math.min(20, len);
    const sma50 =
      closes.slice(-50).reduce((sum, c) => sum + c, 0) / Math.min(50, len);
    const currentPrice = closes[len - 1] as number;

    let trend: 'UP' | 'DOWN' | 'SIDEWAYS';
    if (currentPrice > sma20 && sma20 > sma50) {
      trend = 'UP';
    } else if (currentPrice < sma20 && sma20 < sma50) {
      trend = 'DOWN';
    } else {
      trend = 'SIDEWAYS';
    }

    // Volatility (ATR-like calculation)
    let atrSum = 0;
    for (let i = len - 14; i < len; i++) {
      const high = highs[i] as number;
      const low = lows[i] as number;
      atrSum += high - low;
    }
    const volatility = atrSum / 14 / currentPrice;

    // Price range (last 50 bars)
    const recentCandles = 50;
    const recentHighs = highs.slice(-recentCandles);
    const recentLows = lows.slice(-recentCandles);
    const priceRange = {
      high: Math.max(...recentHighs),
      low: Math.min(...recentLows),
    };

    // Compression detection (low volatility period)
    const compression = volatility < 0.02; // Less than 2% volatility

    return {
      trend,
      volatility,
      priceRange,
      compression,
    };
  }

  /**
   * Detect Wyckoff events
   */
  private detectWyckoffEvents(candles: CandleData): WyckoffEvent[] {
    const events: WyckoffEvent[] = [];
    const len = candles.closes.length;

    // Only check last 20 candles for events
    for (let i = Math.max(0, len - 20); i < len; i++) {
      const close = candles.closes[i] as number;
      const high = candles.highs[i] as number;
      const low = candles.lows[i] as number;
      const volume = candles.volumes[i] as number;
      const timestamp = new Date(candles.timestamps[i] as number);

      // Get context
      const avgVolume =
        candles.volumes
          .slice(Math.max(0, i - 20), i)
          .reduce((sum, v) => sum + v, 0) / 20;
      const priceChange =
        i > 0 ? ((close - (candles.closes[i - 1] as number)) / close) * 100 : 0;

      // Detect Selling Climax (SC)
      if (
        volume > avgVolume * 2 &&
        priceChange < -2 &&
        low < Math.min(...candles.lows.slice(Math.max(0, i - 20), i))
      ) {
        events.push({
          type: 'SC',
          timestamp,
          price: close,
          volume,
          significance: 90,
        });
      }

      // Detect Buying Climax (BC)
      if (
        volume > avgVolume * 2 &&
        priceChange > 2 &&
        high > Math.max(...candles.highs.slice(Math.max(0, i - 20), i))
      ) {
        events.push({
          type: 'BC',
          timestamp,
          price: close,
          volume,
          significance: 90,
        });
      }

      // Detect Sign of Strength (SOS)
      if (volume > avgVolume * 1.5 && priceChange > 1.5) {
        events.push({
          type: 'SOS',
          timestamp,
          price: close,
          volume,
          significance: 70,
        });
      }

      // Detect Sign of Weakness (SOW)
      if (volume > avgVolume * 1.5 && priceChange < -1.5) {
        events.push({
          type: 'SOW',
          timestamp,
          price: close,
          volume,
          significance: 70,
        });
      }
    }

    return events;
  }

  /**
   * Determine current Wyckoff phase
   */

  private determinePhase(
    volumeProfile: any,
    priceAction: any,
    events: WyckoffEvent[]
  ): WyckoffPhase {
    const recentEvents = events.slice(-5);

    // Check for ACCUMULATION phase
    if (this.isAccumulation(volumeProfile, priceAction, recentEvents)) {
      return this.createAccumulationPhase(
        recentEvents,
        volumeProfile,
        priceAction
      );
    }

    // Check for DISTRIBUTION phase
    if (this.isDistribution(volumeProfile, priceAction, recentEvents)) {
      return this.createDistributionPhase(
        recentEvents,
        volumeProfile,
        priceAction
      );
    }

    // Check for MARKUP phase
    if (this.isMarkup(volumeProfile, priceAction, recentEvents)) {
      return this.createMarkupPhase(recentEvents, volumeProfile, priceAction);
    }

    // Check for MARKDOWN phase
    if (this.isMarkdown(volumeProfile, priceAction, recentEvents)) {
      return this.createMarkdownPhase(recentEvents, volumeProfile, priceAction);
    }

    return this.createNeutralPhase('No clear phase detected');
  }

  // 🔧 FIXED: Looser Wyckoff detection logic

  /**
   * Check if in ACCUMULATION phase (LOOSENED)
   */
  private isAccumulation(
    volumeProfile: any,
    priceAction: any,
    events: WyckoffEvent[]
  ): boolean {
    const hasSC = events.some((e) => e.type === 'SC');
    const hasSOS = events.some((e) => e.type === 'SOS');
    const sideways = priceAction.trend === 'SIDEWAYS';
    const compression = priceAction.compression;
    const volumeDecreasing = volumeProfile.volumeTrend === 'DECREASING';
    const downtrend = priceAction.trend === 'DOWN';

    // ✅ ACCUMULATION can be detected if:
    // 1. Selling Climax detected (strong signal)
    if (hasSC) return true;

    // 2. Sign of Strength in sideways market (recovery)
    if (hasSOS && sideways) return true;

    // 3. Classic: sideways + compression + decreasing volume
    if (sideways && compression && volumeDecreasing) return true;

    // 4. Downtrend showing signs of exhaustion
    if (downtrend && compression && volumeDecreasing) return true;

    // 5. Climax selling with compression
    if (volumeProfile.climaxDetected && compression) return true;

    return false;
  }

  /**
   * Check if in DISTRIBUTION phase (LOOSENED)
   */
  private isDistribution(
    volumeProfile: any,
    priceAction: any,
    events: WyckoffEvent[]
  ): boolean {
    const hasBC = events.some((e) => e.type === 'BC');
    const hasSOW = events.some((e) => e.type === 'SOW');
    const sideways = priceAction.trend === 'SIDEWAYS';
    const highVolume =
      volumeProfile.recentVolume > volumeProfile.avgVolume * 1.2;

    // ✅ DISTRIBUTION can be detected if:
    // 1. Buying Climax detected (strong signal)
    if (hasBC) return true;

    // 2. Sign of Weakness after rally
    if (hasSOW && (sideways || priceAction.trend === 'UP')) return true;

    // 3. Sideways with high volume (churning)
    if (sideways && highVolume) return true;

    // 4. Climax buying
    if (volumeProfile.climaxDetected && priceAction.trend === 'UP') return true;

    return false;
  }

  /**
   * Check if in MARKUP phase (LOOSENED)
   */
  private isMarkup(
    volumeProfile: any,
    priceAction: any,
    events: WyckoffEvent[]
  ): boolean {
    const hasSOS = events.some((e) => e.type === 'SOS');
    const uptrend = priceAction.trend === 'UP';
    const volumeIncreasing = volumeProfile.volumeTrend === 'INCREASING';

    // ✅ MARKUP can be detected if:
    // 1. Clear uptrend (doesn't need volume confirmation)
    if (uptrend) return true;

    // 2. Sign of Strength even if trend unclear
    if (hasSOS) return true;

    // 3. Increasing volume with sideways (potential breakout)
    if (volumeIncreasing && priceAction.trend === 'SIDEWAYS') return true;

    return false;
  }

  /**
   * Check if in MARKDOWN phase (LOOSENED)
   */
  private isMarkdown(
    volumeProfile: any,
    priceAction: any,
    events: WyckoffEvent[]
  ): boolean {
    const hasSOW = events.some((e) => e.type === 'SOW');
    const downtrend = priceAction.trend === 'DOWN';
    const volumeIncreasing = volumeProfile.volumeTrend === 'INCREASING';

    // ✅ MARKDOWN can be detected if:
    // 1. Clear downtrend
    if (downtrend) return true;

    // 2. Sign of Weakness
    if (hasSOW) return true;

    // 3. Increasing volume with distribution signs
    if (volumeIncreasing && priceAction.trend === 'SIDEWAYS') {
      // Check if coming from an uptrend (distribution → markdown)
      return true;
    }

    return false;
  }

  /**
   * Update phase creation to use dynamic confidence
   */
  private createAccumulationPhase(
    events: WyckoffEvent[],
    volumeProfile: any,
    priceAction: any
  ): WyckoffPhase {
    const hasSOS = events.some((e) => e.type === 'SOS');
    const hasSC = events.some((e) => e.type === 'SC');
    const hasLPS = events.some((e) => e.type === 'LPS');

    let confidence = 0;
    let stage = 'Early Accumulation';
    let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';

    // Factor 1: Sideways price action (0-25 points)
    if (priceAction.trend === 'SIDEWAYS') {
      if (priceAction.compression) {
        confidence += 25; // Perfect accumulation
        stage = 'Compressed Accumulation';
      } else {
        confidence += 15; // Ranging
      }
    } else if (priceAction.trend === 'DOWN' && priceAction.compression) {
      confidence += 20; // Downtrend exhaustion
      stage = 'Late Accumulation (Exhaustion)';
    }

    // Factor 2: Volume (0-25 points)
    if (volumeProfile.volumeTrend === 'DECREASING') {
      confidence += 25; // Classic accumulation
    } else if (volumeProfile.climaxDetected) {
      confidence += 20; // Selling climax
    } else if (volumeProfile.volumeTrend === 'STABLE') {
      confidence += 10;
    }

    // Factor 3: Wyckoff events (0-35 points)
    if (hasSC && hasSOS && hasLPS) {
      confidence += 35; // Perfect setup
      stage = 'Late Accumulation (Spring → SOS → LPS)';
      signal = 'BUY';
    } else if (hasSC && hasSOS) {
      confidence += 30;
      stage = 'Mid Accumulation (SC → SOS)';
      signal = 'BUY';
    } else if (hasSC) {
      confidence += 20;
      stage = 'Post-Climax Accumulation';
    } else if (hasSOS) {
      confidence += 25;
      stage = 'Sign of Strength Detected';
      signal = 'BUY';
    }

    // Factor 4: Price compression (0-15 points)
    if (priceAction.compression) {
      confidence += 15;
    }

    confidence = Math.min(100, confidence);

    return {
      phase: 'ACCUMULATION',
      confidence,
      stage,
      signal,
      strength: confidence,
      description: `${stage} - Confidence: ${confidence}% (${this.getConfidenceLabel(confidence)})`,
    };
  }

  // Similar updates for other phase creators...
  private createMarkupPhase(
    events: WyckoffEvent[],
    volumeProfile: any,
    priceAction: any
  ): WyckoffPhase {
    const hasSOS = events.some((e) => e.type === 'SOS');
    const hasSC = events.some((e) => e.type === 'SC');

    let confidence = 0;
    let stage = 'Early Markup';
    let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';

    // Factor 1: Trend strength (0-30 points)
    if (priceAction.trend === 'UP') {
      const volatility = priceAction.volatility;

      if (volatility > 0.05) {
        confidence += 30;
        stage = 'Strong Markup';
      } else if (volatility > 0.03) {
        confidence += 20;
        stage = 'Moderate Markup';
      } else {
        confidence += 10;
        stage = 'Weak Markup';
      }
    }

    // Factor 2: Volume confirmation (0-25 points)
    if (volumeProfile.volumeTrend === 'INCREASING') {
      confidence += 25;
    } else if (volumeProfile.climaxDetected) {
      confidence += 15;
    } else if (volumeProfile.volumeTrend === 'STABLE') {
      confidence += 10;
    }

    // Factor 3: Wyckoff events (0-30 points)
    if (hasSOS && hasSC) {
      confidence += 30;
      stage = 'Accumulation → Markup (Confirmed)';
      signal = 'BUY';
    } else if (hasSOS) {
      confidence += 20;
      stage = 'Markup with SOS';
      signal = 'BUY';
    } else if (hasSC) {
      confidence += 10;
    }

    // Factor 4: Price action (0-15 points)
    if (!priceAction.compression) {
      confidence += 15; // Active buying
    } else {
      confidence += 5;
    }

    confidence = Math.min(100, confidence);

    return {
      phase: 'MARKUP',
      confidence,
      stage,
      signal,
      strength: confidence,
      description: `${stage} - Confidence: ${confidence}% (${this.getConfidenceLabel(confidence)})`,
    };
  }

  private createMarkdownPhase(
    events: WyckoffEvent[],
    volumeProfile: any,
    priceAction: any
  ): WyckoffPhase {
    const hasSOW = events.some((e) => e.type === 'SOW');
    const hasBC = events.some((e) => e.type === 'BC');

    // ═══════════════════════════════════════════════════════════
    // DYNAMIC CONFIDENCE CALCULATION
    // ═══════════════════════════════════════════════════════════

    let confidence = 0;
    let stage = 'Early Markdown';
    let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';

    // Factor 1: Trend strength (0-30 points)
    if (priceAction.trend === 'DOWN') {
      // Check how strong the downtrend is
      const volatility = priceAction.volatility;

      if (volatility > 0.05) {
        confidence += 30; // Strong downtrend
        stage = 'Strong Markdown';
      } else if (volatility > 0.03) {
        confidence += 20; // Moderate downtrend
        stage = 'Moderate Markdown';
      } else {
        confidence += 10; // Weak downtrend
        stage = 'Weak Markdown';
      }
    }

    // Factor 2: Volume confirmation (0-25 points)
    if (volumeProfile.volumeTrend === 'INCREASING') {
      confidence += 25; // Strong confirmation
    } else if (volumeProfile.climaxDetected) {
      confidence += 15; // Climax selling
    } else if (volumeProfile.volumeTrend === 'STABLE') {
      confidence += 10; // Some volume
    }
    // No points if volume decreasing (weak signal)

    // Factor 3: Wyckoff events (0-30 points)
    if (hasSOW && hasBC) {
      confidence += 30; // Perfect setup
      stage = 'Distribution → Markdown (Confirmed)';
      signal = 'SELL';
    } else if (hasSOW) {
      confidence += 20; // Sign of weakness
      stage = 'Markdown with SOW';
      signal = 'SELL';
    } else if (hasBC) {
      confidence += 10; // Buying climax (potential top)
    }

    // Factor 4: Price compression (0-15 points)
    // If price is NOT compressed during markdown = stronger signal
    if (!priceAction.compression) {
      confidence += 15; // Active selling
    } else {
      confidence += 5; // Compressed (consolidation)
    }

    // ═══════════════════════════════════════════════════════════
    // FINAL CONFIDENCE RANGE: 0-100
    // ═══════════════════════════════════════════════════════════

    // Weak markdown: 25-40% (don't block trading)
    // Moderate markdown: 41-65% (caution but allow)
    // Strong markdown: 66-100% (consider blocking)

    confidence = Math.min(100, confidence);

    return {
      phase: 'MARKDOWN',
      confidence,
      stage,
      signal,
      strength: confidence,
      description: `${stage} - Confidence: ${confidence}% (${this.getConfidenceLabel(confidence)})`,
    };
  }

  private createDistributionPhase(
    events: WyckoffEvent[],
    volumeProfile: any,
    priceAction: any
  ): WyckoffPhase {
    const hasSOW = events.some((e) => e.type === 'SOW');
    const hasBC = events.some((e) => e.type === 'BC');
    const hasLPSY = events.some((e) => e.type === 'LPSY');

    let confidence = 0;
    let stage = 'Early Distribution';
    let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';

    // Factor 1: Sideways after uptrend (0-25 points)
    if (priceAction.trend === 'SIDEWAYS') {
      confidence += 25;
      stage = 'Sideways Distribution';
    } else if (priceAction.trend === 'UP') {
      confidence += 15; // Still rising but distribution signs
    }

    // Factor 2: Volume (0-25 points)
    if (volumeProfile.recentVolume > volumeProfile.avgVolume * 1.5) {
      confidence += 25; // High volume (churning)
    } else if (volumeProfile.climaxDetected) {
      confidence += 20;
    } else if (volumeProfile.volumeTrend === 'INCREASING') {
      confidence += 15;
    }

    // Factor 3: Wyckoff events (0-35 points)
    if (hasBC && hasSOW && hasLPSY) {
      confidence += 35;
      stage = 'Late Distribution (BC → SOW → LPSY)';
      signal = 'SELL';
    } else if (hasBC && hasSOW) {
      confidence += 30;
      stage = 'Mid Distribution (BC → SOW)';
      signal = 'SELL';
    } else if (hasBC) {
      confidence += 20;
      stage = 'Post-Climax Distribution';
    } else if (hasSOW) {
      confidence += 25;
      stage = 'Sign of Weakness Detected';
      signal = 'SELL';
    }

    // Factor 4: Not compressed (0-15 points)
    if (!priceAction.compression) {
      confidence += 15;
    }

    confidence = Math.min(100, confidence);

    return {
      phase: 'DISTRIBUTION',
      confidence,
      stage,
      signal,
      strength: confidence,
      description: `${stage} - Confidence: ${confidence}% (${this.getConfidenceLabel(confidence)})`,
    };
  }

  /**
   * Helper to label confidence levels
   */
  private getConfidenceLabel(confidence: number): string {
    if (confidence >= 80) return '❤️❤️❤️VERY HIGH';
    if (confidence >= 65) return '❤️❤️HIGH';
    if (confidence >= 50) return '❤️MODERATE';
    if (confidence >= 35) return '🖤LOW';
    return 'VERY LOW';
  }

  private createNeutralPhase(reason: string): WyckoffPhase {
    return {
      phase: 'NEUTRAL',
      confidence: 0,
      signal: 'HOLD',
      strength: 0,
      description: reason,
    };
  }

  /**
   * Get trading recommendation based on Wyckoff analysis
   */
  getTradeSignal(phase: WyckoffPhase): {
    shouldTrade: boolean;
    side?: EntryType;
    confidence: number;
    reason: string;
  } {
    // Only trade on high-confidence signals
    if (phase.confidence < 70) {
      return {
        shouldTrade: false,
        confidence: phase.confidence,
        reason: 'Low confidence - waiting for clearer setup',
      };
    }

    switch (phase.phase) {
      case 'ACCUMULATION':
        if (phase.stage?.includes('Late') || phase.signal === 'BUY') {
          return {
            shouldTrade: true,
            side: 'LONG',
            confidence: phase.confidence,
            reason: `Wyckoff Accumulation ${phase.stage} - Strong buy setup`,
          };
        }
        break;

      case 'DISTRIBUTION':
        if (phase.stage?.includes('Late') || phase.signal === 'SELL') {
          return {
            shouldTrade: true,
            side: 'SHORT',
            confidence: phase.confidence,
            reason: `Wyckoff Distribution ${phase.stage} - Short setup`,
          };
        }
        break;

      case 'MARKUP':
        // Can enter LONG on pullbacks during markup
        return {
          shouldTrade: true,
          side: 'LONG',
          confidence: phase.confidence,
          reason: 'Wyckoff Markup Phase - Trend following long',
        };

      case 'MARKDOWN':
        // Can enter SHORT on rallies during markdown
        return {
          shouldTrade: true,
          side: 'SHORT',
          confidence: phase.confidence,
          reason: 'Wyckoff Markdown Phase - Trend following short',
        };
    }

    return {
      shouldTrade: false,
      confidence: phase.confidence,
      reason: 'No clear Wyckoff signal',
    };
  }
}
