/**
 * 动态 Sitemap 生成
 * 包含所有公开页面：首页、交易员、帖子、小组
 */

import type { MetadataRoute } from "next"
import { getSupabaseAdmin } from "@/lib/supabase/server"
import { dataLogger } from "@/lib/utils/logger"

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"

// 每次最多生成的 URL 数量（Google 限制 50,000）
const MAX_URLS_PER_SITEMAP = 10000

/**
 * 获取所有交易员 handle
 */
async function getAllTraders(): Promise<Array<{ handle: string; updated_at: string }>> {
  try {
    const supabase = getSupabaseAdmin()
    
    // 从 trader_sources 获取所有有 handle 的交易员
    const { data, error } = await supabase
      .from('trader_sources')
      .select('handle, source_trader_id')
      .not('handle', 'is', null)
      .limit(MAX_URLS_PER_SITEMAP)
    
    if (error) {
      dataLogger.error('sitemap 获取交易员失败:', error)
      return []
    }
    
    // 获取最新快照时间
    const { data: latestSnapshot } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    
    const lastMod = latestSnapshot?.captured_at || new Date().toISOString()
    
    return (data || []).map(t => ({
      handle: t.handle || t.source_trader_id,
      updated_at: lastMod,
    }))
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
      .limit(1000) // 限制热门帖子数量
    
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
    {
      url: `${BASE_URL}/rankings`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/pricing`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
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
      url: `${BASE_URL}/login`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
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
  ]
  
  // 并行获取动态数据
  const [traders, posts, groups] = await Promise.all([
    getAllTraders(),
    getPopularPosts(),
    getAllGroups(),
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
  
  // 合并所有页面
  const allPages = [
    ...staticPages,
    ...traderPages,
    ...postPages,
    ...groupPages,
  ]
  
  // 限制总数量
  return allPages.slice(0, MAX_URLS_PER_SITEMAP)
}

// 配置：每 6 小时重新生成
export const revalidate = 21600
