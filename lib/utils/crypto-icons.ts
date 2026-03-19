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
 * Handles Hyperliquid exotic markets: "xyz:tsla" → "tsla", "xyz:cl" → "cl"
 */
export function normalizeCoinSymbol(symbol: string): string {
  return symbol
    // Strip Hyperliquid xyz: prefix for exotic/RWA perp markets
    .replace(/^xyz:/i, '')
    .replace(/[-/]?(USDT|BUSD|USD|USDC|PERP|SWAP)$/i, '')
    .replace(/[-/].*$/, '')
    .toLowerCase()
    .trim()
}

/**
 * Extract a display label (1-2 chars) for use in text fallback icons.
 * Strips the xyz: prefix before extracting initials.
 */
export function getSymbolLabel(symbol: string): string {
  const base = symbol.replace(/^xyz:/i, '').replace(/[-/]?(USDT|BUSD|USD|USDC|PERP|SWAP)$/i, '')
  return base.slice(0, 2).toUpperCase()
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
