/**
 * 动态 Sitemap 生成
 * 包含所有公开页面：首页、交易员、帖子、小组
 */

import type { MetadataRoute } from "next"
import { getSupabaseAdmin } from "@/lib/supabase/server"
import { dataLogger } from "@/lib/utils/logger"

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"

// Google sitemap limit: 50,000 URLs per file
const MAX_TRADER_URLS = 49000  // reserve headroom for other pages
const MAX_OTHER_URLS = 500

/**
 * 获取所有交易员 handle
 */
async function getAllTraders(): Promise<Array<{ handle: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin()

    // Use leaderboard_ranks (the unified data source) for sitemap generation
    // This covers all traders including those without trader_sources entries
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('handle, source_trader_id, computed_at')
      .eq('season_id', '90D')
      .not('handle', 'is', null)
      .limit(MAX_TRADER_URLS)

    if (error) {
      dataLogger.error('sitemap 获取交易员失败:', error)
      return []
    }

    // Deduplicate by handle
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

/**
 * 获取热门帖子
 */
async function getPopularPosts(): Promise<Array<{ id: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin()
    
    const { data, error } = await supabase
      .from('posts')
      .select('id, updated_at, created_at')
      .order('hot_score', { ascending: false })
      .limit(MAX_OTHER_URLS)
    
    if (error) {
      dataLogger.error('sitemap 获取帖子失败:', error)
      return []
    }
    
    return (data || []).map(p => ({
      id: p.id,
      updated_at: p.updated_at || p.created_at,
    }))
  } catch (error) {
    dataLogger.error('sitemap getPopularPosts error:', error)
    return []
  }
}

/**
 * 获取所有书库条目
 */
async function getAllLibraryItems(): Promise<Array<{ id: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('library_items')
      .select('id, created_at')
      .order('download_count', { ascending: false })
      .limit(2000)

    if (error) {
      dataLogger.error('sitemap library items error:', error)
      return []
    }

    return (data || []).map(item => ({
      id: item.id,
      updated_at: item.created_at,
    }))
  } catch (error) {
    dataLogger.error('sitemap getAllLibraryItems error:', error)
    return []
  }
}

/**
 * 获取用户主页
 */
async function getUserProfiles(): Promise<Array<{ handle: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('user_profiles')
      .select('handle, updated_at')
      .not('handle', 'is', null)
      .limit(5000)

    if (error) {
      dataLogger.error('sitemap user profiles error:', error)
      return []
    }

    return (data || [])
      .filter((u: { handle: string | null }) => u.handle)
      .map((u: { handle: string; updated_at: string }) => ({
        handle: u.handle,
        updated_at: u.updated_at || new Date().toISOString(),
      }))
  } catch (error) {
    dataLogger.error('sitemap getUserProfiles error:', error)
    return []
  }
}

/**
 * 获取所有小组
 */
async function getAllGroups(): Promise<Array<{ id: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin()
    
    const { data, error } = await supabase
      .from('groups')
      .select('id, created_at')
      .order('member_count', { ascending: false })
      .limit(500)
    
    if (error) {
      dataLogger.error('sitemap 获取小组失败:', error)
      return []
    }
    
    return (data || []).map(g => ({
      id: g.id,
      updated_at: g.created_at,
    }))
  } catch (error) {
    dataLogger.error('sitemap getAllGroups error:', error)
    return []
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date().toISOString()
  const isBuild = process.env.NEXT_PHASE === 'phase-production-build'

  // Exchange ranking pages (generated from EXCHANGE_CONFIG)
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

  // 静态页面
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1,
    },
    {
      url: `${BASE_URL}/hot`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/groups`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    // /rankings redirects to /, excluded from sitemap
    {
      url: `${BASE_URL}/rankings/bots`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/rankings/institutions`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/rankings/tools`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/rankings/resources`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/pricing`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/methodology`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/rankings/traders`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.85,
    },
    {
      url: `${BASE_URL}/compare`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/search`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/library`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/flash-news`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/market`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/help`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/feed`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/claim`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/login`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${BASE_URL}/disclaimer`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ]
  
  // Skip DB queries during build — dynamic pages populate via ISR at runtime
  if (isBuild) {
    return [...staticPages, ...exchangePages]
  }

  // 并行获取动态数据
  const [traders, posts, groups, libraryItems, userProfiles] = await Promise.all([
    getAllTraders(),
    getPopularPosts(),
    getAllGroups(),
    getAllLibraryItems(),
    getUserProfiles(),
  ])
  
  // 交易员页面
  const traderPages: MetadataRoute.Sitemap = traders.map(trader => ({
    url: `${BASE_URL}/trader/${encodeURIComponent(trader.handle)}`,
    lastModified: trader.updated_at,
    changeFrequency: "daily" as const,
    priority: 0.8,
  }))
  
  // 帖子页面
  const postPages: MetadataRoute.Sitemap = posts.map(post => ({
    url: `${BASE_URL}/post/${post.id}`,
    lastModified: post.updated_at,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }))
  
  // 小组页面
  const groupPages: MetadataRoute.Sitemap = groups.map(group => ({
    url: `${BASE_URL}/groups/${group.id}`,
    lastModified: group.updated_at,
    changeFrequency: "daily" as const,
    priority: 0.7,
  }))
  
  // 书库页面
  const libraryPages: MetadataRoute.Sitemap = libraryItems.map(item => ({
    url: `${BASE_URL}/library/${item.id}`,
    lastModified: item.updated_at,
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }))

  // 用户主页
  const userPages: MetadataRoute.Sitemap = userProfiles.map(user => ({
    url: `${BASE_URL}/u/${encodeURIComponent(user.handle)}`,
    lastModified: user.updated_at,
    changeFrequency: "weekly" as const,
    priority: 0.5,
  }))

  // 合并所有页面（traders 优先，总量控制在 Google 50k 限制内）
  return [
    ...staticPages,
    ...exchangePages,       // ~30 exchange ranking pages
    ...traderPages,         // ~44,962 — SEO 核心资产
    ...postPages,
    ...groupPages,
    ...libraryPages,
    ...userPages,
  ]
}

// 配置：每 1 小时重新生成
export const revalidate = 3600
