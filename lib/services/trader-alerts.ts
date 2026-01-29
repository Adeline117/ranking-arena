/**
 * 交易员异动检测服务
 *
 * 对比交易员最近两次 snapshot，检测大幅变动并生成告警：
 * - 7D ROI 变化超过 ±20% 触发告警
 * - 30D ROI 变化超过 ±50% 触发告警
 * - Arena Score 变化超过 ±15 分触发告警
 *
 * 告警存入 notifications 表（复用现有通知系统）
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

// ============================================
// 类型定义
// ============================================

export interface TraderAlertThresholds {
  roi7dChange: number   // 7D ROI 变化阈值（绝对值百分比），默认 20
  roi30dChange: number  // 30D ROI 变化阈值（绝对值百分比），默认 50
  scoreChange: number   // Arena Score 变化阈值（绝对值分数），默认 15
}

export interface SnapshotComparison {
  sourceTraderid: string
  source: string
  handle: string
  // 当前值
  currentRoi7d: number | null
  currentRoi30d: number | null
  currentArenaScore: number | null
  // 上一次值
  prevRoi7d: number | null
  prevRoi30d: number | null
  prevArenaScore: number | null
}

export interface DetectedAlert {
  userId: string
  traderId: string
  traderHandle: string
  source: string
  alertType: 'roi_7d_change' | 'roi_30d_change' | 'score_change'
  oldValue: number
  newValue: number
  changeAmount: number
  severity: 'info' | 'warning' | 'critical'
}

export const DEFAULT_ALERT_THRESHOLDS: TraderAlertThresholds = {
  roi7dChange: 20,
  roi30dChange: 50,
  scoreChange: 15,
}

// ============================================
// 严重程度判定
// ============================================

function getSeverity(
  alertType: DetectedAlert['alertType'],
  changeAmount: number
): 'info' | 'warning' | 'critical' {
  const absChange = Math.abs(changeAmount)

  switch (alertType) {
    case 'roi_7d_change':
      if (absChange >= 40) return 'critical'
      if (absChange >= 20) return 'warning'
      return 'info'
    case 'roi_30d_change':
      if (absChange >= 80) return 'critical'
      if (absChange >= 50) return 'warning'
      return 'info'
    case 'score_change':
      if (absChange >= 25) return 'critical'
      if (absChange >= 15) return 'warning'
      return 'info'
    default:
      return 'info'
  }
}

// ============================================
// 消息格式化
// ============================================

function formatAlertTitle(
  alertType: DetectedAlert['alertType'],
  language: 'zh' | 'en' = 'zh'
): string {
  const titles: Record<DetectedAlert['alertType'], { zh: string; en: string }> = {
    roi_7d_change: { zh: '7日 ROI 异动', en: '7D ROI Alert' },
    roi_30d_change: { zh: '30日 ROI 异动', en: '30D ROI Alert' },
    score_change: { zh: 'Arena Score 异动', en: 'Arena Score Alert' },
  }
  return titles[alertType]?.[language] || titles[alertType]?.zh || '异动提醒'
}

function formatAlertMessage(
  alert: DetectedAlert,
  language: 'zh' | 'en' = 'zh'
): string {
  const handle = alert.traderHandle || alert.traderId
  const oldStr = alert.alertType === 'score_change'
    ? alert.oldValue.toFixed(1)
    : `${alert.oldValue >= 0 ? '+' : ''}${alert.oldValue.toFixed(2)}%`
  const newStr = alert.alertType === 'score_change'
    ? alert.newValue.toFixed(1)
    : `${alert.newValue >= 0 ? '+' : ''}${alert.newValue.toFixed(2)}%`

  if (language === 'en') {
    switch (alert.alertType) {
      case 'roi_7d_change':
        return `${handle} 7D ROI changed from ${oldStr} to ${newStr}`
      case 'roi_30d_change':
        return `${handle} 30D ROI changed from ${oldStr} to ${newStr}`
      case 'score_change':
        return `${handle} Arena Score changed from ${oldStr} to ${newStr}`
    }
  }

  switch (alert.alertType) {
    case 'roi_7d_change':
      return `你关注的 ${handle} 7日 ROI 从 ${oldStr} 变为 ${newStr}`
    case 'roi_30d_change':
      return `你关注的 ${handle} 30日 ROI 从 ${oldStr} 变为 ${newStr}`
    case 'score_change':
      return `你关注的 ${handle} Arena Score 从 ${oldStr} 变为 ${newStr}`
  }
}

// ============================================
// 核心检测逻辑
// ============================================

/**
 * 对比两次 snapshot 并检测异动
 */
