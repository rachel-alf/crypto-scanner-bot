import fs from 'fs';
import path from 'path';

interface PositionAllocation {
  symbol: string;
  marginUsed: number;
  positionSize: number;
  leverage: number;
  timestamp: number;
}

class FuturesBalanceManager {
  private totalBalance: number;
  private maxActiveBots: number;
  private maxConcurrentPositions: number;
  private reserveRatio: number;
  private defaultLeverage: number;
  private allocations: Map<string, PositionAllocation>;
  private stateFile: string;
  private lockFile: string;

  constructor(
    totalBalance: number, 
    maxActiveBots:number=10,
    maxPositions: number = 55, 
    reserveRatio: number = 0.01,
    defaultLeverage: number = 5
  ) {
    this.totalBalance = totalBalance;
    this.maxActiveBots = maxActiveBots;
    this.maxConcurrentPositions = maxPositions;
    this.reserveRatio = reserveRatio;
    this.defaultLeverage = defaultLeverage;
    this.allocations = new Map();
    this.stateFile = path.join('./states/futures', 'futures_shared_balance.json');
    this.lockFile = path.join('./states/futures', '.futures_shared_balance.lock');
    this.ensureStateDir();
    this.loadState();

    // Log on initialization
    console.log(`[BALANCE] Initialized with shared state file: ${this.stateFile}`);
    console.log(`[BALANCE] Max positions: ${maxPositions}, Max bots: ${maxActiveBots}`);


  }

  private ensureStateDir(): void {
    const dir = './states/futures';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

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
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return false;
  }

  private releaseLock(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch (err:any) {
      // Lock already released
      console.log(err.message);
    }
  }

  /**
   * ✅ NEW: Calculate margin per position based on leverage
   * This is what you actually need to reserve, not the full position size
   */
  getMarginPerPosition(leverage: number = this.defaultLeverage): number {
    const tradingCapital = this.totalBalance * (1 - this.reserveRatio);
    const baseAllocation = tradingCapital / this.maxConcurrentPositions;
    console.log("🥑 ~ FuturesBalanceManager ~ getMarginPerPosition ~ baseAllocation:", baseAllocation)
    
    // The margin you need is the base allocation
    // But you can control a larger position due to leverage
    return baseAllocation;
  }

  /**
   * ✅ NEW: Get maximum position size you can open (including leverage)
   */
  getMaxPositionSize(leverage: number = this.defaultLeverage): number {
    const marginPerPosition = this.getMarginPerPosition(leverage);
    // Position size = margin × leverage
    return marginPerPosition * leverage;
  }

  getTotalBalance(): number {
    return this.totalBalance;
  }

  getTradingCapital(): number {
    return this.totalBalance * (1 - this.reserveRatio);
  }

  getReserve(): number {
    return this.totalBalance * this.reserveRatio;
  }

  /**
   * ✅ UPDATED: Get total margin used (not position size)
   */
  getUsedMargin(): number {
    this.loadState();
    return Array.from(this.allocations.values())
      .reduce((sum, alloc) => sum + alloc.marginUsed, 0);
  }

  /**
   * ✅ UPDATED: Available margin (what matters in futures)
   */
  getAvailableMargin(): number {
    this.loadState();
    const usedMargin = this.getUsedMargin();
    const tradingCapital = this.getTradingCapital();
    return Math.max(0, tradingCapital - usedMargin);
  }

