import fs from 'fs';
import path from 'path';

import { colors } from './colors.js';
import type { BotType } from './type.js';

// export type BotType = 'SPOT' | 'FUTURES';
type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'trade';

interface LoggerConfig {
  botType: BotType;
  symbol?: string;
  consoleOutput: boolean;
  fileOutput: boolean;
  logDir: string;
}

class BotLogger {
  private botType: BotType;
  private symbol: string;
  private consoleOutput: boolean;
  private fileOutput: boolean;
  private logDir: string;
  private logFile: string;
  private tradeFile: string;

  // Color codes
  private colors = colors;
  constructor(config: LoggerConfig) {
    this.botType = config.botType;
    this.symbol = config.symbol || 'MULTI';
    this.consoleOutput = config.consoleOutput;
    this.fileOutput = config.fileOutput;
    this.logDir = config.logDir;

    // Create separate log files for SPOT vs FUTURES
    const date = new Date().toISOString().split('T')[0];
    this.logFile = path.join(
      this.logDir,
      `${this.botType.toLowerCase()}-${date}.log`
    );
    this.tradeFile = path.join(
      this.logDir,
      `${this.botType.toLowerCase()}-trades-${date}.json`
    );

    this.ensureLogDirectory();
    this.initLogFiles();
  }

  private ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private initLogFiles() {
    // Create log file with header if it doesn't exist
    if (!fs.existsSync(this.logFile)) {
      const header = `
========================================
${this.botType} TRADING BOT LOG
Started: ${new Date().toISOString()}
========================================

`;
      fs.writeFileSync(this.logFile, header);
    }

    // Create trade file if it doesn't exist
    if (!fs.existsSync(this.tradeFile)) {
      fs.writeFileSync(this.tradeFile, '');
    }
  }

  /**
   * Main logging method
   */
  log(message: string, level: LogLevel = 'info', symbol?: string) {
    const timestamp = new Date().toISOString();
    const sym = symbol || this.symbol;

    // Determine icon and color
    let icon = 'ℹ️';
    let color = this.colors.cyan;

    switch (level) {
      case 'success':
        icon = '✅';
        color = this.colors.brightGreen as any;
        break;
      case 'warning':
        icon = '⚠️';
        color = this.colors.brightYellow as any;
        break;
      case 'error':
        icon = '❌';
        color = this.colors.brightRed as any;
        break;
      case 'trade':
        icon = '💰';
        color = this.colors.brightMagenta as any;
        break;
    }

    // Format message with bot type prefix
    const botPrefix = this.getBotPrefix();
    const symbolPrefix = sym !== 'MULTI' ? `[${sym}]` : '';
    const consoleMsg = `${color}${icon} ${botPrefix}${symbolPrefix} ${message}${this.colors.reset}`;
    const fileMsg = `[${timestamp}] [${this.botType}] ${symbolPrefix} ${icon} ${message}`;

    // Console output
    if (this.consoleOutput) {
      console.log(consoleMsg);
    }

    // File output
    if (this.fileOutput) {
      fs.appendFileSync(this.logFile, fileMsg + '\n');
    }
  }

  /**
   * Get colored bot prefix
   */
  private getBotPrefix(): string {
    if (this.botType === 'SPOT') {
      return `${this.colors.bgBlue}${this.colors.white} SPOT ${this.colors.reset} `;
    } else {
      return `${this.colors.bgYellow}${this.colors.black} FUTURES ${this.colors.reset} `;
    }
  }

  /**
   * Log trade execution
   */
  logTrade(trade: {
    action: 'BUY' | 'SELL' | 'LONG' | 'SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT';
    symbol: string;
    price: number;
    amount: number;
    pnl?: number;
    strategy?: string;
    reason?: string;
  }) {
    const timestamp = new Date().toISOString();

    const tradeEntry = {
      timestamp,
      botType: this.botType,
      action: trade.action,
      symbol: trade.symbol,
      price: trade.price,
      amount: trade.amount,
      pnl: trade.pnl || 0,
      strategy: trade.strategy || 'UNKNOWN',
      reason: trade.reason || '',
    };

    // Append to trade log file
    if (this.fileOutput) {
      fs.appendFileSync(this.tradeFile, JSON.stringify(tradeEntry) + '\n');
    }

    // Also log to console
    const pnlStr =
      trade.pnl !== undefined
        ? ` | PnL: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} USDT`
        : '';

    this.log(
      `${trade.action} ${trade.amount.toFixed(6)} @ $${trade.price.toFixed(6)}${pnlStr}`,
      'trade',
      trade.symbol
    );
  }

