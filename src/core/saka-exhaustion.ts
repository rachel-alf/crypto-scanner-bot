// import type { OHLCV } from 'ccxt';

// /**
//  * Detects Sakata San-ku (Three Gaps) exhaustion.
//  * Returns: 'sell' (exhausted uptrend), 'buy' (exhausted downtrend), or null.
//  */
// export function detectSakataExhaustion(ohlcv: OHLCV[]): 'buy' | 'sell' | null {
//   if (ohlcv.length < 5) return null;

//   // We look at the last 4 candles to find 3 gaps between them
//   // Gaps: (C1-C2), (C2-C3), (C3-C4)
//   const candles = ohlcv.slice(-5).map((c) => ({
//     high: c[2],
//     low: c[3],
//   }));

//   let gapsUp = 0;
//   let gapsDown = 0;

//   for (let i = 1; i < candles.length; i++) {
//     if (candles[i].low > candles[i - 1].high) gapsUp++;
//     if (candles[i].high < candles[i - 1].low) gapsDown++;
//   }

//   // Sakata Rule: 3 Gaps = Trend Reversal Imminent
//   if (gapsUp >= 3) return 'sell'; // Market is overheated
//   if (gapsDown >= 3) return 'buy'; // Market is over-panicked

//   return null;
// }
