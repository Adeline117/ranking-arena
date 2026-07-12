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

export const runtime = 'edge'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

async function restSelect(table: string, query: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const rows = (await res.json()) as Record<string, unknown>[]
    return rows[0] ?? null
  } catch {
    return null
  }
}

async function fetchRank(handle: string) {
  const enc = encodeURIComponent
  const decoded = decodeURIComponent(handle)
  const cols = 'handle,source,source_trader_id'
  const source =
    (await restSelect('trader_sources', `select=${cols}&handle=ilike.${enc(handle)}`)) ??
    (await restSelect('trader_sources', `select=${cols}&source_trader_id=eq.${enc(decoded)}`)) ??
    (await restSelect(
      'leaderboard_ranks',
      `select=${cols}&source_trader_id=eq.${enc(decoded)}&season_id=eq.90D`
    ))
  if (!source) return null
  const srcName = source.source as string
  const srcTraderId = source.source_trader_id as string
  // A1 data-authenticity: an ACTIVE trader_authorizations row = read-only API
  // key connected → numbers are API-verified, not scraped. Mirrors
  // lib/data/verified-traders.ts. Fail-open (null → Tracked).
  const authRow = await restSelect(
    'trader_authorizations',
    `select=trader_id&status=eq.active&platform=eq.${enc(srcName)}&trader_id=eq.${enc(srcTraderId)}`
  )
  const verified = authRow != null

  for (const season of ['90D', '30D', '7D']) {
    const data = await restSelect(
      'leaderboard_ranks',
      `select=handle,arena_score,rank&source=eq.${enc(srcName)}&source_trader_id=eq.${enc(srcTraderId)}&season_id=eq.${season}`
    )
    if (data && data.rank != null) {
      return {
        handle: (data.handle as string) || (source.handle as string) || decoded,
        rank: Number(data.rank),
        score: data.arena_score != null ? Number(data.arena_score) : null,
        verified,
      }
    }
  }
  return { handle: (source.handle as string) || decoded, rank: null, score: null, verified }
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

  let name = 'Trader'
  let rank: number | null = null
  let score: number | null = null
  let verified = false
  if (SUPABASE_URL && SUPABASE_KEY) {
    const data = await fetchRank(handle)
    if (data) {
      name = data.handle
      rank = data.rank
      score = data.score
      verified = !!data.verified
    }
  }

  const svg = buildSvg({ name, rank, score, verified })
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // CDN-cache 10 min, serve-stale a day — ranks move slowly, embeds are hot.
      'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400',
    },
  })
}