  /**
   * ✅ UPDATED: Request capital for futures position
   * @param symbol - Trading symbol
   * @param positionSizeUsdt - Desired position size in USDT
   * @param leverage - Leverage to use (default: 5x)
   * @returns Allocated margin amount (NOT position size)
   */
async requestCapital(
  symbol: string, 
  marginAmount: number,  // Changed from positionSizeUsdt
  leverage: number = this.defaultLeverage
): Promise<number> {
  console.log("🔧 requestCapital called:");
  console.log(`   Symbol: ${symbol}`);
  console.log(`   Margin: ${marginAmount} USDT`);
  console.log(`   Leverage: ${leverage}x`);
  console.log(`   Position size will be: ${marginAmount * leverage} USDT`);

  const locked = await this.acquireLock();
  if (!locked) {
    this.log(`❌ ${symbol} failed to acquire lock`);
    return 0;
  }

  try {
    this.loadState();

    // Check if already allocated
    if (this.allocations.has(symbol)) {
      const existing = this.allocations.get(symbol)!;
      this.log(`ℹ️ ${symbol} already allocated: ${existing.marginUsed.toFixed(2)} USDT margin`);
      return existing.marginUsed;
    }

    const availableMargin = this.getAvailableMargin();
    console.log(`   Available margin: ${availableMargin}`);

    // Check margin availability
    if (marginAmount > availableMargin) {
      this.log(
        `❌ DENIED ${symbol}: Need ${marginAmount.toFixed(2)} margin ` +
        `but only ${availableMargin.toFixed(2)} available`
      );
      return 0;
    }

    // Check position limit
    if (this.allocations.size >= this.maxConcurrentPositions) {
      this.log(`❌ DENIED ${symbol}: Max positions (${this.maxConcurrentPositions}) reached`);
      return 0;
    }

    // Calculate actual position size
    const positionSize = marginAmount * leverage;
    console.log("🥑 ~ FuturesBalanceManager ~ requestCapital ~ positionSize:", positionSize)

    // Allocate
    this.allocations.set(symbol, {
      symbol,
      marginUsed: marginAmount,
      positionSize: positionSize,
      leverage,
      timestamp: Date.now()
    });
    this.saveState();
    
    const remaining = this.getAvailableMargin();
    this.log(
      `✅ ALLOCATED ${symbol}: ${marginAmount.toFixed(2)} margin ` +
      `(controls ${positionSize.toFixed(2)} @ ${leverage}x) | ` +
      `Positions: ${this.allocations.size}/${this.maxConcurrentPositions} | ` +
      `Available: ${remaining.toFixed(2)}`
    );
    
    return marginAmount;

  } finally {
    this.releaseLock();
  }
}
  /**
   * ✅ UPDATED: Release capital with PnL accounting
   */
  async releaseCapital(symbol: string, pnl: number = 0): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();
      const allocation = this.allocations.get(symbol);

      if (allocation) {
        this.allocations.delete(symbol);
        this.totalBalance += pnl;
        this.saveState();
        
        this.log(
          `🔓 RELEASED ${symbol}: ${allocation.marginUsed.toFixed(2)} margin ` +
          `(was ${allocation.positionSize.toFixed(2)} @ ${allocation.leverage}x) | ` +
          `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | ` +
          `New Balance: ${this.totalBalance.toFixed(2)}`
        );
      }
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Get allocation details for a symbol
   */
  getAllocation(symbol: string): PositionAllocation | undefined {
    this.loadState();
    return this.allocations.get(symbol);
  }

  hasAllocation(symbol: string): boolean {
    this.loadState();
    return this.allocations.has(symbol);
  }

  /**
   * ✅ UPDATED: Detailed futures report
   */
  getReport(): string {
    this.loadState();
    const tradingCapital = this.getTradingCapital();
    const reserve = this.getReserve();
    const usedMargin = this.getUsedMargin();
    const availableMargin = this.getAvailableMargin();
    const maxPositionSize = this.getMaxPositionSize();
    const marginPerPosition = this.getMarginPerPosition();

    const totalExposure = Array.from(this.allocations.values())
      .reduce((sum, alloc) => sum + alloc.positionSize, 0);

    return `
💰 FUTURES BALANCE REPORT
════════════════════════════════════════════
Total Balance:      ${this.totalBalance.toFixed(2)} USDT
Reserve (${(this.reserveRatio * 100).toFixed(0)}%):       ${reserve.toFixed(2)} USDT
Trading Capital:    ${tradingCapital.toFixed(2)} USDT

Margin Per Position: ${marginPerPosition.toFixed(2)} USDT
Max Position Size:   ${maxPositionSize.toFixed(2)} USDT (@ ${this.defaultLeverage}x leverage)

Used Margin:        ${usedMargin.toFixed(2)} USDT
Available Margin:   ${availableMargin.toFixed(2)} USDT
Total Exposure:     ${totalExposure.toFixed(2)} USDT (${(totalExposure / this.totalBalance).toFixed(1)}x)

Positions: ${this.allocations.size}/${this.maxConcurrentPositions}

Active Positions:
${Array.from(this.allocations.values())
  .map(alloc => 
    `  ${alloc.symbol.padEnd(12)} | ` +
    `Margin: ${alloc.marginUsed.toFixed(2).padStart(8)} | ` +
    `Size: ${alloc.positionSize.toFixed(2).padStart(8)} | ` +
    `Leverage: ${alloc.leverage}x`
  )
  .join('\n') || '  (none)'}
════════════════════════════════════════════
    `.trim();
  }

