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
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { captureMessage } from '@/lib/utils/logger'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { evaluateAndAlert } from '@/lib/services/pipeline-self-heal'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import {
  parseVisibleLeaderboardSources,
  type LeaderboardTimeRange,
} from '@/lib/data/visible-leaderboard-sources'
import {
  buildRegistrySourceFreshnessStatuses,
  parseExpectedSourceWindows,
  type VisibleSourceWindow,
} from '@/lib/rankings/source-freshness'
import type { FreshnessReport, PlatformFreshnessStatus } from '@/lib/rankings/freshness-report'

export type { FreshnessReport, PlatformFreshnessStatus } from '@/lib/rankings/freshness-report'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 数据过期阈值（毫秒）
const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000 // 8 小时
const CRITICAL_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 小时
const RANKING_SEASONS: readonly LeaderboardTimeRange[] = ['7D', '30D', '90D']

// 平台级阈值覆盖（毫秒）— 某些平台 API 不稳定或更新频率低
const PLATFORM_THRESHOLD_OVERRIDES: Record<string, { stale: number; critical: number }> = {
  blofin: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 }, // BloFin API 频繁限流
  gmx: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 }, // On-chain, less frequent
  gains: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 }, // On-chain
}

type PipelineLogHandle = Awaited<ReturnType<typeof PipelineLogger.start>>

async function bestEffort(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch {
    logger.error(label, {}, new Error(label))
  }
}

async function freshnessAuthorityUnavailable(plog: PipelineLogHandle | null) {
  if (plog) {
    await bestEffort('Failed to record freshness authority failure', () =>
      plog.error(new Error('Data freshness authority unavailable'))
    )
  }
  await bestEffort('Failed to send freshness authority alert', () =>
    sendRateLimitedAlert(
      {
        title: '数据新鲜度权威不可用',
        message: 'registry、可见榜单或 source_as_of 水位查询失败；本次检查已 fail closed。',
        level: 'critical',
        details: { authority_available: false },
      },
      'data-freshness:authority-unavailable',
      60 * 60 * 1000
    )
  )
  return NextResponse.json({ error: 'freshness_authority_unavailable' }, { status: 500 })
}

async function freshnessPipelineLogUnavailable(): Promise<void> {
  logger.error(
    'Data freshness pipeline log unavailable',
    {},
    new Error('Data freshness pipeline log unavailable')
  )
  await bestEffort('Failed to send freshness pipeline-log alert', () =>
    sendRateLimitedAlert(
      {
        title: '数据新鲜度日志链路不可用',
        message:
          'PipelineLogger 启动失败；数据权威检查将继续执行，但本次运行可能没有 pipeline log。',
        level: 'warning',
        details: { pipeline_log_available: false },
      },
      'data-freshness:pipeline-log-unavailable',
      60 * 60 * 1000
    )
  )
}

/**
 * 构建新鲜度报告（共享逻辑，cron 和 admin endpoint 都用）
 */
