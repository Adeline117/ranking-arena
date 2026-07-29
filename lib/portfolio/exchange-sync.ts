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
import { balanceEvidence, type FirstPartyBalanceSource } from '@/lib/ingest/first-party/fetch'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('portfolio-sync')

/** Our stored exchange id → CCXT module id. */
export const CCXT_ID: Record<string, string> = {
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
export const GEO_BLOCKED = new Set(['binance', 'okx'])
/** Require an API passphrase (passed to CCXT as `password`). */
export const PASSPHRASE_REQUIRED = new Set(['bitget', 'kucoin', 'coinex', 'okx', 'blofin'])

/**
 * CCXT fetch adapter that tunnels every request through the SG VPS proxy
 * (scripts/vps-deploy/arena-proxy.mjs) so geo-blocked exchanges (binance/okx)
 * are reachable from Vercel. The VPS forwards our signed headers verbatim (the
 * API *secret* never leaves this function — CCXT signs locally), and the proxy
 * is X-Proxy-Key-authed. Opt-in: returns null when the proxy env is unset, so
 * geo-blocked exchanges cleanly fall back to `geo_unavailable` (no regression).
 */
export function makeProxyFetch():
  | ((url: string | URL, init?: RequestInit) => Promise<Response>)
  | null {
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
  fetchBalance(): Promise<CcxtBalance>
}
type CcxtRegistry = Record<string, new (cfg: Record<string, unknown>) => CcxtClient>

interface CcxtBalance {
  total?: Record<string, number>
  info?: unknown
}

const PORTFOLIO_EQUITY_SOURCE: Readonly<Partial<Record<string, FirstPartyBalanceSource>>> = {
  binance: 'binance_margin_balance',
  bitget: 'bitget_usdt_equity',
  bybit: 'bybit_total_equity',
  okx: 'okx_total_equity',
}

/**
 * Resolve account equity from the exchange's explicit account-total field.
 * `balance.total.USDT` is only one currency bucket and can understate a unified
 * margin account that also holds USDC, other collateral, or cross-margin PnL.
 */
export function resolvePortfolioEquityEvidence(
  exchange: string,
  balance: CcxtBalance
): number | null {
  return balanceEvidence(balance, PORTFOLIO_EQUITY_SOURCE[exchange] ?? 'stable_totals')
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
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

    const positionsCapability = client.has?.['fetchPositions']
    if (positionsCapability !== true && positionsCapability !== 'emulated') {
      logger.error(`[${ex}] fetchPositions is not available`)
      return { ok: false, reason: 'unsupported' }
    }

    const syncedAt = new Date().toISOString()
    // A portfolio publication is one financial snapshot. Positions and equity
    // therefore have to come from the same successful fetch attempt; persisting
    // positions with a synthetic zero balance corrupts the historical chart.
    const [positions, balance] = await Promise.all([client.fetchPositions(), client.fetchBalance()])
    if (!Array.isArray(positions)) {
      throw new Error('Exchange returned an invalid positions snapshot')
    }

    const equity = resolvePortfolioEquityEvidence(ex, balance)
    if (equity === null || equity < 0) {
      throw new Error('Exchange returned an invalid equity snapshot')
    }

    const rows: SyncedPositionRow[] = []
    for (const position of positions) {
      const contracts = finiteNumber(position.contracts)
      if (contracts === 0) continue

      const symbol = typeof position.symbol === 'string' ? position.symbol.trim() : ''
      const entryPrice = finiteNumber(position.entryPrice)
      const markPrice = finiteNumber(position.markPrice)
      const pnl = finiteNumber(position.unrealizedPnl)
      const pnlPct = finiteNumber(position.percentage)
      const leverage = finiteNumber(position.leverage)
      if (
        contracts === null ||
        contracts < 0 ||
        !symbol ||
        (position.side !== 'long' && position.side !== 'short') ||
        entryPrice === null ||
        entryPrice <= 0 ||
        markPrice === null ||
        markPrice <= 0 ||
        pnl === null ||
        pnlPct === null ||
        leverage === null ||
        leverage <= 0
      ) {
        throw new Error('Exchange returned an incomplete active position')
      }

      rows.push({
        portfolio_id: params.portfolioId,
        symbol,
        side: position.side,
        entry_price: entryPrice,
        mark_price: markPrice,
        size: contracts,
        pnl,
        pnl_pct: pnlPct,
        leverage,
        updated_at: syncedAt,
      })
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
