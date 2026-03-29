// import fs from 'fs';
// import path from 'path';

// interface PositionInfo {
//   symbol: string;
//   side: 'LONG' | 'SHORT';
//   leverage: number;
//   entryPrice: number;
//   quantity: number;
//   entryTime: number;
//   unrealizedPnL?: number | undefined;
//   liquidationPrice?: number | undefined;
// }

// interface CoordinatorState {
//   maxConcurrent: number;
//   maxLeveragePerPosition: number;
//   totalLeverageUsed: number;
//   maxTotalLeverage: number;
//   activePositions: Record<string, PositionInfo>;
//   timestamp: string;
//    isHalted: boolean;
//   haltReason: string;
// }

// class FuturesPositionCoordinator {
//   private maxConcurrent: number;
//   private maxLeveragePerPosition: number;
//   private maxTotalLeverage: number;
//   private totalLeverageUsed: number;
//   private activePositions: Map<string, PositionInfo>;
//   private stateFile: string;
//   private lockFile: string;
//   private isHalted: boolean = false;
//   private haltReason: string = '';
//   // private pendingRequests: Map<string, number>;

//   constructor(
//     maxConcurrent: number = 5,
//     maxLeveragePerPosition: number = 10,
//     maxTotalLeverage: number = 30
//   ) {
//     const botId =
//     process.env.TRADING_SYMBOL?.replace('/', '') ||
//     process.env.SYMBOL ||
//     `bot_${process.pid}`;
//     this.maxConcurrent = maxConcurrent;
//     this.maxLeveragePerPosition = maxLeveragePerPosition;
//     this.maxTotalLeverage = maxTotalLeverage;
//     this.totalLeverageUsed = 0;
//     this.activePositions = new Map();
//     // this.pendingRequests = new Map();
//     this.stateFile = path.join('./states/futures', `futures_coordinator_${botId}.json`);
//     this.lockFile  = path.join('./states/futures', `futures_coordinator_${botId}.lock`);

//     this.ensureStateDir();
//     this.loadState();
//   }

//   private ensureStateDir(): void {
//     const dir = './states/futures';
//     if (!fs.existsSync(dir)) {
//       fs.mkdirSync(dir, { recursive: true });
//     }
//   }

//   /**
//    * Acquire lock with timeout
//    */
//   private async acquireLock(timeoutMs: number = 5000): Promise<boolean> {
//     const startTime = Date.now();

//     while (Date.now() - startTime < timeoutMs) {
//       try {
//         fs.writeFileSync(this.lockFile, process.pid.toString(), { flag: 'wx' });
//         return true;
//       } catch (err) {
//         try {
//           const lockAge = Date.now() - fs.statSync(this.lockFile).mtimeMs;

//           if (lockAge > 10000) {
//             this.log(`⚠️ Stale lock detected (${lockAge}ms old), forcing release`);
//             this.releaseLock();
//             continue;
//           }
//         } catch (readErr) {
//           continue;
//         }

//         await new Promise(resolve => setTimeout(resolve, 50));
//       }
//     }

//     this.log(`❌ Failed to acquire lock after ${timeoutMs}ms`);
//     return false;
//   }

//   /**
//    * Release lock
//    */
//   private releaseLock(): void {
//     try {
//       fs.unlinkSync(this.lockFile);
//     } catch (err:any) {
//       // Lock already released
//       console.log(err.message);
//     }
//   }

//    /**
//    * Halt all trading with a reason
//    */
//   async haltAllTrading(reason: string): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.isHalted = true;
//       this.haltReason = reason;
//       this.saveState();
//       this.log(`🛑 TRADING HALTED: ${reason}`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   /**
//    * Resume trading
//    */
//   async resumeTrading(): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.isHalted = false;
//       this.haltReason = '';
//       this.saveState();
//       this.log(`✅ TRADING RESUMED`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   /**
//    * Check if system is halted
//    */
//   isSystemHalted(): boolean {
//     this.loadState();
//     return this.isHalted;
//   }

//   /**
//    * Get halt reason
//    */
//   getHaltReason(): string {
//     this.loadState();
//     return this.haltReason;
//   }

//   /**
//    * Check if can continue trading (public method for bots to check)
//    */
//   canTrade(): boolean {
//     this.loadState();
//     return !this.isHalted;
//   }

//   /**
//    * Request futures position with leverage check
//    */
//   async requestPosition(
//     symbol: string,
//     side: 'LONG' | 'SHORT',
//     leverage: number,
//     entryPrice: number,
//     quantity: number,
//     liquidationPrice?: number
//   ): Promise<boolean> {

//      // ← CHECK HALT FIRST
//     if (this.isSystemHalted()) {
//       this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
//       return false;
//     }

//     const locked = await this.acquireLock();
//     if (!locked) {
//       this.log(`❌ ${symbol} failed to acquire lock`);
//       return false;
//     }

//     try {
//       this.loadState();

//       // Double-check halt status after acquiring lock
//       if (this.isHalted) {
//         this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
//         return false;
//       }

//       // Check if position already exists
//       if (this.activePositions.has(symbol)) {
//         this.log(`⚠️ ${symbol} position already exists`);
//         return false;
//       }

//       // Validate leverage
//       if (leverage > this.maxLeveragePerPosition) {
//         this.log(`❌ DENIED ${symbol}: Leverage ${leverage}x exceeds max ${this.maxLeveragePerPosition}x`);
//         return false;
//       }

//       // Check position count limit
//       if (this.activePositions.size >= this.maxConcurrent) {
//         this.log(`❌ DENIED ${symbol}: Position limit reached (${this.activePositions.size}/${this.maxConcurrent})`);
//         return false;
//       }

//       // Check total leverage limit
//       const newTotalLeverage = this.totalLeverageUsed + leverage;
//       if (newTotalLeverage > this.maxTotalLeverage) {
//         this.log(`❌ DENIED ${symbol}: Total leverage would exceed limit (${newTotalLeverage}/${this.maxTotalLeverage})`);
//         return false;
//       }

//       // Create position info
//       const positionInfo: PositionInfo = {
//         symbol,
//         side,
//         leverage,
//         entryPrice,
//         quantity,
//         entryTime: Date.now(),
//         liquidationPrice: liquidationPrice !== undefined ? liquidationPrice : undefined,
//         unrealizedPnL: undefined
//       };

//       // Grant position
//       this.activePositions.set(symbol, positionInfo);
//       this.totalLeverageUsed = newTotalLeverage;
//       this.saveState();

//       this.log(`✅ GRANTED ${symbol} ${side} ${leverage}x: ${this.activePositions.size}/${this.maxConcurrent} positions, ${this.totalLeverageUsed}/${this.maxTotalLeverage} leverage`);
//       return true;

//     } finally {
//       this.releaseLock();
//     }
//   }

//     canEnterPosition(symbol: string, leverage: number): boolean {
//     this.loadState();

//     // ← CHECK HALT FIRST
//     if (this.isHalted) return false;

//     if (this.activePositions.has(symbol)) return false;
//     if (this.activePositions.size >= this.maxConcurrent) return false;
//     if (leverage > this.maxLeveragePerPosition) return false;
//     if (this.totalLeverageUsed + leverage > this.maxTotalLeverage) return false;

//     return true;
//   }

//   /**
//    * Update position with current PnL and liquidation price
//    */
//   async updatePosition(
//     symbol: string,
//     unrealizedPnL: number,
//     liquidationPrice?: number
//   ): Promise<boolean> {
//     const locked = await this.acquireLock();
//     if (!locked) return false;

//     try {
//       this.loadState();

//       const position = this.activePositions.get(symbol);
//       if (!position) {
//         this.log(`⚠️ Cannot update ${symbol}: Position not found`);
//         return false;
//       }

//       position.unrealizedPnL = unrealizedPnL;
//       if (liquidationPrice !== undefined) {
//         position.liquidationPrice = liquidationPrice;
//       }

//       this.activePositions.set(symbol, position);
//       this.saveState();

//       return true;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   /**
//    * Release futures position
//    */
//   async releasePosition(symbol: string, realizedPnL?: number): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) {
//       this.log(`❌ ${symbol} failed to acquire lock for release`);
//       return;
//     }

//     try {
//       this.loadState();

//       const position = this.activePositions.get(symbol);
//       if (position) {
//         this.totalLeverageUsed -= position.leverage;
//         this.activePositions.delete(symbol);
//         this.saveState();

//         const pnlInfo = realizedPnL !== undefined ? ` | PnL: ${realizedPnL > 0 ? '+' : ''}${realizedPnL.toFixed(2)}` : '';
//         this.log(`🔓 RELEASED ${symbol} ${position.side} ${position.leverage}x${pnlInfo}: ${this.activePositions.size}/${this.maxConcurrent} positions, ${this.totalLeverageUsed}/${this.maxTotalLeverage} leverage`);
//       }
//     } finally {
//       this.releaseLock();
//     }
//   }

