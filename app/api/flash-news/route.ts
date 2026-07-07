/**
 * Flash News API - 快讯功能
 * 时间线形式的实时快讯，覆盖加密货币、宏观经济、金融市场动态
 */

import { NextRequest } from 'next/server'
import { parsePage, parseLimit } from '@/lib/utils/safe-parse'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import logger from '@/lib/logger'

export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

// 快讯类型定义
interface FlashNews {
  id?: string
  title: string
  title_zh?: string
  title_en?: string
  title_ja?: string
  title_ko?: string
  content?: string
  content_zh?: string
  content_en?: string
  content_ja?: string
  content_ko?: string
  source: string
  source_url?: string
  category?:
    | 'crypto'
    | 'macro'
    | 'defi'
    | 'regulation'
    | 'market'
    | 'btc_eth'
    | 'altcoin'
    | 'exchange'
  importance?: 'breaking' | 'important' | 'normal'
  tags?: string[]
  published_at?: string
}

const ITEMS_PER_PAGE = 20
const MAX_ITEMS_PER_PAGE = 50

/**
 * GET - 获取快讯列表
 * 支持分页、分类筛选、重要性筛选
 */
export async function GET(request: NextRequest) {
  // 限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { searchParams } = new URL(request.url)

    // 解析查询参数
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'), ITEMS_PER_PAGE, MAX_ITEMS_PER_PAGE)
    const category = searchParams.get('category')
    const importance = searchParams.get('importance')
    const offset = (page - 1) * limit

    // 筛选条件 — support new broad categories + legacy DB values.
    const CATEGORY_MAP: Record<string, string[]> = {
      btc_eth: ['crypto', 'btc_eth'], // BTC/ETH: legacy 'crypto' + new 'btc_eth'
      altcoin: ['market', 'altcoin'], // 山寨币: legacy 'market' + new 'altcoin'
      defi: ['defi'],
      macro: ['macro', 'regulation'], // 宏观/监管 combines both
      exchange: ['exchange'], // 交易所
    }

    // Core DB fetch logic — extracted so it can be called with or without cache
    const fetchFromDb = async () => {
      // 构建查询
      // KEEP 'exact' — powers the flash-news pagination UI. flash_news
      // is rotated at 365d (bounded size) so exact COUNT(*) is cheap
      // (indexed published_at DESC).
      let query = supabase
        .from('flash_news')
        .select(
          // source_url/content/content_zh/content_en 必须下发:NewsCard 靠 source_url
          // 渲染来源外链(缺则全站 0 外跳),content* 供 getNewsContent + 翻译管线
          // (缺则 content 恒 undefined,translateNewsContent 永不触发)。
          // title_ja/ko + content_ja/ko (U7-5) 供 ja/ko 读者显示母语标题/正文,
          // 缺则前端回落 title_en/title。列已 REST 探针核实存在。
          'id, title, title_zh, title_en, title_ja, title_ko, content, content_zh, content_en, content_ja, content_ko, source, source_url, category, importance, published_at, tags',
          {
            count: 'exact',
          }
        )
        .order('published_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (category) {
        const mapped = CATEGORY_MAP[category]
        if (mapped && mapped.length === 1) {
          query = query.eq('category', mapped[0])
        } else if (mapped && mapped.length > 1) {
          query = query.in('category', mapped)
        } else if (['crypto', 'macro', 'defi', 'regulation', 'market'].includes(category)) {
          // Legacy direct match
          query = query.eq('category', category)
        }
      }

      if (importance && ['breaking', 'important', 'normal'].includes(importance)) {
        query = query.eq('importance', importance)
      }

      const { data, error: queryError, count } = await query

      if (queryError) {
        // PostgREST returns PGRST103 ("Requested range not satisfiable") when the
        // offset is past the row count — e.g. page 2+ of a category with fewer
        // than `offset+1` rows, or an empty category like 'exchange' (total 0).
        // That is NOT a server error, it just means "this page is past the end".
        // Re-fetch the true count (cheap HEAD) and return an empty page so
        // pagination stays correct instead of 500-ing.
        if (
          queryError.code === 'PGRST103' ||
          /range not satisfiable/i.test(queryError.message || '')
        ) {
          let countQuery = supabase.from('flash_news').select('id', { count: 'exact', head: true })
          if (category) {
            const mapped = CATEGORY_MAP[category]
            if (mapped && mapped.length === 1) countQuery = countQuery.eq('category', mapped[0])
            else if (mapped && mapped.length > 1) countQuery = countQuery.in('category', mapped)
            else if (['crypto', 'macro', 'defi', 'regulation', 'market'].includes(category))
              countQuery = countQuery.eq('category', category)
          }
          if (importance && ['breaking', 'important', 'normal'].includes(importance)) {
            countQuery = countQuery.eq('importance', importance)
          }
          const { count: total } = await countQuery
          const t = total || 0
          return {
            news: [],
            pagination: {
              page,
              limit,
              total: t,
              totalPages: Math.ceil(t / limit),
              hasNext: false,
              hasPrev: page > 1,
            },
          }
        }
        throw new Error(queryError.message)
      }

      return {
        news: data || [],
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit),
          hasNext: count ? page * limit < count : false,
          hasPrev: page > 1,
        },
      }
    }

    // Use tiered cache (memory → Redis → DB) with fallback to direct DB on cache errors
    const cacheKey = `api:flash-news:${page}:${limit}:${category || 'all'}:${importance || 'all'}`
    let result
    try {
      result = await tieredGetOrSet(cacheKey, fetchFromDb, 'hot', ['flash-news'])
    } catch (cacheErr) {
      // Redis unavailable or cache error — fall back to direct DB query
      logger.warn('[flash-news] Cache error, falling back to direct DB:', cacheErr)
      result = await fetchFromDb()
    }

    return success(result, 200, {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * POST - 创建新快讯
 * 仅管理员可用
 */
export async function POST(request: NextRequest) {
  // 限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    // 检查管理员权限
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role')
      // user_profiles keys on `id` (no user_id column — filtering on it 400s with 42703,
      // which made this admin check reject everyone); maybeSingle tolerates missing profiles
      .eq('id', user.id)
      .maybeSingle()

    if (!userProfile || userProfile.role !== 'admin') {
      return error('Insufficient permissions', 403)
    }

    const body = await request.json()
    const newsItem: FlashNews = body

    // 验证必填字段
    const title = validateString(newsItem.title, {
      required: true,
      maxLength: 200,
      fieldName: 'title',
    })

    const source = validateString(newsItem.source, {
      required: true,
      maxLength: 100,
      fieldName: 'source',
    })

    if (!title || !source) {
      return error('Title and source are required', 400)
    }

    // 验证分类 — support both legacy and new category values
    const validCategories = [
      'crypto',
      'macro',
      'defi',
      'regulation',
      'market',
      'btc_eth',
      'altcoin',
      'exchange',
    ]
    if (newsItem.category && !validCategories.includes(newsItem.category)) {
      return error('Invalid category', 400)
    }

    // 验证重要性
    const validImportance = ['breaking', 'important', 'normal']
    if (newsItem.importance && !validImportance.includes(newsItem.importance)) {
      return error('Invalid importance level', 400)
    }

    const newsData = {
      title: title,
      title_zh: newsItem.title_zh || null,
      title_en: newsItem.title_en || null,
      content: newsItem.content || null,
      source: source,
      source_url: newsItem.source_url || null,
      category: newsItem.category || 'btc_eth',
      importance: newsItem.importance || 'normal',
      tags: newsItem.tags || [],
      published_at: newsItem.published_at || new Date().toISOString(),
    }

    const { data, error: insertError } = await supabase
      .from('flash_news')
      .insert(newsData)
      .select()
      .single()

    if (insertError) {
      logger.error('[flash-news] 创建Failed:', insertError)
      return error('Failed to create flash news', 500)
    }

    return success({ news: data, created: true })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * PUT - 更新快讯
 * 仅管理员可用
 */
export async function PUT(request: NextRequest) {
  // 限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    // 检查管理员权限
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role')
      // user_profiles keys on `id` (no user_id column — filtering on it 400s with 42703,
      // which made this admin check reject everyone); maybeSingle tolerates missing profiles
      .eq('id', user.id)
      .maybeSingle()

    if (!userProfile || userProfile.role !== 'admin') {
      return error('Insufficient permissions', 403)
    }

    const { searchParams } = new URL(request.url)
    const newsId = searchParams.get('id')

    if (!newsId) {
      return error('Missing flash news ID', 400)
    }

    const body = await request.json()
    const newsItem: FlashNews = body

    // 验证字段（允许部分更新）
    const updateData: Partial<FlashNews> = {}

    if (newsItem.title) {
      const title = validateString(newsItem.title, {
        required: true,
        maxLength: 200,
        fieldName: 'title',
      })
      if (!title) {
        return error('Invalid title', 400)
      }
      updateData.title = title
    }

    if (newsItem.title_zh) updateData.title_zh = newsItem.title_zh
    if (newsItem.title_en) updateData.title_en = newsItem.title_en
    if (newsItem.content) updateData.content = newsItem.content
    if (newsItem.source) updateData.source = newsItem.source
    if (newsItem.source_url) updateData.source_url = newsItem.source_url
    if (newsItem.tags) updateData.tags = newsItem.tags

    if (newsItem.category) {
      const validCategories = [
        'crypto',
        'macro',
        'defi',
        'regulation',
        'market',
        'btc_eth',
        'altcoin',
        'exchange',
      ]
      if (!validCategories.includes(newsItem.category)) {
        return error('Invalid category', 400)
      }
      updateData.category = newsItem.category
    }

    if (newsItem.importance) {
      const validImportance = ['breaking', 'important', 'normal']
      if (!validImportance.includes(newsItem.importance)) {
        return error('Invalid importance level', 400)
      }
      updateData.importance = newsItem.importance
    }

    const { data, error: updateError } = await supabase
      .from('flash_news')
      .update(updateData)
      .eq('id', newsId)
      .select()
      .single()

    if (updateError) {
      logger.error('[flash-news] 更新Failed:', updateError)
      return error('Failed to update flash news', 500)
    }

    return success({ news: data, updated: true })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * DELETE - 删除快讯
 * 仅管理员可用
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient

    // 检查管理员权限
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role')
      // user_profiles keys on `id` (no user_id column — filtering on it 400s with 42703,
      // which made this admin check reject everyone); maybeSingle tolerates missing profiles
      .eq('id', user.id)
      .maybeSingle()

    if (!userProfile || userProfile.role !== 'admin') {
      return error('Insufficient permissions', 403)
    }

    const { searchParams } = new URL(request.url)
    const newsId = searchParams.get('id')

    if (!newsId) {
      return error('Missing flash news ID', 400)
    }

    const { error: deleteError } = await supabase.from('flash_news').delete().eq('id', newsId)

    if (deleteError) {
      logger.error('[flash-news] 删除Failed:', deleteError)
      return error('Failed to delete flash news', 500)
    }

    return success({ deleted: true })
  } catch (err: unknown) {
    return handleError(err)
  }
}
