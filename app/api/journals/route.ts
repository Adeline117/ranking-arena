/**
 * 跟单日记 API
 * GET /api/journals - 获取日记列表
 * POST /api/journals - 创建日记
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  requireAuth,
  success,
  successWithPagination,
  handleError,
  validateString,
  validateNumber,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import {
  getJournals,
  createJournal,
  type JournalVisibility,
} from '@/lib/data/follow-journals'

/**
 * GET /api/journals
 * 获取跟单日记列表
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const trader_id = validateString(searchParams.get('trader_id')) ?? undefined
    const source = validateString(searchParams.get('source')) ?? undefined
    const user_id = validateString(searchParams.get('user_id')) ?? undefined
    const sort_by = validateEnum(
      searchParams.get('sort_by'),
      ['created_at', 'like_count', 'view_count'] as const
    ) ?? 'created_at'
    const sort_order = validateEnum(
      searchParams.get('sort_order'),
      ['asc', 'desc'] as const
    ) ?? 'desc'

    const user = await getAuthUser(request)

    const journals = await getJournals(
      supabase,
      { limit, offset, trader_id, source, user_id, sort_by, sort_order },
      user?.id
    )

    return successWithPagination(
      { journals },
      { limit, offset, has_more: journals.length === limit }
    )
  } catch (error) {
    return handleError(error, 'journals GET')
  }
}

/**
 * POST /api/journals
 * 创建跟单日记
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const trader_id = validateString(body.trader_id, { required: true, fieldName: 'trader_id' })
    const source = validateString(body.source, { required: true, fieldName: 'source' })
    const content = validateString(body.content, { required: true, minLength: 10, maxLength: 10000, fieldName: 'content' })

    if (!trader_id || !source || !content) {
      return handleError(new Error('缺少必填参数'), 'journals POST')
    }

    const title = validateString(body.title, { maxLength: 200 })
    const profit_loss_percent = body.profit_loss_percent !== undefined 
      ? Number(body.profit_loss_percent) 
      : undefined
    const profit_loss_amount = body.profit_loss_amount !== undefined 
      ? Number(body.profit_loss_amount) 
      : undefined
    const start_date = validateString(body.start_date)
    const end_date = validateString(body.end_date)
    const initial_capital = body.initial_capital !== undefined 
      ? Number(body.initial_capital) 
      : undefined
    const visibility = validateEnum(
      body.visibility,
      ['public', 'followers', 'private'] as const
    ) ?? 'public'

    const journal = await createJournal(supabase, user.id, {
      trader_id,
      source,
      title: title ?? undefined,
      content,
      profit_loss_percent,
      profit_loss_amount,
      start_date: start_date ?? undefined,
      end_date: end_date ?? undefined,
      initial_capital,
      screenshots: Array.isArray(body.screenshots) ? body.screenshots : [],
      tags: Array.isArray(body.tags) ? body.tags : [],
      visibility: visibility as JournalVisibility,
    })

    return success({ journal, message: '日记发布成功' })
  } catch (error) {
    return handleError(error, 'journals POST')
  }
}