  /**
   * Force allocate for recovery
   */
  async forceAllocate(
    symbol: string, 
    marginUsed: number, 
    positionSize: number, 
    leverage: number
  ): Promise<void> {
      console.log("🔧 forceAllocate called with:");
  console.log(`   Symbol: ${symbol}`);
  console.log(`   Margin: ${marginUsed}`);
  console.log(`   Position: ${positionSize}`);
  console.log(`   Leverage: ${leverage}`);
  
  // Check caller stack
  console.trace("forceAllocate call stack:");
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();
      this.allocations.set(symbol, {
        symbol,
        marginUsed,
        positionSize,
        leverage,
        timestamp: Date.now()
      });
      this.saveState();
      this.log(`🔄 FORCE ALLOCATED ${symbol}: ${marginUsed.toFixed(2)} margin`);
    } finally {
      this.releaseLock();
    }
  }

  async resetAllocations(): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.allocations.clear();
      this.saveState();
      this.log('⚠️ ALL ALLOCATIONS CLEARED');
    } finally {
      this.releaseLock();
    }
  }

  private log(msg: string): void {
    console.log(`[FUTURES-BALANCE] ${msg}`);
  }

  private saveState(): void {
    try {

        console.log("💾 SAVING allocations:", this.allocations.size);

            // Log each allocation before saving
    this.allocations.forEach((alloc, symbol) => {
      console.log(`   ${symbol}:`);
      console.log(`     marginUsed: ${alloc.marginUsed}`);
      console.log(`     positionSize: ${alloc.positionSize}`);
      console.log(`     leverage: ${alloc.leverage}`);
      
      // Check if values look suspicious
      if (alloc.marginUsed === 19890.8991) {
        console.warn(`⚠️ ${symbol} has suspicious marginUsed value!`);
      }
    });

      const state = {
        totalBalance: this.totalBalance,
        maxConcurrentPositions: this.maxConcurrentPositions,
        reserveRatio: this.reserveRatio,
        defaultLeverage: this.defaultLeverage,
        allocations: Array.from(this.allocations.entries()),
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[FUTURES-BALANCE] Save failed:', err);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        console.log("📂 Loading state from", this.stateFile);

        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        console.log("Loaded allocations:", data.allocations?.length || 0);
        this.totalBalance = data.totalBalance || this.totalBalance;
        this.defaultLeverage = data.defaultLeverage || this.defaultLeverage;
        this.allocations = new Map(data.allocations || []);


    // Check loaded values
      this.allocations.forEach((alloc, symbol) => {
        console.log(`   Loaded ${symbol}: margin=${alloc.marginUsed}, size=${alloc.positionSize}`);
      });

      }
    } catch (err:any) {
      // Keep existing state if load fails
      console.log(err.message);
    }
  }
}

// ✅ Example: Singleton with futures settings
export const futuresBalance = new FuturesBalanceManager(
   parseFloat(process.env.TOTAL_CAPITAL || '10000'),                    // totalBalance
  parseInt(process.env.MAX_ACTIVE_BOTS || '10'),                       // maxActiveBots ✅
  parseInt(process.env.MAX_CONCURRENT_POSITIONS || '55'),              // maxPositions ✅
  parseFloat(process.env.RESERVE_RATIO || '0.01'),                     // reserveRatio ✅
  parseInt(process.env.DEFAULT_LEVERAGE || '5')          
);

export default FuturesBalanceManager;