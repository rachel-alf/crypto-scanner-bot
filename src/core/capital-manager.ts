// capital-manager.ts (or add to your config file)

// ============================================================================
// CAPITAL TRACKING STATE
// ============================================================================

interface CapitalState {
  totalCapital: number; // Total capital (changes with PnL)
  availableCapital: number; // Free capital for new positions
  allocatedCapital: number; // Capital in active positions
  startingCapital: number; // Initial capital (never changes)
}

let capitalState: CapitalState = {
  totalCapital: 0,
  availableCapital: 0,
  allocatedCapital: 0,
  startingCapital: 0,
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize capital management system
 * Call this ONCE at bot startup
 */
export function initializeCapital(startingAmount: number): void {
  capitalState = {
    totalCapital: startingAmount,
    availableCapital: startingAmount,
    allocatedCapital: 0,
    startingCapital: startingAmount,
  };

  console.log(`💰 Capital initialized: $${startingAmount.toFixed(2)}`);
}

// ============================================================================
// RESERVE CAPITAL (When opening position)
// ============================================================================

/**
 * Reserve capital for a new position
 * @param amount - Margin required (NOT notional value)
 * @returns true if successful, false if insufficient capital
 */
export function reserveCapital(amount: number): boolean {
  if (amount > capitalState.availableCapital) {
    console.log(
      `❌ Insufficient capital:\n` +
        `   Requested: $${amount.toFixed(2)}\n` +
        `   Available: $${capitalState.availableCapital.toFixed(2)}\n` +
        `   Total: $${capitalState.totalCapital.toFixed(2)}\n` +
        `   Allocated: $${capitalState.allocatedCapital.toFixed(2)}`
    );
    return false;
  }

  // Update state
  capitalState.availableCapital -= amount;
  capitalState.allocatedCapital += amount;

  console.log(
    `💰 Reserved $${amount.toFixed(2)} | ` +
      `Available: $${capitalState.availableCapital.toFixed(2)}/$${capitalState.totalCapital.toFixed(2)} | ` +
      `Allocated: $${capitalState.allocatedCapital.toFixed(2)}`
  );

  return true;
}

// ============================================================================
// RELEASE CAPITAL (When closing position)
// ============================================================================

/**
 * Release capital when position closes
 * @param marginUsed - Margin that was reserved
 * @param pnl - Profit/Loss in USD (can be negative)
 */
export function releaseCapital(marginUsed: number, pnl: number): void {
  console.log(
    `💵 Releasing capital:\n` +
      `   Margin: $${marginUsed.toFixed(2)}\n` +
      `   PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
  );

  // Release the margin back to available
  capitalState.availableCapital += marginUsed;
  capitalState.allocatedCapital -= marginUsed;

  // Apply PnL to total capital
  capitalState.totalCapital += pnl;

  // ✅ CRITICAL: Available capital can't exceed total
  if (capitalState.availableCapital > capitalState.totalCapital) {
    capitalState.availableCapital = capitalState.totalCapital;
  }

  // ✅ CRITICAL: If losses reduced total below allocated, adjust
  if (capitalState.totalCapital < capitalState.allocatedCapital) {
    console.log(
      `⚠️ WARNING: Total capital ($${capitalState.totalCapital.toFixed(2)}) ` +
        `< Allocated ($${capitalState.allocatedCapital.toFixed(2)})`
    );
    // This shouldn't happen, but if it does, available should be 0
    capitalState.availableCapital = 0;
  }

  console.log(
    `   New Available: $${capitalState.availableCapital.toFixed(2)}\n` +
      `   New Total: $${capitalState.totalCapital.toFixed(2)}\n` +
      `   Allocated: $${capitalState.allocatedCapital.toFixed(2)}\n` +
      `   Return: ${((capitalState.totalCapital / capitalState.startingCapital - 1) * 100).toFixed(2)}%`
  );
}

// ============================================================================
// GETTERS
// ============================================================================

/**
 * Get current capital status
 */
export function getCapitalStatus(): {
  total: number;
  available: number;
  allocated: number;
  starting: number;
  utilizationPercent: number;
  returnPercent: number;
} {
  return {
    total: capitalState.totalCapital,
    available: capitalState.availableCapital,
    allocated: capitalState.allocatedCapital,
    starting: capitalState.startingCapital,
    utilizationPercent:
      capitalState.totalCapital > 0
        ? (capitalState.allocatedCapital / capitalState.totalCapital) * 100
        : 0,
    returnPercent:
      (capitalState.totalCapital / capitalState.startingCapital - 1) * 100,
  };
}

/**
 * Get capital utilization percentage
 */
export function getCapitalUtilization(): number {
  return capitalState.totalCapital > 0
    ? (capitalState.allocatedCapital / capitalState.totalCapital) * 100
    : 0;
}

/**
 * Check if we have enough capital for a position
 */
export function hasCapitalFor(amount: number): boolean {
  return capitalState.availableCapital >= amount;
}

/**
 * Get available capital amount
 */
export function getAvailableCapital(): number {
  return capitalState.availableCapital;
}

/**
 * Get total capital amount
 */
export function getTotalCapital(): number {
  return capitalState.totalCapital;
}

// ============================================================================
// DEBUGGING
// ============================================================================

/**
 * Print detailed capital state for debugging
 */
export function debugCapitalState(): void {
  console.log('\n💰 CAPITAL STATE DEBUG:');
  console.log('═'.repeat(60));
  console.log(`Starting Capital:  $${capitalState.startingCapital.toFixed(2)}`);
  console.log(`Total Capital:     $${capitalState.totalCapital.toFixed(2)}`);
  console.log(
    `Available:         $${capitalState.availableCapital.toFixed(2)}`
  );
  console.log(
    `Allocated:         $${capitalState.allocatedCapital.toFixed(2)}`
  );
  console.log(`─`.repeat(60));
  console.log(
    `Return:            ${getCapitalStatus().returnPercent.toFixed(2)}%`
  );
  console.log(
    `Utilization:       ${getCapitalStatus().utilizationPercent.toFixed(1)}%`
  );
  console.log('═'.repeat(60));

  // Verify math
  const sum = capitalState.availableCapital + capitalState.allocatedCapital;
  const diff = Math.abs(sum - capitalState.totalCapital);

  if (diff > 0.01) {
    console.log(`❌ MATH ERROR: Available + Allocated ≠ Total`);
    console.log(`   Available: $${capitalState.availableCapital.toFixed(2)}`);
    console.log(`   Allocated: $${capitalState.allocatedCapital.toFixed(2)}`);
    console.log(`   Sum:       $${sum.toFixed(2)}`);
    console.log(`   Total:     $${capitalState.totalCapital.toFixed(2)}`);
    console.log(`   Diff:      $${diff.toFixed(2)}`);
  } else {
    console.log(`✅ Math check passed: Available + Allocated = Total`);
  }
  console.log('');
}

/**
 * Reset capital to starting amount (for testing)
 */
export function resetCapital(): void {
  capitalState.totalCapital = capitalState.startingCapital;
  capitalState.availableCapital = capitalState.startingCapital;
  capitalState.allocatedCapital = 0;
  console.log(
    `♻️ Capital reset to $${capitalState.startingCapital.toFixed(2)}`
  );
}
