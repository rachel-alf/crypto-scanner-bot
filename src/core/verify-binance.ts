import ccxt, { type Balances } from 'ccxt';
import * as dotenv from 'dotenv';

dotenv.config();

if (
  !process.env.BINANCE_FUTURE_API_KEY ||
  !process.env.BINANCE_FUTURE_API_SECRET
) {
  throw Error('Missing BINANCE_FUTURE_API_KEY or BINANCE_FUTURE_API_SECRET');
}

const api = process.env.BINANCE_FUTURE_API_KEY;
const secret = process.env.BINANCE_FUTURE_API_SECRET;
export const binance = new ccxt.binance({
  apiKey: api,
  secret: secret,
  options: {
    defaultType: 'future',
    warnOnFetchOpenOrdersWithoutSymbol: false,
  },
  urls: {
    api: {
      fapiPublic: 'https://testnet.binancefuture.com/fapi/v1',
      fapiPrivate: 'https://testnet.binancefuture.com/fapi/v1',
    },
  },
});

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
  const startingCapital = 210;
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

checkReality().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
