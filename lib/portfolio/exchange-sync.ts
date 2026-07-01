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

/** Reachable from Vercel hnd1 + no passphrase + CCXT fetchPositions validated. */
const SYNC_SUPPORTED = new Set(['bybit', 'mexc', 'gateio', 'bitmart', 'phemex', 'hyperliquid'])
/** Blocked from the serverless region — need a VPS/CF proxy, do not attempt. */
const GEO_BLOCKED = new Set(['binance', 'okx'])
/** Require an API passphrase the connect flow does not yet store. */
const PASSPHRASE_REQUIRED = new Set(['bitget', 'okx', 'kucoin', 'coinex'])

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
  userId: string
}): Promise<SyncOutcome> {
  const ex = params.exchange.toLowerCase()

  if (GEO_BLOCKED.has(ex)) return { ok: false, reason: 'geo_unavailable' }
  if (PASSPHRASE_REQUIRED.has(ex)) return { ok: false, reason: 'passphrase_required' }
  if (!SYNC_SUPPORTED.has(ex)) return { ok: false, reason: 'unsupported' }

  const ccxtId = CCXT_ID[ex]
  if (!ccxtId) return { ok: false, reason: 'unsupported' }

  // Decrypt in-scope only. Never log the plaintext.
  let apiKey: string
  let apiSecret: string
  try {
    apiKey = decryptApiKey(params.apiKeyEncrypted, params.userId)
    apiSecret = decryptApiKey(params.apiSecretEncrypted, params.userId)
  } catch {
    return { ok: false, reason: 'keys_unreadable' }
  }
  if (!apiKey || !apiSecret) return { ok: false, reason: 'keys_unreadable' }

  const mod = await import('ccxt')
  const registry = ((mod as { default?: unknown }).default ?? mod) as unknown as CcxtRegistry
  const ExClass = registry[ccxtId]
  if (!ExClass) return { ok: false, reason: 'unsupported' }

  try {
    const client = new ExClass({
      apiKey,
      secret: apiSecret,
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
    } catch {
      // balance is best-effort; positions still valid
    }

    const pnl = rows.reduce((s, r) => s + r.pnl, 0)
    const pnlPct = equity > 0 ? (pnl / equity) * 100 : 0
    return { ok: true, positions: rows, equity, pnl, pnlPct, syncedAt }
  } catch {
    // Never surface the exchange error body (may echo signed params/secrets).
    return { ok: false, reason: 'exchange_error' }
  }
}
