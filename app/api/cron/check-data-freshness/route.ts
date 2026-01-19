/**
 * 数据新鲜度检查 Cron 端点
 * 
 * GET /api/cron/check-data-freshness - 检查各平台数据是否过期
 * 
 * 检查逻辑:
 * - 查询各平台最后一次成功抓取的时间
 * - 如果超过阈值（默认 12 小时）则发送告警
 * - 返回各平台的数据状态报告
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { alertWarning, alertError } from '@/lib/utils/alerts'
import { isAuthorized, getSupabaseEnv, getSupportedPlatforms } from '@/lib/cron/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 数据过期阈值（毫秒）
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000 // 12 小时
const CRITICAL_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 小时

// 平台显示名称映射
const PLATFORM_NAMES: Record<string, string> = {
  binance_futures: 'Binance 合约',
  binance_spot: 'Binance 现货',
  binance_web3: 'Binance Web3',
  bybit: 'Bybit',
  bitget_futures: 'Bitget 合约',
  bitget_spot: 'Bitget 现货',
  mexc: 'MEXC',
  coinex: 'CoinEx',
  okx_web3: 'OKX Web3',
  kucoin: 'KuCoin',
  gmx: 'GMX',
}

interface PlatformFreshnessStatus {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageMs: number | null
  ageHours: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  recordCount: number
}

/**
 * GET - 检查各平台数据新鲜度
 */
export async function GET(req: Request) {
  // 验证授权（如果配置了 CRON_SECRET）
  if (process.env.CRON_SECRET && !isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { url, serviceKey } = getSupabaseEnv()
  if (!url || !serviceKey) {
    return NextResponse.json(
      { error: 'Supabase 环境变量缺失' },
      { status: 500 }
    )
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  })

  const platforms = getSupportedPlatforms()
  const results: PlatformFreshnessStatus[] = []
  const stalePlatforms: string[] = []
  const criticalPlatforms: string[] = []
  const now = Date.now()

  // 检查每个平台的数据新鲜度
  for (const platform of platforms) {
    try {
      // 查询该平台最新的快照记录
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', platform)
        .order('captured_at', { ascending: false })
        .limit(1)
        .single()

      if (error && error.code !== 'PGRST116') {
        // PGRST116 是 "没有找到记录" 的错误码
        console.error(`[DataFreshness] 查询 ${platform} 失败:`, error)
      }

      // 获取记录数量
      const { count } = await supabase
        .from('trader_snapshots')
        .select('*', { count: 'exact', head: true })
        .eq('source', platform)

      const lastUpdate = data?.captured_at || null
      let ageMs: number | null = null
      let ageHours: number | null = null
      let status: 'fresh' | 'stale' | 'critical' | 'unknown' = 'unknown'

      if (lastUpdate) {
        ageMs = now - new Date(lastUpdate).getTime()
        ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10

        if (ageMs >= CRITICAL_THRESHOLD_MS) {
          status = 'critical'
          criticalPlatforms.push(platform)
        } else if (ageMs >= STALE_THRESHOLD_MS) {
          status = 'stale'
          stalePlatforms.push(platform)
        } else {
          status = 'fresh'
        }
      }

      results.push({
        platform,
        displayName: PLATFORM_NAMES[platform] || platform,
        lastUpdate,
        ageMs,
        ageHours,
        status,
        recordCount: count || 0,
      })
    } catch (error) {
      console.error(`[DataFreshness] 处理 ${platform} 时出错:`, error)
      results.push({
        platform,
        displayName: PLATFORM_NAMES[platform] || platform,
        lastUpdate: null,
        ageMs: null,
        ageHours: null,
        status: 'unknown',
        recordCount: 0,
      })
    }
  }

  // 发送告警
  if (criticalPlatforms.length > 0) {
    const criticalList = criticalPlatforms
      .map(p => `${PLATFORM_NAMES[p] || p}`)
      .join(', ')
    
    await alertError(
      '数据严重过期警告',
      `以下平台数据超过 24 小时未更新:\n${criticalList}\n\n请立即检查爬虫状态！`,
      {
        criticalPlatforms,
        threshold: '24小时',
        type: 'data_freshness_critical',
      }
    ).catch(err => {
      console.error('[DataFreshness] 发送告警失败:', err)
    })
  } else if (stalePlatforms.length > 0) {
    const staleList = stalePlatforms
      .map(p => `${PLATFORM_NAMES[p] || p}`)
      .join(', ')
    
    await alertWarning(
      '数据过期警告',
      `以下平台数据超过 12 小时未更新:\n${staleList}\n\n建议检查爬虫运行状态`,
      {
        stalePlatforms,
        threshold: '12小时',
        type: 'data_freshness_warning',
      }
    ).catch(err => {
      console.error('[DataFreshness] 发送告警失败:', err)
    })
  }

  // 统计
  const freshCount = results.filter(r => r.status === 'fresh').length
  const staleCount = stalePlatforms.length
  const criticalCount = criticalPlatforms.length
  const unknownCount = results.filter(r => r.status === 'unknown').length

  return NextResponse.json({
    ok: criticalCount === 0 && staleCount === 0,
    checked_at: new Date().toISOString(),
    summary: {
      total: platforms.length,
      fresh: freshCount,
      stale: staleCount,
      critical: criticalCount,
      unknown: unknownCount,
    },
    thresholds: {
      stale: `${STALE_THRESHOLD_MS / (1000 * 60 * 60)} 小时`,
      critical: `${CRITICAL_THRESHOLD_MS / (1000 * 60 * 60)} 小时`,
    },
    platforms: results,
  })
}
