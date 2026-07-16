/**
 * Dynamic Sitemap generation using Next.js generateSitemaps()
 * Splits into multiple sitemaps to avoid timeouts on 34k+ trader pages:
 *   sitemap/0 → static + exchange pages
 *   sitemap/1..N → trader pages (5000 per file)
 *   sitemap/N+1 → posts, groups, user profiles
 *
 * IMPORTANT: force dynamic rendering so sitemaps are generated at request time
 * (not build time). At build time, Supabase env vars are placeholders, so all
 * DB queries fail silently and every sitemap shard comes back empty (0 URLs).
 */

import type { MetadataRoute } from 'next'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BASE_URL } from '@/lib/constants/urls'
// Single source of truth for /learn slugs — same list drives generateStaticParams
// on the article route. Importing here prevents this sitemap from drifting from
// the actual published articles. articles.ts is pure data (no client-only imports).
import { ARTICLES } from '@/app/(app)/learn/articles'

// ISR: regenerate sitemaps every hour. The first request after revalidation
// triggers a fresh DB query; subsequent requests serve from cache.
// NOTE: force-dynamic was removed because it doesn't reliably work with
// generateSitemaps() on Vercel Turbopack builds — sitemaps were empty.
export const revalidate = 3600

export const maxDuration = 60

const TRADERS_PER_SITEMAP = 5000
const MAX_OTHER_URLS = 500

// Sitemap index IDs:
// 0 = static + exchange pages
// 1..N = trader pages
// N+1 = posts/groups/users
const STATIC_SITEMAP_ID = 0
const EXTRA_SITEMAP_ID = 999 // posts, groups, user profiles

/**
 * Create a fresh Supabase admin client for sitemap generation.
 * We intentionally do NOT use the singleton from lib/supabase/server.ts
 * because that singleton may have been initialized at build time with
 * placeholder env vars and then cached in the module-level variable.
 * A fresh client ensures we read the real runtime env vars.
 */
function getSitemapSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key || url.includes('placeholder')) {
    console.error(
      '[sitemap] CRITICAL: Supabase env vars missing or placeholder — sitemaps will be empty',
      {
        hasUrl: !!url,
        hasKey: !!key,
        urlPrefix: url?.slice(0, 30),
      }
    )
  }

  return createClient(url || '', key || '', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? AbortSignal.timeout(30_000)
        return globalThis.fetch(input, { ...init, signal })
      },
    },
  })
}

/**
 * Fetch all trader handles from leaderboard_ranks
 */
async function getAllTraders(): Promise<Array<{ handle: string; updated_at: string }>> {
  try {
    const supabase = getSitemapSupabase()

    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('handle, source_trader_id, computed_at')
      .eq('season_id', '90D')
      .not('handle', 'is', null)
      .limit(49000)

    if (error) {
      console.error('[sitemap] getAllTraders query error:', error.message, error.code)
      return []
    }

    const seen = new Set<string>()
    const results: Array<{ handle: string; updated_at: string }> = []
    for (const t of data || []) {
      const h = t.handle || t.source_trader_id
      if (!h || seen.has(h)) continue
      seen.add(h)
      results.push({
        handle: h,
        updated_at: t.computed_at || new Date().toISOString(),
      })
    }

    // eslint-disable-next-line no-console
    console.log(`[sitemap] getAllTraders: ${results.length} traders fetched`)
    return results
  } catch (error) {
    console.error(
      '[sitemap] getAllTraders exception:',
      error instanceof Error ? error.message : error
    )
    return []
  }
}

async function getPopularPosts(): Promise<Array<{ id: string; updated_at: string }>> {
  try {
    const supabase = getSitemapSupabase()
    const { data, error } = await supabase
      .from('posts')
      .select('id, updated_at, created_at')
      // This is the exact anonymous-safe root-post subset of the canonical
      // audience predicate. Keeping it in SQL avoids 500 per-row RPCs during
      // sitemap generation while excluding reposts whose root needs a second
      // authorization decision.
      .in('status', ['active', 'locked'])
      .is('deleted_at', null)
      .eq('visibility', 'public')
      .is('group_id', null)
      .is('original_post_id', null)
      .not('author_id', 'is', null)
      .order('hot_score', { ascending: false })
      .limit(MAX_OTHER_URLS)
    if (error) {
      console.error('[sitemap] getPopularPosts error:', error.message)
      return []
    }
    // eslint-disable-next-line no-console
    console.log(`[sitemap] getPopularPosts: ${(data || []).length} posts fetched`)
    return (data || []).map((p) => ({ id: p.id, updated_at: p.updated_at || p.created_at }))
  } catch (error) {
    console.error(
      '[sitemap] getPopularPosts exception:',
      error instanceof Error ? error.message : error
    )
    return []
  }
}

