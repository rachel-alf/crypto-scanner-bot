

import fs from 'fs';

const files = [
  './signals/scanner-output.json',
  './signals/futures-signals.json',
  './signals/spot-signals.json',
];

console.log('═'.repeat(80));
console.log('🔍 SIGNAL FILE DIAGNOSTICS');
console.log('═'.repeat(80));

files.forEach(file => {
  console.log(`\n📁 Checking: ${file}`);
  console.log('─'.repeat(80));
  
  if (!fs.existsSync(file)) {
    console.log('❌ File does not exist');
    return;
  }
  
  try {
    const stats = fs.statSync(file);
    console.log(`✅ File exists`);
    console.log(`   Size: ${stats.size} bytes`);
    console.log(`   Modified: ${stats.mtime.toLocaleString()}`);
    
    const content = fs.readFileSync(file, 'utf-8');
    
    if (!content.trim()) {
      console.log('⚠️  File is EMPTY');
      return;
    }
    
    let data;
    try {
      data = JSON.parse(content);
    } catch (err: any) {
      console.log('❌ Invalid JSON:', err.message);
      console.log('First 100 chars:', content.substring(0, 100));
      return;
    }
    
    if (!Array.isArray(data)) {
      console.log('❌ Not an array. Type:', typeof data);
      return;
    }
    
    console.log(`📊 Contains ${data.length} signals`);
    
    if (data.length === 0) {
      console.log('⚠️  Signal array is empty');
      return;
    }
    
    // Analyze signals
    const longCount = data.filter(s => s?.signal?.side === 'LONG').length;
    const shortCount = data.filter(s => s?.signal?.side === 'SHORT').length;
    const strategies = [...new Set(data.map(s => s?.signal?.strategy))];
    const avgConfidence = data.reduce((sum, s) => sum + (s.confidence || 0), 0) / data.length;
    
    console.log(`\n   Signal Breakdown:`);
    console.log(`   ├─ LONG: ${longCount}`);
    console.log(`   ├─ SHORT: ${shortCount}`);
    console.log(`   ├─ Avg Confidence: ${avgConfidence.toFixed(1)}%`);
    console.log(`   └─ Strategies: ${strategies.join(', ')}`);
    
    // Show top 3
    console.log(`\n   Top 3 Signals:`);
    data.slice(0, 3).forEach((s: any, i: number) => {
      if (!s || !s.signal) return;
      console.log(`   ${i + 1}. ${s.symbol} ${s.signal.side} ${s.signal.strategy} (${s.confidence}%)`);
      console.log(`      Entry: $${s.price?.toFixed(6)}, SL: $${s.signal.stopLoss?.toFixed(6)}, TP: $${s.signal.takeProfit?.toFixed(6)}`);
    });
    
    // Check structure of first signal
    console.log(`\n   First Signal Structure:`);
    console.log(JSON.stringify(data[0], null, 2).split('\n').slice(0, 15).join('\n'));
    
  } catch (err: any) {
    console.log('❌ Error reading file:', err.message);
  }
});

console.log('\n' + '═'.repeat(80));
console.log('💡 RECOMMENDATIONS:');
console.log('═'.repeat(80));

console.log(`
1. Make sure scanner is running:
    npm run scanner

2. Check scanner mode (should output FUTURES signals):
    Look for: "📁 Exported: X SPOT, Y FUTURES, Z total signals"

3. Wait at least 30 seconds for first scan to complete

4. Check bot is reading correct file:
    Bot CONFIG.signalFile should match scanner output

5. Lower minConfidence if needed:
    Bot: CONFIG.minConfidence = 60
    Scanner: confidence >= 60 to be exported
`);

console.log('═'.repeat(80));


// test-scanner.ts - Quick scanner validation
// Run: npx tsx test-scanner.ts

// import { EMA, RSI } from 'technicalindicators';

// // Simulate some sample candle data
// const sampleCandles = {
//   closes: Array.from({ length: 250 }, (_, i) => 50000 + Math.sin(i / 10) * 2000 + i * 10),
//   highs: Array.from({ length: 250 }, (_, i) => 50000 + Math.sin(i / 10) * 2000 + i * 10 + 100),
//   lows: Array.from({ length: 250 }, (_, i) => 50000 + Math.sin(i / 10) * 2000 + i * 10 - 100),
//   volumes: Array.from({ length: 250 }, () => 1000000),
// };

// console.log('═'.repeat(80));
// console.log('🧪 SCANNER TEST - Validating Signal Detection');
// console.log('═'.repeat(80));

// // Test 1: Calculate indicators
// console.log('\n📊 Test 1: Calculate Indicators');
// console.log('─'.repeat(80));

// try {
//   const ema8 = EMA.calculate({ period: 8, values: sampleCandles.closes });
//   const ema21 = EMA.calculate({ period: 21, values: sampleCandles.closes });
//   const ema50 = EMA.calculate({ period: 50, values: sampleCandles.closes });
//   const ema200 = EMA.calculate({ period: 200, values: sampleCandles.closes });
//   const rsi = RSI.calculate({ period: 14, values: sampleCandles.closes });

