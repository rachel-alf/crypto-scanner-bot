import fs from 'fs';
import path from 'path';

class SharedBalanceManager {
  private totalBalance: number;
  private maxConcurrentPositions: number;
  private reserveRatio: number;
  private allocatedCapital: Map<string, number>;
  private stateFile: string;
  private lockFile: string;

  constructor(
    totalBalance: number,
    maxPositions: number = 2,
    reserveRatio: number = 0.1
  ) {
    this.totalBalance = totalBalance;
    this.maxConcurrentPositions = maxPositions;
    this.reserveRatio = reserveRatio;
    this.allocatedCapital = new Map();
    this.stateFile = path.join('./states/shares_balance', 'shared_balance.json');
    this.lockFile = path.join('./states/shares_balance', '.balance.lock');
    this.ensureStateDir();
    this.loadState();
  }

  private ensureStateDir(): void {
    const dir = './states/shares_balance';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Acquire lock with timeout
   */
  private async acquireLock(timeoutMs: number = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        fs.writeFileSync(this.lockFile, process.pid.toString(), { flag: 'wx' });
        return true;
      } catch (err) {
        try {
          const lockAge = Date.now() - fs.statSync(this.lockFile).mtimeMs;
          if (lockAge > 10000) {
            this.releaseLock();
            continue;
          }
        } catch (readErr) {
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return false;
  }

  /**
   * Release lock
   */
  private releaseLock(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch (err) {
      // Lock already released
    }
  }

  /**
   * Calculate capital per position
   */
  getCapitalPerPosition(): number {
    const tradingCapital = this.totalBalance * (1 - this.reserveRatio);
    return tradingCapital / this.maxConcurrentPositions;
  }

  /**
   * Get total balance
   */
  getTotalBalance(): number {
    return this.totalBalance;
  }

  /**
   * Get trading capital (after reserve)
   */
  getTradingCapital(): number {
    return this.totalBalance * (1 - this.reserveRatio);
  }

  /**
   * Get reserve amount
   */
  getReserve(): number {
    return this.totalBalance * this.reserveRatio;
  }

  /**
   * Get available balance
   */
  getAvailableBalance(): number {
    this.loadState();
    const allocated = this.getAllocatedBalance();
    const tradingCapital = this.getTradingCapital();
    return Math.max(0, tradingCapital - allocated);
  }

  /**
   * Get total allocated
   */
  getAllocatedBalance(): number {
    return Array.from(this.allocatedCapital.values()).reduce(
      (sum, amt) => sum + amt,
      0
    );
  }

  /**
   * Request capital (with locking)
   */
  async requestCapital(symbol: string): Promise<number> {
    const locked = await this.acquireLock();
    if (!locked) {
      this.log(`❌ ${symbol} failed to acquire lock`);
      return 0;
    }

    try {
      this.loadState();

      if (this.allocatedCapital.has(symbol)) {
        return this.allocatedCapital.get(symbol)!;
      }

      const perPosition = this.getCapitalPerPosition();
      const available = this.getAvailableBalance();

      if (perPosition > available) {
        this.log(
          `❌ DENIED ${symbol}: Need ${perPosition.toFixed(2)} but only ${available.toFixed(2)} available`
        );
        return 0;
      }

      this.allocatedCapital.set(symbol, perPosition);
      this.saveState();

      const remaining = this.getAvailableBalance();
      this.log(
        `✅ ALLOCATED ${perPosition.toFixed(2)} USDT to ${symbol} (${this.allocatedCapital.size}/${this.maxConcurrentPositions}) | Available: ${remaining.toFixed(2)}`
      );

      return perPosition;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Release capital (with locking)
   */
  async releaseCapital(symbol: string, pnl: number = 0): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();
      const allocated = this.allocatedCapital.get(symbol);

      if (allocated !== undefined) {
        this.allocatedCapital.delete(symbol);
        this.totalBalance += pnl;
        this.saveState();
        this.log(
          `🔓 RELEASED ${allocated.toFixed(2)} USDT from ${symbol} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | New Total: ${this.totalBalance.toFixed(2)}`
        );
      }
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Get allocated amount for symbol
   */
  getAllocatedAmount(symbol: string): number {
    this.loadState();
    return this.allocatedCapital.get(symbol) || 0;
  }

  /**
   * Check if symbol has allocation
   */
  hasAllocation(symbol: string): boolean {
    this.loadState();
    return this.allocatedCapital.has(symbol);
  }

  /**
   * Get detailed report
   */
  getReport(): string {
    this.loadState();
    const tradingCapital = this.getTradingCapital();
    const reserve = this.getReserve();
    const allocated = this.getAllocatedBalance();
    const available = this.getAvailableBalance();
    const perPosition = this.getCapitalPerPosition();

    return `
💰 SHARED BALANCE REPORT
════════════════════════════════
Total Balance:     ${this.totalBalance.toFixed(2)} USDT
Reserve (${(this.reserveRatio * 100).toFixed(0)}%):      ${reserve.toFixed(2)} USDT
Trading Capital:   ${tradingCapital.toFixed(2)} USDT

Per Position:      ${perPosition.toFixed(2)} USDT (${tradingCapital.toFixed(2)} ÷ ${this.maxConcurrentPositions})
Allocated:         ${allocated.toFixed(2)} USDT (${this.allocatedCapital.size} positions)
Available:         ${available.toFixed(2)} USDT

Active Allocations:
${
  Array.from(this.allocatedCapital.entries())
    .map(([symbol, amt]) => `  ${symbol.padEnd(12)} ${amt.toFixed(2)} USDT`)
    .join('\n') || '  (none)'
}
════════════════════════════════
    `.trim();
  }

  /**
   * Force allocate (for recovery)
   */
  async forceAllocate(symbol: string, amount: number): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();
      this.allocatedCapital.set(symbol, amount);
      this.saveState();
      this.log(`🔄 FORCE ALLOCATED ${amount.toFixed(2)} to ${symbol}`);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Reset all allocations
   */
  async resetAllocations(): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.allocatedCapital.clear();
      this.saveState();
      this.log('⚠️ ALL ALLOCATIONS CLEARED');
    } finally {
      this.releaseLock();
    }
  }

  private log(msg: string): void {
    console.log(`[BALANCE] ${msg}`);
  }

  private saveState(): void {
    try {
      const state = {
        totalBalance: this.totalBalance,
        maxConcurrentPositions: this.maxConcurrentPositions,
        reserveRatio: this.reserveRatio,
        allocatedCapital: Array.from(this.allocatedCapital.entries()),
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[BALANCE] Save failed:', err);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.totalBalance = data.totalBalance || this.totalBalance;
        this.allocatedCapital = new Map(data.allocatedCapital || []);
      }
    } catch (err) {
      // Keep existing state if load fails
    }
  }
}

// Singleton instance
export const sharedBalance = new SharedBalanceManager(
  parseFloat(process.env.TOTAL_CAPITAL || '200'),
  parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),
  parseFloat(process.env.RESERVE_RATIO || '0.10')
);

export default SharedBalanceManager;
