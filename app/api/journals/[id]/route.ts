/**
 * 单个日记 API
 * GET /api/journals/[id] - 获取日记详情
 * PUT /api/journals/[id] - 更新日记
 * DELETE /api/journals/[id] - 删除日记
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  requireAuth,
  success,
  handleError,
  validateString,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import {
  getJournal,
  getJournalComments,
  updateJournal,
  deleteJournal,
  type JournalVisibility,
} from '@/lib/data/follow-journals'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/journals/[id]
 * 获取日记详情
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少日记 ID'), 'journal GET')
    }

    const user = await getAuthUser(request)
    
    const [journal, comments] = await Promise.all([
      getJournal(supabase, id, user?.id),
      getJournalComments(supabase, id),
    ])

    if (!journal) {
      return handleError(new Error('日记不存在或无权访问'), 'journal GET')
    }

    return success({ journal, comments })
  } catch (error) {
    return handleError(error, 'journal GET')
  }
}

/**
 * PUT /api/journals/[id]
 * 更新日记
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params
    const body = await request.json()

    if (!id) {
      return handleError(new Error('缺少日记 ID'), 'journal PUT')
    }

    const title = validateString(body.title, { maxLength: 200 })
    const content = validateString(body.content, { minLength: 10, maxLength: 10000 })
    const visibility = validateEnum(
      body.visibility,
      ['public', 'followers', 'private'] as const
    )

    const journal = await updateJournal(supabase, id, user.id, {
      title: title ?? undefined,
      content: content ?? undefined,
      profit_loss_percent: body.profit_loss_percent,
      profit_loss_amount: body.profit_loss_amount,
      start_date: body.start_date,
      end_date: body.end_date,
      initial_capital: body.initial_capital,
      screenshots: Array.isArray(body.screenshots) ? body.screenshots : undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      visibility: visibility as JournalVisibility | undefined,
      is_pinned: typeof body.is_pinned === 'boolean' ? body.is_pinned : undefined,
    })

    return success({ journal, message: '日记已更新' })
  } catch (error) {
    return handleError(error, 'journal PUT')
  }
}

/**
 * DELETE /api/journals/[id]
 * 删除日记
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少日记 ID'), 'journal DELETE')
    }

    await deleteJournal(supabase, id, user.id)

    return success({ message: '日记已删除' })
  } catch (error) {
    return handleError(error, 'journal DELETE')
  }
}
