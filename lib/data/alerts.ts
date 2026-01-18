/**
 * 风险预警数据层
 * 提供告警配置和告警历史的 CRUD 操作
 */

import { SupabaseClient } from '@supabase/supabase-js'
import type {
  AlertType,
  AlertSeverity,
  UserAlertConfig,
  TraderAlert,
  TraderDailySnapshot,
  CreateAlertConfigInput,
  UpdateAlertConfigInput,
  AlertData,
  DEFAULT_ALERT_CONFIG,
} from '@/lib/types/alerts'

// ============================================
// 告警配置
// ============================================

/**
 * 获取用户的所有告警配置
 */
export async function getUserAlertConfigs(
  supabase: SupabaseClient,
  userId: string
): Promise<UserAlertConfig[]> {
  const { data, error } = await supabase
    .from('user_alert_configs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[alerts] 获取告警配置失败:', error)
    throw error
  }

  return data || []
}

/**
 * 获取特定交易员的告警配置
 */
export async function getAlertConfig(
  supabase: SupabaseClient,
  userId: string,
  traderId: string,
  source: string
): Promise<UserAlertConfig | null> {
  const { data, error } = await supabase
    .from('user_alert_configs')
    .select('*')
    .eq('user_id', userId)
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    console.error('[alerts] 获取告警配置失败:', error)
    throw error
  }

  return data
}

/**
 * 创建告警配置
 */
export async function createAlertConfig(
  supabase: SupabaseClient,
  userId: string,
  input: CreateAlertConfigInput
): Promise<UserAlertConfig> {
  const { data, error } = await supabase
    .from('user_alert_configs')
    .insert({
      user_id: userId,
      trader_id: input.trader_id,
      source: input.source,
      drawdown_threshold: input.drawdown_threshold ?? 10,
      drawdown_spike_threshold: input.drawdown_spike_threshold ?? 5,
      win_rate_drop_threshold: input.win_rate_drop_threshold ?? 10,
      profit_target: input.profit_target,
      stop_loss: input.stop_loss,
      notify_in_app: input.notify_in_app ?? true,
      notify_email: input.notify_email ?? false,
      notify_push: input.notify_push ?? false,
      alert_types: input.alert_types ?? ['DRAWDOWN_WARNING', 'DRAWDOWN_SPIKE', 'WIN_RATE_DROP'],
    })
    .select()
    .single()

  if (error) {
    console.error('[alerts] 创建告警配置失败:', error)
    throw error
  }

  return data
}

/**
 * 更新告警配置
 */
export async function updateAlertConfig(
  supabase: SupabaseClient,
  configId: string,
  userId: string,
  input: UpdateAlertConfigInput
): Promise<UserAlertConfig> {
  const updateData: Record<string, unknown> = {}
  
  if (input.drawdown_threshold !== undefined) updateData.drawdown_threshold = input.drawdown_threshold
  if (input.drawdown_spike_threshold !== undefined) updateData.drawdown_spike_threshold = input.drawdown_spike_threshold
  if (input.win_rate_drop_threshold !== undefined) updateData.win_rate_drop_threshold = input.win_rate_drop_threshold
  if (input.profit_target !== undefined) updateData.profit_target = input.profit_target
  if (input.stop_loss !== undefined) updateData.stop_loss = input.stop_loss
  if (input.notify_in_app !== undefined) updateData.notify_in_app = input.notify_in_app
  if (input.notify_email !== undefined) updateData.notify_email = input.notify_email
  if (input.notify_push !== undefined) updateData.notify_push = input.notify_push
  if (input.alert_types !== undefined) updateData.alert_types = input.alert_types
  if (input.enabled !== undefined) updateData.enabled = input.enabled

  const { data, error } = await supabase
    .from('user_alert_configs')
    .update(updateData)
    .eq('id', configId)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    console.error('[alerts] 更新告警配置失败:', error)
    throw error
  }

  return data
}

/**
 * 删除告警配置
 */
export async function deleteAlertConfig(
  supabase: SupabaseClient,
  configId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('user_alert_configs')
    .delete()
    .eq('id', configId)
    .eq('user_id', userId)

  if (error) {
    console.error('[alerts] 删除告警配置失败:', error)
    throw error
  }
}

/**
 * 获取所有启用的告警配置（用于 Cron）
 */
export async function getAllEnabledConfigs(
  supabase: SupabaseClient
): Promise<UserAlertConfig[]> {
  const { data, error } = await supabase
    .from('user_alert_configs')
    .select('*')
    .eq('enabled', true)

  if (error) {
    console.error('[alerts] 获取启用的告警配置失败:', error)
    throw error
  }

  return data || []
}

// ============================================
// 告警历史
// ============================================

/**
 * 获取用户的告警历史
 */
