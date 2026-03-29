export interface EnhancedMarketData {
  fundingRate: number;
  openInterest?: number | undefined;
  longShortRatio?: number | undefined;
}

/**
 * Fetch real-time BTC futures market data from Binance
 * Includes funding rate, open interest, and long/short ratio
 */
// export async function getBTCFuturesMarketData(): Promise<
//   EnhancedMarketData | undefined
// > {
//   let openInterest;
//   let longShortRatio;

//   try {
//     // Parallel fetch all data
//     const [fundingData, oiData, ratioData] = await Promise.all([
//       // 1. Funding rate (most important)
//       fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT')
//         .then((r) => r.json())
//         .catch(() => null),

//       // 2. Open interest (optional but useful)
//       fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT')
//         .then((r) => r.json())
//         .catch(() => null),

//       // 3. Long/Short ratio (optional)
//       fetch(
//         'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1'
//       )
//         .then((r) => r.json())
//         .catch(() => null),
//     ]);

//     // Parse funding rate
//     const fundingRate = fundingData?.lastFundingRate
//       ? parseFloat(fundingData.lastFundingRate)
//       : 0;

//     // Parse open interest (total $ value of open positions)
//     openInterest = oiData?.openInterest
//       ? parseFloat(oiData.openInterest)
//       : undefined;

//     // Parse long/short ratio
//     longShortRatio =
//       ratioData && Array.isArray(ratioData) && ratioData.length > 0
//         ? parseFloat(ratioData[0].longShortRatio)
//         : undefined;

//     if (!openInterest || !longShortRatio) {
//       throw new Error('error');
//     }

//     console.log('\n💰 BTC Futures Market Data:');
//     console.log(`   Funding Rate: ${(fundingRate * 100).toFixed(4)}%`);
//     if (openInterest) {
//       console.log(
//         `   Open Interest: $${(openInterest / 1_000_000_000).toFixed(2)}B`
//       );
//     }
//     if (longShortRatio) {
//       console.log(`   Long/Short Ratio: ${longShortRatio.toFixed(2)}`);
//     }
//     console.log('');

//     return {
//       fundingRate,
//       openInterest,
//       longShortRatio,
//     };
//   } catch (error: any) {
//     console.log('⚠️  Failed to fetch BTC futures data, using defaults');
//     console.error(error);

//     return {
//       fundingRate: 0,
//       openInterest: undefined,
//       longShortRatio: undefined,
//     };
//   }
// }

// /**
//  * Interpret funding rate status
//  */
// export function interpretFundingRate(fundingRate: number): {
//   status:
//     | 'EXTREME_LONG'
//     | 'HIGH_LONG'
//     | 'NEUTRAL'
//     | 'HIGH_SHORT'
//     | 'EXTREME_SHORT';
//   message: string;
//   bias: 'LONG' | 'SHORT' | 'NEUTRAL';
// } {
//   if (fundingRate > 0.1) {
//     return {
//       status: 'EXTREME_LONG',
//       message: `🚨 CRITICAL: ${(fundingRate * 100).toFixed(3)}% funding - Longs VERY overleveraged, dump imminent`,
//       bias: 'SHORT',
//     };
//   }

//   if (fundingRate > 0.05) {
//     return {
//       status: 'HIGH_LONG',
//       message: `⚠️  Elevated: ${(fundingRate * 100).toFixed(3)}% funding - Longs overleveraged, short bias`,
//       bias: 'SHORT',
//     };
//   }

//   if (fundingRate < -0.05) {
//     return {
//       status: 'EXTREME_SHORT',
//       message: `🚨 CRITICAL: ${(fundingRate * 100).toFixed(3)}% funding - Shorts VERY overleveraged, pump imminent`,
//       bias: 'LONG',
//     };
//   }

//   if (fundingRate < -0.03) {
//     return {
//       status: 'HIGH_SHORT',
//       message: `⚠️  Negative: ${(fundingRate * 100).toFixed(3)}% funding - Shorts overleveraged, long bias`,
//       bias: 'LONG',
//     };
//   }

//   return {
//     status: 'NEUTRAL',
//     message: `✅ Balanced: ${(fundingRate * 100).toFixed(3)}% funding - No extreme leverage`,
//     bias: 'NEUTRAL',
//   };
// }

