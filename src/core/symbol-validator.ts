/**
 * 🚨 EMERGENCY FIX: Symbol Validator
 * Prevents catastrophic losses from 1000X tokens and malformed positions
 */

export interface SymbolMetadata {
  symbol: string;
  multiplier: number; // 1 for normal tokens, 1000 for 1000X tokens
  minNotional: number; // Minimum position size in USDT
  isSupported: boolean; // Whether we support this token
  quantityPrecision: number; // Decimal places for quantity
  pricePrecision: number; // Decimal places for price
}

export class SymbolValidator {
  // 🚫 BLACKLIST: Tokens that cause position sizing issues
  private static EXCLUDED_PREFIXES = ['1000'];
  private static EXCLUDED_SYMBOLS = [
    '1000SHIBUSDT',
    '1000XECUSDT',
    '1000LUNCUSDT',
    '1000PEPEUSDT',
    '1000FLOKIUSDT',
    '1000BONKUSDT',
    '1000SATSUSDT',
    '1000RATSUSDT',
    '1000PEPEUSDC',
    '1000SHIBUSDC',
    '1000CATUSDT',
    '1000CHEEMSUSDT',
  ];

  // Binance minimum notional value
  private static MIN_NOTIONAL_USD = 5;

  // Maximum allowed notional (safety limit)
  private static MAX_NOTIONAL_USD = 10000;

  /**
   * Check if a symbol is safe to trade
   */
  static isSymbolAllowed(symbol: string): boolean {
    // Check exact blacklist
    if (this.EXCLUDED_SYMBOLS.includes(symbol)) {
      console.log(`⚠️ BLOCKED: ${symbol} is in exclusion list`);
      return false;
    }

    // Check prefix blacklist
    for (const prefix of this.EXCLUDED_PREFIXES) {
      if (symbol.startsWith(prefix)) {
        console.log(`⚠️ BLOCKED: ${symbol} has excluded prefix '${prefix}'`);
        return false;
      }
    }

    // Must end with USDT (we only support USDT pairs)
    if (!symbol.endsWith('USDT')) {
      console.log(`⚠️ BLOCKED: ${symbol} is not a USDT pair`);
      return false;
    }

    return true;
  }

  /**
   * Get symbol metadata for position sizing
   */
  static getSymbolMetadata(
    symbol: string,
    currentPrice: number
  ): SymbolMetadata {
    const isSupported = this.isSymbolAllowed(symbol);
    const multiplier = symbol.startsWith('1000') ? 1000 : 1;

    // Determine precision based on price
    let pricePrecision: number;
    let quantityPrecision: number;

    if (currentPrice >= 1000) {
      // High-value assets (BTC, ETH, BNB, etc.)
      pricePrecision = 2;
      quantityPrecision = 6;
    } else if (currentPrice >= 1) {
      // Mid-value assets
      pricePrecision = 4;
      quantityPrecision = 4;
    } else if (currentPrice >= 0.001) {
      // Low-value assets
      pricePrecision = 6;
      quantityPrecision = 2;
    } else {
      // Very low-value assets (meme coins)
      pricePrecision = 8;
      quantityPrecision = 0;
    }

    return {
      symbol,
      multiplier,
      minNotional: this.MIN_NOTIONAL_USD,
      isSupported,
      quantityPrecision,
      pricePrecision,
    };
  }

  /**
   * Validate a position before entry
   * Returns { valid: boolean, reason?: string, notional: number }
   */
  static validatePosition(
    symbol: string,
    price: number,
    positionSizeUSD: number,
    leverage: number
  ): {
    valid: boolean;
    reason?: string;
    notionalValue: number;
    tokenQuantity: number;
    marginRequired: number;
  } {
    console.log(`\n🔍 Validating Position for ${symbol}:`);
    console.log(`   Price: $${price}`);
    console.log(`   Position Size: $${positionSizeUSD}`);
    console.log(`   Leverage: ${leverage}x`);

    // Check if symbol is allowed
    if (!this.isSymbolAllowed(symbol)) {
      return {
        valid: false,
        reason: `Symbol ${symbol} is not supported`,
        notionalValue: 0,
        tokenQuantity: 0,
        marginRequired: 0,
      };
    }

    // Get metadata
    const metadata = this.getSymbolMetadata(symbol, price);

    // Calculate position details
    const notionalValue = positionSizeUSD;
    const tokenQuantity = notionalValue / price;
    const marginRequired = positionSizeUSD;

    console.log(`   Calculated:`);
    console.log(`     - Notional: $${notionalValue.toFixed(2)}`);
    console.log(
      `     - Quantity: ${tokenQuantity.toFixed(metadata.quantityPrecision)}`
    );
    console.log(`     - Margin: $${marginRequired.toFixed(2)}`);

    // Validate price is reasonable
    if (price <= 0) {
      return {
        valid: false,
        reason: `Invalid price: $${price}`,
        notionalValue,
        tokenQuantity,
        marginRequired,
      };
    }

    // Validate notional value is within bounds
    if (notionalValue < this.MIN_NOTIONAL_USD) {
      return {
        valid: false,
        reason: `Notional value $${notionalValue.toFixed(2)} < minimum $${this.MIN_NOTIONAL_USD}`,
        notionalValue,
        tokenQuantity,
        marginRequired,
      };
    }

    if (notionalValue > this.MAX_NOTIONAL_USD) {
      return {
        valid: false,
        reason: `Notional value $${notionalValue.toFixed(2)} > maximum $${this.MAX_NOTIONAL_USD} (safety limit)`,
        notionalValue,
        tokenQuantity,
        marginRequired,
      };
    }

    // Validate token quantity is reasonable
    if (tokenQuantity <= 0) {
      return {
        valid: false,
        reason: `Invalid token quantity: ${tokenQuantity}`,
        notionalValue,
        tokenQuantity,
        marginRequired,
      };
    }

    // Verify back-calculation matches
    const verifyNotional = tokenQuantity * price;
    const notionalDiff = Math.abs(verifyNotional - notionalValue);
    const notionalDiffPct = (notionalDiff / notionalValue) * 100;

    if (notionalDiffPct > 1) {
      // More than 1% difference = something is wrong
      return {
        valid: false,
        reason: `Notional mismatch: expected $${notionalValue.toFixed(2)}, got $${verifyNotional.toFixed(2)} (${notionalDiffPct.toFixed(2)}% diff)`,
        notionalValue,
        tokenQuantity,
        marginRequired,
      };
    }

    console.log(
      `   ✅ Verification: ${tokenQuantity.toFixed(6)} × $${price.toFixed(6)} = $${verifyNotional.toFixed(2)}`
    );
    console.log(`   ✅ Position Valid!`);

    return {
      valid: true,
      notionalValue,
      tokenQuantity,
      marginRequired,
    };
  }

  /**
   * Round quantity to appropriate precision
   */
  static roundQuantity(
    symbol: string,
    quantity: number,
    price: number
  ): number {
    const metadata = this.getSymbolMetadata(symbol, price);
    return Number(quantity.toFixed(metadata.quantityPrecision));
  }

  /**
   * Round price to appropriate precision
   */
  static roundPrice(symbol: string, price: number): number {
    const metadata = this.getSymbolMetadata(symbol, price);
    return Number(price.toFixed(metadata.pricePrecision));
  }
}