export async function buildFreshnessReport(): Promise<FreshnessReport> {
  const supabase = getSupabaseAdmin()
  const now = Date.now()

  // Registry promises, current positive-count visibility, and upstream
  // watermarks are independent authorities. Keeping all three prevents a
  // source from making itself disappear from monitoring when its count falls
  // to zero or its current-generation cache row goes missing.
  const [expectedResult, visibleBySeason, watermarkResult] = await Promise.all([
    supabase.rpc('arena_freshness_expected_sources'),
    Promise.all(
      RANKING_SEASONS.map(async (season) => ({
        season,
        result: await supabase.rpc('arena_visible_sources', {
          p_season_id: season,
        }),
      }))
    ),
    supabase
      .from('leaderboard_source_freshness')
      .select('season_id,source,source_as_of')
      .in('season_id', [...RANKING_SEASONS]),
  ])

  if (expectedResult.error) {
    throw new Error('freshness expected source authority is unavailable')
  }
  const expectedWindows = parseExpectedSourceWindows(expectedResult.data)

  const visibleWindows: VisibleSourceWindow[] = visibleBySeason.flatMap(({ season, result }) => {
    if (result.error) {
      throw new Error('visible source freshness authority is unavailable')
    }
    return parseVisibleLeaderboardSources(result.data).map((source) => ({
      season_id: season,
      registry_slug: source.registrySlug,
      source: source.filterSource,
      display_name: source.exchangeName,
      record_count: source.traderCount,
    }))
  })
  if (watermarkResult.error || !Array.isArray(watermarkResult.data)) {
    throw new Error('source watermark freshness authority is unavailable')
  }

  const sourceStatuses = buildRegistrySourceFreshnessStatuses(
    expectedWindows,
    visibleWindows,
    watermarkResult.data,
    now
  )
  const results: PlatformFreshnessStatus[] = []
  const stalePlatforms: string[] = []
  const criticalPlatforms: string[] = []
  const unknownPlatforms: string[] = []

  for (const source of sourceStatuses) {
    let ageMs: number | null = null
    let ageHours: number | null = null
    let status: PlatformFreshnessStatus['status'] = 'unknown'

    if (source.issues.length > 0 || source.updated_at === null) {
      unknownPlatforms.push(source.source)
    } else {
      ageMs = Math.max(0, now - Date.parse(source.updated_at))
      ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10
      const overrides = PLATFORM_THRESHOLD_OVERRIDES[source.source]
      const critThreshold = overrides?.critical ?? CRITICAL_THRESHOLD_MS
      const staleThreshold = overrides?.stale ?? STALE_THRESHOLD_MS

      if (ageMs >= critThreshold) {
        status = 'critical'
        criticalPlatforms.push(source.source)
      } else if (ageMs >= staleThreshold) {
        status = 'stale'
        stalePlatforms.push(source.source)
      } else {
        status = 'fresh'
      }
    }

    results.push({
      platform: source.source,
      displayName: source.display_name,
      lastUpdate: source.updated_at,
      ageMs,
      ageHours,
      status,
      recordCount: source.record_count,
    })
  }

  const freshCount = results.filter((r) => r.status === 'fresh').length

  return {
    ok:
      criticalPlatforms.length === 0 &&
      stalePlatforms.length === 0 &&
      unknownPlatforms.length === 0,
    checked_at: new Date(now).toISOString(),
    summary: {
      total: results.length,
      fresh: freshCount,
      stale: stalePlatforms.length,
      critical: criticalPlatforms.length,
      unknown: unknownPlatforms.length,
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

  const releaseLock = await acquireCronLock('check-data-freshness', {
    // Keep the lease past Vercel's hard timeout so a duplicate delivery cannot
    // start while the first invocation is still being terminated.
    ttlSeconds: maxDuration + 30,
  })
  if (!releaseLock) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'concurrent_execution',
    })
  }

  try {
    return await runFreshnessCheck()
  } finally {
    await bestEffort('Failed to release freshness cron lock', releaseLock)
  }
}

