// ---------- ANSI COLOR CODES ----------
export const colors = {
  // Reset
  reset: '\x1b[0m',

  // Text Styles
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',

  // Basic Colors (30-37)
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright Colors (90-97)
  brightBlack: '\x1b[90m',
  gray: '\x1b[90m', // Alias
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // 256-Color Extended Colors
  orange: '\x1b[38;5;214m',
  brightOrange: '\x1b[1m\x1b[38;5;214m',
  pink: '\x1b[38;5;213m',
  brightPink: '\x1b[1m\x1b[38;5;213m',
  purple: '\x1b[38;5;141m',
  brightPurple: '\x1b[1m\x1b[38;5;141m',
  indigo: '\x1b[38;5;63m',
  brightIndigo: '\x1b[1m\x1b[38;5;63m',
  teal: '\x1b[38;5;51m',
  brightTeal: '\x1b[1m\x1b[38;5;51m',
  lime: '\x1b[38;5;154m',
  brightLime: '\x1b[1m\x1b[38;5;154m',
  gold: '\x1b[38;5;220m',
  brightGold: '\x1b[1m\x1b[38;5;220m',
  bronze: '\x1b[38;5;172m',
  brightBronze: '\x1b[1m\x1b[38;5;172m',
  silver: '\x1b[38;5;250m',
  brightSilver: '\x1b[1m\x1b[38;5;250m',
  coral: '\x1b[38;5;209m',
  brightCoral: '\x1b[1m\x1b[38;5;209m',
  salmon: '\x1b[38;5;210m',
  brightSalmon: '\x1b[1m\x1b[38;5;210m',
  peach: '\x1b[38;5;217m',
  brightPeach: '\x1b[1m\x1b[38;5;217m',
  lavender: '\x1b[38;5;183m',
  brightLavender: '\x1b[1m\x1b[38;5;183m',
  mint: '\x1b[38;5;121m',
  brightMint: '\x1b[1m\x1b[38;5;121m',
  skyBlue: '\x1b[38;5;117m',
  brightSkyBlue: '\x1b[1m\x1b[38;5;117m',
  navy: '\x1b[38;5;17m',
  brightNavy: '\x1b[1m\x1b[38;5;17m',
  maroon: '\x1b[38;5;88m',
  brightMaroon: '\x1b[1m\x1b[38;5;88m',
  olive: '\x1b[38;5;100m',
  brightOlive: '\x1b[1m\x1b[38;5;100m',
  lightYellow: '\x1b[38;5;229m',
  brightLightYellow: '\x1b[1m\x1b[38;5;229m',
  lightBlue: '\x1b[38;5;153m',
  brightLightBlue: '\x1b[1m\x1b[38;5;153m',

  // Green spectrum
  darkGreen: '\x1b[38;5;22m', // Very dark green
  forestGreen: '\x1b[38;5;28m', // Dark forest green
  oliveGreen: '\x1b[38;5;64m', // Olive green
  mediumGreen: '\x1b[38;5;70m', // Medium green
  // brightGreen: '\x1b[38;5;46m',    // Bright green (lime)
  lightGreen: '\x1b[38;5;118m', // Light green

  // Grayscale (232-255)
  darkGray: '\x1b[38;5;238m',
  mediumGray: '\x1b[38;5;244m',
  lightGray: '\x1b[38;5;250m',

  // Background Colors (40-47)
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',

  // Bright Background Colors (100-107)
  bgBrightBlack: '\x1b[100m',
  bgGray: '\x1b[100m', // Alias
  bgBrightRed: '\x1b[101m',
  bgBrightGreen: '\x1b[102m',
  bgBrightYellow: '\x1b[103m',
  bgBrightBlue: '\x1b[104m',
  bgBrightMagenta: '\x1b[105m',
  bgBrightCyan: '\x1b[106m',
  bgBrightWhite: '\x1b[107m',

  // 256-Color Backgrounds
  bgOrange: '\x1b[48;5;214m',
  bgPink: '\x1b[48;5;213m',
  bgPurple: '\x1b[48;5;141m',
  bgIndigo: '\x1b[48;5;63m',
  bgTeal: '\x1b[48;5;51m',
  bgLime: '\x1b[48;5;154m',
  bgGold: '\x1b[48;5;220m',
  bgBronze: '\x1b[48;5;172m',
  bgSilver: '\x1b[48;5;250m',
  bgCoral: '\x1b[48;5;209m',
  bgSalmon: '\x1b[48;5;210m',
  bgPeach: '\x1b[48;5;217m',
  bgLavender: '\x1b[48;5;183m',
  bgMint: '\x1b[48;5;121m',
  bgSkyBlue: '\x1b[48;5;117m',
  bgNavy: '\x1b[48;5;17m',
  bgMaroon: '\x1b[48;5;88m',
  bgOlive: '\x1b[48;5;100m',
  bgDarkGray: '\x1b[48;5;238m',
  bgMediumGray: '\x1b[48;5;244m',
  bgLightGray: '\x1b[48;5;250m',
} as const;

export type ColorName = keyof typeof colors;
