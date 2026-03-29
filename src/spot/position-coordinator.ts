import fs from 'fs';
import path from 'path';

class PositionCoordinator {
  private maxConcurrent: number;
  private activePositions: Set<string>;
  private stateFile: string;
  private lockFile: string;
  private pendingRequests: Map<string, number>;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(maxConcurrent: number = 5) {
    this.maxConcurrent = maxConcurrent;
    this.activePositions = new Set();
    this.pendingRequests = new Map();
    this.stateFile = path.join('./states/test', 'position_coordinator.json');
    this.lockFile = path.join('./states/test', '.coordinator.lock');

    this.ensureStateDir();
    this.loadState();

    // ✅ Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * ✅ Ensure states directory exists
   */
  private ensureStateDir(): void {
    const dir = path.dirname(this.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * ✅ Acquire lock for state operations
   */
  private acquireLock(): boolean {
    try {
      // Try to create lock file
      fs.writeFileSync(this.lockFile, Date.now().toString(), { flag: 'wx' });
      return true;
    } catch {
      // Lock already exists
      return false;
    }
  }

  /**
   * ✅ Release lock for state operations
   */
  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockFile)) {
        fs.unlinkSync(this.lockFile);
      }
    } catch (err) {
      // Ignore errors on lock release
    }
  }

  /**
   * ✅ Wait for lock with timeout
   */
  private waitForLock(timeout: number = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkLock = () => {
        if (this.acquireLock()) {
          resolve(true);
          return;
        }

        if (Date.now() - startTime > timeout) {
          resolve(false);
          return;
        }

        // Check again after 100ms
        setTimeout(checkLock, 100);
      };

      checkLock();
    });
  }

  /**
   * ✅ Periodic cleanup of stale pending requests
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupStalePending();
        this.cleanupOldLocks();
      },
      2 * 60 * 1000
    ); // Every 2 minutes
  }

  /**
   * ✅ Remove pending requests older than 30 seconds
   */
  private cleanupStalePending(): void {
    const now = Date.now();
    const staleThreshold = 30 * 1000; // 30 seconds

    let removed = 0;
    this.pendingRequests.forEach((timestamp, symbol) => {
      if (now - timestamp > staleThreshold) {
        this.pendingRequests.delete(symbol);
        removed++;
      }
    });

    if (removed > 0) {
      this.log(`🧹 Cleaned ${removed} stale pending requests`);
    }
  }

  /**
   * ✅ Remove old lock files
   */
  private cleanupOldLocks(): void {
    try {
      if (fs.existsSync(this.lockFile)) {
        const stats = fs.statSync(this.lockFile);
        const age = Date.now() - stats.mtimeMs;

        // Remove locks older than 1 minute
        if (age > 60 * 1000) {
          fs.unlinkSync(this.lockFile);
          this.log('🧹 Removed stale lock file');
        }
      }
    } catch (err) {
      // Ignore errors
    }
  }

  /**
   * ✅ Request position opening permission
   */
  async requestPosition(symbol: string): Promise<boolean> {
    // Check if already active
    if (this.activePositions.has(symbol)) {
      this.log(`⏭️ Position already active for ${symbol}`);
      return false;
    }

    // Check if already pending
    if (this.pendingRequests.has(symbol)) {
      this.log(`⏭️ Already pending for ${symbol}`);
      return false;
    }

    // Check max concurrent limit
    if (this.activePositions.size >= this.maxConcurrent) {
      this.pendingRequests.set(symbol, Date.now());
      this.log(
        `⏳ Max positions reached (${this.maxConcurrent}), added ${symbol} to pending`
      );
      return false;
    }

    // Acquire lock before modifying state
    const lockAcquired = await this.waitForLock();
    if (!lockAcquired) {
      this.log(`❌ Failed to acquire lock for ${symbol}`);
      return false;
    }

    try {
      // Add to active positions
      this.activePositions.add(symbol);
      this.saveState();
      this.log(
        `✅ Position approved for ${symbol} (${this.activePositions.size}/${this.maxConcurrent})`
      );
      return true;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * ✅ Release position when closed
   */
  async releasePosition(symbol: string): Promise<void> {
    // Acquire lock before modifying state
    const lockAcquired = await this.waitForLock();
    if (!lockAcquired) {
      this.log(`❌ Failed to acquire lock to release ${symbol}`);
      return;
    }

    try {
      // Remove from active positions
      this.activePositions.delete(symbol);

      // Remove from pending if exists
      this.pendingRequests.delete(symbol);

      this.saveState();
      this.log(
        `✅ Position released for ${symbol} (${this.activePositions.size}/${this.maxConcurrent})`
      );

      // Check if we can process pending requests
      this.processPendingRequests();
    } finally {
      this.releaseLock();
    }
  }

  /**
   * ✅ Process pending requests when slots free up
   */
  private async processPendingRequests(): Promise<void> {
    // Process in FIFO order (oldest first)
    const pendingEntries = Array.from(this.pendingRequests.entries()).sort(
      (a, b) => a[1] - b[1]
    ); // Sort by timestamp

    for (const [symbol] of pendingEntries) {
      if (this.activePositions.size < this.maxConcurrent) {
        const lockAcquired = await this.waitForLock();
        if (!lockAcquired) continue;

        try {
          this.activePositions.add(symbol);
          this.pendingRequests.delete(symbol);
          this.saveState();
          this.log(
            `🔄 Activated pending position for ${symbol} (${this.activePositions.size}/${this.maxConcurrent})`
          );
        } finally {
          this.releaseLock();
        }
      }
    }
  }

  /**
   * ✅ Get current status
   */
  getStatus(): {
    active: string[];
    pending: string[];
    maxConcurrent: number;
  } {
    return {
      active: Array.from(this.activePositions),
      pending: Array.from(this.pendingRequests.keys()),
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * ✅ Cleanup on destroy
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.releaseLock();
    this.pendingRequests.clear();
    this.log('🗑️ PositionCoordinator destroyed');
  }

  /**
   * Force register (with lock)
   */
  async forceRegister(symbol: string): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();
      this.activePositions.add(symbol);
      this.saveState();
      this.log(`🔄 FORCE REGISTERED ${symbol}`);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * ✅ Force reset all positions (use with caution)
   */
  async reset(): Promise<void> {
    const lockAcquired = await this.waitForLock();
    if (!lockAcquired) {
      this.log('❌ Failed to acquire lock for reset');
      return;
    }

    try {
      this.activePositions.clear();
      this.pendingRequests.clear();
      this.saveState();
      this.log('🔄 All positions reset');
    } finally {
      this.releaseLock();
    }
  }

  private log(msg: string): void {
    console.log(`[COORDINATOR] ${msg}`);
  }

  private saveState(): void {
    try {
      const state = {
        maxConcurrent: this.maxConcurrent,
        activePositions: Array.from(this.activePositions),
        pendingRequests: Array.from(this.pendingRequests.entries()),
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[COORDINATOR] Save failed:', err);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.activePositions = new Set(data.activePositions || []);

        // Restore pending requests with their timestamps
        if (data.pendingRequests && Array.isArray(data.pendingRequests)) {
          this.pendingRequests = new Map(data.pendingRequests);
        }

        this.log(`📦 Loaded ${this.activePositions.size} active positions`);
      }
    } catch (err) {
      this.log(
        `⚠️ State load failed: ${err instanceof Error ? err.message : String(err)}`
      );
      // If load fails, keep existing state
    }
  }
}

// Singleton
export const positionCoordinator = new PositionCoordinator(
  parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2')
);

export default PositionCoordinator;
