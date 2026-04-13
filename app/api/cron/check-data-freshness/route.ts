/**
 * 数据新鲜度检查 Cron 端点
 *
 * GET /api/cron/check-data-freshness - 检查各平台数据是否过期
 *
 * 检查逻辑:
 * - 查询各平台最后一次成功抓取的时间
 * - 超过 8 小时 → stale，超过 24 小时 → critical
 * - 将告警记录到 Sentry 并发送通知
 * - 返回各平台的数据状态报告
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { isAuthorized } from '@/lib/cron/utils'
import { getSupportedInlinePlatforms } from '@/lib/cron/fetchers'
import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import { sendScraperAlert, sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { captureMessage } from '@/lib/utils/logger'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { evaluateAndAlert } from '@/lib/services/pipeline-self-heal'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 数据过期阈值（毫秒）
const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000 // 8 小时
const CRITICAL_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 小时

// 平台级阈值覆盖（毫秒）— 某些平台 API 不稳定或更新频率低
const PLATFORM_THRESHOLD_OVERRIDES: Record<string, { stale: number; critical: number }> = {
  blofin: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 }, // BloFin API 频繁限流
  gmx: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 }, // On-chain, less frequent
  gains: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 }, // On-chain
}

// 平台显示名称映射
const PLATFORM_NAMES: Record<string, string> = {
  binance_futures: 'Binance 合约',
  // binance_spot: REMOVED 2026-03-14
  binance_web3: 'Binance Web3',
  bybit: 'Bybit',
  bitget_futures: 'Bitget 合约',
  bitget_spot: 'Bitget 现货',
  mexc: 'MEXC',
  coinex: 'CoinEx',
  okx_web3: 'OKX Web3',
  okx_futures: 'OKX 合约',
  // kucoin: 'KuCoin', — DEAD
  gmx: 'GMX',
  htx: 'HTX',
  htx_futures: 'HTX Futures',
  weex: 'WEEX',
  phemex: 'Phemex',
  bingx: 'BingX',
  gateio: 'Gate.io',
  xt: 'XT',
  gains: 'Gains Network',
  lbank: 'LBank',
  blofin: 'BloFin',
  drift: 'Drift',
  bitunix: 'Bitunix',
  btcc: 'BTCC',
  bitmart: 'BitMart',
  paradex: 'Paradex',
  bitfinex: 'Bitfinex',
  web3_bot: 'Web3 Bot',
  toobit: 'Toobit',
  jupiter_perps: 'Jupiter Perps',
  hyperliquid: 'Hyperliquid',
  dydx: 'dYdX',
  aevo: 'Aevo',
  bybit_spot: 'Bybit Spot',
}

export interface PlatformFreshnessStatus {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageMs: number | null
  ageHours: number | null
  status: 'fresh' | 'stale' | 'critical' | 'unknown'
  recordCount: number
}

export interface FreshnessReport {
  ok: boolean
  checked_at: string
  summary: {
    total: number
    fresh: number
    stale: number
    critical: number
    unknown: number
  }
  thresholds: {
    stale_hours: number
    critical_hours: number
  }
  platforms: PlatformFreshnessStatus[]
}

/**
 * 构建新鲜度报告（共享逻辑，cron 和 admin endpoint 都用）
 */
