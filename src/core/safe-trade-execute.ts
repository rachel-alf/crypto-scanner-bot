import ccxt from 'ccxt';
import * as dotenv from 'dotenv';

import { getRequiredEnvVar } from '../futures/launcher-future.js';

dotenv.config();

// ---------- EXCHANGE INIT ----------
if (
  !process.env.BINANCE_FUTURE_API_KEY ||
  !process.env.BINANCE_FUTURE_API_SECRET
) {
  throw Error('Missing BINANCE_FUTURE_API_KEY or BINANCE_FUTURE_API_SECRET');
}

export const binance = new ccxt.binance({
  apiKey: getRequiredEnvVar('BINANCE_FUTURE_API_KEY'),
  secret: getRequiredEnvVar('BINANCE_FUTURE_API_SECRET'),
  enableRateLimit: true,
  options: { defaultType: 'futures' }, // Or 'future'
});

export async function executeSafeTrade(
  symbol: string,
  side: 'buy' | 'sell',
  riskPercent: number = 0.13
) {
  try {
    // 1. Load Markets (Crucial for precision/rounding)
    await binance.loadMarkets();
    const market = binance.market(symbol);

    // 2. Check Balance - SAFELY
    const balance = (await binance.fetchBalance()) as any;

    // Check if balance.free exists
    if (!balance.free) {
      throw new Error('Unable to fetch free balance from exchange');
    }

    const currencyParts = symbol.split('/');
    const currency = side === 'buy' ? currencyParts[1] : currencyParts[0];

    if (!currency) throw new Error('Invalid symbol format');

    // Safely get free balance with default value
    const freeBalance = balance.free[currency] || 0;

    if (freeBalance <= 0) {
      throw new Error(
        `Insufficient ${currency} funds. Available: ${freeBalance}`
      );
    }

    // 3. Calculate Amount with Binance Precision
    const ticker = await binance.fetchTicker(symbol);
    const entryPrice = ticker.last as number;

    // Simple 10% of balance risk for this example
    let amount =
      (freeBalance * riskPercent) / (side === 'buy' ? entryPrice : 1);
    amount = parseFloat(binance.amountToPrecision(symbol, amount));

    // Check minimum amount
    const minAmount = market.limits?.amount?.min || 0;
    if (amount < minAmount) {
      throw new Error(`Amount ${amount} is below minimum ${minAmount}`);
    }

    console.log(
      `📡 Executing ${side} for ${amount} ${symbol} at ${entryPrice}`
    );

    // 4. Place Main Market Order
    const order = await binance.createMarketOrder(symbol, side, amount);
    console.log(`✅ Order Filled: ${order.id}`);

    // 5. IMMEDIATE DEFENSE: Place Stop Loss (Homma's Protection)
    // If Buy, SL is below entry. If Sell, SL is above entry.
    const slPercent = 0.02; // 2% hard stop
    const stopPrice =
      side === 'buy'
        ? entryPrice * (1 - slPercent)
        : entryPrice * (1 + slPercent);

    const slParams = {
      stopPrice: binance.priceToPrecision(symbol, stopPrice),
      reduceOnly: true, // Prevents opening a reverse position
    };

    await binance.createOrder(
      symbol,
      'STOP_MARKET',
      side === 'buy' ? 'sell' : 'buy',
      amount,
      undefined,
      slParams
    );

    console.log(`🛡️ Defense Active: Stop Loss set at ${stopPrice}`);

    return { success: true, orderId: order.id, amount, entryPrice, stopPrice };
  } catch (e: any) {
    console.error('❌ TRADE FAILED:', e.message);
    // Implement Telegram/Email alert here for "War Zone" survival
    return { success: false, error: e.message };
  }
}
