/**
 * Crypto icon utilities
 * Maps coin symbols to their SVG icon paths from cryptocurrency-icons package.
 * Icons are served from /icons/crypto/{symbol}.svg (lowercase).
 * Falls back to generic.svg for unknown symbols.
 */

const ICON_BASE_PATH = '/icons/crypto'

/**
 * Normalize a trading symbol to the base coin symbol.
 * e.g. "BTCUSDT" → "btc", "ETH-USD" → "eth", "BTC/USDT" → "btc"
 */
export function normalizeCoinSymbol(symbol: string): string {
  return symbol
    .replace(/[-/]?(USDT|BUSD|USD|USDC|PERP|SWAP)$/i, '')
    .replace(/[-/].*$/, '')
    .toLowerCase()
    .trim()
}

/**
 * Get the icon path for a coin symbol.
 */
export function getCryptoIconPath(symbol: string): string {
  const normalized = normalizeCoinSymbol(symbol)
  return `${ICON_BASE_PATH}/${normalized}.svg`
}

/**
 * Get the generic/fallback icon path.
 */
export function getGenericIconPath(): string {
  return `${ICON_BASE_PATH}/generic.svg`
}