//   /**
//    * Check if can enter new position
//    */
//   // canEnterPosition(symbol: string, leverage: number): boolean {
//   //   this.loadState();

//   //   if (this.activePositions.has(symbol)) return false;
//   //   if (this.activePositions.size >= this.maxConcurrent) return false;
//   //   if (leverage > this.maxLeveragePerPosition) return false;
//   //   if (this.totalLeverageUsed + leverage > this.maxTotalLeverage) return false;

//   //   return true;
//   // }

//   /**
//    * Get position info
//    */
//   getPosition(symbol: string): PositionInfo | null {
//     this.loadState();
//     return this.activePositions.get(symbol) || null;
//   }

//   /**
//    * Get all positions
//    */
//   getAllPositions(): PositionInfo[] {
//     this.loadState();
//     return Array.from(this.activePositions.values());
//   }

//   /**
//    * Get positions by side
//    */
//   getPositionsBySide(side: 'LONG' | 'SHORT'): PositionInfo[] {
//     this.loadState();
//     return Array.from(this.activePositions.values()).filter(p => p.side === side);
//   }

//   /**
//    * Get risk metrics
//    */
//   getRiskMetrics(): {
//     activePositions: number;
//     maxPositions: number;
//     totalLeverageUsed: number;
//     maxTotalLeverage: number;
//     availableLeverage: number;
//     leverageUtilization: number;
//     positionUtilization: number;
//     isHalted: boolean;           // ← ADD THIS
//     haltReason: string;
//   } {
//     this.loadState();

//     return {
//       activePositions: this.activePositions.size,
//       maxPositions: this.maxConcurrent,
//       totalLeverageUsed: this.totalLeverageUsed,
//       maxTotalLeverage: this.maxTotalLeverage,
//       availableLeverage: this.maxTotalLeverage - this.totalLeverageUsed,
//       leverageUtilization: (this.totalLeverageUsed / this.maxTotalLeverage) * 100,
//       positionUtilization: (this.activePositions.size / this.maxConcurrent) * 100,
//       isHalted: this.isHalted,
//       haltReason: this.haltReason
//     };
//   }

//   /**
//    * Get total unrealized PnL
//    */
//   getTotalUnrealizedPnL(): number {
//     this.loadState();
//     return Array.from(this.activePositions.values())
//       .reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);
//   }

//   /**
//    * Check if any position is near liquidation
//    */
//   getPositionsNearLiquidation( currentPrices: Record<string, number>,threshold: number = 0.1): PositionInfo[] {
//     this.loadState();

//     return Array.from(this.activePositions.values()).filter(pos => {
//     const currentPrice = currentPrices[pos.symbol];
//     if (!currentPrice || !pos.liquidationPrice) return false;

//     const totalDistance = Math.abs(pos.entryPrice - pos.liquidationPrice);
//     const remainingDistance = Math.abs(currentPrice - pos.liquidationPrice);

//     return remainingDistance / totalDistance < threshold;
//   });
//   }

//   /**
//    * Force register position (emergency recovery)
//    */
// async forceRegister(
//   symbol: string,
//   side: 'LONG' | 'SHORT',
//   leverage: number,
//   entryPrice: number,
//   quantity: number,
//   liquidationPrice?: number
// ): Promise<void> {
//   const locked = await this.acquireLock();
//   if (!locked) return;

//   try {
//     this.loadState();

//     // ✅ CHECK: Don't duplicate if already exists
//     const existing = this.activePositions.get(symbol);
//     if (existing) {
//       this.log(`⚠️ Position already exists for ${symbol}, skipping force register`);
//       this.log(`   Existing: ${existing.side} ${existing.leverage}x @ ${existing.entryPrice}`);
//       this.releaseLock();
//       return;
//     }

//     const positionInfo: PositionInfo = {
//       symbol,
//       side,
//       leverage,
//       entryPrice,
//       quantity,
//       entryTime: Date.now(),
//       liquidationPrice: liquidationPrice !== undefined ? liquidationPrice : undefined,
//       unrealizedPnL: undefined
//     };

//     this.activePositions.set(symbol, positionInfo);
//     this.recalculateTotalLeverage();
//     this.saveState();

//     this.log(`🔄 FORCE REGISTERED ${symbol} ${side} ${leverage}x`);
//   } finally {
//     this.releaseLock();
//   }
// }
//   /**
//    * Recalculate total leverage from active positions
//    */
//   private recalculateTotalLeverage(): void {
//     this.totalLeverageUsed = Array.from(this.activePositions.values())
//       .reduce((sum, pos) => sum + pos.leverage, 0);
//   }

//   /**
//    * Reset all positions
//    */
//   async reset(): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.activePositions.clear();
//       // this.pendingRequests.clear();
//       this.totalLeverageUsed = 0;
//       this.isHalted = false;      // ← RESET HALT
//       this.haltReason = '';       // ← RESET REASON
//       this.saveState();
//       this.log('⚠️ ALL POSITIONS CLEARED');
//     } finally {
//       this.releaseLock();
//     }
//   }

//   /**
//    * Emergency close all positions
//    */
//   async emergencyCloseAll(): Promise<string[]> {
//     const locked = await this.acquireLock();
//     if (!locked) return [];

//     try {
//       this.loadState();
//       const closedSymbols = Array.from(this.activePositions.keys());

//       this.activePositions.clear();
//       this.totalLeverageUsed = 0;
//       this.saveState();

//       this.log(`🚨 EMERGENCY: Closed all ${closedSymbols.length} positions`);
//       return closedSymbols;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   private log(msg: string): void {
//     const timestamp = new Date().toISOString();
//     console.log(`[FUTURES-COORDINATOR ${timestamp}] ${msg}`);
//   }

//   private saveState(): void {
//     try {
//       const state: CoordinatorState = {
//         maxConcurrent: this.maxConcurrent,
//         maxLeveragePerPosition: this.maxLeveragePerPosition,
//         totalLeverageUsed: this.totalLeverageUsed,
//         maxTotalLeverage: this.maxTotalLeverage,
//         activePositions: Object.fromEntries(this.activePositions),
//         timestamp: new Date().toISOString(),
//         isHalted: this.isHalted,      // ← SAVE HALT STATE
//         haltReason: this.haltReason
//       };
//       fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
//     } catch (err) {
//       console.error('[FUTURES-COORDINATOR] Save failed:', err);
//     }
//   }

//   private loadState(): void {
//     try {
//       if (fs.existsSync(this.stateFile)) {
//         const data: CoordinatorState = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
//         this.activePositions = new Map(Object.entries(data.activePositions || {}));
//         this.totalLeverageUsed = data.totalLeverageUsed || 0;
//         this.isHalted = data.isHalted || false;         // ← LOAD HALT STATE
//         this.haltReason = data.haltReason || '';

//         // Recalculate to ensure consistency
//         this.recalculateTotalLeverage();
//       }
//     } catch (err) {
//       console.error('[FUTURES-COORDINATOR] Load failed:', err);
//     }
//   }
// }

// // Singleton instance
// export const futuresCoordinator = new FuturesPositionCoordinator(
//   parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),
//   parseInt(process.env.MAX_LEVERAGE_PER_POSITION || '5'),
//   parseInt(process.env.MAX_TOTAL_LEVERAGE || '30')
// );

// export default FuturesPositionCoordinator;

// import fs from 'fs';
// import path from 'path';

// interface PositionInfo {
//   symbol: string;
//   side: 'LONG' | 'SHORT';
//   leverage: number;
//   entryPrice: number;
//   quantity: number;
//   entryTime: number;
//   unrealizedPnL?: number | undefined;
//   liquidationPrice?: number | undefined;
// }

// interface CoordinatorState {
//   maxPositions: number;              // ✅ RENAMED from maxConcurrent
//   maxActiveBots: number;              // ✅ NEW: Track active bots
//   maxLeveragePerPosition: number;
//   totalLeverageUsed: number;
//   maxTotalLeverage: number;
//   activePositions: Record<string, PositionInfo>;
//   activeBots: string[];               // ✅ NEW: Track which bots are running
//   timestamp: string;
//   isHalted: boolean;
//   haltReason: string;
// }

// class FuturesPositionCoordinator {
//   private maxPositions: number;       // ✅ RENAMED: Max OPEN POSITIONS
//   private maxActiveBots: number;      // ✅ NEW: Max RUNNING BOTS
//   private maxLeveragePerPosition: number;
//   private maxTotalLeverage: number;
//   private totalLeverageUsed: number;
//   private activePositions: Map<string, PositionInfo>;
//   private activeBots: Set<string>;    // ✅ NEW: Track active bots
//   private stateFile: string;
//   private lockFile: string;
//   private isHalted: boolean = false;
//   private haltReason: string = '';

