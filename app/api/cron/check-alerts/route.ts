/**
 * 告警检测 Cron Job
 * 每 30 分钟检查一次所有启用的告警配置
 * 支持分片执行，避免超时
 * 
 * GET /api/cron/check-alerts - 健康检查
 * POST /api/cron/check-alerts - 执行告警检测
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { AlertType, AlertSeverity, UserAlertConfig } from '@/lib/types/alerts'
import {
  checkDrawdownAlert,
  checkWinRateAlert,
  checkTargetAlert,
  checkFollowerExodusAlert,
} from '@/lib/data/alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 验证 Cron 密钥
function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    console.warn('[CheckAlerts Cron] CRON_SECRET 未配置')
    return false
  }

  return authHeader === `Bearer ${cronSecret}`
}

// 获取 Supabase Admin 客户端
function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error('Supabase 环境变量未配置')
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

interface TraderData {
  trader_id: string
  source: string
  roi: number
  max_drawdown: number | null
  win_rate: number | null
  followers: number
}

interface AlertToCreate {
  user_id: string
  trader_id: string
  source: string
  type: AlertType
  severity: AlertSeverity
  title: string
  message: string
  data: Record<string, unknown>
}

/**
 * GET - 健康检查
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Alert check cron endpoint ready',
    checkInterval: '30 minutes',
    features: ['batch-queries', 'shard-support'],
  })
}

/**
 * POST - 执行告警检测
 * 支持 shard 参数进行分片执行
 */
