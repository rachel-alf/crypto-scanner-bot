import ccxt from 'ccxt';

const exchange = new ccxt.pro.binance({
  apiKey: 'YOUR_API_KEY',
  secret: 'YOUR_SECRET_KEY',
});

// Type guard for OHLCV candle
function isValidCandle(
  candle: any
): candle is [number, number, number, number, number, number] {
  return (
    Array.isArray(candle) &&
    candle.length >= 5 &&
    typeof candle[2] === 'number' && // high
    typeof candle[3] === 'number' && // low
    typeof candle[4] === 'number'
  ); // close
}

async function startWarZoneMonitor(symbol: string) {
  console.log(`⚔️  Entering War Zone: Monitoring ${symbol} via WebSockets...`);

  let gapCount = 0;

  while (true) {
    try {
      const ohlcv = await exchange.watchOHLCV(symbol, '15m');

      // Validate we have at least 2 valid candles
      if (!Array.isArray(ohlcv) || ohlcv.length < 2) {
        continue;
      }

      const currentCandle = ohlcv[ohlcv.length - 1];
      const prevCandle = ohlcv[ohlcv.length - 2];

      if (!isValidCandle(currentCandle) || !isValidCandle(prevCandle)) {
        console.log('Invalid candle data received');
        continue;
      }

      // Destructure safely
      const [, , currentHigh, currentLow, currentClose] = currentCandle;
      const [, , prevHigh, prevLow, prevClose] = prevCandle;

      // Your analysis logic here...
      if (currentLow > prevHigh) {
        gapCount++;
        console.log(
          `⚠️  GAP UP DETECTED (${gapCount}/3). Market is aggressive.`
        );
      } else if (currentHigh < prevLow) {
        gapCount++;
        console.log(`⚠️  GAP DOWN DETECTED (${gapCount}/3). Panic selling.`);
      } else {
        gapCount = 0;
      }

      // Rest of your logic...
    } catch (e) {
      console.error('Connection lost, reconnecting...', e);
      break;
    }
  }
}

startWarZoneMonitor('BTC/USDT');