//   constructor(
//     maxPositions: number = 2,         // ✅ RENAMED from maxConcurrent
//     maxActiveBots: number = 55,       // ✅ NEW: Default 55 bots
//     maxLeveragePerPosition: number = 10,
//     maxTotalLeverage: number = 30
//   ) {
//     const botId =
//       process.env.TRADING_SYMBOL?.replace('/', '') ||
//       process.env.SYMBOL ||
//       `bot_${process.pid}`;

//     this.maxPositions = maxPositions;
//     this.maxActiveBots = maxActiveBots;
//     this.maxLeveragePerPosition = maxLeveragePerPosition;
//     this.maxTotalLeverage = maxTotalLeverage;
//     this.totalLeverageUsed = 0;
//     this.activePositions = new Map();
//     this.activeBots = new Set();      // ✅ NEW
//     this.stateFile = path.join('./states/futures', `futures_coordinator_${botId}.json`);
//     this.lockFile = path.join('./states/futures', `futures_coordinator_${botId}.lock`);

//     this.ensureStateDir();
//     this.loadState();
//   }

//   private ensureStateDir(): void {
//     const dir = './states/futures';
//     if (!fs.existsSync(dir)) {
//       fs.mkdirSync(dir, { recursive: true });
//     }
//   }

//   private async acquireLock(timeoutMs: number = 5000): Promise<boolean> {
//     const startTime = Date.now();

//     while (Date.now() - startTime < timeoutMs) {
//       try {
//         fs.writeFileSync(this.lockFile, process.pid.toString(), { flag: 'wx' });
//         return true;
//       } catch (err) {
//         try {
//           const lockAge = Date.now() - fs.statSync(this.lockFile).mtimeMs;

//           if (lockAge > 10000) {
//             this.log(`⚠️ Stale lock detected (${lockAge}ms old), forcing release`);
//             this.releaseLock();
//             continue;
//           }
//         } catch (readErr) {
//           continue;
//         }

//         await new Promise(resolve => setTimeout(resolve, 50));
//       }
//     }

//     this.log(`❌ Failed to acquire lock after ${timeoutMs}ms`);
//     return false;
//   }

//   private releaseLock(): void {
//     try {
//       fs.unlinkSync(this.lockFile);
//     } catch (err: any) {
//       console.log(err.message);
//     }
//   }

//   // ✅ NEW: Register a bot as active (scanning)
//   async registerBot(symbol: string): Promise<boolean> {
//     const locked = await this.acquireLock();
//     if (!locked) return false;

//     try {
//       this.loadState();

//       if (this.activeBots.size >= this.maxActiveBots) {
//         this.log(`❌ DENIED ${symbol}: Max bots reached (${this.activeBots.size}/${this.maxActiveBots})`);
//         return false;
//       }

//       this.activeBots.add(symbol);
//       this.saveState();
//       this.log(`✅ BOT REGISTERED: ${symbol} (${this.activeBots.size}/${this.maxActiveBots})`);
//       return true;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   // ✅ NEW: Unregister a bot (stopped scanning)
//   async unregisterBot(symbol: string): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.loadState();
//       this.activeBots.delete(symbol);
//       this.saveState();
//       this.log(`🔓 BOT UNREGISTERED: ${symbol} (${this.activeBots.size}/${this.maxActiveBots})`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   // ✅ NEW: Check if can start a new bot
//   canStartBot(symbol: string): boolean {
//     this.loadState();
//     if (this.activeBots.has(symbol)) return false; // Already running
//     return this.activeBots.size < this.maxActiveBots;
//   }

//   async haltAllTrading(reason: string): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.isHalted = true;
//       this.haltReason = reason;
//       this.saveState();
//       this.log(`🛑 TRADING HALTED: ${reason}`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   async resumeTrading(): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.isHalted = false;
//       this.haltReason = '';
//       this.saveState();
//       this.log(`✅ TRADING RESUMED`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   isSystemHalted(): boolean {
//     this.loadState();
//     return this.isHalted;
//   }

//   getHaltReason(): string {
//     this.loadState();
//     return this.haltReason;
//   }

//   canTrade(): boolean {
//     this.loadState();
//     return !this.isHalted;
//   }

//   async requestPosition(
//     symbol: string,
//     side: 'LONG' | 'SHORT',
//     leverage: number,
//     entryPrice: number,
//     quantity: number,
//     liquidationPrice?: number
//   ): Promise<boolean> {
//     if (this.isSystemHalted()) {
//       this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
//       return false;
//     }

//     const locked = await this.acquireLock();
//     if (!locked) {
//       this.log(`❌ ${symbol} failed to acquire lock`);
//       return false;
//     }

//     try {
//       this.loadState();

//       if (this.isHalted) {
//         this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
//         return false;
//       }

//       if (this.activePositions.has(symbol)) {
//         this.log(`⚠️ ${symbol} position already exists`);
//         return false;
//       }

//       if (leverage > this.maxLeveragePerPosition) {
//         this.log(`❌ DENIED ${symbol}: Leverage ${leverage}x exceeds max ${this.maxLeveragePerPosition}x`);
//         return false;
//       }

//       // ✅ FIXED: Check position count (not bot count)
//       if (this.activePositions.size >= this.maxPositions) {
//         this.log(`❌ DENIED ${symbol}: Position limit reached (${this.activePositions.size}/${this.maxPositions})`);
//         return false;
//       }

//       const newTotalLeverage = this.totalLeverageUsed + leverage;
//       if (newTotalLeverage > this.maxTotalLeverage) {
//         this.log(`❌ DENIED ${symbol}: Total leverage would exceed limit (${newTotalLeverage}/${this.maxTotalLeverage})`);
//         return false;
//       }

//       const positionInfo: PositionInfo = {
//         symbol,
//         side,
//         leverage,
//         entryPrice,
//         quantity,
//         entryTime: Date.now(),
//         liquidationPrice: liquidationPrice !== undefined ? liquidationPrice : undefined,
//         unrealizedPnL: undefined
//       };

//       this.activePositions.set(symbol, positionInfo);
//       this.totalLeverageUsed = newTotalLeverage;
//       this.saveState();

//       this.log(`✅ POSITION GRANTED: ${symbol} ${side} ${leverage}x (${this.activePositions.size}/${this.maxPositions} positions, ${this.totalLeverageUsed}/${this.maxTotalLeverage} leverage)`);
//       return true;

//     } finally {
//       this.releaseLock();
//     }
//   }

//   canEnterPosition(symbol: string, leverage: number): boolean {
//     this.loadState();

//     if (this.isHalted) return false;
//     if (this.activePositions.has(symbol)) return false;
//     if (this.activePositions.size >= this.maxPositions) return false;
//     if (leverage > this.maxLeveragePerPosition) return false;
//     if (this.totalLeverageUsed + leverage > this.maxTotalLeverage) return false;

//     return true;
//   }

//   async updatePosition(
//     symbol: string,
//     unrealizedPnL: number,
//     liquidationPrice?: number
//   ): Promise<boolean> {
//     const locked = await this.acquireLock();
//     if (!locked) return false;

//     try {
//       this.loadState();

//       const position = this.activePositions.get(symbol);
//       if (!position) {
//         this.log(`⚠️ Cannot update ${symbol}: Position not found`);
//         return false;
//       }

//       position.unrealizedPnL = unrealizedPnL;
//       if (liquidationPrice !== undefined) {
//         position.liquidationPrice = liquidationPrice;
//       }

//       this.activePositions.set(symbol, position);
//       this.saveState();

//       return true;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   async releasePosition(symbol: string, realizedPnL?: number): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) {
//       this.log(`❌ ${symbol} failed to acquire lock for release`);
//       return;
//     }

//     try {
//       this.loadState();

//       const position = this.activePositions.get(symbol);
//       if (position) {
//         this.totalLeverageUsed -= position.leverage;
//         this.activePositions.delete(symbol);
//         this.saveState();

//         const pnlInfo = realizedPnL !== undefined ? ` | PnL: ${realizedPnL > 0 ? '+' : ''}${realizedPnL.toFixed(2)}` : '';
//         this.log(`🔓 POSITION RELEASED: ${symbol} ${position.side} ${position.leverage}x${pnlInfo} (${this.activePositions.size}/${this.maxPositions} positions)`);
//       }
//     } finally {
//       this.releaseLock();
//     }
//   }

//   getPosition(symbol: string): PositionInfo | null {
//     this.loadState();
//     return this.activePositions.get(symbol) || null;
//   }

