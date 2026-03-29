// scanners/advanced-scanner/microstructure.ts

export interface MicrostructureMetrics {
  effectiveSpread: number; // What traders actually pay
  priceImpact: number; // How much price moves per $1M traded
  rollMeasure: number; // Price bounce/mean reversion
}

export function calculateMicrostructure(
  trades: any[],
  orderBook: any
): MicrostructureMetrics {
  if (trades.length < 10) {
    return {
      effectiveSpread: 0,
      priceImpact: 0,
      rollMeasure: 0,
    };
  }

  const midPrice = (orderBook.bids[0][0] + orderBook.asks[0][0]) / 2;

  // 1. Effective Spread
  const effectiveSpreads = trades.map(
    (t) => (2 * Math.abs(t.price - midPrice)) / midPrice
  );
  const effectiveSpread =
    effectiveSpreads.reduce((a, b) => a + b, 0) / effectiveSpreads.length;

  // 2. Price Impact
  const totalVolume = trades.reduce((sum, t) => sum + t.amount * t.price, 0);
  const priceMove = Math.abs(trades[trades.length - 1].price - trades[0].price);
  const priceImpact =
    totalVolume > 0 ? priceMove / midPrice / (totalVolume / 1000000) : 0;

  // 3. Roll Measure (autocorrelation)
  const priceChanges: number[] = [];
  for (let i = 1; i < Math.min(trades.length, 100); i++) {
    priceChanges.push(trades[i].price - trades[i - 1].price);
  }

  let rollMeasure = 0;
  if (priceChanges.length > 1) {
    let autocorr = 0;
    for (let i = 0; i < priceChanges.length - 1; i++) {
      autocorr += (priceChanges[i] as number) * (priceChanges[i + 1] as number);
    }
    rollMeasure = -autocorr / (priceChanges.length - 1);
  }

  return {
    effectiveSpread,
    priceImpact,
    rollMeasure,
  };
}
