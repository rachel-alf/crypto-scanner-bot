// scanners/advanced-scanner/vpin.ts

export interface VPINMetrics {
  vpin: number;
  toxicity: 'LOW' | 'MEDIUM' | 'HIGH';
}

export function calculateVPIN(
  trades: any[],
  buckets: number = 50
): VPINMetrics {
  if (trades.length < buckets * 2) {
    return { vpin: 0, toxicity: 'LOW' };
  }

  // Calculate total volume
  const totalVolume = trades.reduce((sum, t) => sum + t.amount, 0);
  const volumePerBucket = totalVolume / buckets;

  // Calculate volume buckets and imbalances
  const bucketImbalances: number[] = [];
  let currentBucketVolume = 0;
  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of trades) {
    currentBucketVolume += trade.amount;

    if (trade.side === 'buy') {
      buyVolume += trade.amount;
    } else {
      sellVolume += trade.amount;
    }

    // Bucket full
    if (currentBucketVolume >= volumePerBucket) {
      const imbalance = Math.abs(buyVolume - sellVolume);
      bucketImbalances.push(imbalance);

      currentBucketVolume = 0;
      buyVolume = 0;
      sellVolume = 0;
    }
  }

  if (bucketImbalances.length === 0) {
    return { vpin: 0, toxicity: 'LOW' };
  }

  // Calculate VPIN
  const avgImbalance =
    bucketImbalances.reduce((a, b) => a + b, 0) / bucketImbalances.length;
  const vpin = avgImbalance / volumePerBucket;

  // Classify toxicity
  let toxicity: 'LOW' | 'MEDIUM' | 'HIGH';
  if (vpin < 0.3) {
    toxicity = 'LOW';
  } else if (vpin < 0.5) {
    toxicity = 'MEDIUM';
  } else {
    toxicity = 'HIGH';
  }

  return { vpin, toxicity };
}