async function getUserProfiles(): Promise<Array<{ handle: string; updated_at: string }>> {
  try {
    const supabase = getSitemapSupabase()
    const { data, error } = await supabase
      .from('user_profiles')
      .select('handle, updated_at')
      .not('handle', 'is', null)
      .limit(5000)
    if (error) {
      console.error('[sitemap] getUserProfiles error:', error.message)
      return []
    }
    const results = (data || [])
      .filter((u: { handle: string | null }) => u.handle)
      .map((u: { handle: string; updated_at: string }) => ({
        handle: u.handle,
        updated_at: u.updated_at || new Date().toISOString(),
      }))
    // eslint-disable-next-line no-console
    console.log(`[sitemap] getUserProfiles: ${results.length} profiles fetched`)
    return results
  } catch (error) {
    console.error(
      '[sitemap] getUserProfiles exception:',
      error instanceof Error ? error.message : error
    )
    return []
  }
}

async function getAllGroups(): Promise<Array<{ id: string; updated_at: string }>> {
  try {
    const supabase = getSitemapSupabase()
    const { data, error } = await supabase
      .from('groups')
      .select('id, created_at')
      .order('member_count', { ascending: false })
      .limit(500)
    if (error) {
      console.error('[sitemap] getAllGroups error:', error.message)
      return []
    }
    // eslint-disable-next-line no-console
    console.log(`[sitemap] getAllGroups: ${(data || []).length} groups fetched`)
    return (data || []).map((g) => ({ id: g.id, updated_at: g.created_at }))
  } catch (error) {
    console.error(
      '[sitemap] getAllGroups exception:',
      error instanceof Error ? error.message : error
    )
    return []
  }
}

/**
 * generateSitemaps() tells Next.js how many sitemap files to produce.
 * Called at build time — no DB access here, returns stable IDs.
 */
export async function generateSitemaps() {
  // We don't know the exact trader count at build time without a DB call.
  // Return enough IDs to cover 50,000 traders (10 shards × 5000 = 50k).
  // Empty shards are fine — Next.js returns an empty sitemap for them.
  const traderShardCount = 10
  const ids = [
    { id: STATIC_SITEMAP_ID }, // static + exchange pages
    ...Array.from({ length: traderShardCount }, (_, i) => ({ id: i + 1 })), // 1..10 trader shards
    { id: EXTRA_SITEMAP_ID }, // posts, groups, user profiles
  ]
  return ids
}

/**
 * Main sitemap function — called per ID by Next.js.
 */