//   getAllPositions(): PositionInfo[] {
//     this.loadState();
//     return Array.from(this.activePositions.values());
//   }

//   getPositionsBySide(side: 'LONG' | 'SHORT'): PositionInfo[] {
//     this.loadState();
//     return Array.from(this.activePositions.values()).filter(p => p.side === side);
//   }

//   getRiskMetrics(): {
//     activeBots: number;              // ✅ NEW
//     maxBots: number;                 // ✅ NEW
//     activePositions: number;
//     maxPositions: number;            // ✅ RENAMED
//     totalLeverageUsed: number;
//     maxTotalLeverage: number;
//     availableLeverage: number;
//     leverageUtilization: number;
//     positionUtilization: number;
//     botUtilization: number;          // ✅ NEW
//     isHalted: boolean;
//     haltReason: string;
//   } {
//     this.loadState();

//     return {
//       activeBots: this.activeBots.size,
//       maxBots: this.maxActiveBots,
//       activePositions: this.activePositions.size,
//       maxPositions: this.maxPositions,
//       totalLeverageUsed: this.totalLeverageUsed,
//       maxTotalLeverage: this.maxTotalLeverage,
//       availableLeverage: this.maxTotalLeverage - this.totalLeverageUsed,
//       leverageUtilization: (this.totalLeverageUsed / this.maxTotalLeverage) * 100,
//       positionUtilization: (this.activePositions.size / this.maxPositions) * 100,
//       botUtilization: (this.activeBots.size / this.maxActiveBots) * 100,
//       isHalted: this.isHalted,
//       haltReason: this.haltReason
//     };
//   }

//   getTotalUnrealizedPnL(): number {
//     this.loadState();
//     return Array.from(this.activePositions.values())
//       .reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);
//   }

//   getPositionsNearLiquidation(currentPrices: Record<string, number>, threshold: number = 0.1): PositionInfo[] {
//     this.loadState();

//     return Array.from(this.activePositions.values()).filter(pos => {
//       const currentPrice = currentPrices[pos.symbol];
//       if (!currentPrice || !pos.liquidationPrice) return false;

//       const totalDistance = Math.abs(pos.entryPrice - pos.liquidationPrice);
//       const remainingDistance = Math.abs(currentPrice - pos.liquidationPrice);

//       return remainingDistance / totalDistance < threshold;
//     });
//   }

//   async forceRegister(
//     symbol: string,
//     side: 'LONG' | 'SHORT',
//     leverage: number,
//     entryPrice: number,
//     quantity: number,
//     liquidationPrice?: number
//   ): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.loadState();

//       const existing = this.activePositions.get(symbol);
//       if (existing) {
//         this.log(`⚠️ Position already exists for ${symbol}, skipping force register`);
//         this.releaseLock();
//         return;
//       }

//       const positionInfo: PositionInfo = {
//         symbol,
//         side,
//         leverage,
//         entryPrice,
//         quantity,
//         entryTime: Date.now(),
//         liquidationPrice: liquidationPrice !== undefined ? liquidationPrice : undefined,
//         unrealizedPnL: undefined
//       };

//       this.activePositions.set(symbol, positionInfo);
//       this.recalculateTotalLeverage();
//       this.saveState();

//       this.log(`🔄 FORCE REGISTERED ${symbol} ${side} ${leverage}x`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   private recalculateTotalLeverage(): void {
//     this.totalLeverageUsed = Array.from(this.activePositions.values())
//       .reduce((sum, pos) => sum + pos.leverage, 0);
//   }

//   async reset(): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.activePositions.clear();
//       this.activeBots.clear();      // ✅ NEW
//       this.totalLeverageUsed = 0;
//       this.isHalted = false;
//       this.haltReason = '';
//       this.saveState();
//       this.log('⚠️ ALL POSITIONS AND BOTS CLEARED');
//     } finally {
//       this.releaseLock();
//     }
//   }

//   async emergencyCloseAll(): Promise<string[]> {
//     const locked = await this.acquireLock();
//     if (!locked) return [];

//     try {
//       this.loadState();
//       const closedSymbols = Array.from(this.activePositions.keys());

//       this.activePositions.clear();
//       this.totalLeverageUsed = 0;
//       this.saveState();

//       this.log(`🚨 EMERGENCY: Closed all ${closedSymbols.length} positions`);
//       return closedSymbols;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   private log(msg: string): void {
//     const timestamp = new Date().toISOString();
//     console.log(`[FUTURES-COORDINATOR ${timestamp}] ${msg}`);
//   }

//   private saveState(): void {
//     try {
//       const state: CoordinatorState = {
//         maxPositions: this.maxPositions,
//         maxActiveBots: this.maxActiveBots,
//         maxLeveragePerPosition: this.maxLeveragePerPosition,
//         totalLeverageUsed: this.totalLeverageUsed,
//         maxTotalLeverage: this.maxTotalLeverage,
//         activePositions: Object.fromEntries(this.activePositions),
//         activeBots: Array.from(this.activeBots),
//         timestamp: new Date().toISOString(),
//         isHalted: this.isHalted,
//         haltReason: this.haltReason
//       };
//       fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
//     } catch (err) {
//       console.error('[FUTURES-COORDINATOR] Save failed:', err);
//     }
//   }

//   private loadState(): void {
//     try {
//       if (fs.existsSync(this.stateFile)) {
//         const data: CoordinatorState = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
//         this.activePositions = new Map(Object.entries(data.activePositions || {}));
//         this.activeBots = new Set(data.activeBots || []);
//         this.totalLeverageUsed = data.totalLeverageUsed || 0;
//         this.isHalted = data.isHalted || false;
//         this.haltReason = data.haltReason || '';

//         this.recalculateTotalLeverage();
//       }
//     } catch (err) {
//       console.error('[FUTURES-COORDINATOR] Load failed:', err);
//     }
//   }
// }

// // Singleton instance
// export const futuresCoordinator = new FuturesPositionCoordinator(
//   parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),  // Max positions
//   parseInt(process.env.MAX_ACTIVE_BOTS || '55'),          // Max bots
//   parseInt(process.env.MAX_LEVERAGE_PER_POSITION || '5'),
//   parseInt(process.env.MAX_TOTAL_LEVERAGE || '30')
// );

// export default FuturesPositionCoordinator;

// import fs from 'fs';
// import path from 'path';

// interface PositionInfo {
//   symbol: string;
//   side: 'LONG' | 'SHORT';
//   leverage: number;
//   entryPrice: number;
//   quantity: number;
//   entryTime: number;
//   unrealizedPnL?: number | undefined;
//   liquidationPrice?: number | undefined;
// }

// interface BotRegistration {
//   symbol: string;
//   registeredAt: number;
//   lastHeartbeat: number;
//   hasPosition: boolean;
// }

// interface CoordinatorState {
//   maxPositions: number;
//   maxActiveBots: number;
//   maxLeveragePerPosition: number;
//   totalLeverageUsed: number;
//   maxTotalLeverage: number;
//   activePositions: Record<string, PositionInfo>;
//   activeBots: Record<string, BotRegistration>;  // ✅ Changed to object for full info
//   timestamp: string;
//   isHalted: boolean;
//   haltReason: string;
// }

// class FuturesPositionCoordinator {
//   private maxPositions: number;
//   private maxActiveBots: number;
//   private maxLeveragePerPosition: number;
//   private maxTotalLeverage: number;
//   private totalLeverageUsed: number;
//   private activePositions: Map<string, PositionInfo>;
//   private activeBots: Map<string, BotRegistration>;  // ✅ Changed to Map with full info
//   private stateFile: string;
//   private lockFile: string;
//   private isHalted: boolean = false;
//   private haltReason: string = '';
//   private readonly HEARTBEAT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

//   constructor(
//     maxPositions: number = 2,
//     maxActiveBots: number = 55,
//     maxLeveragePerPosition: number = 10,
//     maxTotalLeverage: number = 30
//   ) {
//     this.maxPositions = maxPositions;
//     this.maxActiveBots = maxActiveBots;
//     this.maxLeveragePerPosition = maxLeveragePerPosition;
//     this.maxTotalLeverage = maxTotalLeverage;
//     this.totalLeverageUsed = 0;
//     this.activePositions = new Map();
//     this.activeBots = new Map();

//     // ✅ CRITICAL: Use SHARED state file for ALL bots
//     // DO NOT use botId - all bots must share the same coordinator state
//     const stateDir = './states/futures';
//     if (!fs.existsSync(stateDir)) {
//       fs.mkdirSync(stateDir, { recursive: true });
//     }
//     this.stateFile = path.join(stateDir, 'coordinator_shared_state.json');
//     this.lockFile = path.join(stateDir, 'coordinator_shared.lock');

//     this.loadState();

