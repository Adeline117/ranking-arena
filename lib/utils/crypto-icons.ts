/**
 * Crypto icon utilities
 * Maps coin symbols to their SVG icon paths from cryptocurrency-icons package.
 * Icons are served from /icons/crypto/{symbol}.svg (lowercase).
 * Falls back to generic.svg for unknown symbols.
 */

import { LOCAL_CRYPTO_ICONS } from './crypto-icon-manifest'

const ICON_BASE_PATH = '/icons/crypto'

/**
 * Normalize a trading symbol to the base coin symbol.
 * e.g. "BTCUSDT" → "btc", "ETH-USD" → "eth", "BTC/USDT" → "btc"
 * Handles Hyperliquid exotic markets: "xyz:tsla" → "tsla", "xyz:cl" → "cl"
 */
export function normalizeCoinSymbol(symbol: string): string {
  // Strip Hyperliquid xyz: prefix for exotic/RWA perp markets
  const base = symbol.replace(/^xyz:/i, '')
  const stripped = base.replace(/[-/]?(USDT|BUSD|USD|USDC|PERP|SWAP)$/i, '').replace(/[-/].*$/, '')
  // If the symbol IS a quote currency (e.g. "USDT", "USDC"), stripping the
  // suffix leaves an empty string — keep the original symbol in that case.
  return (stripped || base.replace(/[-/].*$/, '')).toLowerCase().trim()
}

/**
 * Extract a display label (1-2 chars) for use in text fallback icons.
 * Strips the xyz: prefix before extracting initials.
 */
export function getSymbolLabel(symbol: string): string {
  const raw = symbol.replace(/^xyz:/i, '')
  const base = raw.replace(/[-/]?(USDT|BUSD|USD|USDC|PERP|SWAP)$/i, '') || raw
  return base.slice(0, 2).toUpperCase()
}

/**
 * Whether a local SVG exists for this (already-normalized or raw) symbol.
 * Checking before rendering an <img> avoids guaranteed-404 requests for
 * tokens we have no icon file for — browsers always log those to console.
 */
export function hasLocalCryptoIcon(symbol: string): boolean {
  return LOCAL_CRYPTO_ICONS.has(normalizeCoinSymbol(symbol))
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
