// scanners/advanced-scanner/hurst.ts

export function calculateHurstExponent(prices: number[]): number {
  if (prices.length < 100) {
    return 0.5; // Default to random walk
  }

  const lags = [10, 20, 50, 100];
  const rsByLag: number[] = [];

  for (const lag of lags) {
    if (lag > prices.length) continue;

    const subset = prices.slice(-lag) as number[];

    // Calculate mean
    const mean = subset.reduce((a, b) => a + b, 0) / lag;

    // Calculate cumulative deviation
    const deviations: number[] = [];
    let cumDev = 0;

    for (let i = 0; i < lag; i++) {
      cumDev += (subset[i] as number) - mean;
      deviations.push(cumDev);
    }

    // Calculate range
    const range = Math.max(...deviations) - Math.min(...deviations);

    // Calculate standard deviation
    const variance =
      subset.reduce((sum, price) => {
        return sum + Math.pow(price - mean, 2);
      }, 0) / lag;
    const stdDev = Math.sqrt(variance);

    // R/S ratio
    if (stdDev > 0) {
      rsByLag.push(range / stdDev);
    }
  }

  if (rsByLag.length < 2) {
    return 0.5;
  }

  // Linear regression to find Hurst exponent
  const logLags = lags.slice(0, rsByLag.length).map(Math.log);
  const logRS = rsByLag.map(Math.log);

  const n = logLags.length;
  const sumX = logLags.reduce((a, b) => a + b, 0);
  const sumY = logRS.reduce((a, b) => a + b, 0);
  const sumXY = logLags.reduce(
    (sum, x, i) => sum + x * (logRS[i] as number),
    0
  );
  const sumXX = logLags.reduce((sum, x) => sum + x * x, 0);

  const hurst = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

  // Bound between 0 and 1
  return Math.max(0, Math.min(1, hurst));
}