export default async function sitemap({
  id: rawId,
}: {
  id: number
}): Promise<MetadataRoute.Sitemap> {
  // Next.js 16 (Turbopack) passes `id` as a PROMISE despite the `number` type
  // (async-params behavior). Without awaiting, Number(Promise)=NaN → no `id ===`
  // branch matches → EVERY shard returns empty → all trader/post/group URLs
  // silently vanish from the sitemap (SEO loss). Await if thenable, then coerce.
  const isThenable =
    rawId != null && typeof (rawId as unknown as { then?: unknown }).then === 'function'
  const resolvedId = isThenable ? await (rawId as unknown as Promise<number | string>) : rawId
  const id = Number(resolvedId)
  const now = new Date().toISOString()

  // ── Sitemap 0: static pages + exchange landing pages ─────────────────────
  // NOTE: /rankings/{exchange} URLs are deliberately EXCLUDED — they all
  // 301-redirect to /?exchange=... (see next.config.ts redirects). Including
  // redirect URLs in a sitemap is treated as low-quality by Google.
  // Similarly /rankings (→ /), /rankings/traders (→ /), and /library (→ /learn)
  // are all 301 redirects and must NOT appear here.
  // Exchange landing pages at /exchange/{slug} ARE included — they are proper
  // pages with unique content, metadata, and JSON-LD structured data.

  if (id === STATIC_SITEMAP_ID) {
    const staticPages: MetadataRoute.Sitemap = [
      { url: `${BASE_URL}/`, lastModified: now, changeFrequency: 'hourly', priority: 1 },
      { url: `${BASE_URL}/hot`, lastModified: now, changeFrequency: 'hourly', priority: 0.9 },
      { url: `${BASE_URL}/groups`, lastModified: now, changeFrequency: 'daily', priority: 0.8 },
      {
        url: `${BASE_URL}/rankings/tokens`,
        lastModified: now,
        changeFrequency: 'daily',
        priority: 0.8,
      },
      {
        url: `${BASE_URL}/rankings/exchanges`,
        lastModified: now,
        changeFrequency: 'daily',
        priority: 0.8,
      },
      {
        url: `${BASE_URL}/rankings/weekly`,
        lastModified: now,
        changeFrequency: 'daily',
        priority: 0.8,
      },
      { url: `${BASE_URL}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
      {
        url: `${BASE_URL}/methodology`,
        lastModified: now,
        changeFrequency: 'monthly',
        priority: 0.7,
      },
      { url: `${BASE_URL}/compare`, lastModified: now, changeFrequency: 'weekly', priority: 0.6 },
      // /search excluded: empty without ?q= param, should not be indexed
      {
        url: `${BASE_URL}/flash-news`,
        lastModified: now,
        changeFrequency: 'hourly',
        priority: 0.7,
      },
      { url: `${BASE_URL}/market`, lastModified: now, changeFrequency: 'hourly', priority: 0.8 },
      { url: `${BASE_URL}/learn`, lastModified: now, changeFrequency: 'weekly', priority: 0.75 },
      // Learn articles (static content, high SEO value) — derived from ARTICLES
      // (the article route's generateStaticParams source) so slugs never drift.
      ...ARTICLES.map((article) => ({
        url: `${BASE_URL}/learn/${article.slug}`,
        lastModified: now,
        changeFrequency: 'monthly' as const,
        priority: 0.7,
      })),
      { url: `${BASE_URL}/help`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
      { url: `${BASE_URL}/status`, lastModified: now, changeFrequency: 'always', priority: 0.4 },
      { url: `${BASE_URL}/feed`, lastModified: now, changeFrequency: 'hourly', priority: 0.7 },
      { url: `${BASE_URL}/claim`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
      { url: `${BASE_URL}/about`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
      { url: `${BASE_URL}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
      { url: `${BASE_URL}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
      {
        url: `${BASE_URL}/disclaimer`,
        lastModified: now,
        changeFrequency: 'yearly',
        priority: 0.2,
      },
    ]

    // Exchange landing pages — proper pages with unique content and JSON-LD.
    // Uses hyphenated slugs (binance-futures) as canonical URL format.
    const exchangeSlugs = [
      'binance-futures',
      'hyperliquid',
      'okx-futures',
      'bybit',
      'bitget-futures',
      'gmx',
      'dydx',
      'mexc',
      'drift',
      'htx-futures',
      'gateio',
      'jupiter-perps',
      'aevo',
      'coinex',
      'etoro',
      'bingx',
      'blofin',
      'btcc',
      'bitunix',
      'bitfinex',
      'toobit',
      'weex',
      'kucoin',
      'phemex',
    ]
    const exchangePages: MetadataRoute.Sitemap = exchangeSlugs.map((slug) => ({
      url: `${BASE_URL}/exchange/${slug}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.85,
    }))

    return [...staticPages, ...exchangePages]
  }

  // ── Sitemap EXTRA_SITEMAP_ID: posts, groups, user profiles ─────────────────
  if (id === EXTRA_SITEMAP_ID) {
    const [posts, groups, userProfiles] = await Promise.all([
      getPopularPosts(),
      getAllGroups(),
      getUserProfiles(),
    ])

    const postPages: MetadataRoute.Sitemap = posts.map((post) => ({
      url: `${BASE_URL}/post/${post.id}`,
      lastModified: post.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    }))

    const groupPages: MetadataRoute.Sitemap = groups.map((group) => ({
      url: `${BASE_URL}/groups/${group.id}`,
      lastModified: group.updated_at,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    }))

    const userPages: MetadataRoute.Sitemap = userProfiles.map((user) => ({
      url: `${BASE_URL}/u/${encodeURIComponent(user.handle)}`,
      lastModified: user.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.5,
    }))

    return [...postPages, ...groupPages, ...userPages]
  }

  // ── Sitemap 1..N: trader pages (5000 per shard) ───────────────────────────
  // id=1 → traders[0..4999], id=2 → traders[5000..9999], etc.
  const shardIndex = id - 1 // 0-based
  if (shardIndex < 0) return []

  const traders = await getAllTraders()
  const start = shardIndex * TRADERS_PER_SITEMAP
  const slice = traders.slice(start, start + TRADERS_PER_SITEMAP)

  return slice.map((trader) => ({
    url: `${BASE_URL}/trader/${encodeURIComponent(trader.handle)}`,
    lastModified: trader.updated_at,
    changeFrequency: 'daily' as const,
    priority: 0.8,
  }))
}

// Note: revalidate is not needed with dynamic = 'force-dynamic'.
// Vercel CDN will still cache the response via s-maxage headers.
// Sitemaps are only requested by crawlers (infrequent), so
// generating on every request is acceptable.