export async function getBTCFuturesMarketData(): Promise<EnhancedMarketData> {
  try {
    // Parallel fetch all data with timeout
    const [fundingData, oiData, ratioData] = await Promise.all([
      // 1. Funding rate (critical)
      fetchWithTimeout(
        'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',
        5000
      ),

      // 2. Open interest (optional but useful)
      fetchWithTimeout(
        'https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT',
        5000
      ),

      // 3. Long/Short ratio (optional)
      fetchWithTimeout(
        'https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1',
        5000
      ),
    ]);

    // Validate and parse funding rate (critical data)
    if (!fundingData?.lastFundingRate) {
      throw new Error('Critical: Funding rate data unavailable');
    }

    const fundingRate = parseFloat(fundingData.lastFundingRate);
    if (isNaN(fundingRate)) {
      throw new Error('Critical: Invalid funding rate format');
    }

    // Parse optional data
    const openInterest = parseOptionalNumber(oiData?.openInterest);
    const longShortRatio =
      ratioData && Array.isArray(ratioData) && ratioData.length > 0
        ? parseOptionalNumber(ratioData[0].longShortRatio)
        : undefined;

    // Log warnings for missing optional data
    if (!openInterest) {
      console.warn('⚠️  Open Interest data unavailable');
    }
    if (!longShortRatio) {
      console.warn('⚠️  Long/Short Ratio data unavailable');
    }

    // Log successful results
    console.log('\n💰 BTC Futures Market Data:');
    console.log(`   Funding Rate: ${(fundingRate * 100).toFixed(4)}%`);
    if (openInterest) {
      console.log(
        `   Open Interest: $${(openInterest / 1_000_000_000).toFixed(2)}B`
      );
    }
    if (longShortRatio) {
      console.log(`   Long/Short Ratio: ${longShortRatio.toFixed(2)}`);
    }
    console.log('');

    return {
      fundingRate,
      openInterest,
      longShortRatio,
    };
  } catch (error) {
    console.error('❌ Failed to fetch BTC futures data:', error);
    console.log('⚠️  Using fallback defaults (funding rate = 0)');

    // Return safe defaults when critical data fails
    return {
      fundingRate: 0,
      openInterest: undefined,
      longShortRatio: undefined,
    };
  }
}

/**
 * Fetch with timeout to prevent hanging requests
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn(`⏱️  Request timeout: ${url}`);
    } else {
      console.warn(`⚠️  Fetch failed: ${url}`, error);
    }
    return null;
  }
}

/**
 * Safely parse optional numeric values
 */
function parseOptionalNumber(value: any): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsed = parseFloat(value);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Interpret funding rate status
 */
export function interpretFundingRate(fundingRate: number): {
  status:
    | 'EXTREME_LONG'
    | 'HIGH_LONG'
    | 'NEUTRAL'
    | 'HIGH_SHORT'
    | 'EXTREME_SHORT';
  message: string;
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
} {
  if (fundingRate > 0.1) {
    return {
      status: 'EXTREME_LONG',
      message: `🚨 CRITICAL: ${(fundingRate * 100).toFixed(3)}% funding - Longs VERY overleveraged, dump imminent`,
      bias: 'SHORT',
    };
  }

  if (fundingRate > 0.05) {
    return {
      status: 'HIGH_LONG',
      message: `⚠️  Elevated: ${(fundingRate * 100).toFixed(3)}% funding - Longs overleveraged, short bias`,
      bias: 'SHORT',
    };
  }

  if (fundingRate < -0.05) {
    return {
      status: 'EXTREME_SHORT',
      message: `🚨 CRITICAL: ${(fundingRate * 100).toFixed(3)}% funding - Shorts VERY overleveraged, pump imminent`,
      bias: 'LONG',
    };
  }

  if (fundingRate < -0.03) {
    return {
      status: 'HIGH_SHORT',
      message: `⚠️  Negative: ${(fundingRate * 100).toFixed(3)}% funding - Shorts overleveraged, long bias`,
      bias: 'LONG',
    };
  }

  return {
    status: 'NEUTRAL',
    message: `✅ Balanced: ${(fundingRate * 100).toFixed(3)}% funding - No extreme leverage`,
    bias: 'NEUTRAL',
  };
}

/**
 * Example usage in your scanner:
 *
 * // In scanAll(), replace:
 * const btcCandles = this.candleManager.getCandles('BTCUSDT', 'FUTURES');
 * this.currentWeather = await checkMarketWeather(btcCandles, {});
 *
 * // With:
 * const btcCandles = this.candleManager.getCandles('BTCUSDT', 'FUTURES');
 * const marketData = await getBTCFuturesMarketData();
 * const fundingInfo = interpretFundingRate(marketData.fundingRate);
 * console.log(fundingInfo.message);
 * this.currentWeather = await checkMarketWeather(btcCandles, marketData);
 */
