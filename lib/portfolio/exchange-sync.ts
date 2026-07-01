/**
 * Portfolio exchange sync — decrypt a user's stored API keys, fetch their live
 * perp positions + equity from the exchange via CCXT, and return normalized rows
 * for `user_positions` + a portfolio snapshot.
 *
 * SECURITY:
 * - Decrypted keys live only in this function's scope; they are never logged,
 *   returned, or persisted. Exchange error bodies (which can echo signed request
 *   params) are NEVER surfaced — failures collapse to a coarse `reason` string.
 * - Only read endpoints are called (fetchPositions / fetchBalance). Users must
 *   create read-only API keys; we never place/cancel orders.
 *
 * INFRA LIMITS (see docs / CLAUDE.md):
 * - GEO_BLOCKED exchanges (Binance/OKX) are unreachable from Vercel hnd1 and are
 *   refused here rather than attempted (would 451). Needs a VPS/CF proxy — TODO.
 * - PASSPHRASE_REQUIRED exchanges need an API passphrase that the connect flow
 *   does not yet collect/store — refused with a clear reason until that lands.
 * - SYNC_SUPPORTED is a curated allowlist of exchanges validated as reachable +
 *   passphrase-free + CCXT-position-capable. Expanded as each is verified.
 */

import { decryptApiKey } from '@/lib/exchange/secure-encryption'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('portfolio-sync')

/** Our stored exchange id → CCXT module id. */
const CCXT_ID: Record<string, string> = {
  bybit: 'bybit',
  mexc: 'mexc',
  gateio: 'gate',
  bitmart: 'bitmart',
  phemex: 'phemex',
  hyperliquid: 'hyperliquid',
  // present for messaging/classification (not in SYNC_SUPPORTED):
  binance: 'binance',
  okx: 'okx',
  bitget: 'bitget',
  kucoin: 'kucoinfutures',
  htx: 'htx',
  coinex: 'coinex',
  dydx: 'dydx',
  blofin: 'blofin',
}

/** CCXT fetchPositions validated. Passphrase exchanges (bitget/kucoin/coinex/okx)
 * additionally require a stored passphrase; geo exchanges (binance/okx) additionally
 * require the sync proxy to be configured (see below). */
const SYNC_SUPPORTED = new Set([
  'bybit',
  'mexc',
  'gateio',
  'bitmart',
  'phemex',
  'hyperliquid',
  'bitget',
  'kucoin',
  'coinex',
  'binance',
  'okx',
  'htx',
  'blofin',
])
// NOTE: dydx is intentionally NOT here — dYdX v4 authenticates via wallet
// signatures, not an API key/secret, so it doesn't fit this credential model.
// Unsupported exchanges fall back gracefully to reason:'unsupported' (or
// 'exchange_error' if CCXT can't complete) — no crash.
/** Blocked from the serverless region (451). Only syncable when the VPS sync
 * proxy is configured (PORTFOLIO_SYNC_PROXY_URL/_KEY); otherwise refused. */
const GEO_BLOCKED = new Set(['binance', 'okx'])
/** Require an API passphrase (passed to CCXT as `password`). */
const PASSPHRASE_REQUIRED = new Set(['bitget', 'kucoin', 'coinex', 'okx', 'blofin'])

/**
 * CCXT fetch adapter that tunnels every request through the SG VPS proxy
 * (scripts/vps-deploy/arena-proxy.mjs) so geo-blocked exchanges (binance/okx)
 * are reachable from Vercel. The VPS forwards our signed headers verbatim (the
 * API *secret* never leaves this function — CCXT signs locally), and the proxy
 * is X-Proxy-Key-authed. Opt-in: returns null when the proxy env is unset, so
 * geo-blocked exchanges cleanly fall back to `geo_unavailable` (no regression).
 */
function makeProxyFetch(): ((url: string | URL, init?: RequestInit) => Promise<Response>) | null {
  // Reuse the already-provisioned SG VPS proxy (VPS_PROXY_SG / VPS_PROXY_KEY, set
  // in prod for ingest) so binance/okx sync is active without extra config. The
  // PORTFOLIO_SYNC_PROXY_* vars override if you want an independent endpoint/key.
  const proxyUrl = process.env.PORTFOLIO_SYNC_PROXY_URL || process.env.VPS_PROXY_SG
  const proxyKey = process.env.PORTFOLIO_SYNC_PROXY_KEY || process.env.VPS_PROXY_KEY
  if (!proxyUrl || !proxyKey) return null
  return async (url, init) => {
    const headers: Record<string, string> = {}
    const h = init?.headers
    if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v))
    else if (Array.isArray(h)) h.forEach(([k, v]) => (headers[k] = v))
    else if (h) Object.assign(headers, h)
    const resp = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Key': proxyKey },
      body: JSON.stringify({
        url: String(url),
        method: init?.method || 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      }),
    })
    const text = await resp.text()
    return new Response(text, {
      status: resp.status,
      headers: { 'content-type': resp.headers.get('content-type') || 'application/json' },
    })
  }
}

export interface SyncedPositionRow {
  portfolio_id: string
  symbol: string
  side: 'long' | 'short'
  entry_price: number
  mark_price: number
  size: number
  pnl: number
  pnl_pct: number
  leverage: number
  updated_at: string
}

export type SyncReason =
  | 'geo_unavailable'
  | 'passphrase_required'
  | 'unsupported'
  | 'keys_unreadable'
  | 'exchange_error'

