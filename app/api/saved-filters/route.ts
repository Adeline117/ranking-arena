/**
 * 保存的筛选配置 API
 * Pro 会员功能：保存和管理筛选配置
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
import { hasFeatureAccess } from '@/lib/types/premium'
import logger from '@/lib/logger'

export const runtime = 'nodejs'

// 筛选配置类型
interface FilterConfig {
  category?: string[]      // 类型：futures, spot, web3
  exchange?: string[]      // 交易所
  roi_min?: number         // 最小 ROI
  roi_max?: number         // 最大 ROI
  drawdown_min?: number    // 最小回撤
  drawdown_max?: number    // 最大回撤
  period?: '7D' | '30D' | '90D'  // period
  min_pnl?: number         // 最小 PnL
  min_score?: number       // 最小 Arena Score
  min_win_rate?: number    // 最小胜率
}

interface SavedFilter {
  id?: string
  name: string
  description?: string
  filter_config: FilterConfig
  is_default?: boolean
}

const MAX_SAVED_FILTERS = 10

/**
 * GET - 获取用户的筛选配置列表
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = subscription?.tier || 'free'

    // 检查是否有权限
    if (!hasFeatureAccess(tier, 'advanced_filter')) {
      return error('Pro membership required', 403)
    }

    // 获取筛选配置列表
    const { data: filters, error: queryError } = await supabase
      .from('saved_filters')
      .select('id, name, description, filter_config, is_default, use_count, last_used_at, updated_at')
      .eq('user_id', user.id)
      .order('is_default', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(MAX_SAVED_FILTERS)

    if (queryError) {
      logger.error('[saved-filters] 查询Failed:', queryError)
      return error('Failed to fetch saved filters', 500)
    }

    return success({ filters: filters || [] })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * POST - 创建或更新筛选配置
 */
export async function POST(request: NextRequest) {
  // 限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取用户订阅等级
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()

    const tier = subscription?.tier || 'free'

    // 检查是否有权限
    if (!hasFeatureAccess(tier, 'advanced_filter')) {
      return error('Pro membership required', 403)
    }

    const body = await request.json()
    const filter: SavedFilter = body

    // 验证必填字段
    const name = validateString(filter.name, {
      required: true,
      maxLength: 50,
      fieldName: 'name',
    })

    if (!name) {
      return error('Filter name is required', 400)
    }

    // 验证 filter_config
    if (!filter.filter_config || typeof filter.filter_config !== 'object') {
      return error('Invalid filter config', 400)
    }

    const filterData = {
      user_id: user.id,
      name: name,
      description: filter.description || null,
      filter_config: filter.filter_config,
      is_default: filter.is_default ?? false,
    }

    let result
    if (filter.id) {
      // 更新现有配置
      const { data, error: updateError } = await supabase
        .from('saved_filters')
        .update(filterData)
        .eq('id', filter.id)
        .eq('user_id', user.id) // 确保只能更新自己的
        .select()
        .single()

      if (updateError) {
        logger.error('[saved-filters] 更新Failed:', updateError)
        return error('Failed to update filter', 500)
      }
      result = data
    } else {
      // 创建新配置 - check count and insert; if race causes over-limit,
      // the insert still succeeds (acceptable minor overshoot vs. data loss)
      const { count } = await supabase
        .from('saved_filters')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)

      if ((count || 0) >= MAX_SAVED_FILTERS) {
        return error(`Maximum ${MAX_SAVED_FILTERS} saved filters allowed`, 400)
      }

      const { data, error: insertError } = await supabase
        .from('saved_filters')
        .insert(filterData)
        .select()
        .single()

      if (insertError) {
        logger.error('[saved-filters] 创建Failed:', insertError)
        return error('Failed to create filter', 500)
      }
      result = data
    }

    return success({ filter: result, created: !filter.id })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * PUT - 记录使用筛选配置（更新使用统计）
 */
export async function PUT(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { searchParams } = new URL(request.url)
    const filterId = searchParams.get('id')

    if (!filterId) {
      return error('Filter ID is required', 400)
    }

    // 更新使用统计
    const { error: updateError } = await supabase
      .from('saved_filters')
      .update({
        use_count: supabase.rpc('increment', { x: 1 }),
        last_used_at: new Date().toISOString(),
      })
      .eq('id', filterId)
      .eq('user_id', user.id)

    // 如果 rpc 不存在，使用原生更新
    if (updateError) {
      const { data: current } = await supabase
        .from('saved_filters')
        .select('use_count')
        .eq('id', filterId)
        .eq('user_id', user.id)
        .single()

      await supabase
        .from('saved_filters')
        .update({
          use_count: (current?.use_count || 0) + 1,
          last_used_at: new Date().toISOString(),
        })
        .eq('id', filterId)
        .eq('user_id', user.id)
    }

    return success({ updated: true })
  } catch (err: unknown) {
    return handleError(err)
  }
}

/**
 * DELETE - 删除筛选配置
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { searchParams } = new URL(request.url)
    const filterId = searchParams.get('id')

    if (!filterId) {
      return error('Filter ID is required', 400)
    }

    const { error: deleteError } = await supabase
      .from('saved_filters')
      .delete()
      .eq('id', filterId)
      .eq('user_id', user.id)

    if (deleteError) {
      logger.error('[saved-filters] 删除Failed:', deleteError)
      return error('Failed to delete filter', 500)
    }

    return success({ deleted: true })
  } catch (err: unknown) {
    return handleError(err)
  }
}