//   const currentPrice = sampleCandles.closes[sampleCandles.closes.length - 1] as number;
//   const lastEMA8 = ema8[ema8.length - 1]  as number;
//   const lastEMA21 = ema21[ema21.length - 1]  as number;
//   const lastEMA50 = ema50[ema50.length - 1]  as number;
//   const lastEMA200 = ema200[ema200.length - 1]  as number;
//   const lastRSI = rsi[rsi.length - 1]  as number;

//   console.log('✅ Indicators calculated successfully');
//   console.log(`   Current Price: $${currentPrice?.toFixed(2)}`);
//   console.log(`   EMA8: $${lastEMA8?.toFixed(2)}`);
//   console.log(`   EMA21: $${lastEMA21?.toFixed(2)}`);
//   console.log(`   EMA50: $${lastEMA50?.toFixed(2)}`);
//   console.log(`   EMA200: $${lastEMA200?.toFixed(2)}`);
//   console.log(`   RSI: ${lastRSI?.toFixed(1)}`);

//   // Test 2: Check breakout conditions
//   console.log('\n📈 Test 2: Check Breakout Conditions');
//   console.log('─'.repeat(80));

//   const isBreakout = 
//     currentPrice > lastEMA21 &&
//     lastEMA8 > lastEMA21 &&
//     lastRSI > 45 && lastRSI < 75;

//   console.log(`   Price > EMA21: ${currentPrice > lastEMA21 ? '✅' : '❌'} (${currentPrice.toFixed(2)} vs ${lastEMA21.toFixed(2)})`);
//   console.log(`   EMA8 > EMA21: ${lastEMA8 > lastEMA21 ? '✅' : '❌'} (${lastEMA8.toFixed(2)} vs ${lastEMA21.toFixed(2)})`);
//   console.log(`   RSI 45-75: ${lastRSI > 45 && lastRSI < 75 ? '✅' : '❌'} (${lastRSI.toFixed(1)})`);
//   console.log(`   Breakout detected: ${isBreakout ? '✅ YES' : '❌ NO'}`);

//   // Test 3: Check RSI extremes
//   console.log('\n🔥 Test 3: Check RSI Signals');
//   console.log('─'.repeat(80));

//   console.log(`   RSI Value: ${lastRSI.toFixed(1)}`);
//   console.log(`   Oversold (<35): ${lastRSI < 35 ? '✅ YES - LONG signal' : '❌ NO'}`);
//   console.log(`   Overbought (>65): ${lastRSI > 65 ? '✅ YES - SHORT signal' : '❌ NO'}`);
//   console.log(`   Neutral (35-65): ${lastRSI >= 35 && lastRSI <= 65 ? '✅ YES - No extreme' : '❌ NO'}`);

//   // Test 4: EMA alignment
//   console.log('\n📊 Test 4: EMA Alignment');
//   console.log('─'.repeat(80));

//   const bullishAlignment = lastEMA8 > lastEMA21 && lastEMA21 > lastEMA50;
//   const bearishAlignment = lastEMA8 < lastEMA21 && lastEMA21 < lastEMA50;

//   console.log(`   Bullish (EMA8>21>50): ${bullishAlignment ? '✅ YES' : '❌ NO'}`);
//   console.log(`   Bearish (EMA8<21<50): ${bearishAlignment ? '✅ YES' : '❌ NO'}`);
//   console.log(`   Ranging: ${!bullishAlignment && !bearishAlignment ? '✅ YES' : '❌ NO'}`);

//   // Summary
//   console.log('\n' + '═'.repeat(80));
//   console.log('📋 SUMMARY');
//   console.log('═'.repeat(80));

//   let signalCount = 0;
//   if (isBreakout) {
//     console.log('✅ BREAKOUT signal available');
//     signalCount++;
//   }
//   if (lastRSI < 35) {
//     console.log('✅ RSI_OVERSOLD signal available');
//     signalCount++;
//   }
//   if (lastRSI > 65) {
//     console.log('✅ RSI_OVERBOUGHT signal available');
//     signalCount++;
//   }
//   if (currentPrice < lastEMA21 && lastEMA8 < lastEMA21) {
//     console.log('✅ BREAKDOWN signal available');
//     signalCount++;
//   }

//   console.log(`\nTotal signals detected: ${signalCount}`);

//   if (signalCount === 0) {
//     console.log('\n⚠️  NO SIGNALS DETECTED');
//     console.log('This is normal if:');
//     console.log('  - Market is ranging (no clear trend)');
//     console.log('  - RSI is neutral (35-65)');
//     console.log('  - Price is between EMAs');
//     console.log('\n💡 To force signals for testing:');
//     console.log('  - Lower minConfidence to 40');
//     console.log('  - Widen RSI ranges (30-70 instead of 35-65)');
//     console.log('  - Relax EMA conditions');
//   }

// } catch (err: any) {
//   console.error('❌ Error:', err.message);
//   console.error(err.stack);
// }

// console.log('\n' + '═'.repeat(80));
// console.log('🔍 NEXT STEPS:');
// console.log('═'.repeat(80));
// console.log('1. Check actual market conditions');
// console.log('2. Run scanner with: npm run scanner');
// console.log('3. Look for console logs showing signal detection');
// console.log('4. If no signals, market might be in neutral zone');
// console.log('5. Consider lowering thresholds temporarily for testing');
// console.log('═'.repeat(80));