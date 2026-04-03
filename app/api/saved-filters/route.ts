/**
 * 保存的筛选配置 API
 * Pro 会员功能：保存和管理筛选配置
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { hasFeatureAccess } from '@/lib/types/premium'
import { createLogger } from '@/lib/utils/logger'

export const runtime = 'nodejs'

const logger = createLogger('saved-filters')

const MAX_SAVED_FILTERS = 10

// Zod schema for filter_config
const FilterConfigSchema = z.object({
  category: z.array(z.string()).optional(),
  exchange: z.array(z.string()).optional(),
  roi_min: z.number().min(-100).max(100000).optional(),
  roi_max: z.number().min(-100).max(100000).optional(),
  drawdown_min: z.number().min(0).max(100).optional(),
  drawdown_max: z.number().min(0).max(100).optional(),
  period: z.enum(['7D', '30D', '90D']).optional(),
  min_pnl: z.number().min(-1e12).max(1e12).optional(),
  min_score: z.number().min(0).max(100).optional(),
  min_win_rate: z.number().min(0).max(100).optional(),
}).passthrough()

// Zod schema for POST /api/saved-filters
const SaveFilterSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1, 'Filter name is required').max(50, 'Filter name must be at most 50 characters'),
  description: z.string().max(200).optional().nullable(),
  filter_config: FilterConfigSchema,
  is_default: z.boolean().optional().default(false),
})

/**
 * GET - 获取用户的筛选配置列表
 */
export const GET = withAuth(async ({ user, supabase }) => {
  // 获取用户订阅等级
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', user.id)
    .maybeSingle()

  const tier = subscription?.tier || 'free'

  // 检查是否有权限
  if (!hasFeatureAccess(tier, 'advanced_filter')) {
    return NextResponse.json({ success: false, error: 'Pro membership required' }, { status: 403 })
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
    throw new Error('Failed to fetch saved filters')
  }

  return { filters: filters || [] }
}, { name: 'get-saved-filters', rateLimit: 'authenticated' })

/**
 * POST - 创建或更新筛选配置
 */
export const POST = withAuth(async ({ user, supabase, request }) => {
  // 获取用户订阅等级
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', user.id)
    .maybeSingle()

  const tier = subscription?.tier || 'free'

  // 检查是否有权限
  if (!hasFeatureAccess(tier, 'advanced_filter')) {
    return NextResponse.json({ success: false, error: 'Pro membership required' }, { status: 403 })
  }

  const body = await request.json()
  const parsed = SaveFilterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const filter = parsed.data

  const filterData = {
    user_id: user.id,
    name: filter.name,
    description: filter.description || null,
    filter_config: filter.filter_config,
    is_default: filter.is_default,
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
      throw new Error('Failed to update filter')
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
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_SAVED_FILTERS} saved filters allowed` },
        { status: 400 }
      )
    }

    const { data, error: insertError } = await supabase
      .from('saved_filters')
      .insert(filterData)
      .select()
      .single()

    if (insertError) {
      logger.error('[saved-filters] 创建Failed:', insertError)
      throw new Error('Failed to create filter')
    }
    result = data
  }

  return { filter: result, created: !filter.id }
}, { name: 'post-saved-filters', rateLimit: 'authenticated' })

/**
 * PUT - 记录使用筛选配置（更新使用统计）
 */
export const PUT = withAuth(async ({ user, supabase, request }) => {
  const { searchParams } = new URL(request.url)
  const filterId = searchParams.get('id')

  if (!filterId) {
    return NextResponse.json({ success: false, error: 'Filter ID is required' }, { status: 400 })
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

  return { updated: true }
}, { name: 'put-saved-filters', rateLimit: 'authenticated' })

/**
 * DELETE - 删除筛选配置
 */
export const DELETE = withAuth(async ({ user, supabase, request }) => {
  const { searchParams } = new URL(request.url)
  const filterId = searchParams.get('id')

  if (!filterId) {
    return NextResponse.json({ success: false, error: 'Filter ID is required' }, { status: 400 })
  }

  const { error: deleteError } = await supabase
    .from('saved_filters')
    .delete()
    .eq('id', filterId)
    .eq('user_id', user.id)

  if (deleteError) {
    logger.error('[saved-filters] 删除Failed:', deleteError)
    throw new Error('Failed to delete filter')
  }

  return { deleted: true }
}, { name: 'delete-saved-filters', rateLimit: 'authenticated' })
