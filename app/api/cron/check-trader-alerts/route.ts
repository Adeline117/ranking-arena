/**
 * 交易员变动检测 Cron
 * Pro 会员功能：检测关注交易员的变动并发送提醒
 * 
 * GET /api/cron/check-trader-alerts - 健康检查
 * POST /api/cron/check-trader-alerts - 执行检测
 */

import { NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getPushNotificationService } from '@/lib/services/push-notification'
import { sendEmail, buildTraderAlertEmail } from '@/lib/services/email'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 验证 Cron 密钥
function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = env.CRON_SECRET

  if (!cronSecret) {
    logger.warn('[TraderAlerts Cron] CRON_SECRET 未配置')
    return false
  }

  return authHeader === `Bearer ${cronSecret}`
}

interface TraderData {
  source_trader_id: string
  source: string
  roi: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  pnl_7d?: number
  pnl_30d?: number
  max_drawdown?: number
  win_rate?: number
  arena_score?: number
}

interface AlertConfig {
  id: string
  user_id: string
  trader_id: string
  source?: string
  alert_roi_change: boolean
  roi_change_threshold: number
  alert_drawdown: boolean
  drawdown_threshold: number
  alert_pnl_change: boolean
  pnl_change_threshold: number
  alert_score_change: boolean
  score_change_threshold: number
  alert_rank_change: boolean
  rank_change_threshold: number
  alert_new_position: boolean
  alert_price_above: boolean
  price_above_value: number | null
  alert_price_below: boolean
  price_below_value: number | null
  price_symbol: string | null
  one_time: boolean
}

interface Snapshot {
  trader_id: string
  source: string
  roi_90d?: number
  pnl_90d?: number
  max_drawdown?: number
  arena_score?: number
}

/**
 * GET - 健康检查
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Trader alerts cron endpoint ready',
    description: 'Checks trader changes and sends alerts to Pro users',
  })
}

/**
 * POST - 执行交易员变动检测
 */