export async function buildFreshnessReport(): Promise<FreshnessReport> {
  const supabase = getSupabaseAdmin()

  const allPlatforms = getSupportedInlinePlatforms()
  const deadSet = new Set(DEAD_BLOCKED_PLATFORMS as string[])
  const platforms = allPlatforms.filter(p => !deadSet.has(p))
  const results: PlatformFreshnessStatus[] = []
  const stalePlatforms: string[] = []
  const criticalPlatforms: string[] = []
  const now = Date.now()

  // 检查每个平台的数据新鲜度
  for (const platform of platforms) {
    try {
      // 查询该平台最新的 v2 快照记录
      const { data, error } = await supabase
        .from('trader_snapshots_v2')
        .select('created_at')
        .eq('platform', platform)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (error && error.code !== 'PGRST116') {
        logger.dbError('query-platform-freshness', error, { platform })
      }

      // 获取记录数量 — estimated to avoid full scans of trader_snapshots_v2
      // (~70M rows). This is a health check; approximate count is sufficient
      // to decide "stale vs fresh" and the job runs every 3h.
      const { count } = await supabase
        .from('trader_snapshots_v2')
        .select('id', { count: 'estimated', head: true })
        .eq('platform', platform)

      const lastUpdate = data?.created_at || null
      let ageMs: number | null = null
      let ageHours: number | null = null
      let status: 'fresh' | 'stale' | 'critical' | 'unknown' = 'unknown'

      if (lastUpdate) {
        ageMs = now - new Date(lastUpdate).getTime()
        ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10

        // Use per-platform threshold overrides if available
        const overrides = PLATFORM_THRESHOLD_OVERRIDES[platform]
        const critThreshold = overrides?.critical ?? CRITICAL_THRESHOLD_MS
        const staleThreshold = overrides?.stale ?? STALE_THRESHOLD_MS

        if (ageMs >= critThreshold) {
          status = 'critical'
          criticalPlatforms.push(platform)
        } else if (ageMs >= staleThreshold) {
          status = 'stale'
          stalePlatforms.push(platform)
        } else {
          status = 'fresh'
        }

        // Guard: a single garbage row can make a broken platform appear fresh.
        // Check recent row count to confirm real data is flowing.
        if (status === 'fresh' && typeof count === 'number') {
          const { count: recentCount } = await supabase
            .from('trader_snapshots_v2')
            .select('id', { count: 'estimated', head: true })
            .eq('platform', platform)
            .gte('created_at', new Date(now - staleThreshold).toISOString())
          if (typeof recentCount === 'number' && recentCount < 5) {
            status = 'stale'
            stalePlatforms.push(platform)
            logger.warn(`[freshness] ${platform}: latest row is recent but only ${recentCount} rows in window — marking stale`)
          }
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
    } catch (error: unknown) {
      logger.error('Error processing platform freshness', { platform }, error instanceof Error ? error : new Error(String(error)))
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

  const freshCount = results.filter((r) => r.status === 'fresh').length
  const unknownCount = results.filter((r) => r.status === 'unknown').length

  return {
    ok: criticalPlatforms.length === 0 && stalePlatforms.length === 0,
    checked_at: new Date().toISOString(),
    summary: {
      total: platforms.length,
      fresh: freshCount,
      stale: stalePlatforms.length,
      critical: criticalPlatforms.length,
      unknown: unknownCount,
    },
    thresholds: {
      stale_hours: STALE_THRESHOLD_MS / (1000 * 60 * 60),
      critical_hours: CRITICAL_THRESHOLD_MS / (1000 * 60 * 60),
    },
    platforms: results,
  }
}

/**
 * GET - 检查各平台数据新鲜度（cron 触发）
 */
export async function GET(req: Request) {
  // 验证授权
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('check-data-freshness')

  try {
    const report = await buildFreshnessReport()

    const stalePlatforms = report.platforms.filter((p) => p.status === 'stale')
    const criticalPlatforms = report.platforms.filter((p) => p.status === 'critical')

    // ── Sentry 告警 ──────────────────────────────────────────
    if (criticalPlatforms.length > 0) {
      const names = criticalPlatforms.map((p) => p.displayName).join(', ')
      await captureMessage(
        `[DataFreshness] CRITICAL: ${names} 超过 24 小时未更新`,
        'error',
        {
          level: 'critical',
          stalePlatforms: stalePlatforms.map((p) => p.platform),
          criticalPlatforms: criticalPlatforms.map((p) => p.platform),
          summary: report.summary,
        }
      )
      logger.error(`Data severely stale: ${names} - not updated in 24h`, {
        criticalPlatforms: criticalPlatforms.map((p) => p.platform)
      }, new Error('Data severely stale'))
    } else if (stalePlatforms.length > 0) {
      const names = stalePlatforms.map((p) => p.displayName).join(', ')
      await captureMessage(
        `[DataFreshness] STALE: ${names} 超过 8 小时未更新`,
        'warning',
        {
          level: 'stale',
          stalePlatforms: stalePlatforms.map((p) => p.platform),
          summary: report.summary,
        }
      )
      logger.warn(`Data stale: ${names} - not updated in 8h`, {
        stalePlatforms: stalePlatforms.map((p) => p.platform)
      })
    }

    // ── Telegram 告警 (rate-limited, 6h cooldown per platform set) ─────
    if (criticalPlatforms.length > 0 || stalePlatforms.length > 0) {
      const isCritical = criticalPlatforms.length > 0
      const lines: string[] = []
      if (criticalPlatforms.length > 0) {
        lines.push('严重过期 (>24h):')
        criticalPlatforms.forEach((p) => {
          lines.push(`  • ${p.displayName} — ${p.ageHours}h ago, ${p.recordCount} records`)
        })
      }
      if (stalePlatforms.length > 0) {
        lines.push('陈旧 (>8h):')
        stalePlatforms.forEach((p) => {
          lines.push(`  • ${p.displayName} — ${p.ageHours}h ago, ${p.recordCount} records`)
        })
      }
      lines.push(`\n✅ ${report.summary.fresh} fresh / ${report.summary.total} total`)

      const platformKey = [...criticalPlatforms, ...stalePlatforms].map(p => p.platform).sort().join(',')
      await sendRateLimitedAlert({
        title: '数据新鲜度告警',
        message: lines.join('\n'),
        level: isCritical ? 'critical' : 'warning',
        details: {
          critical_count: criticalPlatforms.length,
          stale_count: stalePlatforms.length,
        },
      }, `data-freshness:${platformKey}`, 6 * 60 * 60 * 1000)
    }

    // ── 外部告警通知（Slack / 飞书等）────────────────────────
    if (criticalPlatforms.length > 0 || stalePlatforms.length > 0) {
      try {
        const alertResult = await sendScraperAlert(
          criticalPlatforms.map((p) => p.platform),
          stalePlatforms.map((p) => p.platform),
          PLATFORM_NAMES
        )
        if (alertResult.sent) {
          // Alert sent successfully
        }
      } catch (error: unknown) {
        logger.error('Failed to send freshness alert', {}, error instanceof Error ? error : new Error(String(error)))
      }
    }

    // ── Self-heal evaluation (Redis-backed consecutive failure tracking) ──
    try {
      const platformStatuses = report.platforms.map(p => ({
        platform: p.platform,
        ageHours: p.ageHours,
        recordCount: p.recordCount,
      }))
      const selfHealAlerts = await evaluateAndAlert(platformStatuses)
      if (selfHealAlerts.length > 0) {
        logger.warn(`[DataFreshness] Self-heal triggered alerts for ${selfHealAlerts.length} platforms`, {
          platforms: selfHealAlerts.map(a => a.platform),
        })
      }
    } catch (shErr) {
      logger.error('[DataFreshness] Self-heal evaluation error:', shErr)
    }

    // Always log as success — this is a monitoring job, detecting staleness is expected behavior.
    // Staleness details are in metadata, not treated as job failure.
    await plog.success(report.summary.fresh, {
      summary: report.summary,
      critical: report.summary.critical,
      stale: report.summary.stale,
    })

    return NextResponse.json(report)
  } catch (error: unknown) {
    await plog.error(error)
    const message =
      error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
