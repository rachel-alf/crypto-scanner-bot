/**
 * Calculate liquidation price for futures positions
 * 
 * Liquidation occurs when: Position Margin + Unrealized PnL ≤ Maintenance Margin
 * 
 * @param entryPrice - Entry price of the position
 * @param leverage - Leverage used (e.g., 5 for 5x)
 * @param side - Position side ('LONG' or 'SHORT')
 * @param maintenanceMarginRate - Maintenance margin rate (default: 0.4% for most pairs)
 * @returns Liquidation price
 */
function calculateLiquidationPrice(
  entryPrice: number,
  leverage: number,
  side: 'LONG' | 'SHORT' | 'SPOT',
  maintenanceMarginRate: number = 0.004 // 0.4% default
): number {
  // Initial margin rate = 1 / leverage
  const initialMarginRate = 1 / leverage;
  
  // Calculate liquidation price
  // Formula for LONG: Liq = Entry × (1 - InitialMarginRate + MaintenanceMarginRate)
  // Formula for SHORT: Liq = Entry × (1 + InitialMarginRate - MaintenanceMarginRate)
  
  if (side === 'LONG') {
    // For longs, liquidation happens when price drops
    const liquidationPrice = entryPrice * (1 - initialMarginRate + maintenanceMarginRate);
    return liquidationPrice;
  } else {
    // For shorts, liquidation happens when price rises
    const liquidationPrice = entryPrice * (1 + initialMarginRate - maintenanceMarginRate);
    return liquidationPrice;
  }
}

/**
 * Calculate liquidation price with more accurate Binance formula
 * Includes bankruptcy price calculation
 * 
 * @param entryPrice - Entry price
 * @param leverage - Leverage (1-125x)
 * @param side - 'LONG' or 'SHORT'
 * @param walletBalance - Wallet balance allocated to position
 * @param positionSize - Position size (in base asset, e.g., BTC amount)
 * @param maintenanceMarginRate - Maintenance margin rate
 * @param maintenanceAmount - Maintenance amount (fixed fee)
 * @returns Object with liquidation and bankruptcy prices
 */
function calculateLiquidationPriceDetailed(
  entryPrice: number,
  leverage: number,
  side: 'LONG' | 'SHORT',
  walletBalance: number,
  positionSize: number,
  maintenanceMarginRate: number = 0.004,
  maintenanceAmount: number = 0
): {
  liquidationPrice: number;
  bankruptcyPrice: number;
  marginRatio: number;
  maintenanceMargin: number;
} {
  const positionValue = entryPrice * positionSize;
  const initialMargin = positionValue / leverage;
  const maintenanceMargin = positionValue * maintenanceMarginRate + maintenanceAmount;
  
  let liquidationPrice: number;
  let bankruptcyPrice: number;
  
  if (side === 'LONG') {
    // LONG liquidation price formula:
    // LP = (WB - MM + MAmt) / (PS × (MMR - 1))
    // Where: WB = Wallet Balance, MM = Maintenance Margin, MAmt = Maintenance Amount
    //        PS = Position Size, MMR = Maintenance Margin Rate
    
    liquidationPrice = 
      (walletBalance - maintenanceAmount + positionValue * maintenanceMarginRate) / 
      (positionSize * (maintenanceMarginRate + 1));
    
    // Bankruptcy price (where position value = 0)
    bankruptcyPrice = entryPrice * (1 - (1 / leverage));
    
  } else {
    // SHORT liquidation price formula:
    // LP = (WB - MM + MAmt) / (PS × (1 - MMR))
    
    liquidationPrice = 
      (walletBalance + maintenanceAmount + positionValue * maintenanceMarginRate) / 
      (positionSize * (1 - maintenanceMarginRate));
    
    // Bankruptcy price
    bankruptcyPrice = entryPrice * (1 + (1 / leverage));
  }
  
  const marginRatio = maintenanceMargin / walletBalance;
  
  return {
    liquidationPrice,
    bankruptcyPrice,
    marginRatio,
    maintenanceMargin
  };
}

/**
 * Get maintenance margin rate based on position size (Binance tiers)
 * Different position sizes have different maintenance margin requirements
 * 
 * @param positionValueUsdt - Position value in USDT
 * @param symbol - Trading symbol (for specific tier rules)
 * @returns Maintenance margin rate and amount
 */
function getMaintenanceMarginTier(
  positionValueUsdt: number,
  symbol: string = 'BTCUSDT'
): { rate: number; amount: number } {
  // Binance BTCUSDT maintenance margin tiers (example)
  // Adjust these based on actual Binance documentation for your symbols
  
  const btcTiers = [
    { max: 50000, rate: 0.004, amount: 0 },        // 0-50k: 0.4%
    { max: 250000, rate: 0.005, amount: 50 },      // 50k-250k: 0.5%
    { max: 1000000, rate: 0.01, amount: 1300 },    // 250k-1M: 1%
    { max: 5000000, rate: 0.025, amount: 16300 },  // 1M-5M: 2.5%
    { max: Infinity, rate: 0.05, amount: 141300 }  // 5M+: 5%
  ];
  
  // For other symbols, use more conservative tiers
  const defaultTiers = [
    { max: 50000, rate: 0.01, amount: 0 },         // 0-50k: 1%
    { max: 250000, rate: 0.025, amount: 750 },     // 50k-250k: 2.5%
    { max: 1000000, rate: 0.05, amount: 7000 },    // 250k-1M: 5%
    { max: Infinity, rate: 0.1, amount: 57000 }    // 1M+: 10%
  ];
  
  const tiers = symbol.includes('BTC') ? btcTiers : defaultTiers;
  
  for (const tier of tiers) {
    if (positionValueUsdt <= tier.max) {
      return { rate: tier.rate, amount: tier.amount };
    }
  }
  
  return { rate: 0.05, amount: 0 }; // Fallback
}

