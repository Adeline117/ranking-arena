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

import { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

// ============================================
// 类型定义
// ============================================

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderAlertThresholds {
  roi7dChange: number   // 7D ROI 变化阈值（绝对值百分比），默认 20
  roi30dChange: number  // 30D ROI 变化阈值（绝对值百分比），默认 50
  scoreChange: number   // Arena Score 变化阈值（绝对值分数），默认 15
  rankChange: number    // 排名变化阈值（位数），默认 10
}

export interface SnapshotComparison {
  sourceTraderid: string
  source: string
  handle: string
  // 当前值
  currentRoi7d: number | null
  currentRoi30d: number | null
  currentArenaScore: number | null
  currentRank: number | null
  // 上一次值
  prevRoi7d: number | null
  prevRoi30d: number | null
  prevArenaScore: number | null
  prevRank: number | null
}

export interface DetectedAlert {
  userId: string
  traderId: string
  traderHandle: string
  source: string
  alertType: 'roi_7d_change' | 'roi_30d_change' | 'score_change' | 'rank_change'
  oldValue: number
  newValue: number
  changeAmount: number
  severity: 'info' | 'warning' | 'critical'
}

export const DEFAULT_ALERT_THRESHOLDS: TraderAlertThresholds = {
  roi7dChange: 20,
  roi30dChange: 50,
  scoreChange: 15,
  rankChange: 10,
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
    case 'rank_change':
      if (absChange >= 30) return 'critical'
      if (absChange >= 10) return 'warning'
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
    rank_change: { zh: '排名变动', en: 'Rank Change Alert' },
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
      case 'rank_change': {
        const dir = alert.changeAmount < 0 ? 'up' : 'down'
        return `${handle} rank moved ${dir} from #${Math.round(alert.oldValue)} to #${Math.round(alert.newValue)}`
      }
    }
  }

  switch (alert.alertType) {
    case 'roi_7d_change':
      return `你关注的 ${handle} 7日 ROI 从 ${oldStr} 变为 ${newStr}`
    case 'roi_30d_change':
      return `你关注的 ${handle} 30日 ROI 从 ${oldStr} 变为 ${newStr}`
    case 'score_change':
      return `你关注的 ${handle} Arena Score 从 ${oldStr} 变为 ${newStr}`
    case 'rank_change': {
      const dir = alert.changeAmount < 0 ? '上升' : '下降'
      return `你关注的 ${handle} 排名${dir}，从 #${Math.round(alert.oldValue)} 变为 #${Math.round(alert.newValue)}`
    }
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

  // 排名变动检测
  if (
    comparison.currentRank !== null &&
    comparison.prevRank !== null
  ) {
    const change = comparison.currentRank - comparison.prevRank // positive = dropped, negative = improved
    if (Math.abs(change) >= thresholds.rankChange) {
      for (const userId of userIds) {
        alerts.push({
          userId,
          traderId: comparison.sourceTraderid,
          traderHandle: comparison.handle,
          source: comparison.source,
          alertType: 'rank_change',
          oldValue: comparison.prevRank,
          newValue: comparison.currentRank,
          changeAmount: change,
          severity: getSeverity('rank_change', change),
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
    link: `/trader/${encodeURIComponent(alert.traderId)}?platform=${alert.source}`,
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
      logger.warn('[TraderAlerts] upsert 失败，退回 insert:', error.message)
      const { error: insertError } = await supabase
        .from('notifications')
        .insert(batch)
      if (insertError) {
        logger.error('[TraderAlerts] 批量插入失败:', insertError)
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
    logger.error('[TraderAlerts] 查询关注者失败:', error)
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
  thresholds: TraderAlertThresholds = DEFAULT_ALERT_THRESHOLDS
): Promise<{
  tradersChecked: number
  alertsDetected: number
  notificationsSaved: number
  errors: number
}> {
  const supabase = getSupabaseAdmin() as SupabaseClient

  // 1. 获取有人关注的交易员列表（去重）
  const { data: follows, error: followsError } = await supabase
    .from('trader_follows')
    .select('trader_id, user_id')
    .order('created_at', { ascending: false })
    .limit(5000)

  if (followsError) {
    logger.error('[TraderAlerts] 获取关注列表失败:', followsError)
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

  // 2. Get current state from leaderboard_ranks (has roi per season, arena_score, rank, handle)
  const { data: currentRanks, error: ranksError } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id, source, handle, roi, arena_score, rank, season_id')
    .in('source_trader_id', traderIds)
    .in('season_id', ['7D', '30D', '90D'])

  if (ranksError) {
    logger.error('[TraderAlerts] 获取 leaderboard_ranks 失败:', ranksError)
    return { tradersChecked: 0, alertsDetected: 0, notificationsSaved: 0, errors: 1 }
  }

  // Build current state map: traderId -> { 7D, 30D, 90D data }
  interface CurrentState {
    source: string
    handle: string
    roi7d: number | null
    roi30d: number | null
    arenaScore: number | null
    rank: number | null
  }
  const currentStateMap = new Map<string, CurrentState>()
  if (currentRanks) {
    for (const r of currentRanks) {
      const existing = currentStateMap.get(r.source_trader_id) || {
        source: r.source,
        handle: r.handle || r.source_trader_id,
        roi7d: null, roi30d: null, arenaScore: null, rank: null,
      }
      existing.source = r.source
      if (r.handle) existing.handle = r.handle
      if (r.season_id === '7D') existing.roi7d = r.roi
      if (r.season_id === '30D') existing.roi30d = r.roi
      if (r.season_id === '90D') {
        existing.arenaScore = r.arena_score
        existing.rank = r.rank
      }
      currentStateMap.set(r.source_trader_id, existing)
    }
  }

  // 3. Get previous snapshots from trader_snapshots_v2 for comparison
  const twoWeeksAgo = new Date()
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

  const { data: prevSnapshots, error: snapshotError } = await supabase
    .from('trader_snapshots_v2')
    .select('trader_key, platform, roi_pct, arena_score, rank, window, created_at')
    .in('trader_key', traderIds)
    .gte('created_at', twoWeeksAgo.toISOString())
    .order('created_at', { ascending: false })
    .limit(10000)

  if (snapshotError) {
    logger.error('[TraderAlerts] 获取 trader_snapshots_v2 失败:', snapshotError)
    return { tradersChecked: 0, alertsDetected: 0, notificationsSaved: 0, errors: 1 }
  }

  // Build previous state: for each trader, get second-most-recent entry per window
  interface PrevState {
    roi7d: number | null
    roi30d: number | null
    arenaScore: number | null
    rank: number | null
  }
  const prevStateMap = new Map<string, PrevState>()
  // Track seen counts per trader+window to skip the first (current) and take second (previous)
  const seenCounts = new Map<string, number>()
  if (prevSnapshots) {
    for (const snap of prevSnapshots) {
      const countKey = `${snap.trader_key}:${snap.window}`
      const count = (seenCounts.get(countKey) || 0) + 1
      seenCounts.set(countKey, count)
      // Skip the latest (count=1), use the second entry (count=2)
      if (count !== 2) continue

      const existing = prevStateMap.get(snap.trader_key) || {
        roi7d: null, roi30d: null, arenaScore: null, rank: null,
      }
      if (snap.window === '7D') existing.roi7d = snap.roi_pct
      if (snap.window === '30D') existing.roi30d = snap.roi_pct
      if (snap.window === '90D') {
        existing.arenaScore = snap.arena_score
        existing.rank = snap.rank
      }
      prevStateMap.set(snap.trader_key, existing)
    }
  }

  // 4. 对比检测
  const allAlerts: DetectedAlert[] = []

  for (const traderId of traderIds) {
    const current = currentStateMap.get(traderId)
    const prev = prevStateMap.get(traderId)
    if (!current || !prev) continue

    const comparison: SnapshotComparison = {
      sourceTraderid: traderId,
      source: current.source,
      handle: current.handle,
      currentRoi7d: current.roi7d,
      currentRoi30d: current.roi30d,
      currentArenaScore: current.arenaScore,
      currentRank: current.rank,
      prevRoi7d: prev.roi7d,
      prevRoi30d: prev.roi30d,
      prevArenaScore: prev.arenaScore,
      prevRank: prev.rank,
    }

    const userIds = traderFollowersMap.get(traderId) || []
    const alerts = detectAlerts(comparison, userIds, thresholds)
    allAlerts.push(...alerts)
  }

  // 5. 写入通知
  const { inserted, errors } = await saveAlertsAsNotifications(supabase, allAlerts)


  return {
    tradersChecked: traderIds.length,
    alertsDetected: allAlerts.length,
    notificationsSaved: inserted,
    errors,
  }
}
