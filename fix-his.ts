// fix-trade-history.ts
import fs from 'fs';

const stateFile = './bot-state.json';
const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));

let fixedCount = 0;

state.tradeHistory.forEach((trade: any) => {
  const originalReason = trade.exitReason;
  
  // If isWin is true but exitReason is STOP_LOSS, fix it
  if (trade.isWin && trade.exitReason === 'STOP_LOSS') {
    trade.exitReason = 'TAKE_PROFIT';
    console.log(`✅ Fixed ${trade.symbol}: STOP_LOSS → TAKE_PROFIT (PnL: $${trade.pnlUsd.toFixed(2)})`);
    fixedCount++;
  }
  
  // If isWin is false but exitReason is TAKE_PROFIT, fix it
  if (!trade.isWin && trade.exitReason === 'TAKE_PROFIT') {
    trade.exitReason = 'STOP_LOSS';
    console.log(`✅ Fixed ${trade.symbol}: TAKE_PROFIT → STOP_LOSS (PnL: $${trade.pnlUsd.toFixed(2)})`);
    fixedCount++;
  }
});

if (fixedCount > 0) {
  // Backup original
  fs.writeFileSync(`${stateFile}.backup`, JSON.stringify(state, null, 2));
  
  // Write fixed version
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  
  console.log(`\n✅ Fixed ${fixedCount} trades. Backup saved to ${stateFile}.backup`);
} else {
  console.log('No fixes needed.');
}