// scanners/advanced-scanner/order-flow.ts

export interface OrderFlowMetrics {
  bidAskImbalance: number; // Ratio of bid to ask volume
  cumulativeDelta: number; // Net buying/selling pressure
  deltaVolume: number; // Buy volume - sell volume
  buyVolume: number; // Total buy volume
  sellVolume: number; // Total sell volume
}

export function calculateOrderFlow(
  orderBook: any,
  trades: any[]
): OrderFlowMetrics {
  // 1. Calculate Bid/Ask Imbalance from order book
  const bidVolume = orderBook.bids
    .slice(0, 10)
    .reduce((sum: number, [price, vol]: [number, number]) => sum + vol, 0);

  const askVolume = orderBook.asks
    .slice(0, 10)
    .reduce((sum: number, [price, vol]: [number, number]) => sum + vol, 0);

  const bidAskImbalance = askVolume > 0 ? bidVolume / askVolume : 0;

  // 2. Calculate Delta from trades
  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of trades) {
    if (trade.side === 'buy') {
      buyVolume += trade.amount;
    } else {
      sellVolume += trade.amount;
    }
  }

  const deltaVolume = buyVolume - sellVolume;
  const cumulativeDelta = deltaVolume; // In real system, this would accumulate over time

  return {
    bidAskImbalance,
    cumulativeDelta,
    deltaVolume,
    buyVolume,
    sellVolume,
  };
}
