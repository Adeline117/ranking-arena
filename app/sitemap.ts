/**
 * Dynamic Sitemap generation using Next.js generateSitemaps()
 * Splits into multiple sitemaps to avoid timeouts on 34k+ trader pages:
 *   sitemap/0 → static + exchange pages
 *   sitemap/1..N → trader pages (5000 per file)
 *   sitemap/N+1 → posts, groups, user profiles
 */

import type { MetadataRoute } from "next"
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from "@/lib/supabase/server"
import { dataLogger } from "@/lib/utils/logger"
import { BASE_URL } from '@/lib/constants/urls'

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
 * Fetch all trader handles from leaderboard_ranks
 */
async function getAllTraders(): Promise<Array<{ handle: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin() as SupabaseClient

    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('handle, source_trader_id, computed_at')
      .eq('season_id', '90D')
      .not('handle', 'is', null)
      .limit(49000)

    if (error) {
      dataLogger.error('sitemap getAllTraders error:', error)
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

    return results
  } catch (error) {
    dataLogger.error('sitemap getAllTraders error:', error)
    return []
  }
}

async function getPopularPosts(): Promise<Array<{ id: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { data, error } = await supabase
      .from('posts')
      .select('id, updated_at, created_at')
      .order('hot_score', { ascending: false })
      .limit(MAX_OTHER_URLS)
    if (error) return []
    return (data || []).map(p => ({ id: p.id, updated_at: p.updated_at || p.created_at }))
  } catch { return [] }
}

async function getUserProfiles(): Promise<Array<{ handle: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { data, error } = await supabase
      .from('user_profiles')
      .select('handle, updated_at')
      .not('handle', 'is', null)
      .limit(5000)
    if (error) return []
    return (data || [])
      .filter((u: { handle: string | null }) => u.handle)
      .map((u: { handle: string; updated_at: string }) => ({
        handle: u.handle,
        updated_at: u.updated_at || new Date().toISOString(),
      }))
  } catch { return [] }
}

async function getAllGroups(): Promise<Array<{ id: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { data, error } = await supabase
      .from('groups')
      .select('id, created_at')
      .order('member_count', { ascending: false })
      .limit(500)
    if (error) return []
    return (data || []).map(g => ({ id: g.id, updated_at: g.created_at }))
  } catch { return [] }
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
    { id: STATIC_SITEMAP_ID },     // static + exchange pages
    ...Array.from({ length: traderShardCount }, (_, i) => ({ id: i + 1 })), // 1..10 trader shards
    { id: EXTRA_SITEMAP_ID },       // posts, groups, user profiles
  ]
  return ids
}

/**
 * Main sitemap function — called per ID by Next.js.
 */
export default async function sitemap({ id }: { id: number }): Promise<MetadataRoute.Sitemap> {
  const now = new Date().toISOString()

  // ── Sitemap 0: static pages + exchange ranking pages ──────────────────────
  if (id === STATIC_SITEMAP_ID) {
    const { EXCHANGE_CONFIG, DEAD_BLOCKED_PLATFORMS } = await import('@/lib/constants/exchanges')
    const deadSet = new Set(DEAD_BLOCKED_PLATFORMS)
    const exchangePages: MetadataRoute.Sitemap = Object.keys(EXCHANGE_CONFIG)
      .filter(k => !deadSet.has(k as import('@/lib/constants/exchanges').TraderSource) && !k.startsWith('dune_') && k !== 'okx_wallet')
      .map(source => ({
        url: `${BASE_URL}/rankings/${source}`,
        lastModified: now,
        changeFrequency: 'daily' as const,
        priority: 0.85,
      }))

    const staticPages: MetadataRoute.Sitemap = [
      { url: `${BASE_URL}/`, lastModified: now, changeFrequency: 'hourly', priority: 1 },
      { url: `${BASE_URL}/rankings`, lastModified: now, changeFrequency: 'hourly', priority: 0.95 },
      { url: `${BASE_URL}/hot`, lastModified: now, changeFrequency: 'hourly', priority: 0.9 },
      { url: `${BASE_URL}/groups`, lastModified: now, changeFrequency: 'daily', priority: 0.8 },
      { url: `${BASE_URL}/rankings/bots`, lastModified: now, changeFrequency: 'daily', priority: 0.8 },
      { url: `${BASE_URL}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
      { url: `${BASE_URL}/methodology`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
      { url: `${BASE_URL}/rankings/traders`, lastModified: now, changeFrequency: 'daily', priority: 0.85 },
      { url: `${BASE_URL}/compare`, lastModified: now, changeFrequency: 'weekly', priority: 0.6 },
      { url: `${BASE_URL}/search`, lastModified: now, changeFrequency: 'weekly', priority: 0.6 },
      { url: `${BASE_URL}/flash-news`, lastModified: now, changeFrequency: 'hourly', priority: 0.7 },
      { url: `${BASE_URL}/market`, lastModified: now, changeFrequency: 'hourly', priority: 0.8 },
      { url: `${BASE_URL}/learn`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
      { url: `${BASE_URL}/library`, lastModified: now, changeFrequency: 'weekly', priority: 0.75 },
      { url: `${BASE_URL}/competitions`, lastModified: now, changeFrequency: 'daily', priority: 0.7 },
      { url: `${BASE_URL}/help`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
      { url: `${BASE_URL}/feed`, lastModified: now, changeFrequency: 'hourly', priority: 0.7 },
      { url: `${BASE_URL}/claim`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
      { url: `${BASE_URL}/login`, lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
      { url: `${BASE_URL}/about`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
      { url: `${BASE_URL}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
      { url: `${BASE_URL}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
      { url: `${BASE_URL}/disclaimer`, lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
    ]

    return [...staticPages, ...exchangePages]
  }

  // ── Sitemap EXTRA_SITEMAP_ID: posts, groups, user profiles ─────────────────
  if (id === EXTRA_SITEMAP_ID) {
    const [posts, groups, userProfiles] = await Promise.all([
      getPopularPosts(),
      getAllGroups(),
      getUserProfiles(),
    ])

    const postPages: MetadataRoute.Sitemap = posts.map(post => ({
      url: `${BASE_URL}/post/${post.id}`,
      lastModified: post.updated_at,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    }))

    const groupPages: MetadataRoute.Sitemap = groups.map(group => ({
      url: `${BASE_URL}/groups/${group.id}`,
      lastModified: group.updated_at,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    }))

    const userPages: MetadataRoute.Sitemap = userProfiles.map(user => ({
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

  return slice.map(trader => ({
    url: `${BASE_URL}/trader/${encodeURIComponent(trader.handle)}`,
    lastModified: trader.updated_at,
    changeFrequency: 'daily' as const,
    priority: 0.8,
  }))
}

// Revalidate every hour
export const revalidate = 3600