//     // Log on initialization
//     console.log(`[COORDINATOR] Initialized with shared state file: ${this.stateFile}`);
//     console.log(`[COORDINATOR] Max positions: ${maxPositions}, Max bots: ${maxActiveBots}`);
//   }

//   private async acquireLock(timeoutMs: number = 5000): Promise<boolean> {
//     const startTime = Date.now();

//     while (Date.now() - startTime < timeoutMs) {
//       try {
//         fs.writeFileSync(this.lockFile, process.pid.toString(), { flag: 'wx' });
//         return true;
//       } catch (err) {
//         try {
//           const lockAge = Date.now() - fs.statSync(this.lockFile).mtimeMs;

//           if (lockAge > 10000) {
//             this.log(`⚠️ Stale lock detected (${lockAge}ms old), forcing release`);
//             this.releaseLock();
//             continue;
//           }
//         } catch (readErr) {
//           continue;
//         }

//         await new Promise(resolve => setTimeout(resolve, 50));
//       }
//     }

//     this.log(`❌ Failed to acquire lock after ${timeoutMs}ms`);
//     return false;
//   }

//   private releaseLock(): void {
//     try {
//       fs.unlinkSync(this.lockFile);
//     } catch (err: any) {
//       // Lock already released
//     }
//   }

//   // ✅ Clean up stale bots before checking limits
//   private cleanupStaleBots(): void {
//     const now = Date.now();
//     const stale: string[] = [];

//     for (const [symbol, reg] of this.activeBots.entries()) {
//       if (now - reg.lastHeartbeat > this.HEARTBEAT_TIMEOUT) {
//         stale.push(symbol);
//       }
//     }

//     if (stale.length > 0) {
//       for (const symbol of stale) {
//         this.activeBots.delete(symbol);
//         this.log(`🧹 CLEANUP: Removed stale bot ${symbol}`);
//       }
//       this.saveState();
//     }
//   }

//   // ✅ Register a bot as active (scanning)
//   async registerBot(symbol: string): Promise<boolean> {
//     const locked = await this.acquireLock();
//     if (!locked) return false;

//     try {
//       this.loadState();
//       this.cleanupStaleBots();  // ✅ Clean before checking

//       // ✅ Check if already registered
//       if (this.activeBots.has(symbol)) {
//         const existing = this.activeBots.get(symbol)!;
//         existing.lastHeartbeat = Date.now();
//         this.saveState();
//         this.log(`🔄 BOT ALREADY REGISTERED: ${symbol} (refreshed heartbeat)`);
//         return true;
//       }

//       // ✅ Check bot limit
//       if (this.activeBots.size >= this.maxActiveBots) {
//         this.log(`❌ DENIED ${symbol}: Max bots reached (${this.activeBots.size}/${this.maxActiveBots})`);
//         return false;
//       }

//       this.activeBots.set(symbol, {
//         symbol,
//         registeredAt: Date.now(),
//         lastHeartbeat: Date.now(),
//         hasPosition: false
//       });
//       this.saveState();
//       this.log(`✅ BOT REGISTERED: ${symbol} (${this.activeBots.size}/${this.maxActiveBots})`);
//       return true;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   // ✅ Unregister a bot (stopped scanning)
//   async unregisterBot(symbol: string): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.loadState();
//       if (this.activeBots.delete(symbol)) {
//         this.saveState();
//         this.log(`📤 BOT UNREGISTERED: ${symbol} (${this.activeBots.size}/${this.maxActiveBots})`);
//       }
//     } finally {
//       this.releaseLock();
//     }
//   }

//   // ✅ Heartbeat to keep bot alive
//   async heartbeat(symbol: string): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.loadState();
//       const bot = this.activeBots.get(symbol);
//       if (bot) {
//         bot.lastHeartbeat = Date.now();
//         this.saveState();
//       }
//     } finally {
//       this.releaseLock();
//     }
//   }

//   // ✅ Check if can start a new bot
//   canStartBot(symbol: string): boolean {
//     this.loadState();
//     if (this.activeBots.has(symbol)) return true; // Already registered
//     return this.activeBots.size < this.maxActiveBots;
//   }

//   async haltAllTrading(reason: string): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.isHalted = true;
//       this.haltReason = reason;
//       this.saveState();
//       this.log(`🛑 TRADING HALTED: ${reason}`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   async resumeTrading(): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.isHalted = false;
//       this.haltReason = '';
//       this.saveState();
//       this.log(`✅ TRADING RESUMED`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   isSystemHalted(): boolean {
//     this.loadState();
//     return this.isHalted;
//   }

//   getHaltReason(): string {
//     this.loadState();
//     return this.haltReason;
//   }

//   canTrade(): boolean {
//     this.loadState();
//     return !this.isHalted;
//   }

//   async requestPosition(
//     symbol: string,
//     side: 'LONG' | 'SHORT',
//     leverage: number,
//     entryPrice: number,
//     quantity: number,
//     liquidationPrice?: number
//   ): Promise<boolean> {
//     if (this.isSystemHalted()) {
//       this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
//       return false;
//     }

//     const locked = await this.acquireLock();
//     if (!locked) {
//       this.log(`❌ ${symbol} failed to acquire lock`);
//       return false;
//     }

//     try {
//       this.loadState();

//       if (this.isHalted) {
//         this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
//         return false;
//       }

//       if (this.activePositions.has(symbol)) {
//         this.log(`⚠️ ${symbol} position already exists`);
//         return false;
//       }

//       if (leverage > this.maxLeveragePerPosition) {
//         this.log(`❌ DENIED ${symbol}: Leverage ${leverage}x exceeds max ${this.maxLeveragePerPosition}x`);
//         return false;
//       }

//       if (this.activePositions.size >= this.maxPositions) {
//         this.log(`❌ DENIED ${symbol}: Position limit reached (${this.activePositions.size}/${this.maxPositions})`);
//         return false;
//       }

//       const newTotalLeverage = this.totalLeverageUsed + leverage;
//       if (newTotalLeverage > this.maxTotalLeverage) {
//         this.log(`❌ DENIED ${symbol}: Total leverage would exceed limit (${newTotalLeverage}/${this.maxTotalLeverage})`);
//         return false;
//       }

//       const positionInfo: PositionInfo = {
//         symbol,
//         side,
//         leverage,
//         entryPrice,
//         quantity,
//         entryTime: Date.now(),
//         liquidationPrice: liquidationPrice !== undefined ? liquidationPrice : undefined,
//         unrealizedPnL: undefined
//       };

//       this.activePositions.set(symbol, positionInfo);
//       this.totalLeverageUsed = newTotalLeverage;

//       // ✅ Mark bot as having position
//       const bot = this.activeBots.get(symbol);
//       if (bot) {
//         bot.hasPosition = true;
//         bot.lastHeartbeat = Date.now();
//       }

//       this.saveState();

//       this.log(`✅ POSITION GRANTED: ${symbol} ${side} ${leverage}x (${this.activePositions.size}/${this.maxPositions} positions, ${this.totalLeverageUsed}/${this.maxTotalLeverage} leverage)`);
//       return true;

//     } finally {
//       this.releaseLock();
//     }
//   }

//   canEnterPosition(symbol: string, leverage: number): boolean {
//     this.loadState();

//     if (this.isHalted) return false;
//     if (this.activePositions.has(symbol)) return false;
//     if (this.activePositions.size >= this.maxPositions) return false;
//     if (leverage > this.maxLeveragePerPosition) return false;
//     if (this.totalLeverageUsed + leverage > this.maxTotalLeverage) return false;

//     return true;
//   }

//   async updatePosition(
//     symbol: string,
//     unrealizedPnL: number,
//     liquidationPrice?: number
//   ): Promise<boolean> {
//     const locked = await this.acquireLock();
//     if (!locked) return false;

//     try {
//       this.loadState();

//       const position = this.activePositions.get(symbol);
//       if (!position) {
//         this.log(`⚠️ Cannot update ${symbol}: Position not found`);
//         return false;
//       }

//       position.unrealizedPnL = unrealizedPnL;
//       if (liquidationPrice !== undefined) {
//         position.liquidationPrice = liquidationPrice;
//       }

//       this.activePositions.set(symbol, position);
//       this.saveState();

//       return true;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   async releasePosition(symbol: string, realizedPnL?: number): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) {
//       this.log(`❌ ${symbol} failed to acquire lock for release`);
//       return;
//     }

//     try {
//       this.loadState();

//       const position = this.activePositions.get(symbol);
//       if (position) {
//         this.totalLeverageUsed -= position.leverage;
//         this.activePositions.delete(symbol);

//         // ✅ Mark bot as no longer having position
//         const bot = this.activeBots.get(symbol);
//         if (bot) {
//           bot.hasPosition = false;
//           bot.lastHeartbeat = Date.now();
//         }