export function detectAlerts(
  comparison: SnapshotComparison,
  userIds: string[],
  thresholds: TraderAlertThresholds = DEFAULT_ALERT_THRESHOLDS
): DetectedAlert[] {
  const alerts: DetectedAlert[] = []

  // 7D ROI 变动检测
  if (
    comparison.currentRoi7d !== null &&
    comparison.prevRoi7d !== null
  ) {
    const change = comparison.currentRoi7d - comparison.prevRoi7d
    if (Math.abs(change) >= thresholds.roi7dChange) {
      for (const userId of userIds) {
        alerts.push({
          userId,
          traderId: comparison.sourceTraderid,
          traderHandle: comparison.handle,
          source: comparison.source,
          alertType: 'roi_7d_change',
          oldValue: comparison.prevRoi7d,
          newValue: comparison.currentRoi7d,
          changeAmount: change,
          severity: getSeverity('roi_7d_change', change),
        })
      }
    }
  }

  // 30D ROI 变动检测
  if (
    comparison.currentRoi30d !== null &&
    comparison.prevRoi30d !== null
  ) {
    const change = comparison.currentRoi30d - comparison.prevRoi30d
    if (Math.abs(change) >= thresholds.roi30dChange) {
      for (const userId of userIds) {
        alerts.push({
          userId,
          traderId: comparison.sourceTraderid,
          traderHandle: comparison.handle,
          source: comparison.source,
          alertType: 'roi_30d_change',
          oldValue: comparison.prevRoi30d,
          newValue: comparison.currentRoi30d,
          changeAmount: change,
          severity: getSeverity('roi_30d_change', change),
        })
      }
    }
  }

  // Arena Score 变动检测
  if (
    comparison.currentArenaScore !== null &&
    comparison.prevArenaScore !== null
  ) {
    const change = comparison.currentArenaScore - comparison.prevArenaScore
    if (Math.abs(change) >= thresholds.scoreChange) {
      for (const userId of userIds) {
        alerts.push({
          userId,
          traderId: comparison.sourceTraderid,
          traderHandle: comparison.handle,
          source: comparison.source,
          alertType: 'score_change',
          oldValue: comparison.prevArenaScore,
          newValue: comparison.currentArenaScore,
          changeAmount: change,
          severity: getSeverity('score_change', change),
        })
      }
    }
  }

  return alerts
}

// ============================================
// 数据库操作
// ============================================

/**
 * 将告警写入 notifications 表
 */
export async function saveAlertsAsNotifications(
  supabase: SupabaseClient,
  alerts: DetectedAlert[]
): Promise<{ inserted: number; errors: number }> {
  if (alerts.length === 0) return { inserted: 0, errors: 0 }

  const notifications = alerts.map((alert) => ({
    user_id: alert.userId,
    type: 'trader_alert' as const,
    title: formatAlertTitle(alert.alertType, 'zh'),
    message: formatAlertMessage(alert, 'zh'),
    link: `/trader/${encodeURIComponent(alert.traderId)}?source=${alert.source}`,
    read: false,
    reference_id: `${alert.alertType}:${alert.traderId}:${new Date().toISOString().split('T')[0]}`,
  }))

  // 去重：同一天同一交易员同一类型不重复发
  const uniqueKeys = new Set<string>()
  const dedupedNotifications = notifications.filter((n) => {
    const key = `${n.user_id}:${n.reference_id}`
    if (uniqueKeys.has(key)) return false
    uniqueKeys.add(key)
    return true
  })

  let inserted = 0
  let errors = 0

  // 分批插入，每批 50 条
  const BATCH_SIZE = 50
  for (let i = 0; i < dedupedNotifications.length; i += BATCH_SIZE) {
    const batch = dedupedNotifications.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('notifications')
      .upsert(batch, {
        onConflict: 'user_id,reference_id',
        ignoreDuplicates: true,
      })

    if (error) {
      // 如果 upsert 因缺少 unique constraint 而失败，退回到普通 insert
      console.warn('[TraderAlerts] upsert 失败，退回 insert:', error.message)
      const { error: insertError } = await supabase
        .from('notifications')
        .insert(batch)
      if (insertError) {
        console.error('[TraderAlerts] 批量插入失败:', insertError)
        errors += batch.length
      } else {
        inserted += batch.length
      }
    } else {
      inserted += batch.length
    }
  }

  return { inserted, errors }
}

/**
 * 获取关注某交易员的所有用户 ID
 */
export async function getFollowerUserIds(
  supabase: SupabaseClient,
  traderId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('trader_follows')
    .select('user_id')
    .eq('trader_id', traderId)

  if (error) {
    console.error('[TraderAlerts] 查询关注者失败:', error)
    return []
  }

  return (data || []).map((row) => row.user_id)
}