  /**
   * Log position update
   */
  logPosition(position: {
    symbol: string;
    side: string;
    entryPrice: number;
    currentPrice: number;
    pnlUsd: number;
    pnlPct: number;
  }) {
    const pnlColor =
      position.pnlUsd >= 0 ? this.colors.brightGreen : this.colors.brightRed;

    const msg =
      `${position.side} @ $${position.entryPrice.toFixed(6)} | ` +
      `Current: $${position.currentPrice.toFixed(6)} | ` +
      `${pnlColor}PnL: ${position.pnlUsd >= 0 ? '+' : ''}${position.pnlUsd.toFixed(2)} USDT ` +
      `(${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(2)}%)${this.colors.reset}`;

    this.log(msg, 'info', position.symbol);
  }

  /**
   * Rotate log files (keep last 7 days)
   */
  rotateLogs(maxAgeDays: number = 7): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

      files.forEach((file: string) => {
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          fs.unlinkSync(filePath);
          this.log(`Deleted old log file: ${file}`, 'info');
        }
      });
    } catch (err: any) {
      this.log(`Failed to rotate logs: ${err.message}`, 'error');
    }
  }
}

// ============================================================================
// LOGGER FACTORY
// ============================================================================

class LoggerFactory {
  private static spotLogger: BotLogger | null = null;
  private static futuresLogger: BotLogger | null = null;

  static getSpotLogger(symbol?: string): BotLogger {
    if (!this.spotLogger) {
      this.spotLogger = new BotLogger({
        botType: 'SPOT',
        symbol: symbol || 'SPOT',
        consoleOutput: true,
        fileOutput: true,
        logDir: './data/logs',
      });
    }
    return this.spotLogger;
  }

  static getFuturesLogger(symbol?: string): BotLogger {
    if (!this.futuresLogger) {
      this.futuresLogger = new BotLogger({
        botType: 'FUTURES',
        symbol: symbol || 'FUTURES',
        consoleOutput: true,
        fileOutput: true,
        logDir: './data/futures/logs',
      });
    }
    return this.futuresLogger;
  }

  static getLogger(botType: BotType, symbol?: string): BotLogger {
    return botType === 'SPOT'
      ? this.getSpotLogger(symbol)
      : this.getFuturesLogger(symbol);
  }
}

// ============================================================================
// USAGE EXAMPLES
// ============================================================================

// In bot-spot.ts:
const spotLogger = LoggerFactory.getSpotLogger('SOL/USDT');
spotLogger.log('Bot started', 'success');
spotLogger.log('Scanning for entry signals...', 'info');
spotLogger.logTrade({
  action: 'BUY',
  symbol: 'SOL/USDT',
  price: 100.5,
  amount: 0.5,
  strategy: 'EMA_PULLBACK',
});

// In launcher-future.ts:
const futuresLogger = LoggerFactory.getFuturesLogger('BTC/USDT');
futuresLogger.log('Bot started', 'success');
futuresLogger.log('Waiting for signals...', 'info');
futuresLogger.logTrade({
  action: 'LONG',
  symbol: 'BTC/USDT',
  price: 43250.5,
  amount: 0.001,
  strategy: 'SMC_LONG',
});

// Log position updates:
futuresLogger.logPosition({
  symbol: 'BTC/USDT',
  side: 'LONG',
  entryPrice: 43250.5,
  currentPrice: 43500.0,
  pnlUsd: 25.0,
  pnlPct: 2.5,
});

export { BotLogger, LoggerFactory, type BotType, type LogLevel };