export async function getUserAlerts(
  supabase: SupabaseClient,
  userId: string,
  options: {
    limit?: number
    offset?: number
    unread_only?: boolean
    trader_id?: string
    source?: string
  } = {}
): Promise<TraderAlert[]> {
  const { limit = 50, offset = 0, unread_only = false, trader_id, source } = options

  let query = supabase
    .from('trader_alerts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (unread_only) {
    query = query.eq('read', false)
  }

  if (trader_id) {
    query = query.eq('trader_id', trader_id)
  }

  if (source) {
    query = query.eq('source', source)
  }

  const { data, error } = await query

  if (error) {
    console.error('[alerts] 获取告警历史失败:', error)
    throw error
  }

  return data || []
}

/**
 * 获取未读告警数量
 */
export async function getUnreadAlertCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('trader_alerts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false)

  if (error) {
    console.error('[alerts] 获取未读告警数量失败:', error)
    throw error
  }

  return count || 0
}

/**
 * 创建告警
 */
export async function createAlert(
  supabase: SupabaseClient,
  alert: {
    user_id: string
    trader_id: string
    source: string
    type: AlertType
    severity: AlertSeverity
    title: string
    message: string
    data?: AlertData
  }
): Promise<TraderAlert> {
  const { data, error } = await supabase
    .from('trader_alerts')
    .insert({
      user_id: alert.user_id,
      trader_id: alert.trader_id,
      source: alert.source,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      data: alert.data || {},
    })
    .select()
    .single()

  if (error) {
    console.error('[alerts] 创建告警失败:', error)
    throw error
  }

  return data
}

/**
 * 批量创建告警
 */
export async function createAlerts(
  supabase: SupabaseClient,
  alerts: Array<{
    user_id: string
    trader_id: string
    source: string
    type: AlertType
    severity: AlertSeverity
    title: string
    message: string
    data?: AlertData
  }>
): Promise<number> {
  if (alerts.length === 0) return 0

  const { data, error } = await supabase
    .from('trader_alerts')
    .insert(alerts.map(a => ({
      user_id: a.user_id,
      trader_id: a.trader_id,
      source: a.source,
      type: a.type,
      severity: a.severity,
      title: a.title,
      message: a.message,
      data: a.data || {},
    })))
    .select()

  if (error) {
    console.error('[alerts] 批量创建告警失败:', error)
    throw error
  }

  return data?.length || 0
}

/**
 * 标记告警为已读
 */
export async function markAlertRead(
  supabase: SupabaseClient,
  alertId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('trader_alerts')
    .update({ read: true, acknowledged_at: new Date().toISOString() })
    .eq('id', alertId)
    .eq('user_id', userId)

  if (error) {
    console.error('[alerts] 标记告警已读失败:', error)
    throw error
  }
}

/**
 * 批量标记告警为已读
 */
