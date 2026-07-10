/**
 * Shared token-symbol normalization for the /rankings/tokens surfaces.
 *
 * Previously `extractBaseToken` was copy-pasted into three files
 * (rankings/tokens/page.tsx, tokens/[token]/page.tsx, api/rankings/by-token)
 * with only a `length > 10` guard, so junk symbols leaked onto the token
 * leaderboard (U1-5: `HL-107`, `XYZ:TSLA`, pure-numeric ids). Single source
 * of truth now, with an explicit validity gate.
 */

const QUOTE_SUFFIXES = ['USDT.P', 'USDT', 'BUSD', 'USDC', 'USD', '-PERP', '-USD'] as const

/** Normalize a raw exchange symbol to its base token (BTCUSDT → BTC, ETH/USD → ETH). */
export function extractBaseToken(symbol: string): string {
  let s = symbol.toUpperCase()
  // Split the pair FIRST, then strip the quote suffix — doing it the other way
  // turned BTC/USDT into "BTC/" (endsWith('USDT') matched before the slash).
  if (s.includes('/')) s = s.split('/')[0]
  for (const suffix of QUOTE_SUFFIXES) {
    if (s.endsWith(suffix)) return s.slice(0, -suffix.length)
  }
  // NOTE: colon-namespaced symbols (XYZ:TSLA — stock/forex CFDs from the CFD
  // sources) are deliberately NOT rescued; the retained ':' makes them fail
  // isValidTokenSymbol so they drop off the crypto token board (U1-5).
  return s
}

/**
 * A plausible crypto ticker: 1–10 uppercase alphanumerics with at least one
 * letter. Rejects the junk that used to top the board:
 *  - `HL-107` / `BTC-1` — contains a dash → fails the charset
 *  - `XYZ:TSLA` — colon (also split off by extractBaseToken) → fails charset
 *  - `107` / `1000` — pure numbers (internal ids) → no letter
 * Keeps real tickers incl. numbered ones like `1000PEPE`, `1INCH`.
 */
export function isValidTokenSymbol(base: string): boolean {
  return /^[A-Z0-9]{1,10}$/.test(base) && /[A-Z]/.test(base)
}