// ============================================
// 主检测流程
// ============================================

/**
 * 执行完整的异动检测流程
 *
 * 1. 获取有人关注的交易员列表
 * 2. 获取每个交易员的最近两次快照
 * 3. 对比检测异动
 * 4. 写入 notifications 表
 */
export async function runTraderAlertDetection(
  supabaseUrl: string,
  supabaseKey: string,
  thresholds: TraderAlertThresholds = DEFAULT_ALERT_THRESHOLDS
): Promise<{
  tradersChecked: number
  alertsDetected: number
  notificationsSaved: number
  errors: number
}> {
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  // 1. 获取有人关注的交易员列表（去重）
  const { data: follows, error: followsError } = await supabase
    .from('trader_follows')
    .select('trader_id, user_id')
    .order('created_at', { ascending: false })
    .limit(5000)

  if (followsError) {
    console.error('[TraderAlerts] 获取关注列表失败:', followsError)
    return { tradersChecked: 0, alertsDetected: 0, notificationsSaved: 0, errors: 1 }
  }

  if (!follows || follows.length === 0) {
    return { tradersChecked: 0, alertsDetected: 0, notificationsSaved: 0, errors: 0 }
  }

  // 按交易员分组用户
  const traderFollowersMap = new Map<string, string[]>()
  for (const f of follows) {
    const existing = traderFollowersMap.get(f.trader_id) || []
    existing.push(f.user_id)
    traderFollowersMap.set(f.trader_id, existing)
  }

  const traderIds = [...traderFollowersMap.keys()]

  // 2. 获取最近两次 snapshot
  // 取最近 14 天的 snapshots（确保有两次以上数据）
  const twoWeeksAgo = new Date()
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

  const { data: snapshots, error: snapshotError } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, source, roi, roi_7d, roi_30d, arena_score, captured_at')
    .in('source_trader_id', traderIds)
    .gte('captured_at', twoWeeksAgo.toISOString())
    .order('captured_at', { ascending: false })
    .limit(10000)

  if (snapshotError) {
    console.error('[TraderAlerts] 获取快照失败:', snapshotError)
    return { tradersChecked: 0, alertsDetected: 0, notificationsSaved: 0, errors: 1 }
  }

  // 获取交易员 handle
  const { data: sources } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .in('source_trader_id', traderIds)

  const handleMap = new Map<string, string>()
  if (sources) {
    for (const s of sources) {
      handleMap.set(s.source_trader_id, s.handle || s.source_trader_id)
    }
  }

  // 3. 按交易员分组，取最近两次
  interface SnapshotRow {
    source_trader_id: string
    source: string
    roi: number | null
    roi_7d: number | null
    roi_30d: number | null
    arena_score: number | null
    captured_at: string
  }

  const snapshotsByTrader = new Map<string, SnapshotRow[]>()
  if (snapshots) {
    for (const snap of snapshots as SnapshotRow[]) {
      const key = snap.source_trader_id
      const existing = snapshotsByTrader.get(key) || []
      existing.push(snap)
      snapshotsByTrader.set(key, existing)
    }
  }

  // 4. 对比检测
  const allAlerts: DetectedAlert[] = []

  for (const [traderId, traderSnapshots] of snapshotsByTrader) {
    if (traderSnapshots.length < 2) continue

    // 按时间排序（最新在前）
    traderSnapshots.sort(
      (a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
    )

    const latest = traderSnapshots[0]
    const previous = traderSnapshots[1]

    const comparison: SnapshotComparison = {
      sourceTraderid: traderId,
      source: latest.source,
      handle: handleMap.get(traderId) || traderId,
      currentRoi7d: latest.roi_7d,
      currentRoi30d: latest.roi_30d,
      currentArenaScore: latest.arena_score,
      prevRoi7d: previous.roi_7d,
      prevRoi30d: previous.roi_30d,
      prevArenaScore: previous.arena_score,
    }

    const userIds = traderFollowersMap.get(traderId) || []
    const alerts = detectAlerts(comparison, userIds, thresholds)
    allAlerts.push(...alerts)
  }

  // 5. 写入通知
  const { inserted, errors } = await saveAlertsAsNotifications(supabase, allAlerts)

  console.log(
    `[TraderAlerts] 检测完成: ${traderIds.length} 交易员, ${allAlerts.length} 告警, ${inserted} 通知已保存, ${errors} 错误`
  )

  return {
    tradersChecked: traderIds.length,
    alertsDetected: allAlerts.length,
    notificationsSaved: inserted,
    errors,
  }
}
