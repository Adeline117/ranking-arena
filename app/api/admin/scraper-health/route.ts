/**
 * 抓取系统健康状态 API
 * GET /api/admin/scraper-health
 *
 * 返回各平台抓取统计、系统健康状态、告警信息
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSystemHealth, getAllPlatformStats, getRecentAlerts } from '@/lib/scraper/telemetry'
import { getCronCircuitBreakerStats } from '@/lib/cron/utils'
import { PLATFORM_CONFIGS, getEnabledPlatforms } from '@/lib/scraper/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 简单的管理员认证
function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // 开发环境允许无密钥访问
  if (!cronSecret && process.env.NODE_ENV === 'development') {
    return true
  }

  if (!cronSecret) {
    return false
  }

  return authHeader === `Bearer ${cronSecret}`
}

export async function GET(req: NextRequest) {
  // 验证权限
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const period = searchParams.get('period') || '24h'
    const includeDetails = searchParams.get('details') === 'true'

    // 并行获取所有数据
    const [health, platformStats, alerts, circuitBreakerStats] = await Promise.all([
      getSystemHealth(),
      getAllPlatformStats(period),
      getRecentAlerts(20),
      Promise.resolve(getCronCircuitBreakerStats()),
    ])

    // 构建平台概览
    const enabledPlatforms = getEnabledPlatforms()
    const platformOverview = enabledPlatforms.map(config => {
      const stats = platformStats.find(s => s.platform === config.id)
      const cbStats = circuitBreakerStats[`cron-${config.id}`]

      return {
        id: config.id,
        name: config.name,
        type: config.type,
        priority: config.priority,
        enabled: config.enabled,
        stats: stats ? {
          successRate: stats.successRate,
          totalRequests: stats.totalRequests,
          avgDuration: Math.round(stats.avgDuration),
          p95Duration: stats.p95Duration,
          lastSuccess: stats.lastSuccess,
          lastFailure: stats.lastFailure,
        } : null,
        circuitBreaker: cbStats ? {
          state: cbStats.state,
          failures: cbStats.failures,
          totalRequests: cbStats.totalRequests,
        } : null,
      }
    })

    // 计算汇总统计
    const summary = {
      totalPlatforms: enabledPlatforms.length,
      healthyPlatforms: health.platformsUp,
      degradedPlatforms: health.platformsDegraded,
      downPlatforms: health.platformsDown,
      overallSuccessRate: health.overallSuccessRate,
      activeAlerts: alerts.filter(a => a.level === 'critical').length,
      warnings: alerts.filter(a => a.level === 'warning').length,
    }

    const response: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      period,
      summary,
      health: {
        status: health.platformsDown > 0 ? 'critical' : health.platformsDegraded > 0 ? 'degraded' : 'healthy',
        platformsUp: health.platformsUp,
        platformsDown: health.platformsDown,
        platformsDegraded: health.platformsDegraded,
      },
      alerts: alerts.slice(0, 10),
      platforms: platformOverview.sort((a, b) => a.priority - b.priority),
    }

    // 详细模式包含更多信息
    if (includeDetails) {
      response.platformConfigs = Object.fromEntries(
        enabledPlatforms.map(p => [p.id, {
          scrape: p.scrape,
          retry: p.retry,
          circuitBreaker: p.circuitBreaker,
          validation: p.validation,
          refreshSchedule: p.refreshSchedule,
        }])
      )
      response.fullStats = platformStats
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[ScraperHealth] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch health data' },
      { status: 500 }
    )
  }
}