async function runFreshnessCheck() {
  let plog: PipelineLogHandle | null = null
  try {
    plog = await PipelineLogger.start('check-data-freshness')
  } catch {
    await freshnessPipelineLogUnavailable()
  }

  let report: FreshnessReport
  try {
    report = await buildFreshnessReport()
  } catch {
    return freshnessAuthorityUnavailable(plog)
  }

  const stalePlatforms = report.platforms.filter((p) => p.status === 'stale')
  const criticalPlatforms = report.platforms.filter((p) => p.status === 'critical')
  const unknownPlatforms = report.platforms.filter((p) => p.status === 'unknown')

  // ── Sentry 告警 ──────────────────────────────────────────
  if (unknownPlatforms.length > 0) {
    const names = unknownPlatforms.map((p) => p.displayName).join(', ')
    await bestEffort('Failed to capture unknown freshness alert', () =>
      captureMessage(`[DataFreshness] UNKNOWN WATERMARK: ${names} 缺少可信上游水位`, 'error', {
        level: 'critical',
        unknownPlatforms: unknownPlatforms.map((p) => p.platform),
        criticalPlatforms: criticalPlatforms.map((p) => p.platform),
        stalePlatforms: stalePlatforms.map((p) => p.platform),
        summary: report.summary,
      })
    )
    logger.error(
      `Data freshness watermark unavailable: ${names}`,
      { unknownPlatforms: unknownPlatforms.map((p) => p.platform) },
      new Error('Data freshness watermark unavailable')
    )
  } else if (criticalPlatforms.length > 0) {
    const names = criticalPlatforms.map((p) => p.displayName).join(', ')
    await bestEffort('Failed to capture critical freshness alert', () =>
      captureMessage(`[DataFreshness] CRITICAL: ${names} 超过 24 小时未更新`, 'error', {
        level: 'critical',
        stalePlatforms: stalePlatforms.map((p) => p.platform),
        criticalPlatforms: criticalPlatforms.map((p) => p.platform),
        summary: report.summary,
      })
    )
    logger.error(
      `Data severely stale: ${names} - not updated in 24h`,
      {
        criticalPlatforms: criticalPlatforms.map((p) => p.platform),
      },
      new Error('Data severely stale')
    )
  } else if (stalePlatforms.length > 0) {
    const names = stalePlatforms.map((p) => p.displayName).join(', ')
    await bestEffort('Failed to capture stale freshness alert', () =>
      captureMessage(`[DataFreshness] STALE: ${names} 超过 8 小时未更新`, 'warning', {
        level: 'stale',
        stalePlatforms: stalePlatforms.map((p) => p.platform),
        summary: report.summary,
      })
    )
    logger.warn(`Data stale: ${names} - not updated in 8h`, {
      stalePlatforms: stalePlatforms.map((p) => p.platform),
    })
  }

  // ── Telegram 告警 (rate-limited, 6h cooldown per platform set) ─────
  if (unknownPlatforms.length > 0 || criticalPlatforms.length > 0 || stalePlatforms.length > 0) {
    const isCritical = unknownPlatforms.length > 0 || criticalPlatforms.length > 0
    const lines: string[] = []
    if (unknownPlatforms.length > 0) {
      lines.push('水位未知（缺失、非法、超前或当前榜单缺失）:')
      unknownPlatforms.forEach((p) => {
        lines.push(`  • ${p.displayName} — ${p.recordCount} visible records`)
      })
    }
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

    const platformKey = [...unknownPlatforms, ...criticalPlatforms, ...stalePlatforms]
      .map((p) => p.platform)
      .sort()
      .join(',')
    await bestEffort('Failed to send rate-limited freshness alert', () =>
      sendRateLimitedAlert(
        {
          title: '数据新鲜度告警',
          message: lines.join('\n'),
          level: isCritical ? 'critical' : 'warning',
          details: {
            critical_count: criticalPlatforms.length,
            stale_count: stalePlatforms.length,
            unknown_count: unknownPlatforms.length,
          },
        },
        `data-freshness:${unknownPlatforms.length > 0 ? 'unknown:' : ''}${platformKey}`,
        6 * 60 * 60 * 1000
      )
    )
  }

  // ── Self-heal evaluation (Redis-backed consecutive failure tracking) ──
  await bestEffort('Data freshness self-heal evaluation failed', async () => {
    const platformStatuses = report.platforms.map((p) => ({
      platform: p.platform,
      ageHours: p.ageHours,
      recordCount: p.recordCount,
    }))
    const selfHealAlerts = await evaluateAndAlert(platformStatuses)
    if (selfHealAlerts.length > 0) {
      logger.warn(
        `[DataFreshness] Self-heal triggered alerts for ${selfHealAlerts.length} platforms`,
        {
          platforms: selfHealAlerts.map((a) => a.platform),
        }
      )
    }
  })

  // Always log as success — this is a monitoring job, detecting staleness is expected behavior.
  // Staleness details are in metadata, not treated as job failure.
  if (plog) {
    await bestEffort('Failed to record freshness check success', () =>
      plog.success(report.summary.fresh, {
        summary: report.summary,
        critical: report.summary.critical,
        stale: report.summary.stale,
        unknown: report.summary.unknown,
      })
    )
  }

  return NextResponse.json(report)
}
