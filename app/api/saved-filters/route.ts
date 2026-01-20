/**
 * 保存的筛选配置 API
 * Pro 会员功能：保存和管理筛选配置
 */

import { NextRequest, NextResponse } from 'next/server'
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

export const runtime = 'nodejs'

// 筛选配置类型
interface FilterConfig {
  category?: string[]      // 类型：futures, spot, web3
  exchange?: string[]      // 交易所
  roi_min?: number         // 最小 ROI
  roi_max?: number         // 最大 ROI
  drawdown_min?: number    // 最小回撤
  drawdown_max?: number    // 最大回撤
  period?: '7D' | '30D' | '90D'  // 周期
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
      return error('此功能需要 Pro 会员', 403)
    }

    // 获取筛选配置列表
    const { data: filters, error: queryError } = await supabase
      .from('saved_filters')
      .select('*')
      .eq('user_id', user.id)
      .order('is_default', { ascending: false })
      .order('updated_at', { ascending: false })

    if (queryError) {
      console.error('[saved-filters] 查询失败:', queryError)
      return error('获取筛选配置失败', 500)
    }

    return success({ filters: filters || [] })
  } catch (err) {
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
      return error('此功能需要 Pro 会员', 403)
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
      return error('请输入筛选配置名称', 400)
    }

    // 验证 filter_config
    if (!filter.filter_config || typeof filter.filter_config !== 'object') {
      return error('筛选配置无效', 400)
    }

    // 如果是新建，检查数量限制
    if (!filter.id) {
      const { count } = await supabase
        .from('saved_filters')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)

      if ((count || 0) >= MAX_SAVED_FILTERS) {
        return error(`最多只能保存 ${MAX_SAVED_FILTERS} 个筛选配置`, 400)
      }
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
        console.error('[saved-filters] 更新失败:', updateError)
        return error('更新筛选配置失败', 500)
      }
      result = data
    } else {
      // 创建新配置
      const { data, error: insertError } = await supabase
        .from('saved_filters')
        .insert(filterData)
        .select()
        .single()

      if (insertError) {
        console.error('[saved-filters] 创建失败:', insertError)
        return error('创建筛选配置失败', 500)
      }
      result = data
    }

    return success({ filter: result, created: !filter.id })
  } catch (err) {
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
      return error('缺少筛选配置 ID', 400)
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
  } catch (err) {
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
      return error('缺少筛选配置 ID', 400)
    }

    const { error: deleteError } = await supabase
      .from('saved_filters')
      .delete()
      .eq('id', filterId)
      .eq('user_id', user.id)

    if (deleteError) {
      console.error('[saved-filters] 删除失败:', deleteError)
      return error('删除筛选配置失败', 500)
    }

    return success({ deleted: true })
  } catch (err) {
    return handleError(err)
  }
}
