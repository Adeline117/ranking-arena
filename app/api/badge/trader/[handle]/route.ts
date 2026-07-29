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
 * Edge runtime + CDN-cached. Public serving data only (leaderboard_ranks /
 * trader_sources). Never errors the embed: an unknown handle returns a generic
 * "View on Arena" badge, not a 404, so a trader's page never shows a broken
 * image.
 */

import type { NextRequest } from 'next/server'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readEdgePublicTraderRanking } from '@/lib/rankings/read-edge-public-trader-ranking'
import {
  publicRankingResponseCacheHeaders,
  redirectToPublicRankingResponseCacheEpoch,
} from '@/lib/rankings/public-response-cache'

export const runtime = 'edge'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

async function readActiveAuthorization(source: string, sourceTraderId: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({
      select: 'trader_id',
      status: 'eq.active',
      platform: `eq.${source}`,
      trader_id: `eq.${sourceTraderId}`,
      limit: '1',
    })
    const res = await fetch(`${SUPABASE_URL}/rest/v1/trader_authorizations?${params.toString()}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return false
    const payload: unknown = await res.json()
    return (
      Array.isArray(payload) &&
      payload.length === 1 &&
      payload[0] !== null &&
      typeof payload[0] === 'object'
    )
  } catch {
    return false
  }
}

async function fetchRank(handle: string) {
  const trader = await readEdgePublicTraderRanking(
    {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SUPABASE_KEY,
    },
    { handle }
  )
  if (!trader) return null

  const srcName = trader.source
  if (!isPublicRankingSourceAllowed(srcName)) return null
  // A1 data-authenticity: an ACTIVE trader_authorizations row = read-only API
  // key connected → numbers are API-verified, not scraped. Verification is
  // supplemental identity data, so an unavailable lookup only omits the mark.
  const verified = await readActiveAuthorization(srcName, trader.sourceTraderId)

  return {
    handle: trader.handle || handle,
    rank: trader.rank,
    score: trader.arenaScore,
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
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const data = await fetchRank(handle)
      if (data) {
        name = data.handle
        rank = data.rank
        score = data.score
        verified = !!data.verified
      }
    } catch {
      // A publication proof failure must not leak an unsealed rank. Keep the
      // embed valid while rendering the generic, metric-free badge.
    }
  }

  const svg = buildSvg({ name, rank, score, verified })
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // CDN-cache 10 min, serve-stale a day — ranks move slowly, embeds are hot.
      ...publicRankingResponseCacheHeaders(
        'public, max-age=300, s-maxage=600, stale-while-revalidate=86400'
      ),
    },
  })
}
