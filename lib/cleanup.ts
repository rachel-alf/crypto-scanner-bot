import readline from 'readline';

import ccxt, { type Balances } from 'ccxt';
import * as dotenv from 'dotenv';

import { binance } from '../src//core/verify-binance.js';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}
async function checkReality() {
  console.log('🔍 CHECKING BINANCE REALITY...\n');

  // 1. Get actual account balance
  const balance = (await binance.fetchBalance()) as Balances;

  console.log('💰 WALLET BALANCE:');
  console.log(`  Total USDT: $${(balance.USDT?.total as number).toFixed(2)}`);
  console.log(`  Free: $${(balance.USDT?.free as number).toFixed(2)}`);
  console.log(
    `  Used (in positions): $${(balance.USDT?.used as number).toFixed(2)}\n`
  );

  // 2. Get all open positions
  const positions = await binance.fetchPositions();
  const openPositions = positions.filter((p) => {
    const con = p.contracts as any;
    return parseFloat(con) !== 0 && con !== null;
  });

  console.log(`📊 OPEN POSITIONS: ${openPositions.length}`);
  if (openPositions.length > 0) {
    openPositions.forEach((p) => {
      const unrealizedPnL = p.unrealizedPnl || 0;
      const percentage = p.percentage || 0;
      const posSide = p.side as string;
      const posNot = p.notional as number;

      console.log(`
  ${p.symbol}
    Side: ${posSide.toUpperCase()}
    Contracts: ${p.contracts}
    Entry Price: $${p.entryPrice}
    Current Price: $${p.markPrice}
    Unrealized PnL: $${unrealizedPnL.toFixed(2)} (${percentage.toFixed(2)}%)
    Notional: $${posNot.toFixed(2)}
    Leverage: ${p.leverage}x
    Liquidation Price: $${p.liquidationPrice || 'N/A'}
      `);
    });
  } else {
    console.log('  ✅ No open positions\n');
  }

  // 3. Get all open orders
  const openOrders = await binance.fetchOpenOrders();
  console.log(`📋 OPEN ORDERS: ${openOrders.length}`);
  if (openOrders.length > 0) {
    openOrders.forEach((o) => {
      const opType = o.type as string;
      const oSide = o.side as string;

      console.log(`
  ${o.symbol}
    Type: ${opType.toUpperCase()}
    Side: ${oSide.toUpperCase()}
    Price: $${o.price}
    Amount: ${o.amount}
    Status: ${o.status}
    Created: ${new Date(o.timestamp).toLocaleString()}
      `);
    });
  } else {
    console.log('  ✅ No open orders\n');
  }

  // 4. Calculate real PnL
  const startingCapital = 287;
  const currentBalance = balance.USDT?.total as number;
  const realizedPnL = currentBalance - startingCapital;
  const totalUnrealizedPnL = openPositions.reduce(
    (sum, p) => sum + (p.unrealizedPnl || 0),
    0
  );

  console.log('💰 REAL PNL:');
  console.log(`  Starting Capital: $${startingCapital.toFixed(2)}`);
  console.log(`  Current Balance: $${currentBalance.toFixed(2)}`);
  console.log(
    `  Realized PnL: $${realizedPnL.toFixed(2)} (${((realizedPnL / startingCapital) * 100).toFixed(2)}%)`
  );
  console.log(`  Unrealized PnL: $${totalUnrealizedPnL.toFixed(2)}`);
  console.log(
    `  Total PnL: $${(realizedPnL + totalUnrealizedPnL).toFixed(2)}\n`
  );

  // 5. Next steps
  console.log('🚨 WHAT TO DO NEXT:');
  if (openPositions.length > 0) {
    console.log(
      '  ⚠️  You have open positions - close them manually or run cleanup script'
    );
  }
  if (openOrders.length > 0) {
    console.log('  ⚠️  You have open orders - cancel them with cleanup script');
  }
  if (openPositions.length === 0 && openOrders.length === 0) {
    console.log('  ✅ Clean slate - proceed to fix config');
  }
  console.log('');
}

async function cleanup() {
  console.log('🧹 CLEANUP SCRIPT\n');

  // 1. Cancel all open orders
  const openOrders = await binance.fetchOpenOrders();

  if (openOrders.length > 0) {
    console.log(`📋 Found ${openOrders.length} open orders:`);
    openOrders.forEach((o) => {
      console.log(`  - ${o.symbol} ${o.side} ${o.type} @ $${o.price}`);
    });

    const answer = (await ask('\n❓ Cancel all orders? (yes/no): ')) as string;

    if (answer.toLowerCase() === 'yes') {
      for (const order of openOrders) {
        try {
          await binance.cancelOrder(order.id, order.symbol);
          console.log(
            `  ✅ Cancelled: ${order.symbol} ${order.side} ${order.type}`
          );
        } catch (err: any) {
          console.error(
            `  ❌ Failed to cancel ${order.symbol}: ${err.message}`
          );
        }
      }
      console.log('✅ All orders processed\n');
    }
  } else {
    console.log('✅ No open orders to cancel\n');
  }

  // 2. Close all positions
  const positions = await binance.fetchPositions();
  const openPositions = positions.filter(
    (p) => parseFloat(p.contracts as any) !== 0 && p.contracts !== null
  );

  if (openPositions.length > 0) {
    console.log(`📊 Found ${openPositions.length} open positions:`);
    openPositions.forEach((p) => {
      const pnl = p.unrealizedPnl || 0;
      console.log(
        `  - ${p.symbol} ${p.side} ${p.contracts} contracts (PnL: $${pnl.toFixed(2)})`
      );
    });

    const answer = (await ask(
      '\n❓ Close all positions? (yes/no): '
    )) as string;

    if (answer.toLowerCase() === 'yes') {
      for (const pos of openPositions) {
        try {
          // Close position with market order
          const side = pos.side === 'long' ? 'sell' : 'buy';
          const amount = Math.abs(parseFloat(pos.contracts as any));

          const order = await binance.createOrder(
            pos.symbol,
            'market',
            side,
            amount,
            undefined,
            { reduceOnly: true }
          );

          console.log(
            `  ✅ Closed: ${pos.symbol} (PnL: $${(pos.unrealizedPnl || 0).toFixed(2)})`
          );

          // Wait between orders
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (err: any) {
          console.error(`  ❌ Failed to close ${pos.symbol}: ${err.message}`);
        }
      }
      console.log('✅ All positions processed\n');
    }
  } else {
    console.log('✅ No open positions to close\n');
  }

  rl.close();
  console.log('🏁 Cleanup complete!');
}

cleanup().catch((err) => {
  console.error('❌ Error:', err.message);
  rl.close();
  process.exit(1);
});
