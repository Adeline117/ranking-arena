/**
 * Enrichment 数据新鲜度检查 Cron 端点
 *
 * GET /api/cron/check-enrichment-freshness - 检查 enrichment 表数据是否过期
 *
 * 检查逻辑:
 * - 查询 trader_stats_detail 和 trader_equity_curve 最后更新时间
 * - 超过 12 小时 → stale，超过 48 小时 → critical
 * - 将告警记录到 Sentry 并发送通知
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorized, getSupabaseEnv } from '@/lib/cron/utils'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { captureMessage } from '@/lib/utils/logger'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Enrichment 过期阈值（毫秒）
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000 // 12 小时
const CRITICAL_THRESHOLD_MS = 48 * 60 * 60 * 1000 // 48 小时

interface EnrichmentStatus {
  table: string
  source: string
  period: string
  lastUpdate: string | null
  ageHours: number | null
  recordCount: number
  status: 'fresh' | 'stale' | 'critical' | 'empty'
}

export async function GET(req: Request) {
  // 验证授权
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { url, serviceKey } = getSupabaseEnv()
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  })

  const now = Date.now()
  const results: EnrichmentStatus[] = []
  // Expanded platforms to monitor - cover all major platforms
  const platforms = [
    'binance_futures', 'binance_spot', 'bybit', 'bybit_spot',
    'okx_futures', 'bitget_futures', 'bitget_spot',
    'hyperliquid', 'gmx', 'mexc', 'kucoin'
  ]
  const periods = ['7D', '30D', '90D']
  const tables = ['trader_stats_detail', 'trader_equity_curve']

  // Check each table/platform/period combination
  for (const table of tables) {
    for (const source of platforms) {
      for (const period of periods) {
        try {
          // Get latest record (both tables use 'period' field)
          const { data, error } = await supabase
            .from(table)
            .select('captured_at')
            .eq('source', source)
            .eq('period', period)
            .order('captured_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (error) {
            logger.dbError('query-enrichment-freshness', error, { table, source, period })
          }

          // Get count
          const { count } = await supabase
            .from(table)
            .select('id', { count: 'exact', head: true })
            .eq('source', source)
            .eq('period', period)

          const lastUpdate = data?.captured_at || null
          let ageHours: number | null = null
          let status: 'fresh' | 'stale' | 'critical' | 'empty' = 'empty'

          if (lastUpdate) {
            const ageMs = now - new Date(lastUpdate).getTime()
            ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10

            if (ageMs >= CRITICAL_THRESHOLD_MS) {
              status = 'critical'
            } else if (ageMs >= STALE_THRESHOLD_MS) {
              status = 'stale'
            } else {
              status = 'fresh'
            }
          }

          results.push({
            table,
            source,
            period,
            lastUpdate,
            ageHours,
            recordCount: count || 0,
            status,
          })
        } catch (error) {
          logger.error('Error checking enrichment freshness', { table, source, period }, error instanceof Error ? error : new Error(String(error)))
          results.push({
            table,
            source,
            period,
            lastUpdate: null,
            ageHours: null,
            recordCount: 0,
            status: 'empty',
          })
        }
      }
    }
  }

  // Check sharpe_ratio fill rate in trader_snapshots
  const sharpeFillRates: { source: string; fillPct: number }[] = []
  for (const source of platforms) {
    try {
      // Get total count
      const { count: total } = await supabase
        .from('trader_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('source', source)

      // Get count with sharpe_ratio
      const { count: hasSharpe } = await supabase
        .from('trader_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('source', source)
        .not('sharpe_ratio', 'is', null)

      const fillPct = total && total > 0 ? Math.round((hasSharpe || 0) / total * 100) : 0
      sharpeFillRates.push({ source, fillPct })
    } catch (err) {
      logger.error('Error checking sharpe fill rate', { source }, err instanceof Error ? err : new Error(String(err)))
    }
  }

  // Alert on low sharpe ratio fill rates
  const lowSharpePlatforms = sharpeFillRates.filter(s => s.fillPct < 30)
  if (lowSharpePlatforms.length > 3) {
    await captureMessage(
      `[EnrichmentFreshness] Low sharpe_ratio fill rate: ${lowSharpePlatforms.map(p => `${p.source}(${p.fillPct}%)`).join(', ')}`,
      'warning',
      { lowSharpePlatforms }
    )
  }

  // Calculate summary
  const summary = {
    total: results.length,
    fresh: results.filter((r) => r.status === 'fresh').length,
    stale: results.filter((r) => r.status === 'stale').length,
    critical: results.filter((r) => r.status === 'critical').length,
    empty: results.filter((r) => r.status === 'empty').length,
  }

  const criticalItems = results.filter((r) => r.status === 'critical')
  const staleItems = results.filter((r) => r.status === 'stale')
  const emptyItems = results.filter((r) => r.status === 'empty')

  // Send alerts if needed
  if (criticalItems.length > 0) {
    const items = criticalItems.map((r) => `${r.table}/${r.source}/${r.period}`).join(', ')
    await captureMessage(
      `[EnrichmentFreshness] CRITICAL: ${criticalItems.length} enrichment items >48h old`,
      'error',
      { criticalItems: items, summary }
    )

    await sendRateLimitedAlert(
      {
        title: 'Enrichment 数据严重过期',
        message: `${criticalItems.length} enrichment data items not updated in 48+ hours`,
        level: 'critical',
        details: {
          '过期项': items.substring(0, 200),
          '检查时间': new Date().toLocaleString('zh-CN'),
        },
      },
      'enrichment-freshness-critical',
      3600000 // 1 hour
    )
  } else if (staleItems.length > 5) {
    await captureMessage(
      `[EnrichmentFreshness] STALE: ${staleItems.length} enrichment items >12h old`,
      'warning',
      { staleCount: staleItems.length, summary }
    )
  }

  // Warn about empty tables
  if (emptyItems.length > 0 && emptyItems.length === results.length) {
    await captureMessage(
      '[EnrichmentFreshness] All enrichment tables are empty - enrichment may not be running',
      'warning',
      { summary }
    )
  }

  return NextResponse.json({
    ok: summary.critical === 0 && summary.stale < 5,
    checked_at: new Date().toISOString(),
    thresholds: {
      stale_hours: STALE_THRESHOLD_MS / (1000 * 60 * 60),
      critical_hours: CRITICAL_THRESHOLD_MS / (1000 * 60 * 60),
    },
    summary,
    sharpe_fill_rates: sharpeFillRates,
    results,
  })
}
