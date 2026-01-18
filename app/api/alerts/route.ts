/**
 * 用户告警 API
 * GET /api/alerts - 获取告警历史
 * POST /api/alerts - 创建告警配置
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
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
  getUserAlerts,
  getUserAlertConfigs,
  createAlertConfig,
  getUnreadAlertCount,
  markAllAlertsRead,
} from '@/lib/data/alerts'
import type { AlertType } from '@/lib/types/alerts'

/**
 * GET /api/alerts
 * 获取用户的告警历史和配置
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const type = validateString(searchParams.get('type'))
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const unread_only = searchParams.get('unread_only') === 'true'
    const trader_id = validateString(searchParams.get('trader_id')) ?? undefined
    const source = validateString(searchParams.get('source')) ?? undefined

    // 根据 type 参数决定返回什么
    if (type === 'configs') {
      // 获取告警配置
      const configs = await getUserAlertConfigs(supabase, user.id)
      return success({ configs })
    }

    // 默认获取告警历史
    const [alerts, unreadCount] = await Promise.all([
      getUserAlerts(supabase, user.id, { limit, offset, unread_only, trader_id, source }),
      getUnreadAlertCount(supabase, user.id),
    ])

    return successWithPagination(
      { alerts, unread_count: unreadCount },
      { limit, offset, has_more: alerts.length === limit }
    )
  } catch (error) {
    return handleError(error, 'alerts GET')
  }
}

/**
 * POST /api/alerts
 * 创建告警配置
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

    if (!trader_id || !source) {
      return handleError(new Error('缺少必填参数'), 'alerts POST')
    }

    const drawdown_threshold = validateNumber(body.drawdown_threshold, { min: 1, max: 100 })
    const drawdown_spike_threshold = validateNumber(body.drawdown_spike_threshold, { min: 1, max: 50 })
    const win_rate_drop_threshold = validateNumber(body.win_rate_drop_threshold, { min: 1, max: 50 })
    const profit_target = validateNumber(body.profit_target, { min: 1 })
    const stop_loss = validateNumber(body.stop_loss, { min: 1 })

    const config = await createAlertConfig(supabase, user.id, {
      trader_id,
      source,
      drawdown_threshold: drawdown_threshold ?? undefined,
      drawdown_spike_threshold: drawdown_spike_threshold ?? undefined,
      win_rate_drop_threshold: win_rate_drop_threshold ?? undefined,
      profit_target: profit_target ?? undefined,
      stop_loss: stop_loss ?? undefined,
      notify_in_app: body.notify_in_app ?? true,
      notify_email: body.notify_email ?? false,
      notify_push: body.notify_push ?? false,
      alert_types: body.alert_types as AlertType[] | undefined,
    })

    return success({ config, message: '告警配置创建成功' })
  } catch (error) {
    return handleError(error, 'alerts POST')
  }
}

/**
 * PUT /api/alerts
 * 批量操作：标记所有告警为已读
 */
export async function PUT(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    if (body.mark_all_read) {
      const count = await markAllAlertsRead(supabase, user.id)
      return success({ message: `已标记 ${count} 条告警为已读` })
    }

    return handleError(new Error('无效的操作'), 'alerts PUT')
  } catch (error) {
    return handleError(error, 'alerts PUT')
  }
}
