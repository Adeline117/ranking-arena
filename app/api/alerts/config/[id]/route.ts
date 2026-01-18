/**
 * 单个告警配置 API
 * PUT /api/alerts/config/[id] - 更新配置
 * DELETE /api/alerts/config/[id] - 删除配置
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateNumber,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { updateAlertConfig, deleteAlertConfig } from '@/lib/data/alerts'
import type { AlertType } from '@/lib/types/alerts'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * PUT /api/alerts/config/[id]
 * 更新告警配置
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
      return handleError(new Error('缺少配置 ID'), 'alert config PUT')
    }

    const drawdown_threshold = validateNumber(body.drawdown_threshold, { min: 1, max: 100 })
    const drawdown_spike_threshold = validateNumber(body.drawdown_spike_threshold, { min: 1, max: 50 })
    const win_rate_drop_threshold = validateNumber(body.win_rate_drop_threshold, { min: 1, max: 50 })
    const profit_target = body.profit_target !== undefined 
      ? (body.profit_target === null ? null : validateNumber(body.profit_target, { min: 1 }))
      : undefined
    const stop_loss = body.stop_loss !== undefined 
      ? (body.stop_loss === null ? null : validateNumber(body.stop_loss, { min: 1 }))
      : undefined

    const config = await updateAlertConfig(supabase, id, user.id, {
      drawdown_threshold: drawdown_threshold ?? undefined,
      drawdown_spike_threshold: drawdown_spike_threshold ?? undefined,
      win_rate_drop_threshold: win_rate_drop_threshold ?? undefined,
      profit_target,
      stop_loss,
      notify_in_app: body.notify_in_app,
      notify_email: body.notify_email,
      notify_push: body.notify_push,
      alert_types: body.alert_types as AlertType[] | undefined,
      enabled: body.enabled,
    })

    return success({ config, message: '配置已更新' })
  } catch (error) {
    return handleError(error, 'alert config PUT')
  }
}

/**
 * DELETE /api/alerts/config/[id]
 * 删除告警配置
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少配置 ID'), 'alert config DELETE')
    }

    await deleteAlertConfig(supabase, id, user.id)

    return success({ message: '配置已删除' })
  } catch (error) {
    return handleError(error, 'alert config DELETE')
  }
}
