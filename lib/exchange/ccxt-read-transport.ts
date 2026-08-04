/**
 * Guarded worker transport metadata for read-only CCXT account fetches.
 *
 * This module contains no credential decryption and no portfolio sync entry
 * point. The only runtime consumer is the first-party worker, which must prove
 * an exact reviewed V2 API-key identity mapping before decrypting credentials.
 */

/** Canonical account exchange id -> CCXT module id. */
export const CCXT_ID: Record<string, string> = {
  bybit: 'bybit',
  mexc: 'mexc',
  gateio: 'gate',
  bitmart: 'bitmart',
  phemex: 'phemex',
  hyperliquid: 'hyperliquid',
  binance: 'binance',
  okx: 'okx',
  bitget: 'bitget',
  kucoin: 'kucoinfutures',
  htx: 'htx',
  coinex: 'coinex',
  dydx: 'dydx',
  blofin: 'blofin',
}

/** Exchanges unreachable from the serverless region without the guarded proxy. */
export const GEO_BLOCKED = new Set(['binance', 'okx'])

/** Exchanges whose CCXT client also requires a passphrase. */
export const PASSPHRASE_REQUIRED = new Set(['bitget', 'kucoin', 'coinex', 'okx', 'blofin'])

/**
 * Build the guarded SG proxy adapter used by the first-party worker. The CCXT
 * client signs locally; the proxy receives the resulting request only after
 * the worker's reviewed-identity guard has passed.
 */
export function makeProxyFetch():
  | ((url: string | URL, init?: RequestInit) => Promise<Response>)
  | null {
  const proxyUrl = process.env.PORTFOLIO_SYNC_PROXY_URL || process.env.VPS_PROXY_SG
  const proxyKey = process.env.PORTFOLIO_SYNC_PROXY_KEY || process.env.VPS_PROXY_KEY
  if (!proxyUrl || !proxyKey) return null

  return async (url, init) => {
    const headers: Record<string, string> = {}
    const inputHeaders = init?.headers
    if (inputHeaders instanceof Headers) {
      inputHeaders.forEach((value, key) => (headers[key] = value))
    } else if (Array.isArray(inputHeaders)) {
      inputHeaders.forEach(([key, value]) => (headers[key] = value))
    } else if (inputHeaders) {
      Object.assign(headers, inputHeaders)
    }

    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Key': proxyKey },
      body: JSON.stringify({
        url: String(url),
        method: init?.method || 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      }),
    })
    const text = await response.text()
    return new Response(text, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/json',
      },
    })
  }
}