//         this.saveState();

//         const pnlInfo = realizedPnL !== undefined ? ` | PnL: ${realizedPnL > 0 ? '+' : ''}${realizedPnL.toFixed(2)}` : '';
//         this.log(`📤 POSITION RELEASED: ${symbol} ${position.side} ${position.leverage}x${pnlInfo} (${this.activePositions.size}/${this.maxPositions} positions)`);
//       }
//     } finally {
//       this.releaseLock();
//     }
//   }

//   getPosition(symbol: string): PositionInfo | null {
//     this.loadState();
//     return this.activePositions.get(symbol) || null;
//   }

//   getAllPositions(): PositionInfo[] {
//     this.loadState();
//     return Array.from(this.activePositions.values());
//   }

//   getPositionsBySide(side: 'LONG' | 'SHORT'): PositionInfo[] {
//     this.loadState();
//     return Array.from(this.activePositions.values()).filter(p => p.side === side);
//   }

//   getRiskMetrics(): {
//     activeBots: number;
//     maxBots: number;
//     activePositions: number;
//     maxPositions: number;
//     totalLeverageUsed: number;
//     maxTotalLeverage: number;
//     availableLeverage: number;
//     leverageUtilization: number;
//     positionUtilization: number;
//     botUtilization: number;
//     isHalted: boolean;
//     haltReason: string;
//   } {
//     this.loadState();
//     this.cleanupStaleBots();

//     return {
//       activeBots: this.activeBots.size,
//       maxBots: this.maxActiveBots,
//       activePositions: this.activePositions.size,
//       maxPositions: this.maxPositions,
//       totalLeverageUsed: this.totalLeverageUsed,
//       maxTotalLeverage: this.maxTotalLeverage,
//       availableLeverage: this.maxTotalLeverage - this.totalLeverageUsed,
//       leverageUtilization: (this.totalLeverageUsed / this.maxTotalLeverage) * 100,
//       positionUtilization: (this.activePositions.size / this.maxPositions) * 100,
//       botUtilization: (this.activeBots.size / this.maxActiveBots) * 100,
//       isHalted: this.isHalted,
//       haltReason: this.haltReason
//     };
//   }

//   // ✅ Debug helper
//   getDebugInfo(): void {
//     this.loadState();
//     this.cleanupStaleBots();
//     console.log('\n📊 COORDINATOR DEBUG:');
//     console.log(`  Max Bots: ${this.maxActiveBots}`);
//     console.log(`  Active Bots: ${this.activeBots.size}`);
//     console.log(`  Registered Bots:`, Array.from(this.activeBots.keys()));
//     console.log(`  Max Positions: ${this.maxPositions}`);
//     console.log(`  Active Positions: ${this.activePositions.size}`);
//     console.log(`  Position Symbols:`, Array.from(this.activePositions.keys()));
//     console.log(`  Total Leverage: ${this.totalLeverageUsed}/${this.maxTotalLeverage}`);
//     console.log(`  Halted: ${this.isHalted}`);
//     if (this.isHalted) {
//       console.log(`  Halt Reason: ${this.haltReason}`);
//     }
//     console.log('');
//   }

//   getTotalUnrealizedPnL(): number {
//     this.loadState();
//     return Array.from(this.activePositions.values())
//       .reduce((sum, pos) => sum + (pos.unrealizedPnL || 0), 0);
//   }

//   getPositionsNearLiquidation(currentPrices: Record<string, number>, threshold: number = 0.1): PositionInfo[] {
//     this.loadState();

//     return Array.from(this.activePositions.values()).filter(pos => {
//       const currentPrice = currentPrices[pos.symbol];
//       if (!currentPrice || !pos.liquidationPrice) return false;

//       const totalDistance = Math.abs(pos.entryPrice - pos.liquidationPrice);
//       const remainingDistance = Math.abs(currentPrice - pos.liquidationPrice);

//       return remainingDistance / totalDistance < threshold;
//     });
//   }

//   async forceRegister(
//     symbol: string,
//     side: 'LONG' | 'SHORT',
//     leverage: number,
//     entryPrice: number,
//     quantity: number,
//     liquidationPrice?: number
//   ): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.loadState();

//       const existing = this.activePositions.get(symbol);
//       if (existing) {
//         this.log(`⚠️ Position already exists for ${symbol}, skipping force register`);
//         return;
//       }

//       const positionInfo: PositionInfo = {
//         symbol,
//         side,
//         leverage,
//         entryPrice,
//         quantity,
//         entryTime: Date.now(),
//         liquidationPrice: liquidationPrice !== undefined ? liquidationPrice : undefined,
//         unrealizedPnL: undefined
//       };

//       this.activePositions.set(symbol, positionInfo);
//       this.recalculateTotalLeverage();
//       this.saveState();

//       this.log(`🔄 FORCE REGISTERED ${symbol} ${side} ${leverage}x`);
//     } finally {
//       this.releaseLock();
//     }
//   }

//   private recalculateTotalLeverage(): void {
//     this.totalLeverageUsed = Array.from(this.activePositions.values())
//       .reduce((sum, pos) => sum + pos.leverage, 0);
//   }

//   async reset(): Promise<void> {
//     const locked = await this.acquireLock();
//     if (!locked) return;

//     try {
//       this.activePositions.clear();
//       this.activeBots.clear();
//       this.totalLeverageUsed = 0;
//       this.isHalted = false;
//       this.haltReason = '';
//       this.saveState();
//       this.log('⚠️ ALL POSITIONS AND BOTS CLEARED');
//     } finally {
//       this.releaseLock();
//     }
//   }

//   async emergencyCloseAll(): Promise<string[]> {
//     const locked = await this.acquireLock();
//     if (!locked) return [];

//     try {
//       this.loadState();
//       const closedSymbols = Array.from(this.activePositions.keys());

//       this.activePositions.clear();
//       this.totalLeverageUsed = 0;
//       this.saveState();

//       this.log(`🚨 EMERGENCY: Closed all ${closedSymbols.length} positions`);
//       return closedSymbols;
//     } finally {
//       this.releaseLock();
//     }
//   }

//   private log(msg: string): void {
//     const timestamp = new Date().toISOString();
//     console.log(`[FUTURES-COORDINATOR ${timestamp}] ${msg}`);
//   }

//   private saveState(): void {
//     try {
//       const state: CoordinatorState = {
//         maxPositions: this.maxPositions,
//         maxActiveBots: this.maxActiveBots,
//         maxLeveragePerPosition: this.maxLeveragePerPosition,
//         totalLeverageUsed: this.totalLeverageUsed,
//         maxTotalLeverage: this.maxTotalLeverage,
//         activePositions: Object.fromEntries(this.activePositions),
//         activeBots: Object.fromEntries(
//           Array.from(this.activeBots.entries()).map(([k, v]) => [k, v])
//         ),
//         timestamp: new Date().toISOString(),
//         isHalted: this.isHalted,
//         haltReason: this.haltReason
//       };
//       fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
//     } catch (err) {
//       console.error('[FUTURES-COORDINATOR] Save failed:', err);
//     }
//   }

//   private loadState(): void {
//     try {
//       if (fs.existsSync(this.stateFile)) {
//         const data: CoordinatorState = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
//         this.activePositions = new Map(Object.entries(data.activePositions || {}));
//         this.activeBots = new Map(
//           Object.entries(data.activeBots || {}).map(([k, v]) => [k, v as BotRegistration])
//         );
//         this.totalLeverageUsed = data.totalLeverageUsed || 0;
//         this.isHalted = data.isHalted || false;
//         this.haltReason = data.haltReason || '';

//         this.recalculateTotalLeverage();
//       }
//     } catch (err) {
//       console.error('[FUTURES-COORDINATOR] Load failed:', err);
//     }
//   }
// }

// // Singleton instance
// export const futuresCoordinator = new FuturesPositionCoordinator(
//   parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),  // Max positions
//   parseInt(process.env.MAX_ACTIVE_BOTS || '55'),          // Max bots
//   parseInt(process.env.MAX_LEVERAGE_PER_POSITION || '5'),
//   parseInt(process.env.MAX_TOTAL_LEVERAGE || '30')
// );

// export default FuturesPositionCoordinator;

import fs from 'fs';
import path from 'path';

import type { EntryType } from '../../lib/type.js';

interface PositionInfo {
  symbol: string;
  side: 'LONG' | 'SHORT' | 'SPOT';
  leverage: number;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  unrealizedPnL?: number | undefined;
  liquidationPrice?: number | undefined;
}

interface BotRegistration {
  symbol: string;
  registeredAt: number;
  lastHeartbeat: number;
  hasPosition: boolean;
}

