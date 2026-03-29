// test-scanner.ts

import ccxt from 'ccxt';

import { AdvancedScanner } from '../scanner/adv-scan.js';

async function testScanner() {
  const exchange = new ccxt.binance({
    enableRateLimit: true,
    options: { defaultType: 'future' },
  });

  const scanner = new AdvancedScanner(exchange, {
    timeframe: '5m',
    scanInterval: 60000, // Test: 1 minute
    maxSignals: 3,
  });

  // Run single scan
  const signals = await scanner.scan();

  console.log('\n📊 Test Results:');
  console.log(`Found ${signals.length} signals`);

  signals.forEach((signal, i) => {
    console.log(`\n${i + 1}. ${signal.symbol} ${signal.side}`);
    console.log(`   Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
    console.log(`   Entry: $${signal.entry.toFixed(2)}`);
    console.log(`   SL: $${signal.stopLoss.toFixed(2)}`);
    console.log(`   TP: $${signal.takeProfit.toFixed(2)}`);
    console.log(`   Reason: ${signal.reason}`);
  });
}

testScanner();
