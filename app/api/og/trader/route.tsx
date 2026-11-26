/**
 * OG Image for individual trader cards
 * GET /api/og/trader?handle=xxx
 *
 * Generates a 1200x630 social card with trader avatar, ROI, arena score,
 * rank, exchange badge, and brand styling.
 * Edge runtime compatible.
 */

import { formatScoreWhole } from '@/lib/utils/format'
import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { BASE_URL } from '@/lib/constants/urls'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import {
  publicRankingResponseRejectionHeaders,
  redirectToPublicRankingResponseCacheEpoch,
} from '@/lib/rankings/public-response-cache'

// 2026-07-11:改回 edge runtime。此前 runtime='nodejs'(为 getSupabaseAdmin)触发
// next/og@16 在 nodejs runtime 的 pipe-time "u2 is not iterable" bug —— 惰性渲染
// 在 handler return 之后抛,try/catch 和 302 兜底全够不着,~1412 个 trader 分享卡
// 全部 500(隔离验证:唯一 nodejs 的 OG 路由 500,edge 的 rank/homepage/compare 全
// 200)。edge 无 pg,故 DB 查询改为 Supabase REST fetch。
// (getSupabaseAdmin 本身基于 fetch，在 edge 可用；这里只用它调 arena_resolve_trader。)
export const runtime = 'edge'

const PUBLIC_RANKING_COLUMNS =
  'season_id,source,source_trader_id,handle,avatar_url,rank,arena_score,roi,pnl,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at,idle_window'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Escape PostgREST ILIKE wildcards so a source-less handle lookup is exact. */
function exactIlike(value: string): string {
  return encodeURIComponent(value.replace(/[\\*%_]/g, '\\$&'))
}

/**
 * Edge-safe Supabase REST GET → exactly one row or null. Multiple rows are
 * ambiguous identity evidence, so do not bind either one to an OG metric.
 */
