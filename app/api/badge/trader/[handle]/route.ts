/**
 * Embeddable trader rank badge (SVG) — A5 growth loop.
 *
 * A trader drops
 *   <a href="https://www.arenafi.org/trader/<handle>">
 *     <img src="https://www.arenafi.org/api/badge/trader/<handle>.svg" alt="Arena rank"/>
 *   </a>
 * on their X/site → a crisp, self-contained SVG showing their Arena rank +
 * score, back-linking to Arena. `?platform=<source>` (optional) names the
 * account's source, which is what makes a serving-only account findable. Every embed is a backlink (SEO) and a proof
 * point. SVG (not next/og PNG) so it embeds anywhere via <img>, scales
 * crisply, and stays tiny.
 *
 * Edge runtime. Public serving data only (public_ranked_leaderboard /
 * trader_sources). Never errors the embed: an unknown handle returns a generic
 * "View on Arena" badge, not a 404, so a trader's page never shows a broken
 * image. A lookup that FAILED still answers with that generic image, but with
 * status 503 so nothing downstream keeps it as this trader's badge.
 */

import { formatScoreWhole } from '@/lib/utils/format'
import type { NextRequest } from 'next/server'
import { resolveServingTraderOutcome, SERVING_RESOLVE_ERRORED } from '@/lib/data/serving/resolve'
import { getSupabaseAdmin } from '@/lib/supabase/server'
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
  'season_id,source,source_trader_id,handle,rank,arena_score,roi,pnl,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at,idle_window'

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

/** The lookup has no answer. NOT the same as "no such trader". */
const LOOKUP_ERRORED = Symbol('badge-lookup-errored')

async function restSelect(
  table: string,
  query: string,
  limit: number
): Promise<Record<string, unknown>[] | typeof LOOKUP_ERRORED> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    if (!supabaseUrl || !supabaseKey) return LOOKUP_ERRORED
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}&limit=${limit}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return LOOKUP_ERRORED
    const rows: unknown = await res.json()
    return Array.isArray(rows) ? rows.filter(isRecord) : LOOKUP_ERRORED
  } catch {
    return LOOKUP_ERRORED
  }
}

/**
 * Fetch exactly one REST row. A duplicate is not an identity proof: return
 * unknown instead of binding an arbitrary account to a public rank badge.
 */
async function restSelectOne(
  table: string,
  query: string
): Promise<Record<string, unknown> | null> {
  const rows = await restSelect(table, query, 2)
  return rows !== LOOKUP_ERRORED && rows.length === 1 ? rows[0] : null
}

type PublishedBadgeRow = {
  /** Null for an idle-window row: ranked, but no trading — no rank shown. */
  rank: number | null
  /** Null for an idle-window row: it is ranked but was not scored. */
  score: number | null
  idle: boolean
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
  // An idle-window row (no ROI and no PnL in the period) carries a placeholder
  // score that means "not scored". Like every other surface, the badge says
  // "no trading" for it and shows neither a rank nor a score.
  if (row.idle_window === true) return { rank: null, score: null, idle: true }
  return { rank: row.rank, score: row.arena_score, idle: false }
}

const SEASONS = ['90D', '30D', '7D'] as const

type BadgeData = {
  handle: string
  rank: number | null
  score: number | null
  idle?: boolean
  verified: boolean
}

function unranked(handle: string): BadgeData {
  return { handle, rank: null, score: null, verified: false }
}

function ranked(handle: string, published: PublishedBadgeRow): BadgeData {
  // V1 CEX connections are private and never mint a public data badge. Legacy
  // authorization-derived rows remain quarantined during the 48-hour drain and
  // are deliberately ignored here.
  const verified = false
  return { handle, rank: published.rank, score: published.score, idle: published.idle, verified }
}