/**
 * Calculate distance to liquidation as percentage
 * 
 * @param currentPrice - Current market price
 * @param liquidationPrice - Calculated liquidation price
 * @param side - Position side
 * @returns Distance to liquidation in percentage
 */
function getDistanceToLiquidation(
  currentPrice: number,
  liquidationPrice: number,
  side: 'LONG' | 'SHORT' | 'SPOT'
): number {
  if (side === 'LONG') {
    // For longs, liquidation is below entry
    return ((currentPrice - liquidationPrice) / currentPrice) * 100;
  } else {
    // For shorts, liquidation is above entry
    return ((liquidationPrice - currentPrice) / currentPrice) * 100;
  }
}

/**
 * Check if position is near liquidation (warning threshold)
 * 
 * @param currentPrice - Current price
 * @param liquidationPrice - Liquidation price
 * @param side - Position side
 * @param warningThreshold - Warning threshold percentage (default: 10%)
 * @returns Object with warning status and details
 */
function checkLiquidationRisk(
  currentPrice: number,
  liquidationPrice: number,
  side: 'LONG' | 'SHORT' |'SPOT',
  warningThreshold: number = 10
): {
  isAtRisk: boolean;
  distancePercent: number;
  severity: 'safe' | 'warning' | 'critical' | 'danger';
} {
  const distance = getDistanceToLiquidation(currentPrice, liquidationPrice, side);
  
  let severity: 'safe' | 'warning' | 'critical' | 'danger';
  
  if (distance < 2) {
    severity = 'danger';      // < 2% to liquidation
  } else if (distance < 5) {
    severity = 'critical';    // < 5% to liquidation
  } else if (distance < warningThreshold) {
    severity = 'warning';     // < threshold% to liquidation
  } else {
    severity = 'safe';        // Safe distance
  }
  
  return {
    isAtRisk: distance < warningThreshold,
    distancePercent: distance,
    severity
  };
}

/**
 * Example usage and testing
 */
function exampleUsage() {
  console.log('🧮 LIQUIDATION PRICE CALCULATOR\n');
  console.log('═'.repeat(60));
  
  // Example 1: Simple calculation
  const entry1 = 43000;
  const leverage1 = 10;
  const side1 = 'LONG';
  
  const liq1 = calculateLiquidationPrice(entry1, leverage1, side1);
  console.log('\n📊 Example 1: Simple LONG position');
  console.log(`Entry: $${entry1}`);
  console.log(`Leverage: ${leverage1}x`);
  console.log(`Liquidation: $${liq1.toFixed(2)}`);
  console.log(`Distance: ${((entry1 - liq1) / entry1 * 100).toFixed(2)}%`);
  
  // Example 2: SHORT position
  const entry2 = 43000;
  const leverage2 = 5;
  const side2 = 'SHORT';
  
  const liq2 = calculateLiquidationPrice(entry2, leverage2, side2);
  console.log('\n📊 Example 2: Simple SHORT position');
  console.log(`Entry: $${entry2}`);
  console.log(`Leverage: ${leverage2}x`);
  console.log(`Liquidation: $${liq2.toFixed(2)}`);
  console.log(`Distance: ${((liq2 - entry2) / entry2 * 100).toFixed(2)}%`);
  
  // Example 3: Detailed calculation
  const entry3 = 43000;
  const leverage3 = 10;
  const side3 = 'LONG';
  const walletBalance3 = 1000; // $1000 margin
  const positionSize3 = 0.232; // BTC amount
  
  const tier = getMaintenanceMarginTier(entry3 * positionSize3);
  const detailed = calculateLiquidationPriceDetailed(
    entry3,
    leverage3,
    side3,
    walletBalance3,
    positionSize3,
    tier.rate,
    tier.amount
  );
  
  console.log('\n📊 Example 3: Detailed LONG position');
  console.log(`Entry: $${entry3}`);
  console.log(`Leverage: ${leverage3}x`);
  console.log(`Position Size: ${positionSize3} BTC`);
  console.log(`Wallet Balance: $${walletBalance3}`);
  console.log(`Position Value: $${(entry3 * positionSize3).toFixed(2)}`);
  console.log(`Maintenance Margin Rate: ${(tier.rate * 100).toFixed(2)}%`);
  console.log(`Maintenance Margin: $${detailed.maintenanceMargin.toFixed(2)}`);
  console.log(`Liquidation Price: $${detailed.liquidationPrice.toFixed(2)}`);
  console.log(`Bankruptcy Price: $${detailed.bankruptcyPrice.toFixed(2)}`);
  
  // Example 4: Risk check
  const currentPrice = 42500;
  const risk = checkLiquidationRisk(currentPrice, detailed.liquidationPrice, side3, 10);
  
  console.log('\n⚠️  Liquidation Risk Assessment');
  console.log(`Current Price: $${currentPrice}`);
  console.log(`Distance to Liquidation: ${risk.distancePercent.toFixed(2)}%`);
  console.log(`Risk Level: ${risk.severity.toUpperCase()}`);
  console.log(`At Risk: ${risk.isAtRisk ? '⚠️ YES' : '✅ NO'}`);
  
  console.log('\n' + '═'.repeat(60));
}

// Export functions
export {
  calculateLiquidationPrice,
  calculateLiquidationPriceDetailed,
  getMaintenanceMarginTier,
  getDistanceToLiquidation,
  checkLiquidationRisk
};

// Run example if executed directly
// if (require.main === module) {
//   exampleUsage();
// }