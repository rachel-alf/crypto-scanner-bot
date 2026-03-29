// main.ts or your startup file

import { binance } from '../core/safe-trade-execute.js';
import { AdvancedScanner } from '../scanner/adv-scan.js';

async function startAdvancedScanner() {
  // Initialize exchange
  // const exchange = new ccxt.binance({
  //   apiKey: process.env.BINANCE_API_KEY,
  //   secret: process.env.BINANCE_SECRET,
  //   enableRateLimit: true,
  //   options: {
  //     defaultType: 'future'
  //   }
  // });

  // Create scanner with custom config
  const scanner = new AdvancedScanner(binance, {
    timeframe: '5m', // 5-minute scalping
    minVolume: 20_000_000, // $15M minimum volume
    maxSpread: 0.03, // 0.03% max spread
    scanInterval: 30_000, // Scan every 30 seconds
    maxSignals: 5, // Max 5 signals per scan
    minHurst: 0.58, // Strong trend required
    minOrderFlowImbalance: 2.0, // 2:1 buy/sell ratio
    maxVPIN: 0.4, // Low toxicity only
  });

  // Start scanning
  scanner.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down...');
    scanner.stop();
    process.exit(0);
  });
}

startAdvancedScanner();