interface CoordinatorState {
  maxPositions: number;
  maxActiveBots: number;
  maxLeveragePerPosition: number;
  totalLeverageUsed: number;
  maxTotalLeverage: number;
  activePositions: Record<string, PositionInfo>;
  activeBots: Record<string, BotRegistration>; // ✅ Changed to object for full info
  timestamp: string;
  isHalted: boolean;
  haltReason: string;
}

class FuturesPositionCoordinator {
  private maxPositions: number;
  private maxActiveBots: number;
  private maxLeveragePerPosition: number;
  private maxTotalLeverage: number;
  private totalLeverageUsed: number;
  private activePositions: Map<string, PositionInfo>;
  private activeBots: Map<string, BotRegistration>; // ✅ Changed to Map with full info
  private stateFile: string;
  private lockFile: string;
  private isHalted: boolean = false;
  private haltReason: string = '';
  private readonly HEARTBEAT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  constructor(
    maxPositions: number = 56,
    maxActiveBots: number = 56,
    maxLeveragePerPosition: number = 5,
    maxTotalLeverage: number = 50
  ) {
    this.maxPositions = maxPositions;
    this.maxActiveBots = maxActiveBots;
    this.maxLeveragePerPosition = maxLeveragePerPosition;
    this.maxTotalLeverage = maxTotalLeverage;
    this.totalLeverageUsed = 0;
    this.activePositions = new Map();
    this.activeBots = new Map();

    // ✅ CRITICAL: Use SHARED state file for ALL bots
    // DO NOT use botId - all bots must share the same coordinator state
    const stateDir = './states/futures';
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    this.stateFile = path.join(stateDir, 'coordinator_shared_state.json');
    this.lockFile = path.join(stateDir, 'coordinator_shared.lock');

    this.loadState();

    // Log on initialization
    console.log(
      `[COORDINATOR] Initialized with shared state file: ${this.stateFile}`
    );
    console.log(
      `[COORDINATOR] Max positions: ${maxPositions}, Max bots: ${maxActiveBots}`
    );
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
            this.log(
              `⚠️ Stale lock detected (${lockAge}ms old), forcing release`
            );
            this.releaseLock();
            continue;
          }
        } catch (readErr) {
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    this.log(`❌ Failed to acquire lock after ${timeoutMs}ms`);
    return false;
  }

  private releaseLock(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch (err: any) {
      // Lock already released
    }
  }

  // ✅ Clean up stale bots before checking limits
  private cleanupStaleBots(): void {
    const now = Date.now();
    const stale: string[] = [];

    for (const [symbol, reg] of this.activeBots.entries()) {
      if (now - reg.lastHeartbeat > this.HEARTBEAT_TIMEOUT) {
        stale.push(symbol);
      }
    }

    if (stale.length > 0) {
      for (const symbol of stale) {
        this.activeBots.delete(symbol);
        this.log(`🧹 CLEANUP: Removed stale bot ${symbol}`);
      }
      this.saveState();
    }
  }

  // ✅ Register a bot as active (scanning)
  async registerBot(symbol: string): Promise<boolean> {
    const locked = await this.acquireLock();
    if (!locked) return false;

    try {
      this.loadState();
      this.cleanupStaleBots(); // ✅ Clean before checking

      // ✅ Check if already registered
      if (this.activeBots.has(symbol)) {
        const existing = this.activeBots.get(symbol)!;
        existing.lastHeartbeat = Date.now();
        this.saveState();
        this.log(`🔄 BOT ALREADY REGISTERED: ${symbol} (refreshed heartbeat)`);
        return true;
      }

      // ✅ Check bot limit
      if (this.activeBots.size >= this.maxActiveBots) {
        this.log(
          `❌ DENIED ${symbol}: Max bots reached (${this.activeBots.size}/${this.maxActiveBots})`
        );
        return false;
      }

      this.activeBots.set(symbol, {
        symbol,
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
        hasPosition: false,
      });
      this.saveState();
      this.log(
        `✅ BOT REGISTERED: ${symbol} (${this.activeBots.size}/${this.maxActiveBots})`
      );
      return true;
    } finally {
      this.releaseLock();
    }
  }

  // ✅ Unregister a bot (stopped scanning)
  async unregisterBot(symbol: string): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();
      if (this.activeBots.delete(symbol)) {
        this.saveState();
        this.log(
          `📤 BOT UNREGISTERED: ${symbol} (${this.activeBots.size}/${this.maxActiveBots})`
        );
      }
    } finally {
      this.releaseLock();
    }
  }

  // ✅ Heartbeat to keep bot alive
  async heartbeat(symbol: string): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();
      const bot = this.activeBots.get(symbol);
      if (bot) {
        bot.lastHeartbeat = Date.now();
        this.saveState();
      }
    } finally {
      this.releaseLock();
    }
  }

  // ✅ Check if can start a new bot
  canStartBot(symbol: string): boolean {
    this.loadState();
    if (this.activeBots.has(symbol)) return true; // Already registered
    return this.activeBots.size < this.maxActiveBots;
  }

  async haltAllTrading(reason: string): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.isHalted = true;
      this.haltReason = reason;
      this.saveState();
      this.log(`🛑 TRADING HALTED: ${reason}`);
    } finally {
      this.releaseLock();
    }
  }

  async resumeTrading(): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.isHalted = false;
      this.haltReason = '';
      this.saveState();
      this.log(`✅ TRADING RESUMED`);
    } finally {
      this.releaseLock();
    }
  }

  isSystemHalted(): boolean {
    this.loadState();
    return this.isHalted;
  }

  getHaltReason(): string {
    this.loadState();
    return this.haltReason;
  }

  canTrade(): boolean {
    this.loadState();
    return !this.isHalted;
  }

  async requestPosition(
    symbol: string,
    side: 'LONG' | 'SHORT' | 'SPOT',
    leverage: number,
    entryPrice: number,
    quantity?: number,
    liquidationPrice?: number
  ): Promise<boolean> {
    if (this.isSystemHalted()) {
      this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
      return false;
    }

    const locked = await this.acquireLock();
    if (!locked) {
      this.log(`❌ ${symbol} failed to acquire lock`);
      return false;
    }

    try {
      this.loadState();

      if (this.isHalted) {
        this.log(`❌ DENIED ${symbol}: Trading halted - ${this.haltReason}`);
        return false;
      }

      if (this.activePositions.has(symbol)) {
        this.log(`⚠️ ${symbol} position already exists`);
        return false;
      }

      if (leverage > this.maxLeveragePerPosition) {
        this.log(
          `❌ DENIED ${symbol}: Leverage ${leverage}x exceeds max ${this.maxLeveragePerPosition}x`
        );
        return false;
      }

      if (this.activePositions.size >= this.maxPositions) {
        this.log(
          `❌ DENIED ${symbol}: Position limit reached (${this.activePositions.size}/${this.maxPositions})`
        );
        return false;
      }

      const newTotalLeverage = this.totalLeverageUsed + leverage;
      if (newTotalLeverage > this.maxTotalLeverage) {
        this.log(
          `❌ DENIED ${symbol}: Total leverage would exceed limit (${newTotalLeverage}/${this.maxTotalLeverage})`
        );
        return false;
      }

      const positionInfo: PositionInfo = {
        symbol,
        side,
        leverage,
        entryPrice,
        quantity: quantity || 0,
        entryTime: Date.now(),
        liquidationPrice:
          liquidationPrice !== undefined ? liquidationPrice : undefined,
        unrealizedPnL: undefined,
      };

      this.activePositions.set(symbol, positionInfo);
      this.totalLeverageUsed = newTotalLeverage;

      // ✅ Mark bot as having position
      const bot = this.activeBots.get(symbol);
      if (bot) {
        bot.hasPosition = true;
        bot.lastHeartbeat = Date.now();
      }

      this.saveState();

      this.log(
        `✅ POSITION GRANTED: ${symbol} ${side} ${leverage}x (${this.activePositions.size}/${this.maxPositions} positions, ${this.totalLeverageUsed}/${this.maxTotalLeverage} leverage)`
      );
      return true;
    } finally {
      this.releaseLock();
    }
  }

  canEnterPosition(symbol: string, leverage: number): boolean {
    this.loadState();

    if (this.isHalted) return false;
    if (this.activePositions.has(symbol)) return false;
    if (this.activePositions.size >= this.maxPositions) return false;
    if (leverage > this.maxLeveragePerPosition) return false;
    if (this.totalLeverageUsed + leverage > this.maxTotalLeverage) return false;

    return true;
  }

  async updatePosition(
    symbol: string,
    unrealizedPnL: number,
    liquidationPrice?: number
  ): Promise<boolean> {
    const locked = await this.acquireLock();
    if (!locked) return false;

    try {
      this.loadState();

      const position = this.activePositions.get(symbol);
      if (!position) {
        this.log(`⚠️ Cannot update ${symbol}: Position not found`);
        return false;
      }

      position.unrealizedPnL = unrealizedPnL;
      if (liquidationPrice !== undefined) {
        position.liquidationPrice = liquidationPrice;
      }

      this.activePositions.set(symbol, position);
      this.saveState();

      return true;
    } finally {
      this.releaseLock();
    }
  }

  async releasePosition(symbol: string, realizedPnL?: number): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) {
      this.log(`❌ ${symbol} failed to acquire lock for release`);
      return;
    }

    try {
      this.loadState();

      const position = this.activePositions.get(symbol);
      if (position) {
        this.totalLeverageUsed -= position.leverage;
        this.activePositions.delete(symbol);

        // ✅ Mark bot as no longer having position
        const bot = this.activeBots.get(symbol);
        if (bot) {
          bot.hasPosition = false;
          bot.lastHeartbeat = Date.now();
        }

        this.saveState();

        const pnlInfo =
          realizedPnL !== undefined
            ? ` | PnL: ${realizedPnL > 0 ? '+' : ''}${realizedPnL.toFixed(2)}`
            : '';
        this.log(
          `📤 POSITION RELEASED: ${symbol} ${position.side} ${position.leverage}x${pnlInfo} (${this.activePositions.size}/${this.maxPositions} positions)`
        );
      }
    } finally {
      this.releaseLock();
    }
  }

  getPosition(symbol: string): PositionInfo | null {
    this.loadState();
    return this.activePositions.get(symbol) || null;
  }

  getAllPositions(): PositionInfo[] {
    this.loadState();
    return Array.from(this.activePositions.values());
  }

  getPositionsBySide(side: 'LONG' | 'SHORT'): PositionInfo[] {
    this.loadState();
    return Array.from(this.activePositions.values()).filter(
      (p) => p.side === side
    );
  }

  getRiskMetrics(): {
    activeBots: number;
    maxBots: number;
    activePositions: number;
    maxPositions: number;
    totalLeverageUsed: number;
    maxTotalLeverage: number;
    availableLeverage: number;
    leverageUtilization: number;
    positionUtilization: number;
    botUtilization: number;
    isHalted: boolean;
    haltReason: string;
  } {
    this.loadState();
    this.cleanupStaleBots();

    return {
      activeBots: this.activeBots.size,
      maxBots: this.maxActiveBots,
      activePositions: this.activePositions.size,
      maxPositions: this.maxPositions,
      totalLeverageUsed: this.totalLeverageUsed,
      maxTotalLeverage: this.maxTotalLeverage,
      availableLeverage: this.maxTotalLeverage - this.totalLeverageUsed,
      leverageUtilization:
        (this.totalLeverageUsed / this.maxTotalLeverage) * 100,
      positionUtilization:
        (this.activePositions.size / this.maxPositions) * 100,
      botUtilization: (this.activeBots.size / this.maxActiveBots) * 100,
      isHalted: this.isHalted,
      haltReason: this.haltReason,
    };
  }

  // ✅ Debug helper
  getDebugInfo(): void {
    this.loadState();
    this.cleanupStaleBots();
    console.log('\n📊 COORDINATOR DEBUG:');
    console.log(`  Max Bots: ${this.maxActiveBots}`);
    console.log(`  Active Bots: ${this.activeBots.size}`);
    console.log(`  Registered Bots:`, Array.from(this.activeBots.keys()));
    console.log(`  Max Positions: ${this.maxPositions}`);
    console.log(`  Active Positions: ${this.activePositions.size}`);
    console.log(`  Position Symbols:`, Array.from(this.activePositions.keys()));
    console.log(
      `  Total Leverage: ${this.totalLeverageUsed}/${this.maxTotalLeverage}`
    );
    console.log(`  Halted: ${this.isHalted}`);
    if (this.isHalted) {
      console.log(`  Halt Reason: ${this.haltReason}`);
    }
    console.log('');
  }

  getTotalUnrealizedPnL(): number {
    this.loadState();
    return Array.from(this.activePositions.values()).reduce(
      (sum, pos) => sum + (pos.unrealizedPnL || 0),
      0
    );
  }

  getPositionsNearLiquidation(
    currentPrices: Record<string, number>,
    threshold: number = 0.1
  ): PositionInfo[] {
    this.loadState();

    return Array.from(this.activePositions.values()).filter((pos) => {
      const currentPrice = currentPrices[pos.symbol];
      if (!currentPrice || !pos.liquidationPrice) return false;

      const totalDistance = Math.abs(pos.entryPrice - pos.liquidationPrice);
      const remainingDistance = Math.abs(currentPrice - pos.liquidationPrice);

      return remainingDistance / totalDistance < threshold;
    });
  }

  async forceRegister(
    symbol: string,
    side: EntryType,
    leverage: number,
    entryPrice: number,
    quantity: number,
    liquidationPrice?: number
  ): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.loadState();

      const existing = this.activePositions.get(symbol);
      if (existing) {
        this.log(
          `⚠️ Position already exists for ${symbol}, skipping force register`
        );
        return;
      }

      const positionInfo: PositionInfo = {
        symbol,
        side,
        leverage,
        entryPrice,
        quantity,
        entryTime: Date.now(),
        liquidationPrice:
          liquidationPrice !== undefined ? liquidationPrice : undefined,
        unrealizedPnL: undefined,
      };

      this.activePositions.set(symbol, positionInfo);
      this.recalculateTotalLeverage();
      this.saveState();

      this.log(`🔄 FORCE REGISTERED ${symbol} ${side} ${leverage}x`);
    } finally {
      this.releaseLock();
    }
  }

  private recalculateTotalLeverage(): void {
    this.totalLeverageUsed = Array.from(this.activePositions.values()).reduce(
      (sum, pos) => sum + pos.leverage,
      0
    );
  }

  async reset(): Promise<void> {
    const locked = await this.acquireLock();
    if (!locked) return;

    try {
      this.activePositions.clear();
      this.activeBots.clear();
      this.totalLeverageUsed = 0;
      this.isHalted = false;
      this.haltReason = '';
      this.saveState();
      this.log('⚠️ ALL POSITIONS AND BOTS CLEARED');
    } finally {
      this.releaseLock();
    }
  }

  async emergencyCloseAll(): Promise<string[]> {
    const locked = await this.acquireLock();
    if (!locked) return [];

    try {
      this.loadState();
      const closedSymbols = Array.from(this.activePositions.keys());

      this.activePositions.clear();
      this.totalLeverageUsed = 0;
      this.saveState();

      this.log(`🚨 EMERGENCY: Closed all ${closedSymbols.length} positions`);
      return closedSymbols;
    } finally {
      this.releaseLock();
    }
  }

  private log(msg: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[FUTURES-COORDINATOR ${timestamp}] ${msg}`);
  }

  private saveState(): void {
    try {
      const state: CoordinatorState = {
        maxPositions: this.maxPositions,
        maxActiveBots: this.maxActiveBots,
        maxLeveragePerPosition: this.maxLeveragePerPosition,
        totalLeverageUsed: this.totalLeverageUsed,
        maxTotalLeverage: this.maxTotalLeverage,
        activePositions: Object.fromEntries(this.activePositions),
        activeBots: Object.fromEntries(
          Array.from(this.activeBots.entries()).map(([k, v]) => [k, v])
        ),
        timestamp: new Date().toISOString(),
        isHalted: this.isHalted,
        haltReason: this.haltReason,
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[FUTURES-COORDINATOR] Save failed:', err);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data: CoordinatorState = JSON.parse(
          fs.readFileSync(this.stateFile, 'utf-8')
        );
        this.activePositions = new Map(
          Object.entries(data.activePositions || {})
        );
        this.activeBots = new Map(
          Object.entries(data.activeBots || {}).map(([k, v]) => [
            k,
            v as BotRegistration,
          ])
        );
        this.totalLeverageUsed = data.totalLeverageUsed || 0;
        this.isHalted = data.isHalted || false;
        this.haltReason = data.haltReason || '';

        this.recalculateTotalLeverage();
      }
    } catch (err) {
      console.error('[FUTURES-COORDINATOR] Load failed:', err);
    }
  }
}

// Singleton instance
export const futuresCoordinator = new FuturesPositionCoordinator(
  parseInt(process.env.MAX_CONCURRENT_POSITIONS || '1'), // Max positions
  parseInt(process.env.MAX_ACTIVE_BOTS || '55'), // Max bots
  parseInt(process.env.MAX_LEVERAGE_PER_POSITION || '5'),
  parseInt(process.env.MAX_TOTAL_LEVERAGE || '50')
);

export default FuturesPositionCoordinator;