async function restSelectOne(
  table: string,
  query: string
): Promise<Record<string, unknown> | null> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    if (!supabaseUrl || !supabaseKey) return null
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}&limit=2`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const rows = (await res.json()) as Record<string, unknown>[]
    return rows.length === 1 && isRecord(rows[0]) ? rows[0] : null
  } catch {
    return null
  }
}

const C = {
  bgTop: '#0A0A0F',
  bgMid: '#1a1525',
  card: '#14131A',
  purple: '#8B5CF6',
  purpleLight: '#A78BFA',
  gold: '#D4AF37',
  goldLight: '#F0D060',
  goldDim: 'rgba(212,175,55,0.15)',
  white: '#FFFFFF',
  offWhite: '#EDEDED',
  sub: '#9A9A9A',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  success: '#2FE57D',
  error: '#FF5555',
  border: 'rgba(139,92,246,0.25)',
  borderGold: 'rgba(212,175,55,0.35)',
}

const PLATFORM_COLORS: Record<string, string> = {
  binance_futures: '#F0B90B',
  binance_spot: '#F0B90B',
  binance_web3: '#F0B90B',
  bybit: '#F7A600',
  bybit_spot: '#F7A600',
  okx: '#FFFFFF',
  okx_futures: '#FFFFFF',
  okx_spot: '#FFFFFF',
  okx_web3: '#FFFFFF',
  bitget_futures: '#00D4AA',
  bitget_spot: '#00D4AA',
  hyperliquid: '#50E3C2',
  gmx: '#4B8FEE',
  dydx: '#6966FF',
  mexc: '#00B897',
  kucoin: '#24AE8F',
  gateio: '#2354E6',
  htx_futures: '#2E7CF6',
  coinex: '#3FB68B',
  drift: '#E040FB',
  bitunix: '#3B82F6',
  btcc: '#FF6B35',
  bitfinex: '#A7E92F',
  etoro: '#69C53E',
  blofin: '#00D4FF',
  phemex: '#D4FF00',
  jupiter_perps: '#C7F284',
  aevo: '#FF7A45',
}

const PLATFORM_NAMES: Record<string, string> = {
  binance_futures: 'Binance',
  binance_spot: 'Binance Spot',
  binance_web3: 'Binance Web3',
  bybit: 'Bybit',
  bybit_spot: 'Bybit Spot',
  bitget_futures: 'Bitget',
  bitget_spot: 'Bitget Spot',
  okx_futures: 'OKX',
  okx_spot: 'OKX Spot',
  okx_web3: 'OKX Web3',
  hyperliquid: 'Hyperliquid',
  gmx: 'GMX',
  dydx: 'dYdX',
  mexc: 'MEXC',
  kucoin: 'KuCoin',
  gateio: 'Gate.io',
  htx_futures: 'HTX',
  coinex: 'CoinEx',
  drift: 'Drift',
  bitunix: 'Bitunix',
  btcc: 'BTCC',
  bitfinex: 'Bitfinex',
  etoro: 'eToro',
  blofin: 'BloFin',
  phemex: 'Phemex',
  weex: 'WEEX',
  bingx: 'BingX',
  xt: 'XT.COM',
  jupiter_perps: 'Jupiter Perps',
  aevo: 'Aevo',
  web3_bot: 'Web3 Bot',
  kwenta: 'Kwenta',
}

function formatRoi(roi: number): string {
  const abs = Math.abs(roi)
  const sign = roi >= 0 ? '+' : '-'
  if (abs >= 10000) return sign + Math.round(abs / 1000) + 'K%'
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'K%'
  return sign + abs.toFixed(1) + '%'
}

type TraderIdentity = {
  handle: string
  avatarUrl: string | null
  source: string
  sourceTraderId: string
}

type PublishedTraderCard = {
  rank: number
  roi: number
  /** Null for an idle-window row: ranked, but not scored. */
  score: number | null
  /** Ranked but no trading in the period: the card says so, with no rank or return. */
  idle: boolean
  // Optional on a ranked row: null means the source did not provide it.
  winRate: number | null
  maxDrawdown: number | null
}

function optionalFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function verifiedTraderCard(
  value: unknown,
  source: string,
  sourceTraderId: string,
  period: string
): PublishedTraderCard | null {
  const sanitized = sanitizePublicRankingPayload(
    { traders: value === null ? [] : [value], period },
    { expectedPeriod: period }
  ) as { traders?: unknown[] }
  const row = sanitized.traders?.[0]
  if (
    !isRecord(row) ||
    row.source !== source ||
    row.source_trader_id !== sourceTraderId ||
    row.season_id !== period ||
    typeof row.rank !== 'number' ||
    !Number.isSafeInteger(row.rank) ||
    row.rank <= 0 ||
    typeof row.roi !== 'number' ||
    !Number.isFinite(row.roi) ||
    typeof row.arena_score !== 'number' ||
    !Number.isFinite(row.arena_score) ||
    !optionalFiniteNumber(row.win_rate) ||
    !optionalFiniteNumber(row.max_drawdown)
  ) {
    return null
  }
  return {
    rank: row.rank,
    roi: row.roi,
    // An idle-window row carries a placeholder score that means "not scored".
    score: row.idle_window === true ? null : row.arena_score,
    winRate: row.win_rate,
    maxDrawdown: row.max_drawdown,
    idle: row.idle_window === true,
  }
}

/**
 * A trader that exists only in the serving layer has no trader_sources row,
 * and the public ranking may name its source by an alias (`blofin`) while the
 * serving layer uses the slug (`blofin_futures`). arena_resolve_trader accepts
 * either name for the same account, so the name the request used is the public
 * one unless the resolver reports the public name itself (same rule as
 * /api/traders/[handle]/first-screen).
 *
 * Only with a source in the request: without one the resolver would pick a
 * single account for a name several sources share, which is the arbitrary
 * binding restSelectOne refuses.
 */
async function resolveServingOnlyIdentity(
  decoded: string,
  sourceHint: string | null
): Promise<TraderIdentity | null> {
  if (sourceHint === null) return null
  const resolved = await resolveServingTrader(getSupabaseAdmin(), {
    handle: decoded,
    source: sourceHint,
  })
  if (!resolved) return null
  return {
    handle: resolved.nickname && resolved.nickname.trim().length > 0 ? resolved.nickname : decoded,
    avatarUrl: resolved.avatarMirrorUrl,
    source: resolved.publicSource ?? sourceHint,
    sourceTraderId: resolved.exchangeTraderId,
  }
}

async function resolveTraderIdentity(
  handle: string,
  sourceHint: string | null
): Promise<TraderIdentity | null> {
  const enc = encodeURIComponent
  const decoded = safeDecode(handle)
  const cols = 'handle,avatar_url,source,source_trader_id'
  const sourceFilter = sourceHint ? `&source=eq.${enc(sourceHint)}` : ''

  const source =
    (await restSelectOne(
      'trader_sources',
      `select=${cols}&handle=ilike.${exactIlike(decoded)}${sourceFilter}`
    )) ??
    (await restSelectOne(
      'trader_sources',
      `select=${cols}&source_trader_id=eq.${enc(decoded)}${sourceFilter}`
    ))
  if (!source) return resolveServingOnlyIdentity(decoded, sourceHint)

  const sourceName = typeof source.source === 'string' ? source.source : ''
  const sourceTraderId = typeof source.source_trader_id === 'string' ? source.source_trader_id : ''
  if (!sourceName || !sourceTraderId || (sourceHint !== null && sourceName !== sourceHint))
    return null
  return {
    handle:
      typeof source.handle === 'string' && source.handle.trim().length > 0
        ? source.handle
        : decoded,
    avatarUrl: typeof source.avatar_url === 'string' ? source.avatar_url : null,
    source: sourceName,
    sourceTraderId,
  }
}

async function fetchTrader(handle: string, sourceHint: string | null) {
  const identity = await resolveTraderIdentity(handle, sourceHint)
  if (!identity) return null

  // An identity may remain visible even if its source is not rankable, but no
  // source label or metric is inferred from the raw serving relation.
  if (!isPublicRankingSourceAllowed(identity.source)) {
    return { handle: identity.handle, avatar_url: identity.avatarUrl, platform: '', season: '90D' }
  }

  const enc = encodeURIComponent
  for (const season of ['90D', '30D', '7D']) {
    const data = await restSelectOne(
      'public_ranked_leaderboard',
      `select=${PUBLIC_RANKING_COLUMNS}&source=eq.${enc(identity.source)}&source_trader_id=eq.${enc(identity.sourceTraderId)}&season_id=eq.${season}`
    )
    const published = verifiedTraderCard(data, identity.source, identity.sourceTraderId, season)
    if (published) {
      return {
        handle: identity.handle,
        avatar_url: identity.avatarUrl,
        platform: identity.source,
        season,
        rank: published.rank,
        roi: published.roi,
        arena_score: published.score,
        win_rate: published.winRate,
        max_drawdown: published.maxDrawdown,
        idle_window: published.idle,
      }
    }
  }

  // No raw rank/snapshot fallback: this is intentionally an identity-only OG
  // card until a view row carries a current publication proof.
  return {
    handle: identity.handle,
    avatar_url: identity.avatarUrl,
    platform: identity.source,
    season: '90D',
  }
}

export async function GET(request: NextRequest) {
  try {
    // OG 路由不限流；每次都从 sealed view 读取，避免 CDN 缓存旧的排名证明。
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')?.slice(0, 200) || ''

    if (!handle) {
      return new Response('Missing or invalid handle parameter', { status: 400 })
    }

    // Only `source` is allowed as a hint for multi-platform traders.
    // ROI/score/rank overrides removed — prevents attackers from crafting
    // misleading share links with fake stats for any trader.
    const requestedSource = (searchParams.get('source') || '').slice(0, 50).trim().toLowerCase()
    if (requestedSource && !isPublicRankingSourceAllowed(requestedSource)) {
      return new Response('Unknown or unavailable ranking source', {
        status: 404,
        headers: publicRankingResponseRejectionHeaders(),
      })
    }

    const epochRedirect = redirectToPublicRankingResponseCacheEpoch(request)
    if (epochRedirect) return epochRedirect

    const trader = (await fetchTrader(handle, requestedSource || null)) as Record<
      string,
      unknown
    > | null
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

    const displayName = str(trader?.display_name) || str(trader?.handle) || handle
    // An idle-window account: no score, no return, no rank — just the note.
    const idle = trader?.idle_window === true
    const roi = idle ? null : num(trader?.roi)
    const score = idle ? null : num(trader?.arena_score)
    const rank = idle ? null : num(trader?.rank)
    const winRate = num(trader?.win_rate)
    const mdd = num(trader?.max_drawdown)
    // `source` is a lookup constraint, not a display override. The only source
    // shown is the source that resolved the exact identity and sealed row.
    const platform = str(trader?.platform) || ''
    const avatarUrl = str(trader?.avatar_url)
    const season = str(trader?.season) ?? '90D'
    const seasonLabel = season === 'latest' ? 'Latest' : season

    const roiValid = roi != null
    const roiColor = roiValid && roi >= 0 ? C.success : C.error
    const roiStr = roiValid ? formatRoi(roi) : '--'
    const platformLabel = PLATFORM_NAMES[platform] || platform.replace(/_/g, ' ').toUpperCase()
    const platformColor = PLATFORM_COLORS[platform] || C.purpleLight

    // Only show stat cards that have real data
    const showWinRate = winRate != null
    const showMdd = mdd != null
    // Count visible optional cards for flex sizing
    const optionalCardCount = (showWinRate ? 1 : 0) + (showMdd ? 1 : 0)

    // V1 permits only an already-inline avatar in OG output. Do not make a
    // self-request or direct upstream request from this renderer.
    const avatarSrc = avatarUrl?.startsWith('data:') ? avatarUrl : null

    return new ImageResponse(
      <div
        style={{
          width: 1200,
          height: 630,
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(135deg, ${C.bgTop} 0%, ${C.bgMid} 50%, ${C.bgTop} 100%)`,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background gradient blobs */}
        <div
          style={{
            position: 'absolute',
            top: -120,
            left: -80,
            width: 500,
            height: 500,
            background: 'radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)',
            display: 'flex',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -100,
            right: -60,
            width: 420,
            height: 420,
            background: 'radial-gradient(circle, rgba(212,175,55,0.10) 0%, transparent 70%)',
            display: 'flex',
          }}
        />

        {/* Top accent bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
            display: 'flex',
          }}
        />

        {/* Main content */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            padding: '44px 60px 36px',
            zIndex: 1,
          }}
        >
          {/* Top row: Arena branding */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 36,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: C.gold,
                  display: 'flex',
                }}
              />
              <span
                style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}
              >
                ARENA
              </span>
              <span style={{ fontSize: 13, color: C.dimmer, marginLeft: 4 }}>arenafi.org</span>
            </div>
            <div
              style={{
                display: 'flex',
                padding: '6px 16px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: C.dim, letterSpacing: '1px' }}>
                {seasonLabel}
              </span>
            </div>
          </div>

          {/* Trader identity row: Avatar + Name + Exchange */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 32 }}>
            {/* Avatar */}
            {avatarSrc ? (
              <img
                src={avatarSrc}
                alt=""
                width={88}
                height={88}
                style={{
                  borderRadius: '50%',
                  border: `3px solid ${platformColor}40`,
                  objectFit: 'cover',
                }}
              />
            ) : (
              <div
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, ${C.purple}, #6366f1)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 36,
                  fontWeight: 800,
                  color: '#fff',
                }}
              >
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span
                style={{
                  fontSize: displayName.length > 18 ? 32 : 40,
                  fontWeight: 900,
                  color: C.white,
                  letterSpacing: '-0.5px',
                }}
              >
                {displayName.length > 24 ? displayName.slice(0, 24) + '...' : displayName}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {/* Exchange badge */}
                {platformLabel && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 12px',
                      borderRadius: 6,
                      background: platformColor + '18',
                      border: '1px solid ' + platformColor + '35',
                    }}
                  >
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: platformColor,
                        display: 'flex',
                      }}
                    />
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: platformColor,
                        letterSpacing: '0.5px',
                      }}
                    >
                      {platformLabel}
                    </span>
                  </div>
                )}
                {/* Rank badge */}
                {rank != null && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '4px 12px',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.12)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: C.dim,
                        letterSpacing: '0.5px',
                      }}
                    >
                      #{rank}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Stats cards row — only show cards with real data */}
          <div style={{ display: 'flex', gap: 16, flex: 1, alignItems: 'stretch' }}>
            {idle && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  flex: 2,
                  padding: '20px 24px',
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.10)',
                }}
              >
                <span
                  style={{
                    fontSize: 32,
                    fontWeight: 800,
                    color: C.dimmer,
                    letterSpacing: '-1px',
                    lineHeight: 1.1,
                    display: 'flex',
                  }}
                >
                  No trading this period
                </span>
              </div>
            )}
            {/* Arena Score — always shown (except for an idle account) */}
            {!idle && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  flex: optionalCardCount === 0 ? 1.2 : 1,
                  padding: '20px 24px',
                  borderRadius: 16,
                  background: C.goldDim,
                  border: '1px solid ' + C.borderGold,
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: C.goldLight,
                    letterSpacing: '2px',
                    display: 'flex',
                  }}
                >
                  ARENA SCORE
                </span>
                <span
                  style={{
                    fontSize: 52,
                    fontWeight: 900,
                    color: C.goldLight,
                    letterSpacing: '-2px',
                    lineHeight: 1,
                    display: 'flex',
                  }}
                >
                  {score != null ? formatScoreWhole(score) : '--'}
                </span>
              </div>
            )}

            {/* ROI — always shown (except for an idle account) */}
            {!idle && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  flex: optionalCardCount === 0 ? 1.2 : 1,
                  padding: '20px 24px',
                  borderRadius: 16,
                  background:
                    roiValid && roi >= 0 ? 'rgba(47,229,125,0.07)' : 'rgba(255,85,85,0.07)',
                  border:
                    roiValid && roi >= 0
                      ? '1px solid rgba(47,229,125,0.25)'
                      : '1px solid rgba(255,85,85,0.25)',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: C.dimmer,
                    letterSpacing: '2px',
                    display: 'flex',
                  }}
                >
                  ROI ({seasonLabel})
                </span>
                <span
                  style={{
                    fontSize: 48,
                    fontWeight: 900,
                    color: roiColor,
                    letterSpacing: '-2px',
                    lineHeight: 1,
                    display: 'flex',
                  }}
                >
                  {roiStr}
                </span>
              </div>
            )}

            {/* Win Rate — only when data exists */}
            {showWinRate && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  flex: 0.8,
                  padding: '20px 24px',
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: C.dimmer,
                    letterSpacing: '2px',
                    display: 'flex',
                  }}
                >
                  WIN RATE
                </span>
                <span
                  style={{
                    fontSize: 40,
                    fontWeight: 900,
                    color: C.offWhite,
                    letterSpacing: '-1px',
                    lineHeight: 1,
                    display: 'flex',
                  }}
                >
                  {winRate.toFixed(0) + '%'}
                </span>
              </div>
            )}

            {/* Max Drawdown — only when data exists */}
            {showMdd && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  flex: 0.8,
                  padding: '20px 24px',
                  borderRadius: 16,
                  background: 'rgba(255,85,85,0.05)',
                  border: '1px solid rgba(255,85,85,0.15)',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: C.dimmer,
                    letterSpacing: '2px',
                    display: 'flex',
                  }}
                >
                  MAX DD
                </span>
                <span
                  style={{
                    fontSize: 40,
                    fontWeight: 900,
                    color: C.error,
                    letterSpacing: '-1px',
                    lineHeight: 1,
                    display: 'flex',
                  }}
                >
                  {`-${Math.abs(mdd).toFixed(0)}%`}
                </span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 20,
              paddingTop: 16,
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <span style={{ fontSize: 14, color: C.dim }}>Crypto Trader Rankings</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.dim }}>
              View full profile at arenafi.org
            </span>
          </div>
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
        // A cached OG image can outlive a withdrawn rank proof. Keep this
        // request-bound to the sealed view instead of serving stale metrics.
        headers: publicRankingResponseRejectionHeaders(),
      }
    )
  } catch (e) {
    console.error('[OG Trader] Error:', e) // edge runtime — console, not node logger
    // Return a minimal fallback OG image instead of a 500 error.
    // A broken OG image means no social preview on Twitter/Discord — unacceptable.
    const fallbackHandle = (new URL(request.url).searchParams.get('handle') || 'Trader').slice(
      0,
      200
    )
    try {
      return new ImageResponse(
        <div
          style={{
            width: 1200,
            height: 630,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, #0A0A0F 0%, #1a1525 50%, #0A0A0F 100%)',
            fontFamily: 'Inter, system-ui, sans-serif',
          }}
        >
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #8B5CF6, #6366f1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 36,
              fontWeight: 800,
              color: '#fff',
              marginBottom: 24,
            }}
          >
            {fallbackHandle.charAt(0).toUpperCase()}
          </div>
          <span style={{ fontSize: 36, fontWeight: 900, color: '#fff', marginBottom: 12 }}>
            {fallbackHandle.length > 24 ? fallbackHandle.slice(0, 24) + '...' : fallbackHandle}
          </span>
          <span style={{ fontSize: 18, color: '#D4AF37', fontWeight: 700, letterSpacing: '1.5px' }}>
            ARENA — Crypto Trader Rankings
          </span>
          <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', marginTop: 8 }}>
            arenafi.org
          </span>
        </div>,
        {
          width: 1200,
          height: 630,
          headers: publicRankingResponseRejectionHeaders(),
        }
      )
    } catch {
      // Even the Satori fallback failed (observed for some handles where the
      // primary render + minimal fallback both throw). A 500 here = a BROKEN
      // social card on Twitter/Discord (no preview at all). Redirect to the
      // static site OG image so the share card is always valid, never a 500.
      // MUST use `new Response`, not `Response.redirect`: the latter VALIDATES
      // the URL/status and can itself THROW — and here it's the innermost handler,
      // so its throw propagates to a 500 (the exact bug that kept ?handle=test at
      // 500 even after this fallback shipped). `new Response` with a Location
      // header never throws.
      return new Response(null, {
        status: 302,
        headers: {
          ...publicRankingResponseRejectionHeaders(),
          Location: `${BASE_URL}/og-image.png`,
        },
      })
    }
  }
}