export async function markAlertsRead(
  supabase: SupabaseClient,
  alertIds: string[],
  userId: string
): Promise<number> {
  if (alertIds.length === 0) return 0

  const { data, error } = await supabase
    .from('trader_alerts')
    .update({ read: true, acknowledged_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', alertIds)
    .select()

  if (error) {
    console.error('[alerts] 批量标记告警已读失败:', error)
    throw error
  }

  return data?.length || 0
}

/**
 * 标记所有告警为已读
 */
export async function markAllAlertsRead(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { data, error } = await supabase
    .from('trader_alerts')
    .update({ read: true, acknowledged_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('read', false)
    .select()

  if (error) {
    console.error('[alerts] 标记所有告警已读失败:', error)
    throw error
  }

  return data?.length || 0
}

// ============================================
// 每日快照
// ============================================

/**
 * 获取交易员的历史快照
 */
export async function getTraderSnapshots(
  supabase: SupabaseClient,
  traderId: string,
  source: string,
  days: number = 7
): Promise<TraderDailySnapshot[]> {
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)

  const { data, error } = await supabase
    .from('trader_daily_snapshots')
    .select('*')
    .eq('trader_id', traderId)
    .eq('source', source)
    .gte('snapshot_date', startDate.toISOString().split('T')[0])
    .order('snapshot_date', { ascending: false })

  if (error) {
    console.error('[alerts] 获取交易员快照失败:', error)
    throw error
  }

  return data || []
}

/**
 * 保存每日快照
 */
export async function saveTraderSnapshot(
  supabase: SupabaseClient,
  snapshot: {
    trader_id: string
    source: string
    roi?: number
    pnl?: number
    max_drawdown?: number
    win_rate?: number
    followers?: number
    trades_count?: number
  }
): Promise<void> {
  const { error } = await supabase
    .from('trader_daily_snapshots')
    .upsert(
      {
        trader_id: snapshot.trader_id,
        source: snapshot.source,
        roi: snapshot.roi,
        pnl: snapshot.pnl,
        max_drawdown: snapshot.max_drawdown,
        win_rate: snapshot.win_rate,
        followers: snapshot.followers,
        trades_count: snapshot.trades_count,
        snapshot_date: new Date().toISOString().split('T')[0],
      },
      {
        onConflict: 'trader_id,source,snapshot_date',
      }
    )

  if (error) {
    console.error('[alerts] 保存交易员快照失败:', error)
    throw error
  }
}

// ============================================
// 告警检测逻辑
// ============================================

/**
 * 检测回撤告警
 */
export function checkDrawdownAlert(
  currentDrawdown: number,
  previousDrawdown: number,
  config: UserAlertConfig
): { type: AlertType; severity: AlertSeverity; message: string } | null {
  const absCurrentDrawdown = Math.abs(currentDrawdown)
  const absPreviousDrawdown = Math.abs(previousDrawdown)
  const change = absCurrentDrawdown - absPreviousDrawdown

  // 检查回撤急剧加深
  if (
    config.alert_types.includes('DRAWDOWN_SPIKE') &&
    change >= config.drawdown_spike_threshold
  ) {
    const severity: AlertSeverity = change >= 10 ? 'CRITICAL' : change >= 7 ? 'HIGH' : 'MEDIUM'
    return {
      type: 'DRAWDOWN_SPIKE',
      severity,
      message: `回撤在 24 小时内加深了 ${change.toFixed(1)}%，当前回撤 ${absCurrentDrawdown.toFixed(1)}%`,
    }
  }

  // 检查回撤超过阈值
  if (
    config.alert_types.includes('DRAWDOWN_WARNING') &&
    absCurrentDrawdown >= config.drawdown_threshold &&
    absPreviousDrawdown < config.drawdown_threshold
  ) {
    const severity: AlertSeverity = absCurrentDrawdown >= 20 ? 'HIGH' : 'MEDIUM'
    return {
      type: 'DRAWDOWN_WARNING',
      severity,
      message: `回撤已超过预警阈值 ${config.drawdown_threshold}%，当前回撤 ${absCurrentDrawdown.toFixed(1)}%`,
    }
  }

  return null
}

/**
 * 检测胜率下降告警
 */
export function checkWinRateAlert(
  currentWinRate: number,
  previousWinRate: number,
  config: UserAlertConfig
): { type: AlertType; severity: AlertSeverity; message: string } | null {
  if (!config.alert_types.includes('WIN_RATE_DROP')) return null

  const drop = previousWinRate - currentWinRate

  if (drop >= config.win_rate_drop_threshold) {
    const severity: AlertSeverity = drop >= 15 ? 'HIGH' : 'MEDIUM'
    return {
      type: 'WIN_RATE_DROP',
      severity,
      message: `胜率下降了 ${drop.toFixed(1)}%，当前胜率 ${currentWinRate.toFixed(1)}%`,
    }
  }

  return null
}

/**
 * 检测止盈止损告警
 */
export function checkTargetAlert(
  currentRoi: number,
  config: UserAlertConfig
): { type: AlertType; severity: AlertSeverity; message: string } | null {
  // 检查止盈
  if (
    config.profit_target !== null &&
    config.alert_types.includes('PROFIT_TARGET_HIT') &&
    currentRoi >= config.profit_target
  ) {
    return {
      type: 'PROFIT_TARGET_HIT',
      severity: 'LOW',
      message: `已达到止盈目标 ${config.profit_target}%，当前收益 ${currentRoi.toFixed(1)}%`,
    }
  }

  // 检查止损
  if (
    config.stop_loss !== null &&
    config.alert_types.includes('STOP_LOSS_HIT') &&
    currentRoi <= -Math.abs(config.stop_loss)
  ) {
    return {
      type: 'STOP_LOSS_HIT',
      severity: 'HIGH',
      message: `已触发止损 ${config.stop_loss}%，当前收益 ${currentRoi.toFixed(1)}%`,
    }
  }

  return null
}

/**
 * 检测跟单者撤离告警
 */
export function checkFollowerExodusAlert(
  currentFollowers: number,
  previousFollowers: number,
  config: UserAlertConfig
): { type: AlertType; severity: AlertSeverity; message: string } | null {
  if (!config.alert_types.includes('FOLLOWER_EXODUS')) return null
  if (previousFollowers === 0) return null

  const changePercent = ((previousFollowers - currentFollowers) / previousFollowers) * 100

  // 跟单者减少超过 20%
  if (changePercent >= 20) {
    const severity: AlertSeverity = changePercent >= 40 ? 'HIGH' : 'MEDIUM'
    return {
      type: 'FOLLOWER_EXODUS',
      severity,
      message: `跟单者减少了 ${changePercent.toFixed(0)}%（${previousFollowers} → ${currentFollowers}）`,
    }
  }

  return null
}
