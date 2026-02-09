/**
 * Flash News API - 快讯功能
 * 时间线形式的实时快讯，覆盖加密货币、宏观经济、金融市场动态
 */

import { NextRequest } from 'next/server'
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
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import logger from '@/lib/logger'

export const runtime = 'nodejs'

// 快讯类型定义
interface FlashNews {
  id?: string
  title: string
  title_zh?: string
  title_en?: string
  content?: string
  source: string
  source_url?: string
  category?: 'crypto' | 'macro' | 'defi' | 'regulation' | 'market' | 'btc_eth' | 'altcoin' | 'exchange'
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
  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    // 解析查询参数
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = Math.min(
      MAX_ITEMS_PER_PAGE,
      Math.max(1, parseInt(searchParams.get('limit') || ITEMS_PER_PAGE.toString()))
    )
    const category = searchParams.get('category')
    const importance = searchParams.get('importance')
    const offset = (page - 1) * limit

    // Use tiered cache (memory → Redis → DB)
    const cacheKey = `api:flash-news:${page}:${limit}:${category || 'all'}:${importance || 'all'}`
    const result = await tieredGetOrSet(
      cacheKey,
      async () => {
        // 构建查询
        let query = supabase
          .from('flash_news')
          .select('*', { count: 'exact' })
          .order('published_at', { ascending: false })
          .range(offset, offset + limit - 1)

        // 添加筛选条件 — support new broad categories + legacy DB values
        const CATEGORY_MAP: Record<string, string[]> = {
          btc_eth: ['crypto'],          // BTC/ETH maps to crypto in DB
          altcoin: ['market'],          // 山寨币 maps to market in DB
          defi: ['defi'],
          macro: ['macro', 'regulation'], // 宏观/监管 combines both
          exchange: ['market'],          // 交易所 — will refine when DB has this category
        }
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
          throw new Error(queryError.message)
        }

        return {
          news: data || [],
          pagination: {
            page,
            limit,
            total: count || 0,
            totalPages: Math.ceil((count || 0) / limit),
            hasNext: count ? (page * limit) < count : false,
            hasPrev: page > 1,
          }
        }
      },
      'hot',
      ['flash-news']
    )

    return success(result, 200, { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' })
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
    const supabase = getSupabaseAdmin()

    // 检查管理员权限
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .single()

    if (!userProfile || userProfile.role !== 'admin') {
      return error('权限不足', 403)
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
      return error('标题和来源为必填字段', 400)
    }

    // 验证分类
    const validCategories = ['crypto', 'macro', 'defi', 'regulation', 'market']
    if (newsItem.category && !validCategories.includes(newsItem.category)) {
      return error('无效的分类', 400)
    }

    // 验证重要性
    const validImportance = ['breaking', 'important', 'normal']
    if (newsItem.importance && !validImportance.includes(newsItem.importance)) {
      return error('无效的重要性等级', 400)
    }

    const newsData = {
      title: title,
      title_zh: newsItem.title_zh || null,
      title_en: newsItem.title_en || null,
      content: newsItem.content || null,
      source: source,
      source_url: newsItem.source_url || null,
      category: newsItem.category || 'crypto',
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
      logger.error('[flash-news] 创建失败:', insertError)
      return error('创建快讯失败', 500)
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
    const supabase = getSupabaseAdmin()

    // 检查管理员权限
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .single()

    if (!userProfile || userProfile.role !== 'admin') {
      return error('权限不足', 403)
    }

    const { searchParams } = new URL(request.url)
    const newsId = searchParams.get('id')

    if (!newsId) {
      return error('缺少快讯 ID', 400)
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
        return error('标题无效', 400)
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
      const validCategories = ['crypto', 'macro', 'defi', 'regulation', 'market']
      if (!validCategories.includes(newsItem.category)) {
        return error('无效的分类', 400)
      }
      updateData.category = newsItem.category
    }

    if (newsItem.importance) {
      const validImportance = ['breaking', 'important', 'normal']
      if (!validImportance.includes(newsItem.importance)) {
        return error('无效的重要性等级', 400)
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
      logger.error('[flash-news] 更新失败:', updateError)
      return error('更新快讯失败', 500)
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
    const supabase = getSupabaseAdmin()

    // 检查管理员权限
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .single()

    if (!userProfile || userProfile.role !== 'admin') {
      return error('权限不足', 403)
    }

    const { searchParams } = new URL(request.url)
    const newsId = searchParams.get('id')

    if (!newsId) {
      return error('缺少快讯 ID', 400)
    }

    const { error: deleteError } = await supabase
      .from('flash_news')
      .delete()
      .eq('id', newsId)

    if (deleteError) {
      logger.error('[flash-news] 删除失败:', deleteError)
      return error('删除快讯失败', 500)
    }

    return success({ deleted: true })
  } catch (err: unknown) {
    return handleError(err)
  }
}