export type SyncOutcome =
  | {
      ok: true
      positions: SyncedPositionRow[]
      equity: number
      pnl: number
      pnlPct: number
      /** Single timestamp stamped on every synced row; used for stale-row pruning. */
      syncedAt: string
    }
  | { ok: false; reason: SyncReason }

// Minimal structural types for the CCXT surface we use (avoids `any`).
interface CcxtPosition {
  symbol?: string
  side?: string
  contracts?: number
  contractSize?: number
  entryPrice?: number
  markPrice?: number
  unrealizedPnl?: number
  percentage?: number
  leverage?: number
}
interface CcxtClient {
  has: Record<string, boolean | string>
  fetchPositions(symbols?: string[]): Promise<CcxtPosition[]>
  fetchBalance(): Promise<{ total?: Record<string, number> }>
}
type CcxtRegistry = Record<string, new (cfg: Record<string, unknown>) => CcxtClient>

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function syncExchangePortfolio(params: {
  portfolioId: string
  exchange: string
  apiKeyEncrypted: string
  apiSecretEncrypted: string
  apiPassphraseEncrypted?: string | null
  userId: string
}): Promise<SyncOutcome> {
  const ex = params.exchange.toLowerCase()

  // Geo-blocked exchanges are only syncable through the VPS proxy; if it's not
  // configured, refuse (unchanged "coming soon" behavior — no regression).
  const proxyFetch = GEO_BLOCKED.has(ex) ? makeProxyFetch() : null
  if (GEO_BLOCKED.has(ex) && !proxyFetch) return { ok: false, reason: 'geo_unavailable' }
  if (!SYNC_SUPPORTED.has(ex)) return { ok: false, reason: 'unsupported' }
  const needsPassphrase = PASSPHRASE_REQUIRED.has(ex)
  if (needsPassphrase && !params.apiPassphraseEncrypted) {
    return { ok: false, reason: 'passphrase_required' }
  }

  const ccxtId = CCXT_ID[ex]
  if (!ccxtId) return { ok: false, reason: 'unsupported' }

  // Decrypt in-scope only. Never log the plaintext.
  let apiKey: string
  let apiSecret: string
  let passphrase: string | undefined
  try {
    apiKey = decryptApiKey(params.apiKeyEncrypted, params.userId)
    apiSecret = decryptApiKey(params.apiSecretEncrypted, params.userId)
    if (params.apiPassphraseEncrypted) {
      passphrase = decryptApiKey(params.apiPassphraseEncrypted, params.userId)
    }
  } catch (err) {
    // Log the failure CLASS (never the plaintext — a decrypt exception can't
    // contain it) so a global key-rotation/config fault is distinguishable from
    // one user's corrupt blob, instead of silently telling every user "reconnect".
    logger.error(`[${ex}] key decrypt failed:`, err instanceof Error ? err.name : 'unknown')
    return { ok: false, reason: 'keys_unreadable' }
  }
  if (!apiKey || !apiSecret) return { ok: false, reason: 'keys_unreadable' }
  if (needsPassphrase && !passphrase) return { ok: false, reason: 'keys_unreadable' }

  const mod = await import('ccxt')
  const registry = ((mod as { default?: unknown }).default ?? mod) as unknown as CcxtRegistry
  const ExClass = registry[ccxtId]
  if (!ExClass) return { ok: false, reason: 'unsupported' }

  try {
    const client = new ExClass({
      apiKey,
      secret: apiSecret,
      ...(passphrase ? { password: passphrase } : {}),
      ...(proxyFetch ? { fetchImplementation: proxyFetch } : {}),
      enableRateLimit: true,
      timeout: 8000, // fail fast — sequential calls must stay well under maxDuration
      options: { defaultType: 'swap' },
    })

    const syncedAt = new Date().toISOString()
    let rows: SyncedPositionRow[] = []
    if (client.has?.['fetchPositions']) {
      const positions = await client.fetchPositions()
      rows = positions
        .filter((p) => num(p.contracts ?? p.contractSize) > 0)
        .map(
          (p): SyncedPositionRow => ({
            portfolio_id: params.portfolioId,
            symbol: String(p.symbol ?? ''),
            side: p.side === 'short' ? 'short' : 'long',
            entry_price: num(p.entryPrice),
            mark_price: num(p.markPrice),
            size: num(p.contracts ?? p.contractSize),
            pnl: num(p.unrealizedPnl),
            pnl_pct: num(p.percentage),
            leverage: num(p.leverage) || 1,
            updated_at: syncedAt,
          })
        )
        .filter((r) => r.symbol)
    }

    let equity = 0
    try {
      const bal = await client.fetchBalance()
      equity = num(bal?.total?.USDT ?? bal?.total?.USD)
    } catch (err) {
      // Best-effort (positions still valid) but LOG it — otherwise a broken
      // fetchBalance silently persists equity=0 and flatlines the equity curve
      // at a fake zero forever with no signal.
      logger.warn(
        `[${ex}] balance fetch failed (equity=0):`,
        err instanceof Error ? err.name : 'unknown'
      )
    }

    const pnl = rows.reduce((s, r) => s + r.pnl, 0)
    const pnlPct = equity > 0 ? (pnl / equity) * 100 : 0
    return { ok: true, positions: rows, equity, pnl, pnlPct, syncedAt }
  } catch (err) {
    // Never surface the exchange error BODY (may echo signed params/secrets),
    // but LOG the error class + exchange so integration breakage (CCXT change,
    // auth regression, proxy outage) is discoverable instead of invisible.
    logger.error(`[${ex}] sync fetch failed:`, err instanceof Error ? err.name : 'unknown')
    return { ok: false, reason: 'exchange_error' }
  }
}
