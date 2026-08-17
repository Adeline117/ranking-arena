/**
 * Sitemap API Route — serves sitemap index + shard XML
 *
 * Why not app/sitemap.ts? Next.js metadata sitemap routes pre-render at
 * build time and cache the result. At build time, Supabase env vars are
 * placeholders, so all DB queries fail and sitemaps come back empty.
 * Neither force-dynamic nor revalidate fixed this reliably.
 *
 * This API route runs at request time with real env vars, guaranteed.
 *
 * Routes:
 *   GET /api/sitemap           → sitemap index XML
 *   GET /api/sitemap?shard=0   → static pages
 *   GET /api/sitemap?shard=1-N → trader pages (5000 per shard)
 *   GET /api/sitemap?shard=999 → posts, groups, user profiles
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { TOP_EXCHANGE_SLUGS } from '@/lib/constants/exchange-slugs'
import { ARTICLES } from '@/app/(app)/learn/articles'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BASE_URL = 'https://www.arenafi.org'
const TRADERS_PER_SHARD = 5000
const DISCOVERABLE_GROUP_VISIBILITIES = ['open', 'apply'] as const
// This security-barrier view is the sole authority for search-engine-visible
// ranked traders. Keep the ungenerated relation isolated here until database
// types are regenerated; never fall back to the wider raw rank table.
const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard' as const

const CACHEABLE_SITEMAP_HEADERS = {
  'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
} as const

const STATEFUL_SITEMAP_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

type SitemapProfileState = {
  id?: string | null
  handle?: string | null
  updated_at?: string | null
  deleted_at?: string | null
  banned_at?: string | null
  is_banned?: boolean | null
  ban_expires_at?: string | null
}

type PublicSitemapTrader = {
  handle: string
  source: string
  computedAt?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function asPublicSitemapTrader(row: unknown): PublicSitemapTrader | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const record = row as Record<string, unknown>
  const rank = record.rank
  const source = record.source
  const handle = isNonEmptyString(record.handle)
    ? record.handle
    : isNonEmptyString(record.source_trader_id)
      ? record.source_trader_id
      : null

  // The view itself enforces full/non-estimated/source-fresh membership. This
  // boundary check is only a fail-closed defense against a malformed response
  // from a proxy or rolling schema deployment.
  if (
    typeof rank !== 'number' ||
    !Number.isSafeInteger(rank) ||
    rank <= 0 ||
    !isNonEmptyString(source) ||
    !isNonEmptyString(handle)
  ) {
    return null
  }

  const computedAt =
    isNonEmptyString(record.computed_at) && Number.isFinite(Date.parse(record.computed_at))
      ? new Date(record.computed_at).toISOString()
      : undefined

  return { handle, source, ...(computedAt ? { computedAt } : {}) }
}

export function isSitemapProfileActive(profile: SitemapProfileState, now = Date.now()): boolean {
  if (profile.deleted_at || profile.banned_at) return false
  if (!profile.is_banned) return true
  if (!profile.ban_expires_at) return false
  const banExpiresAt = Date.parse(profile.ban_expires_at)
  return Number.isFinite(banExpiresAt) && banExpiresAt <= now
}

function xmlResponse(
  xml: string,
  cacheHeaders: Record<string, string> = CACHEABLE_SITEMAP_HEADERS
): NextResponse {
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml',
      ...cacheHeaders,
    },
  })
}

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function GET(request: NextRequest) {
  const shard = request.nextUrl.searchParams.get('shard')

  // No shard param → return sitemap index
  if (shard === null) {
    const traderCount = await getTraderCount()
    // An unavailable/invalid public count is unknown, not evidence for a
    // synthetic trader shard. Keep the static and stateful sitemap entries
    // discoverable while failing the ranked-trader branch closed.
    const shardCount = traderCount > 0 ? Math.ceil(traderCount / TRADERS_PER_SHARD) : 0
    const shards = [0, ...Array.from({ length: shardCount }, (_, i) => i + 1), 999]
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${shards.map((id) => `  <sitemap><loc>${BASE_URL}/api/sitemap-xml?shard=${id}</loc></sitemap>`).join('\n')}
</sitemapindex>`
    return xmlResponse(xml)
  }

  const shardId = Number(shard)
  const now = new Date().toISOString()

  // Shard 0: static pages (no DB)
  if (shardId === 0) {
    const urls = [
      { url: '/', priority: 1, freq: 'hourly' },
      { url: '/hot', priority: 0.9, freq: 'hourly' },
      { url: '/market', priority: 0.8, freq: 'hourly' },
      { url: '/groups', priority: 0.8, freq: 'daily' },
      { url: '/pricing', priority: 0.7, freq: 'monthly' },
      { url: '/methodology', priority: 0.7, freq: 'monthly' },
      { url: '/learn', priority: 0.75, freq: 'weekly' },
      { url: '/search', priority: 0.6, freq: 'weekly' },
      { url: '/flash-news', priority: 0.7, freq: 'hourly' },
      { url: '/feed', priority: 0.7, freq: 'hourly' },
      { url: '/compare', priority: 0.6, freq: 'weekly' },
      { url: '/claim', priority: 0.6, freq: 'monthly' },
      { url: '/about', priority: 0.4, freq: 'monthly' },
      { url: '/help', priority: 0.5, freq: 'monthly' },
      { url: '/privacy', priority: 0.2, freq: 'yearly' },
      { url: '/terms', priority: 0.2, freq: 'yearly' },
      { url: '/disclaimer', priority: 0.2, freq: 'yearly' },
      // Rankings subpages that were previously missing from the sitemap.
      { url: '/rankings', priority: 0.9, freq: 'hourly' },
      { url: '/rankings/exchanges', priority: 0.7, freq: 'daily' },
      { url: '/rankings/weekly', priority: 0.7, freq: 'daily' },
      // High-SEO exchange landing pages ("binance leaderboard" etc.) — one per
      // prerendered slug, previously absent from the sitemap entirely.
      ...TOP_EXCHANGE_SLUGS.map((slug) => ({
        url: `/exchange/${slug}`,
        priority: 0.75,
        freq: 'daily' as const,
      })),
      // Individual learn articles (only the /learn index was listed before).
      ...ARTICLES.map((a) => ({
        url: `/learn/${a.slug}`,
        priority: 0.6,
        freq: 'weekly' as const,
      })),
    ]
    return xmlResponse(
      urlsetXml(
        urls.map((u) => ({
          loc: `${BASE_URL}${u.url}`,
          lastmod: now,
          changefreq: u.freq,
          priority: u.priority,
        }))
      )
    )
  }

  // Shard 999: posts, groups, user profiles
  if (shardId === 999) {
    const supabase = getSupabase()
    const [postCandidates, groups, userCandidates] = await Promise.all([
      supabase
        .from('posts')
        .select('id, updated_at, author_id')
        .eq('status', 'active')
        .eq('visibility', 'public')
        .is('deleted_at', null)
        .is('group_id', null)
        .is('original_post_id', null)
        .order('hot_score', { ascending: false })
        .limit(1000),
      supabase
        .from('groups')
        .select('id, created_at')
        .is('dissolved_at', null)
        .in('visibility', [...DISCOVERABLE_GROUP_VISIBILITIES])
        .order('member_count', { ascending: false })
        .limit(500),
      supabase
        .from('user_profiles')
        .select('id, handle, updated_at, deleted_at, banned_at, is_banned, ban_expires_at')
        .not('handle', 'is', null)
        .limit(6000),
    ])
    const authorIds = [
      ...new Set(
        (postCandidates.data ?? [])
          .map((post) => post.author_id)
          .filter((authorId): authorId is string => typeof authorId === 'string')
      ),
    ]
    const authorProfiles =
      authorIds.length > 0
        ? await supabase
            .from('user_profiles')
            .select('id, deleted_at, banned_at, is_banned, ban_expires_at')
            .in('id', authorIds)
        : { data: [], error: null }
    const profileNow = Date.now()
    const activeAuthorIds = authorProfiles.error
      ? new Set<string>()
      : new Set(
          (authorProfiles.data ?? [])
            .filter((profile) => isSitemapProfileActive(profile, profileNow))
            .map((profile) => profile.id)
            .filter((authorId): authorId is string => typeof authorId === 'string')
        )
    const posts = (postCandidates.data ?? [])
      .filter((post) => activeAuthorIds.has(post.author_id))
      .slice(0, 500)
    const users = (userCandidates.data ?? [])
      .filter((profile) => isSitemapProfileActive(profile, profileNow))
      .slice(0, 5000)
    const entries = [
      ...posts.map((p) => ({
        loc: `${BASE_URL}/post/${p.id}`,
        lastmod: p.updated_at,
        changefreq: 'weekly',
        priority: 0.6,
      })),
      ...(groups.data || []).map((g) => ({
        loc: `${BASE_URL}/groups/${g.id}`,
        lastmod: g.created_at,
        changefreq: 'daily',
        priority: 0.7,
      })),
      ...users
        .filter((u) => u.handle)
        .map((u) => ({
          loc: `${BASE_URL}/u/${encodeURIComponent(u.handle)}`,
          lastmod: u.updated_at,
          changefreq: 'weekly',
          priority: 0.5,
        })),
    ]
    // This shard contains mutable public resources. Never let a shared cache
    // keep a dissolved/private/deleted URL discoverable after the database has
    // revoked it; static and trader-only shards retain their long-lived cache.
    return xmlResponse(urlsetXml(entries), STATEFUL_SITEMAP_NO_STORE_HEADERS)
  }

  // Shard 1..N: trader pages
  const supabase = getSupabase()
  const offset = (shardId - 1) * TRADERS_PER_SHARD
  // The public cohort view applies its membership proof before this season
  // predicate and range. Keep all caller clauses in this one SQL builder; do
  // not fetch an arbitrary raw page and attempt to filter it after pagination.
  const { data, error } = (await supabase
    .from(PUBLIC_RANKED_LEADERBOARD as never)
    .select('handle, source_trader_id, source, rank, computed_at')
    .eq('season_id', '90D')
    .not('rank', 'is', null)
    .order('rank', { ascending: true, nullsFirst: false })
    .order('source', { ascending: true, nullsFirst: false })
    .order('source_trader_id', { ascending: true, nullsFirst: false })
    .range(offset, offset + TRADERS_PER_SHARD - 1)) as {
    data: unknown[] | null
    error: { message: string } | null
  }

  if (error) {
    console.error('[sitemap] public ranked cohort query failed:', error.message)
    return xmlResponse(urlsetXml([]))
  }

  const traders = (data || []).map(asPublicSitemapTrader)
  // Do not remove an invalid row and pull a later account into this fixed
  // shard: that would make the next shard a false continuation. Search
  // engines receive no trader URLs until the serving cohort is trustworthy.
  if (traders.some((trader) => trader === null)) {
    console.error('[sitemap] public ranked cohort returned a malformed row')
    return xmlResponse(urlsetXml([]))
  }

  const seen = new Set<string>()
  const entries = traders
    .filter((trader): trader is PublicSitemapTrader => {
      if (!trader) return false
      // The platform parameter is part of the canonical trader identity, so
      // same-handle accounts across exchanges must not collapse into one URL.
      const identity = `${trader.source}:${trader.handle}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .map((trader) => ({
      // 与 trader 页 canonical 对齐(2026-07-11 SEO 审计):带 ?platform= 消除
      // handle-vs-id 双 URL + 跨源同名歧义。ASCII handle 用 handle 段,否则不确定
      // 就用它本身(sitemap 只是发现入口,canonical 才是权威,Google 会向其收敛)。
      loc: `${BASE_URL}/trader/${encodeURIComponent(trader.handle)}?platform=${encodeURIComponent(trader.source)}`,
      // 用真实 computed_at 作 lastmod;此前全用请求时刻 now → Google 判 lastmod
      // 不可信直接整体忽略该字段(2026-07-11 SEO 审计),而不是伪造请求时刻。
      lastmod: trader.computedAt,
      changefreq: 'daily',
      priority: 0.8,
    }))

  return xmlResponse(urlsetXml(entries))
}

async function getTraderCount(): Promise<number> {
  try {
    const supabase = getSupabase()
    const { count, error } = (await supabase
      .from(PUBLIC_RANKED_LEADERBOARD as never)
      .select('id', { count: 'exact', head: true })
      .eq('season_id', '90D')
      .not('rank', 'is', null)) as {
      count: number | null
      error: { message: string } | null
    }
    if (error) {
      console.error('[sitemap] public ranked cohort count failed:', error.message)
      return 0
    }
    return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0
  } catch (error) {
    console.error(
      '[sitemap] public ranked cohort count exception:',
      error instanceof Error ? error.message : error
    )
    // A guessed shard count is not a public-ranking authority. Returning zero
    // fails closed and leaves static/stateful sitemap shards available.
    return 0
  }
}

function urlsetXml(
  entries: Array<{ loc: string; lastmod?: string; changefreq?: string; priority?: number }>
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${e.loc}</loc>
${e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>\n` : ''}${e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>\n` : ''}${e.priority !== undefined ? `    <priority>${e.priority}</priority>\n` : ''}  </url>`
  )
  .join('\n')}
</urlset>`
}