export async function POST(req: Request) {
  const startTime = Date.now()
  const plog = await PipelineLogger.start('check-trader-alerts')

  try {
    // 验证授权
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()

    // 1. 获取启用的提醒配置（限制最大数量防止内存爆炸）
    const MAX_ALERTS_PER_RUN = 1000
    const { data: alerts, error: alertsError } = await supabase
      .from('trader_alerts')
      .select('id, user_id, trader_id, source, alert_roi_change, roi_change_threshold, alert_drawdown, drawdown_threshold, alert_pnl_change, pnl_change_threshold, alert_score_change, score_change_threshold, alert_rank_change, rank_change_threshold, alert_new_position, alert_price_above, price_above_value, alert_price_below, price_below_value, price_symbol, one_time')
      .eq('enabled', true)
      .limit(MAX_ALERTS_PER_RUN)

    if (alertsError) {
      logger.error('[TraderAlerts Cron] 获取提醒配置Failed:', alertsError)
      return NextResponse.json({ ok: false, error: alertsError.message }, { status: 500 })
    }

    if (!alerts || alerts.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No active alerts to process',
        alertsChecked: 0,
        alertsSent: 0,
      })
    }

    // 2. 收集需要检查的交易员 ID
    const traderIds = [...new Set(alerts.map((a: AlertConfig) => a.trader_id))]

    // 3. 获取这些交易员的当前数据 (from leaderboard_ranks, 90D period)
    const { data: lrData, error: tradersError } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, source, roi, pnl, max_drawdown, win_rate, arena_score, season_id')
      .in('source_trader_id', traderIds)
      .eq('season_id', '90D')

    if (tradersError) {
      logger.error('[TraderAlerts Cron] 获取交易员数据Failed:', tradersError)
      return NextResponse.json({ ok: false, error: tradersError.message }, { status: 500 })
    }

    // Map leaderboard_ranks data to TraderData shape for compatibility
    const tradersData: TraderData[] | null = lrData?.map(lr => ({
      source_trader_id: lr.source_trader_id,
      source: lr.source,
      roi: lr.roi ?? 0,
      pnl: lr.pnl ?? undefined,
      max_drawdown: lr.max_drawdown ?? undefined,
      win_rate: lr.win_rate ?? undefined,
      arena_score: lr.arena_score ?? undefined,
    })) ?? null

    // 4. 获取昨天的快照数据 (from trader_daily_snapshots)
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    const { data: snapshots, error: snapshotsError } = await supabase
      .from('trader_daily_snapshots')
      .select('trader_key, platform, roi, pnl, max_drawdown')
      .in('trader_key', traderIds)
      .eq('date', yesterdayStr)
      .limit(MAX_ALERTS_PER_RUN)

    if (snapshotsError) {
      logger.error('[TraderAlerts Cron] 获取快照Failed:', snapshotsError)
      // 继续执行，可能是第一次运行
    }

    // Also get arena_score from leaderboard_ranks for comparison (already fetched above as lrData)
    // Build a map of arena scores from yesterday's daily snapshots + current LR data
    const arenaScoreMap = new Map<string, number>()
    if (lrData) {
      for (const lr of lrData) {
        arenaScoreMap.set(`${lr.source_trader_id}_${lr.source}`, lr.arena_score ?? 0)
      }
    }

    // 创建快照映射
    const snapshotMap = new Map<string, Snapshot>()
    if (snapshots) {
      for (const snap of snapshots) {
        snapshotMap.set(`${snap.trader_key}_${snap.platform}`, {
          trader_id: snap.trader_key,
          source: snap.platform,
          roi_90d: snap.roi ?? undefined,
          pnl_90d: snap.pnl ?? undefined,
          max_drawdown: snap.max_drawdown ?? undefined,
          arena_score: undefined, // daily snapshots don't have arena_score
        })
      }
    }

    // 创建当前数据映射
    const traderDataMap = new Map<string, TraderData>()
    if (tradersData) {
      for (const trader of tradersData) {
        traderDataMap.set(`${trader.source_trader_id}_${trader.source}`, trader)
      }
    }

    // 5. Save today's snapshot to trader_daily_snapshots for tomorrow's comparison
    const today = new Date().toISOString().split('T')[0]
    const snapshotsToInsert = tradersData?.map((t: TraderData) => ({
      platform: t.source,
      trader_key: t.source_trader_id,
      date: today,
      roi: t.roi,
      pnl: t.pnl ?? null,
      max_drawdown: t.max_drawdown ?? null,
      win_rate: t.win_rate ?? null,
    })) || []

    if (snapshotsToInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('trader_daily_snapshots')
        .upsert(snapshotsToInsert, {
          onConflict: 'platform,trader_key,date',
          ignoreDuplicates: true
        })

      if (insertError) {
        logger.error('[TraderAlerts Cron] 保存快照Failed:', insertError)
      }
    }

    // 6. 检测变动并发送提醒（批量处理）
    let alertsSent = 0
    const alertsToSend: Array<{
      user_id: string
      trader_id: string
      type: string
      title: string
      message: string
      link: string
    }> = []

    // 收集所有日志，最后批量插入
    const alertLogsToInsert: Array<{
      alert_id: string
      user_id: string
      trader_id: string
      alert_type: string
      old_value: number | null | undefined
      new_value: number | null | undefined
      change_percent?: number
      message: string
    }> = []

    for (const alert of alerts as AlertConfig[]) {
      const key = `${alert.trader_id}_${alert.source || ''}`
      const currentData = traderDataMap.get(key) ||
        // 尝试不带 source 的匹配
        Array.from(traderDataMap.values()).find(t => t.source_trader_id === alert.trader_id)

      if (!currentData) continue

      const snapshotKey = `${alert.trader_id}_${currentData.source}`
      const prevSnapshot = snapshotMap.get(snapshotKey)

      if (!prevSnapshot) continue // 没有历史数据，跳过

      // 检查 ROI 变动
      if (alert.alert_roi_change && prevSnapshot.roi_90d != null && currentData.roi != null) {
        const change = Math.abs(currentData.roi - prevSnapshot.roi_90d)
        if (change >= alert.roi_change_threshold) {
          const direction = currentData.roi > prevSnapshot.roi_90d ? '上涨' : '下跌'
          alertsToSend.push({
            user_id: alert.user_id,
            trader_id: alert.trader_id,
            type: 'trader_alert',
            title: 'ROI 变动提醒',
            message: `Trader ${alert.trader_id} ROI ${direction} ${change.toFixed(2)}%（${prevSnapshot.roi_90d.toFixed(2)}% → ${currentData.roi.toFixed(2)}%）`,
            link: `/trader/${encodeURIComponent(alert.trader_id)}?platform=${alert.source}`,
          })

          // 收集日志（不再单独插入）
          alertLogsToInsert.push({
            alert_id: alert.id,
            user_id: alert.user_id,
            trader_id: alert.trader_id,
            alert_type: 'roi_change',
            old_value: prevSnapshot.roi_90d,
            new_value: currentData.roi,
            change_percent: change,
            message: `ROI ${direction} ${change.toFixed(2)}%`,
          })
        }
      }

      // 检查回撤
      if (alert.alert_drawdown && currentData.max_drawdown != null) {
        const drawdown = Math.abs(currentData.max_drawdown)
        if (drawdown >= alert.drawdown_threshold) {
          alertsToSend.push({
            user_id: alert.user_id,
            trader_id: alert.trader_id,
            type: 'trader_alert',
            title: '回撤预警',
            message: `Trader ${alert.trader_id} max drawdown reached ${drawdown.toFixed(2)}%`,
            link: `/trader/${encodeURIComponent(alert.trader_id)}?platform=${alert.source}`,
          })

          alertLogsToInsert.push({
            alert_id: alert.id,
            user_id: alert.user_id,
            trader_id: alert.trader_id,
            alert_type: 'drawdown',
            old_value: prevSnapshot.max_drawdown,
            new_value: currentData.max_drawdown,
            message: `Drawdown reached ${drawdown.toFixed(2)}%`,
          })
        }
      }

      // 检查 Score 变动
      if (alert.alert_score_change && prevSnapshot.arena_score != null && currentData.arena_score != null) {
        const change = Math.abs(currentData.arena_score - prevSnapshot.arena_score)
        if (change >= alert.score_change_threshold) {
          const direction = currentData.arena_score > prevSnapshot.arena_score ? '上升' : '下降'
          alertsToSend.push({
            user_id: alert.user_id,
            trader_id: alert.trader_id,
            type: 'trader_alert',
            title: 'Arena Score 变动',
            message: `Trader ${alert.trader_id} Arena Score ${direction} ${change.toFixed(1)} pts (${prevSnapshot.arena_score.toFixed(1)} → ${currentData.arena_score.toFixed(1)}）`,
            link: `/trader/${encodeURIComponent(alert.trader_id)}?platform=${alert.source}`,
          })

          alertLogsToInsert.push({
            alert_id: alert.id,
            user_id: alert.user_id,
            trader_id: alert.trader_id,
            alert_type: 'score_change',
            old_value: prevSnapshot.arena_score,
            new_value: currentData.arena_score,
            change_percent: change,
            message: `Arena Score ${direction} ${change.toFixed(1)} 分`,
          })
        }
      }
    }

    // 批量插入日志（替代单个插入）
    if (alertLogsToInsert.length > 0) {
      const { error: logsError } = await supabase
        .from('trader_alert_logs')
        .insert(alertLogsToInsert)

      if (logsError) {
        logger.error('[TraderAlerts Cron] 批量保存日志Failed:', logsError)
      }
    }

    // 批量插入 alert_history
    if (alertLogsToInsert.length > 0) {
      const historyToInsert = alertLogsToInsert.map(log => ({
        alert_id: log.alert_id,
        user_id: log.user_id,
        alert_type: log.alert_type,
        triggered_at: new Date().toISOString(),
        data: {
          trader_id: log.trader_id,
          old_value: log.old_value,
          new_value: log.new_value,
          change_percent: log.change_percent,
          message: log.message,
        },
      }))

      const { error: historyError } = await supabase
        .from('alert_history')
        .insert(historyToInsert)

      if (historyError) {
        logger.error('[TraderAlerts Cron] 保存 alert_history Failed:', historyError)
      }
    }

    // 更新 last_triggered_at 并处理一次性提醒
    const triggeredAlertIds = [...new Set(alertLogsToInsert.map(l => l.alert_id))]
    if (triggeredAlertIds.length > 0) {
      await supabase
        .from('trader_alerts')
        .update({ last_triggered_at: new Date().toISOString() })
        .in('id', triggeredAlertIds)

      // 禁用一次性提醒
      const oneTimeAlertIds = (alerts as AlertConfig[])
        .filter(a => a.one_time && triggeredAlertIds.includes(a.id))
        .map(a => a.id)

      if (oneTimeAlertIds.length > 0) {
        await supabase
          .from('trader_alerts')
          .update({ enabled: false })
          .in('id', oneTimeAlertIds)
      }
    }

    // 7. 批量发送通知
    if (alertsToSend.length > 0) {
      const notifications = alertsToSend.map(a => ({
        user_id: a.user_id,
        type: a.type,
        title: a.title,
        message: a.message,
        link: a.link,
      }))

      const { error: notifyError } = await supabase
        .from('notifications')
        .insert(notifications)

      if (notifyError) {
        logger.error('[TraderAlerts Cron] 发送通知Failed:', notifyError)
      } else {
        alertsSent = alertsToSend.length
      }

      // Send push notifications (fire-and-forget)
      try {
        const pushService = getPushNotificationService()
        let pushSent = 0
        for (const alert of alertsToSend) {
          await pushService.sendToUser(alert.user_id, {
            title: alert.title,
            body: alert.message,
            data: { url: alert.link || '/notifications', type: 'rank_change' },
          })
          pushSent++
        }
        logger.info(`[TraderAlerts Cron] Push notifications sent: ${pushSent}`)
      } catch (pushError) {
        logger.warn('[TraderAlerts Cron] Failed to send push notifications', { error: pushError })
      }

      // Send email notifications grouped by user
      try {
        // Group alerts by user_id
        const alertsByUser = new Map<string, typeof alertsToSend>()
        for (const alert of alertsToSend) {
          const existing = alertsByUser.get(alert.user_id) || []
          existing.push(alert)
          alertsByUser.set(alert.user_id, existing)
        }

        // Look up user emails
        const userIds = [...alertsByUser.keys()]
        const { data: userProfiles } = await supabase
          .from('user_profiles')
          .select('id, email, email_digest')
          .in('id', userIds)

        let emailsSent = 0
        if (userProfiles) {
          for (const profile of userProfiles) {
            // Skip if no email or user opted out
            if (!profile.email) continue
            if (profile.email_digest === 'none') continue

            const userAlerts = alertsByUser.get(profile.id)
            if (!userAlerts || userAlerts.length === 0) continue

            const html = buildTraderAlertEmail(
              userAlerts.map(a => ({
                title: a.title,
                message: a.message,
                link: a.link,
              }))
            )

            const sent = await sendEmail({
              to: profile.email,
              subject: `Arena: ${userAlerts.length} trader alert${userAlerts.length > 1 ? 's' : ''} triggered`,
              html,
            })
            if (sent) emailsSent++
          }
        }

        if (emailsSent > 0) {
          logger.info(`[TraderAlerts Cron] Emails sent: ${emailsSent}`)
        }
      } catch (emailError) {
        logger.warn('[TraderAlerts Cron] Failed to send email notifications', { error: emailError })
      }
    }

    const duration = Date.now() - startTime

    await plog.success(alertsSent, { alertsChecked: alerts.length, tradersChecked: traderIds.length })

    return NextResponse.json({
      ok: true,
      message: 'Trader alerts check completed',
      duration: `${duration}ms`,
      alertsChecked: alerts.length,
      tradersChecked: traderIds.length,
      snapshotsSaved: snapshotsToInsert.length,
      alertsSent,
      timestamp: new Date().toISOString(),
    })
  } catch (error: unknown) {
    logger.error('[TraderAlerts Cron] 执行Failed:', error)
    await plog.error(error)
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