/** The account's first publishable row, longest period first. */
async function readPublished(
  source: string,
  sourceTraderId: string
): Promise<{ published: PublishedBadgeRow | null; errored: boolean }> {
  const enc = encodeURIComponent
  let errored = false
  for (const season of SEASONS) {
    const rows = await restSelect(
      'public_ranked_leaderboard',
      `select=${PUBLIC_RANKING_COLUMNS}&source=eq.${enc(source)}&source_trader_id=eq.${enc(sourceTraderId)}&season_id=eq.${season}`,
      2
    )
    if (rows === LOOKUP_ERRORED) {
      errored = true
      continue
    }
    const verified = verifiedBadgeRow(
      rows.length === 1 ? rows[0] : null,
      source,
      sourceTraderId,
      season
    )
    if (verified) return { published: verified, errored: false }
  }
  return { published: null, errored }
}

/** trader_sources, the legacy identity table. Lookup failures read as "no row". */
async function legacyIdentity(decoded: string, platform: string | null) {
  const enc = encodeURIComponent
  const cols = 'handle,source,source_trader_id'
  const sourceFilter = platform ? `&source=eq.${enc(platform)}` : ''
  const source =
    (await restSelectOne(
      'trader_sources',
      `select=${cols}&handle=ilike.${exactIlike(decoded)}${sourceFilter}`
    )) ??
    (await restSelectOne(
      'trader_sources',
      `select=${cols}&source_trader_id=eq.${enc(decoded)}${sourceFilter}`
    ))
  if (!source) return null
  return {
    handle:
      typeof source.handle === 'string' && source.handle.trim().length > 0
        ? source.handle
        : decoded,
    source: typeof source.source === 'string' ? source.source : '',
    sourceTraderId: typeof source.source_trader_id === 'string' ? source.source_trader_id : '',
  }
}

async function legacyBadge(decoded: string, platform: string | null): Promise<BadgeData | null> {
  const identity = await legacyIdentity(decoded, platform)
  if (!identity) return null
  if (!isPublicRankingSourceAllowed(identity.source)) return unranked(identity.handle)
  if (!identity.sourceTraderId) return unranked(identity.handle)
  // A verified-API marker is meaningful only alongside a currently published
  // metric row. Never let a source authorization revive an unpublished rank.
  const { published } = await readPublished(identity.source, identity.sourceTraderId)
  return published ? ranked(identity.handle, published) : unranked(identity.handle)
}

/**
 * The request names the source. A serving-only account has no trader_sources
 * row, and the public ranking may publish its source under an alias (`gateio`)
 * while the serving layer uses the slug (`gate_futures`). arena_resolve_trader
 * accepts either name for the same account and reports the public one; until a
 * deployed resolver does, the name the request used is the public one (same
 * rule as /api/share/rank-card and /api/og/trader).
 */
async function platformBadge(
  decoded: string,
  platform: string
): Promise<BadgeData | null | typeof LOOKUP_ERRORED> {
  const resolved = await resolveServingTraderOutcome(getSupabaseAdmin(), {
    handle: decoded,
    source: platform,
  })
  if (resolved === SERVING_RESOLVE_ERRORED) return LOOKUP_ERRORED
  // Not a serving account: it may still be a legacy one on that source.
  if (!resolved) return legacyBadge(decoded, platform)

  const name =
    resolved.nickname && resolved.nickname.trim().length > 0 ? resolved.nickname : decoded
  const publicSource = resolved.publicSource ?? platform
  if (!isPublicRankingSourceAllowed(publicSource)) return unranked(name)
  const { published, errored } = await readPublished(publicSource, resolved.exchangeTraderId)
  if (published) return ranked(name, published)
  return errored ? LOOKUP_ERRORED : unranked(name)
}

/**
 * No source in the request and no legacy row: the handle may still identify
 * exactly one account on the public ranking. "Exactly one" is across every
 * period, by nickname or by account id — the same name on two sources is not
 * an identity, and the badge shows no numbers rather than pick one.
 */
