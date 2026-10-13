/**
 * Embeddable trader rank badge (SVG) — A5 growth loop.
 *
 * A trader drops
 *   <a href="https://www.arenafi.org/trader/<handle>">
 *     <img src="https://www.arenafi.org/api/badge/trader/<handle>.svg" alt="Arena rank"/>
 *   </a>
 * on their X/site → a crisp, self-contained SVG showing their Arena rank +
 * score, back-linking to Arena. Every embed is a backlink (SEO) and a proof
 * point. SVG (not next/og PNG) so it embeds anywhere via <img>, scales
 * crisply, and stays tiny.
 *
 * Edge runtime. Public serving data only (public_ranked_leaderboard /
 * trader_sources). Never errors the embed: an unknown handle returns a generic
 * "View on Arena" badge, not a 404, so a trader's page never shows a broken
 * image.
 */

import type { NextRequest } from 'next/server'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import {
  publicRankingResponseRejectionHeaders,
  redirectToPublicRankingResponseCacheEpoch,
} from '@/lib/rankings/public-response-cache'

export const runtime = 'edge'

const PUBLIC_RANKING_COLUMNS =
  'season_id,source,source_trader_id,handle,rank,arena_score,roi,pnl,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'

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

/**
 * PostgREST accepts `*`, `%`, and `_` as ILIKE wildcards after URL decoding.
 * Escape each one (and the escape character itself) before encoding so a
 * badge URL can only resolve its exact handle, case-insensitively.
 */
function exactIlike(value: string): string {
  return encodeURIComponent(value.replace(/[\\*%_]/g, '\\$&'))
}

/**
 * Fetch exactly one REST row. A duplicate is not an identity proof: return
 * unknown instead of binding an arbitrary account to a public rank badge.
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

type PublishedBadgeRow = {
  rank: number
  score: number
}

/**
 * The REST API is deliberately treated as an untyped transport. The sealed
 * view is the only metric authority, and this second boundary check prevents
 * a stale/malformed proxy response from becoming a badge value.
 */
function verifiedBadgeRow(
  value: unknown,
  source: string,
  sourceTraderId: string,
  period: string
): PublishedBadgeRow | null {
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
    typeof row.arena_score !== 'number' ||
    !Number.isFinite(row.arena_score)
  ) {
    return null
  }
  return { rank: row.rank, score: row.arena_score }
}

async function fetchRank(handle: string) {
  const enc = encodeURIComponent
  const decoded = safeDecode(handle)
  const cols = 'handle,source,source_trader_id'
  const source =
    (await restSelectOne('trader_sources', `select=${cols}&handle=ilike.${exactIlike(decoded)}`)) ??
    (await restSelectOne('trader_sources', `select=${cols}&source_trader_id=eq.${enc(decoded)}`))
  if (!source) return null
  const identityHandle =
    typeof source.handle === 'string' && source.handle.trim().length > 0 ? source.handle : decoded
  const srcName = typeof source.source === 'string' ? source.source : ''
  const srcTraderId = typeof source.source_trader_id === 'string' ? source.source_trader_id : ''
  if (!isPublicRankingSourceAllowed(srcName)) {
    return { handle: identityHandle, rank: null, score: null, verified: false }
  }
  if (!srcTraderId) {
    return { handle: identityHandle, rank: null, score: null, verified: false }
  }

  let published: PublishedBadgeRow | null = null
  for (const season of ['90D', '30D', '7D']) {
    const candidate = await restSelectOne(
      'public_ranked_leaderboard',
      `select=${PUBLIC_RANKING_COLUMNS}&source=eq.${enc(srcName)}&source_trader_id=eq.${enc(srcTraderId)}&season_id=eq.${season}`
    )
    const verified = verifiedBadgeRow(candidate, srcName, srcTraderId, season)
    if (verified) {
      published = verified
      break
    }
  }

  // A verified-API marker is meaningful only alongside a currently published
  // metric row. Never let a source authorization revive an unpublished rank.
  if (!published) {
    return { handle: identityHandle, rank: null, score: null, verified: false }
  }

  // V1 CEX connections are private and never mint a public data badge. Legacy
  // authorization-derived rows remain quarantined during the 48-hour drain and
  // are deliberately ignored here.
  const verified = false
  return {
    handle: identityHandle,
    rank: published.rank,
    score: published.score,
    verified,
  }
}

/** XML-escape for safe SVG text interpolation. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function buildSvg(opts: {
  name: string
  rank: number | null
  score: number | null
  verified?: boolean
}): string {
  const { name, rank, score, verified } = opts
  const W = 268
  const H = 64
  const displayName = esc(truncate(name, 18))
  const rankText = rank != null ? `#${rank.toLocaleString('en-US')}` : '—'
  const scoreText = score != null ? Math.round(score).toString() : '—'
  // Dark, brand-consistent (matches OG card palette). System font stack so no
  // external font fetch (CSP-safe, instant render).
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
  // ✓ VERIFIED pill (A1) — only when the trader connected a read-only API key.
  // No negative "Tracked" label: an unverified badge simply omits it, so a
  // trader embedding this never advertises a downgrade — only an upgrade.
  const verifiedMark = verified
    ? `<g transform="translate(76,17)">
    <path d="M0 4.5 L3 8 L9 0" fill="none" stroke="#2FE57D" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="14" y="8" font-family="${FONT}" font-size="9" font-weight="800" letter-spacing="1" fill="#2FE57D">VERIFIED</text>
  </g>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${displayName} — Arena rank ${rankText}${verified ? ' (Verified)' : ''}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#14131A"/>
      <stop offset="1" stop-color="#1a1525"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="url(#bg)" stroke="rgba(139,92,246,0.35)"/>
  <text x="16" y="26" font-family="${FONT}" font-size="13" font-weight="800" letter-spacing="1.5" fill="#A78BFA">ARENA</text>
  ${verifiedMark}
  <text x="16" y="46" font-family="${FONT}" font-size="12" font-weight="500" fill="#9A9A9A">${displayName}</text>
  <line x1="150" y1="14" x2="150" y2="50" stroke="rgba(255,255,255,0.12)"/>
  <text x="166" y="24" font-family="${FONT}" font-size="9" font-weight="700" letter-spacing="1" fill="rgba(255,255,255,0.45)">RANK</text>
  <text x="166" y="46" font-family="${FONT}" font-size="20" font-weight="800" fill="#F0D060">${rankText}</text>
  <text x="224" y="24" font-family="${FONT}" font-size="9" font-weight="700" letter-spacing="1" fill="rgba(255,255,255,0.45)">SCORE</text>
  <text x="224" y="46" font-family="${FONT}" font-size="20" font-weight="800" fill="#EDEDED">${scoreText}</text>
</svg>`
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
): Promise<Response> {
  const { handle: rawHandle } = await params
  // Allow ".svg" suffix so the URL reads like an image file in <img src>.
  const handle = rawHandle.replace(/\.svg$/i, '')
  const epochRedirect = redirectToPublicRankingResponseCacheEpoch(_request)
  if (epochRedirect) return epochRedirect

  let name = 'Trader'
  let rank: number | null = null
  let score: number | null = null
  let verified = false
  const data = await fetchRank(handle)
  if (data) {
    name = data.handle
    rank = data.rank
    score = data.score
    verified = !!data.verified
  }

  const svg = buildSvg({ name, rank, score, verified })
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // A public-rank withdrawal must take effect on the next image request;
      // an image CDN cache cannot prove the current sealed cohort.
      ...publicRankingResponseRejectionHeaders(),
    },
  })
}