export async function POST(req: Request) {
  const startTime = Date.now()

  try {
    // 验证授权
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    
    // 解析分片参数
    const url = new URL(req.url)
    const shard = url.searchParams.get('shard') // 格式: "1/3" 表示第 1 片，共 3 片
    let shardIndex = 0
    let totalShards = 1
    
    if (shard) {
      const [index, total] = shard.split('/').map(Number)
      if (index > 0 && total > 0 && index <= total) {
        shardIndex = index - 1
        totalShards = total
      }
    }

    // 1. 获取所有启用的告警配置
    const { data: allConfigs, error: configError } = await supabase
      .from('user_alert_configs')
      .select('*')
      .eq('enabled', true)
      .order('user_id')

    if (configError) {
      console.error('[CheckAlerts] 获取告警配置失败:', configError)
      return NextResponse.json({ ok: false, error: configError.message }, { status: 500 })
    }

    if (!allConfigs || allConfigs.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No enabled alert configs',
        alertsCreated: 0,
      })
    }

    // 分片过滤配置
    const configs = allConfigs.filter((_, index) => index % totalShards === shardIndex)
    
    console.log(`[CheckAlerts] 分片 ${shardIndex + 1}/${totalShards}: 检查 ${configs.length}/${allConfigs.length} 个告警配置`)

    if (configs.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No configs in this shard',
        shard: `${shardIndex + 1}/${totalShards}`,
        alertsCreated: 0,
      })
    }

    // 2. 收集所有需要检查的交易员（去重）
    const traderKeysSet = new Set<string>()
    const traderIdsBySource = new Map<string, Set<string>>()
    
    configs.forEach((config: UserAlertConfig) => {
      traderKeysSet.add(`${config.trader_id}:${config.source}`)
      
      if (!traderIdsBySource.has(config.source)) {
        traderIdsBySource.set(config.source, new Set())
      }
      traderIdsBySource.get(config.source)!.add(config.trader_id)
    })

    // 3. 【批量查询】获取当前数据 - 修复 N+1 问题
    const traderDataMap = new Map<string, TraderData>()
    
    for (const [source, traderIds] of traderIdsBySource) {
      const traderIdArray = Array.from(traderIds)
      
      // 批量查询当前快照（使用 distinct on 获取每个交易员的最新记录）
      const { data: snapshots, error: snapshotError } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, source, roi, max_drawdown, win_rate, followers, captured_at')
        .eq('source', source)
        .in('source_trader_id', traderIdArray)
        .order('captured_at', { ascending: false })
      
      if (snapshotError) {
        console.error(`[CheckAlerts] 批量获取 ${source} 快照失败:`, snapshotError)
        continue
      }
      
      // 为每个交易员取最新的记录
      const latestByTrader = new Map<string, typeof snapshots[0]>()
      snapshots?.forEach(s => {
        if (!latestByTrader.has(s.source_trader_id)) {
          latestByTrader.set(s.source_trader_id, s)
        }
      })
      
      latestByTrader.forEach((snapshot, traderId) => {
        const key = `${traderId}:${source}`
        traderDataMap.set(key, {
          trader_id: traderId,
          source,
          roi: snapshot.roi || 0,
          max_drawdown: snapshot.max_drawdown,
          win_rate: snapshot.win_rate,
          followers: snapshot.followers || 0,
        })
      })
    }

    // 4. 【批量查询】获取昨天的快照数据 - 修复 N+1 问题
    const yesterdayDataMap = new Map<string, TraderData>()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    for (const [source, traderIds] of traderIdsBySource) {
      const traderIdArray = Array.from(traderIds)
      
      // 批量查询昨天的快照
      const { data: snapshots, error: snapshotError } = await supabase
        .from('trader_daily_snapshots')
        .select('*')
        .eq('source', source)
        .eq('snapshot_date', yesterdayStr)
        .in('trader_id', traderIdArray)
      
      if (snapshotError) {
        console.error(`[CheckAlerts] 批量获取 ${source} 昨日快照失败:`, snapshotError)
        continue
      }
      
      snapshots?.forEach(snapshot => {
        const key = `${snapshot.trader_id}:${source}`
        yesterdayDataMap.set(key, {
          trader_id: snapshot.trader_id,
          source,
          roi: snapshot.roi || 0,
          max_drawdown: snapshot.max_drawdown,
          win_rate: snapshot.win_rate,
          followers: snapshot.followers || 0,
        })
      })
    }

    // 5. 检测告警
    const alertsToCreate: AlertToCreate[] = []

    for (const config of configs as UserAlertConfig[]) {
      const key = `${config.trader_id}:${config.source}`
      const currentData = traderDataMap.get(key)
      const previousData = yesterdayDataMap.get(key)

      if (!currentData) continue

      // 检测回撤告警
      if (currentData.max_drawdown !== null) {
        const previousDrawdown = previousData?.max_drawdown ?? 0
        const drawdownAlert = checkDrawdownAlert(
          currentData.max_drawdown,
          previousDrawdown,
          config
        )
        
        if (drawdownAlert) {
          alertsToCreate.push({
            user_id: config.user_id,
            trader_id: config.trader_id,
            source: config.source,
            type: drawdownAlert.type,
            severity: drawdownAlert.severity,
            title: drawdownAlert.type === 'DRAWDOWN_SPIKE' ? '回撤急剧加深' : '回撤预警',
            message: drawdownAlert.message,
            data: {
              current_drawdown: currentData.max_drawdown,
              previous_drawdown: previousDrawdown,
              threshold: config.drawdown_threshold,
            },
          })
        }
      }

      // 检测胜率告警
      if (currentData.win_rate !== null && previousData && previousData.win_rate !== null) {
        const winRateAlert = checkWinRateAlert(
          currentData.win_rate,
          previousData.win_rate,
          config
        )
        
        if (winRateAlert) {
          alertsToCreate.push({
            user_id: config.user_id,
            trader_id: config.trader_id,
            source: config.source,
            type: winRateAlert.type,
            severity: winRateAlert.severity,
            title: '胜率下降预警',
            message: winRateAlert.message,
            data: {
              current_win_rate: currentData.win_rate,
              previous_win_rate: previousData.win_rate,
              change: previousData.win_rate - currentData.win_rate,
            },
          })
        }
      }

      // 检测止盈止损告警
      const targetAlert = checkTargetAlert(currentData.roi, config)
      if (targetAlert) {
        alertsToCreate.push({
          user_id: config.user_id,
          trader_id: config.trader_id,
          source: config.source,
          type: targetAlert.type,
          severity: targetAlert.severity,
          title: targetAlert.type === 'PROFIT_TARGET_HIT' ? '达到止盈目标' : '触发止损',
          message: targetAlert.message,
          data: {
            current_roi: currentData.roi,
            target: targetAlert.type === 'PROFIT_TARGET_HIT' ? config.profit_target : config.stop_loss,
          },
        })
      }

      // 检测跟单者撤离告警
      if (previousData) {
        const followerAlert = checkFollowerExodusAlert(
          currentData.followers,
          previousData.followers,
          config
        )
        
        if (followerAlert) {
          alertsToCreate.push({
            user_id: config.user_id,
            trader_id: config.trader_id,
            source: config.source,
            type: followerAlert.type,
            severity: followerAlert.severity,
            title: '跟单者撤离预警',
            message: followerAlert.message,
            data: {
              current_followers: currentData.followers,
              previous_followers: previousData.followers,
            },
          })
        }
      }
    }

    // 6. 批量创建告警
    let alertsCreated = 0
    if (alertsToCreate.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from('trader_alerts')
        .insert(alertsToCreate)
        .select()

      if (insertError) {
        console.error('[CheckAlerts] 创建告警失败:', insertError)
      } else {
        alertsCreated = inserted?.length || 0
        console.log(`[CheckAlerts] 创建了 ${alertsCreated} 条告警`)
      }
    }

    // 7. 【批量保存】今天的快照 - 修复 N+1 问题
    const today = new Date().toISOString().split('T')[0]
    const snapshotsToUpsert = Array.from(traderDataMap.values()).map(data => ({
      trader_id: data.trader_id,
      source: data.source,
      roi: data.roi,
      max_drawdown: data.max_drawdown,
      win_rate: data.win_rate,
      followers: data.followers,
      snapshot_date: today,
    }))
    
    if (snapshotsToUpsert.length > 0) {
      const { error: upsertError } = await supabase
        .from('trader_daily_snapshots')
        .upsert(snapshotsToUpsert, {
          onConflict: 'trader_id,source,snapshot_date',
        })
      
      if (upsertError) {
        console.error('[CheckAlerts] 批量保存快照失败:', upsertError)
      }
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      ok: true,
      message: 'Alert check completed',
      shard: totalShards > 1 ? `${shardIndex + 1}/${totalShards}` : undefined,
      duration: `${duration}ms`,
      configsChecked: configs.length,
      tradersChecked: traderDataMap.size,
      alertsCreated,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[CheckAlerts] 执行失败:', error)
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