async function uniquePublicBadge(
  decoded: string
): Promise<BadgeData | null | typeof LOOKUP_ERRORED> {
  const seasons = `season_id=in.(${SEASONS.join(',')})`
  // One account has at most one row per period, so a fourth row (or any row of
  // a second account within the first four) proves the name is shared.
  const limit = SEASONS.length + 1
  const lookups = await Promise.all([
    restSelect(
      'public_ranked_leaderboard',
      `select=${PUBLIC_RANKING_COLUMNS}&handle=ilike.${exactIlike(decoded)}&${seasons}`,
      limit
    ),
    restSelect(
      'public_ranked_leaderboard',
      `select=${PUBLIC_RANKING_COLUMNS}&source_trader_id=eq.${encodeURIComponent(decoded)}&${seasons}`,
      limit
    ),
  ])
  const rows: Record<string, unknown>[] = []
  for (const lookup of lookups) {
    // Half an answer cannot prove uniqueness.
    if (lookup === LOOKUP_ERRORED) return LOOKUP_ERRORED
    rows.push(...lookup)
  }
  if (rows.length === 0) return null

  const accounts = new Set(rows.map((row) => JSON.stringify([row.source, row.source_trader_id])))
  const first = rows[0]
  if (
    accounts.size !== 1 ||
    typeof first.source !== 'string' ||
    typeof first.source_trader_id !== 'string'
  ) {
    return null
  }
  const name =
    typeof first.handle === 'string' && first.handle.trim().length > 0 ? first.handle : decoded
  for (const season of SEASONS) {
    const row = rows.find((candidate) => candidate.season_id === season)
    const verified = row
      ? verifiedBadgeRow(row, first.source, first.source_trader_id, season)
      : null
    if (verified) return ranked(name, verified)
  }
  return unranked(name)
}

async function fetchRank(
  handle: string,
  platform: string | null
): Promise<BadgeData | null | typeof LOOKUP_ERRORED> {
  const decoded = safeDecode(handle)
  if (platform) return platformBadge(decoded, platform)
  return (await legacyBadge(decoded, null)) ?? uniquePublicBadge(decoded)
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
  idle?: boolean
}): string {
  const { name, rank, score, verified, idle = false } = opts
  const W = 268
  const H = 64
  const displayName = esc(truncate(name, 18))
  const rankText = rank != null ? `#${rank.toLocaleString('en-US')}` : '—'
  // Escaped where it is written: a small score formats as "<1", and a raw "<"
  // inside <text> makes the whole SVG invalid.
  const scoreText = score != null ? formatScoreWhole(score) : '—'
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${displayName} — ${idle ? 'Arena: no trading this period' : `Arena rank ${rankText}`}${verified ? ' (Verified)' : ''}">
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
  ${
    idle
      ? `<text x="166" y="38" font-family="${FONT}" font-size="12" font-weight="700" fill="rgba(255,255,255,0.6)">No trading</text>
  <text x="166" y="52" font-family="${FONT}" font-size="10" font-weight="500" fill="rgba(255,255,255,0.45)">this period</text>`
      : `<text x="166" y="24" font-family="${FONT}" font-size="9" font-weight="700" letter-spacing="1" fill="rgba(255,255,255,0.45)">RANK</text>
  <text x="166" y="46" font-family="${FONT}" font-size="20" font-weight="800" fill="#F0D060">${rankText}</text>
  <text x="224" y="24" font-family="${FONT}" font-size="9" font-weight="700" letter-spacing="1" fill="rgba(255,255,255,0.45)">SCORE</text>
  <text x="224" y="46" font-family="${FONT}" font-size="20" font-weight="800" fill="#EDEDED">${esc(scoreText)}</text>`
  }
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
  let idle = false
  const platform =
    (new URL(_request.url).searchParams.get('platform') || '').slice(0, 50).trim().toLowerCase() ||
    null
  const data = await fetchRank(handle, platform)
  if (data !== LOOKUP_ERRORED && data) {
    name = data.handle
    rank = data.rank
    score = data.score
    verified = !!data.verified
    idle = data.idle === true
  }

  const svg = buildSvg({ name, rank, score, verified, idle })
  return new Response(svg, {
    // A failed lookup is not "this trader has no rank". The body is still a
    // drawable image (an <img> shows it either way), but the status keeps a
    // proxy or image cache from storing it as the trader's badge.
    status: data === LOOKUP_ERRORED ? 503 : 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // A public-rank withdrawal must take effect on the next image request;
      // an image CDN cache cannot prove the current sealed cohort.
      ...publicRankingResponseRejectionHeaders(),
    },
  })
}
