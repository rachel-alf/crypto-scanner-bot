// ─────────────────────────────────────────────────────────────────────────────
// TradeRejectionLogger.ts
//
// Solves: "bot selected token but never traded — no idea why"
//
// Every gate in createBot / enterPosition calls reject() with a structured
// reason. At the end of each attempt one summary line is emitted regardless
// of how deep into the pipeline it got. Recent history is kept in memory so
// you can call getRejectionSummary() from the dashboard at any time.
//
// Usage:
//   const r = new TradeRejectionLogger(signal);
//   ...
//   return r.reject('GATE_RR', `RR ${rr.toFixed(2)} < 1.5`);   // returns false/null
//   ...
//   r.accept();   // call once if the trade actually opens
// ─────────────────────────────────────────────────────────────────────────────

export type RejectionGate =
  // createBot gates
  | 'COOLDOWN'
  | 'TRADE_LIMIT'
  | 'CONCURRENT_POSITIONS'
  | 'INVALID_SIGNAL'
  | 'PRICE_FETCH'
  | 'ENTRY_SLIPPAGE'
  // enterPosition gates
  | 'ALREADY_HAS_POSITION'
  | 'SYMBOL_BLOCKED'
  | 'CANDLE_INIT'
  | 'CANDLE_DATA'
  | 'INVALID_PRICE'
  | 'SIGNAL_SLIPPAGE'
  | 'ZERO_BALANCE'
  | 'INVALID_ATR'
  | 'ATR_RISK_TOO_HIGH'
  | 'GATE_RR'
  | 'SPREAD_TOO_WIDE'
  | 'ORDER_BOOK_FETCH'
  | 'CAPITAL_RESERVATION'
  | 'ORDER_FAILED'
  | 'POST_FILL_RR'
  | 'SLTP_CALC_FAILED'
  // catch-all
  | 'UNKNOWN';

export interface RejectionRecord {
  timestamp: Date;
  symbol: string;
  side: string;
  strategy: string;
  confidence: number;
  gate: RejectionGate;
  reason: string;
  // optional context attached at rejection time
  context?: Record<string, string | number>;
}

export interface AcceptRecord {
  timestamp: Date;
  symbol: string;
  side: string;
  strategy: string;
  confidence: number;
}

// ─────────────────────────────────────────────────────────────────────────────

const MAX_HISTORY = 200;

// Module-level store so the dashboard can import it directly
const rejectionHistory: RejectionRecord[] = [];
const acceptHistory: AcceptRecord[] = [];

// ─────────────────────────────────────────────────────────────────────────────

export class TradeRejectionLogger {
  private readonly symbol: string;
  private readonly side: string;
  private readonly strategy: string;
  private readonly confidence: number;
  private readonly startedAt: Date;
  private settled = false; // prevent double-logging

  constructor(signal: {
    symbol: string;
    side: string;
    strategy: string;
    confidence: number;
  }) {
    this.symbol = signal.symbol;
    this.side = signal.side;
    this.strategy = signal.strategy;
    this.confidence = signal.confidence;
    this.startedAt = new Date();
  }

  // ── Call at every gate failure ─────────────────────────────────────────────
  // Returns `value` so you can write:
  //   return r.reject('GATE_RR', `RR too low`, { rr: preRR });
  // and it acts as the return statement in the enclosing function.

  reject<T extends false | null>(
    gate: RejectionGate,
    reason: string,
    context?: Record<string, string | number>,
    value?: T
  ): T extends null ? null : false {
    if (this.settled) return (value ?? false) as any;
    this.settled = true;

    // Create the base record without context
    const record: RejectionRecord = {
      timestamp: new Date(),
      symbol: this.symbol,
      side: this.side,
      strategy: this.strategy,
      confidence: this.confidence,
      gate,
      reason,
      // Don't include context property at all if it's undefined
      ...(context !== undefined ? { context } : {}),
    };

    // Push to module history
    rejectionHistory.unshift(record);
    if (rejectionHistory.length > MAX_HISTORY) rejectionHistory.pop();

    // ── Single summary line — easy to grep, easy to read ──────────────────
    const elapsed = Date.now() - this.startedAt.getTime();
    const ctx = context
      ? '  ' +
        Object.entries(context)
          .map(([k, v]) => `${k}=${v}`)
          .join('  ')
      : '';

    console.log(
      `\n${'─'.repeat(72)}\n` +
        `🚫 TRADE REJECTED  ${this.symbol}  ${this.side}  [${this.strategy}]\n` +
        `   Gate     : ${gate}\n` +
        `   Reason   : ${reason}${ctx ? '\n   Context  :' + ctx : ''}\n` +
        `   Signal   : confidence=${this.confidence}%\n` +
        `   Elapsed  : ${elapsed}ms\n` +
        `${'─'.repeat(72)}`
    );

    return (value ?? false) as any;
  }

  // ── Call once when the trade actually opens ────────────────────────────────
  accept(): void {
    if (this.settled) return;
    this.settled = true;

    const record: AcceptRecord = {
      timestamp: new Date(),
      symbol: this.symbol,
      side: this.side,
      strategy: this.strategy,
      confidence: this.confidence,
    };

    acceptHistory.unshift(record);
    if (acceptHistory.length > MAX_HISTORY) acceptHistory.pop();

    // No noise on success — enterPosition already logs the ✅ open line.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Module-level accessors (call from dashboard / status endpoint)
  // ─────────────────────────────────────────────────────────────────────────

  static getRecentRejections(limit = 20): RejectionRecord[] {
    return rejectionHistory.slice(0, limit);
  }

  static getRecentAccepts(limit = 20): AcceptRecord[] {
    return acceptHistory.slice(0, limit);
  }

  // Rejection breakdown: how many times each gate killed a trade
  static getGateStats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const r of rejectionHistory) {
      counts[r.gate] = (counts[r.gate] ?? 0) + 1;
    }
    // Sort descending by count
    return Object.fromEntries(
      Object.entries(counts).sort(([, a], [, b]) => b - a)
    );
  }

  // Per-symbol rejection count (shows which tokens are consistently blocked)
  static getSymbolStats(): Record<
    string,
    { rejected: number; accepted: number; topGate: string }
  > {
    const map: Record<
      string,
      { rejected: number; accepted: number; gates: Record<string, number> }
    > = {};

    for (const r of rejectionHistory) {
      let entry = map[r.symbol];
      if (!entry) {
        entry = { rejected: 0, accepted: 0, gates: {} };
        map[r.symbol] = entry;
      }
      entry.rejected++;
      entry.gates[r.gate] = (entry.gates[r.gate] ?? 0) + 1;
    }

    for (const a of acceptHistory) {
      let entry = map[a.symbol];
      if (!entry) {
        entry = { rejected: 0, accepted: 0, gates: {} };
        map[a.symbol] = entry;
      }
      entry.accepted++;
    }

    return Object.fromEntries(
      Object.entries(map).map(([sym, data]) => {
        const topGate =
          Object.entries(data.gates).sort(([, a], [, b]) => b - a)[0]?.[0] ??
          '-';
        return [
          sym,
          { rejected: data.rejected, accepted: data.accepted, topGate },
        ];
      })
    );
  }

  // Pretty-print a diagnostic snapshot (call from CLI or dashboard)
  static printDiagnostics(): void {
    const SEP = '═'.repeat(72);

    console.log(`\n${SEP}`);
    console.log(`  TRADE REJECTION DIAGNOSTICS`);
    console.log(SEP);

    const gateStats = TradeRejectionLogger.getGateStats();
    if (Object.keys(gateStats).length === 0) {
      console.log('  No rejections recorded yet.');
    } else {
      console.log('\n  GATE BREAKDOWN (most common first):');
      for (const [gate, count] of Object.entries(gateStats)) {
        const bar = '█'.repeat(Math.min(count, 30));
        console.log(
          `    ${gate.padEnd(28)} ${String(count).padStart(4)}  ${bar}`
        );
      }
    }

    console.log('\n  RECENT REJECTIONS:');
    for (const r of TradeRejectionLogger.getRecentRejections(10)) {
      const ts = r.timestamp.toISOString().slice(11, 19);
      const ctx = r.context
        ? '  ' +
          Object.entries(r.context)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
        : '';
      console.log(
        `    [${ts}] ${r.symbol.padEnd(14)} ${r.gate.padEnd(28)} ${r.reason}${ctx}`
      );
    }

    console.log('\n  SYMBOL HIT RATES:');
    const symStats = TradeRejectionLogger.getSymbolStats();
    const sorted = Object.entries(symStats).sort(
      ([, a], [, b]) => b.rejected - a.rejected
    );
    for (const [sym, data] of sorted.slice(0, 15)) {
      const total = data.rejected + data.accepted;
      const acceptRate =
        total > 0 ? ((data.accepted / total) * 100).toFixed(0) : '0';
      console.log(
        `    ${sym.padEnd(16)} rejected=${String(data.rejected).padStart(3)}  ` +
          `accepted=${String(data.accepted).padStart(3)}  accept%=${acceptRate.padStart(3)}%  ` +
          `topGate=${data.topGate}`
      );
    }

    console.log(`\n${SEP}\n`);
  }
}
