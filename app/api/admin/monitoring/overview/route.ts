/**
 * Performance Monitoring Overview API
 *
 * GET /api/admin/monitoring/overview - Get comprehensive performance metrics
 *
 * Returns:
 * - System health status
 * - Smart Scheduler metrics
 * - Anomaly Detection metrics
 * - API cost tracking
 * - Data freshness monitoring
 * - Real-time alerts
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('monitoring-overview')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Fetch data from internal API endpoint
 */
async function fetchInternalAPI(
  origin: string,
  path: string,
  authHeader: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${origin}${path}`, {
      headers: {
        'Cache-Control': 'no-cache',
        Authorization: authHeader,
      },
    })

    if (!response.ok) {
      logger.warn(`Failed to fetch ${path}`, { status: response.status })
      return null
    }

    return await response.json()
  } catch (error: unknown) {
    logger.error(`Error fetching ${path}`, { error })
    return null
  }
}

/**
 * Calculate system health score (0-100)
 */
function calculateHealthScore(metrics: {
  scraperHealth: { fresh?: number; stale?: number; critical?: number }
  overdueTraders: number
  totalTraders: number
  pendingAnomalies: number
}): number {
  const { scraperHealth, overdueTraders, totalTraders, pendingAnomalies } = metrics

  let score = 100

  // Scraper health impact (max -30 points)
  const fresh = scraperHealth.fresh ?? 0
  const stale = scraperHealth.stale ?? 0
  const critical = scraperHealth.critical ?? 0
  const totalScrapers = fresh + stale + critical
  if (totalScrapers > 0) {
    const stalePercent = (stale / totalScrapers) * 100
    const criticalPercent = (critical / totalScrapers) * 100
    score -= Math.min(30, stalePercent * 0.2 + criticalPercent * 0.5)
  }

  // Overdue traders impact (max -30 points)
  if (totalTraders > 0) {
    const overduePercent = (overdueTraders / totalTraders) * 100
    score -= Math.min(30, overduePercent * 0.3)
  }

  // Pending anomalies impact (max -20 points)
  score -= Math.min(20, pendingAnomalies * 0.5)

  return Math.max(0, Math.round(score))
}

/**
 * Determine health status based on score
 */
function getHealthStatus(score: number): {
  status: 'healthy' | 'warning' | 'critical'
  color: string
  message: string
} {
  if (score >= 80) {
    return {
      status: 'healthy',
      color: 'var(--color-chart-green)',
      message: 'System operating normally',
    }
  } else if (score >= 60) {
    return {
      status: 'warning',
      color: 'var(--color-medal-gold)',
      message: 'Minor issues detected',
    }
  } else {
    return {
      status: 'critical',
      color: 'var(--color-accent-error)',
      message: 'Critical issues require attention',
    }
  }
}

interface SchedulerStats {
  ok?: boolean
  enabled?: boolean
  dataFreshness?: { overdueTraders?: number; lastTierUpdate?: string }
  tierDistribution?: { total?: number; [key: string]: unknown }
  apiEfficiency?: Record<string, unknown>
}

interface AnomalyStats {
  ok?: boolean
  enabled?: boolean
  stats?: {
    bySeverity?: { critical?: number; high?: number; [key: string]: unknown }
    byStatus?: { pending?: number; [key: string]: unknown }
    byType?: Record<string, number>
    total?: number
  }
  recentAnomalies?: Array<{
    id: string
    trader_id: string
    platform: string
    anomaly_type: string
    field_name: string
    severity: string
    status: string
    detected_at: string
  }>
}

interface GeneralStats {
  ok?: boolean
  stats?: {
    scraperHealth?: { fresh?: number; stale?: number; critical?: number }
    users?: { total: number; newToday: number; newYesterday: number; banned: number }
    posts?: { total: number; newToday: number; newYesterday: number }
    comments?: { total: number; newToday: number }
    reports?: { pending: number; thisWeek: number }
    groups?: { total: number; pendingApplications: number }
  }
}

/**
 * Generate alerts based on metrics
 */
function generateAlerts(data: {
  schedulerStats: SchedulerStats | null
  anomalyStats: AnomalyStats | null
  generalStats: GeneralStats | null
}): Array<{
  id: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  message: string
  timestamp: string
}> {
  const alerts: Array<{
    id: string
    severity: 'info' | 'warning' | 'critical'
    title: string
    message: string
    timestamp: string
  }> = []
  const now = new Date().toISOString()

  // Smart Scheduler alerts
  if (data.schedulerStats?.ok && data.schedulerStats.enabled) {
    const overdueCount = data.schedulerStats.dataFreshness?.overdueTraders || 0
    const totalTraders = data.schedulerStats.tierDistribution?.total || 0

    if (totalTraders > 0 && overdueCount > totalTraders * 0.1) {
      alerts.push({
        id: 'scheduler-overdue',
        severity: 'warning',
        title: 'High Overdue Trader Count',
        message: `${overdueCount} traders (${((overdueCount / totalTraders) * 100).toFixed(1)}%) are overdue for refresh`,
        timestamp: now,
      })
    }
  }

  // Anomaly Detection alerts
  if (data.anomalyStats?.ok) {
    const criticalCount = data.anomalyStats.stats?.bySeverity?.critical || 0
    const highCount = data.anomalyStats.stats?.bySeverity?.high || 0

    if (criticalCount > 0) {
      alerts.push({
        id: 'anomaly-critical',
        severity: 'critical',
        title: 'Critical Anomalies Detected',
        message: `${criticalCount} critical anomalies require immediate attention`,
        timestamp: now,
      })
    } else if (highCount > 10) {
      alerts.push({
        id: 'anomaly-high',
        severity: 'warning',
        title: 'Multiple High-Severity Anomalies',
        message: `${highCount} high-severity anomalies detected`,
        timestamp: now,
      })
    }
  }

  // Scraper health alerts
  if (data.generalStats?.ok) {
    const critical = data.generalStats.stats?.scraperHealth?.critical || 0
    if (critical > 0) {
      alerts.push({
        id: 'scraper-critical',
        severity: 'critical',
        title: 'Scraper Health Critical',
        message: `${critical} scrapers have not updated in over 24 hours`,
        timestamp: now,
      })
    }
  }

  return alerts
}

/**
 * GET - Get comprehensive monitoring overview
 */
export async function GET(req: NextRequest) {
  try {
    // Rate limit check
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.sensitive)
    if (rateLimitResponse) {
      logger.warn('Rate limit exceeded for monitoring/overview')
      return rateLimitResponse
    }

    // Verify admin access
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    const admin = await verifyAdmin(supabase, authHeader)

    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Fetch data from all monitoring endpoints in parallel
    const origin = req.nextUrl.origin
    const adminAuthHeader = authHeader as string
    const [generalStatsRaw, schedulerStatsRaw, anomalyStatsRaw] = await Promise.all([
      fetchInternalAPI(origin, '/api/admin/stats', adminAuthHeader),
      fetchInternalAPI(origin, '/api/admin/scheduler/stats', adminAuthHeader),
      fetchInternalAPI(origin, '/api/admin/anomalies/stats', adminAuthHeader),
    ])

    const generalStats = generalStatsRaw as GeneralStats | null
    const schedulerStats = schedulerStatsRaw as SchedulerStats | null
    const anomalyStats = anomalyStatsRaw as AnomalyStats | null

    // Calculate system health
    const healthMetrics = {
      scraperHealth: generalStats?.stats?.scraperHealth || { fresh: 0, stale: 0, critical: 0 },
      overdueTraders: schedulerStats?.dataFreshness?.overdueTraders || 0,
      totalTraders: schedulerStats?.tierDistribution?.total || 0,
      pendingAnomalies: anomalyStats?.stats?.byStatus?.pending || 0,
    }

    const healthScore = calculateHealthScore(healthMetrics)
    const healthStatus = getHealthStatus(healthScore)

    // Generate alerts
    const alerts = generateAlerts({
      generalStats,
      schedulerStats,
      anomalyStats,
    })

    // Compile overview
    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),

      // System health summary
      health: {
        score: healthScore,
        status: healthStatus.status,
        color: healthStatus.color,
        message: healthStatus.message,
      },

      // Alerts
      alerts: {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        warning: alerts.filter(a => a.severity === 'warning').length,
        items: alerts,
      },

      // Smart Scheduler overview
      scheduler: schedulerStats?.ok ? {
        enabled: schedulerStats.enabled,
        tierDistribution: schedulerStats.tierDistribution,
        apiEfficiency: schedulerStats.apiEfficiency,
        dataFreshness: schedulerStats.dataFreshness,
      } : {
        enabled: false,
        error: 'Failed to fetch scheduler stats',
      },

      // Anomaly Detection overview
      anomalyDetection: anomalyStats?.ok ? {
        enabled: anomalyStats.enabled,
        stats: anomalyStats.stats,
        recentAnomalies: anomalyStats.recentAnomalies?.slice(0, 5) || [],
      } : {
        enabled: false,
        error: 'Failed to fetch anomaly stats',
      },

      // General system stats
      system: generalStats?.ok && generalStats.stats ? {
        users: generalStats.stats.users,
        content: {
          posts: generalStats.stats.posts,
          comments: generalStats.stats.comments,
        },
        moderation: {
          reports: generalStats.stats.reports,
          groups: generalStats.stats.groups,
        },
        scraperHealth: generalStats.stats.scraperHealth,
      } : {
        error: 'Failed to fetch system stats',
      },

      // Performance metrics
      performance: {
        responseTime: {
          avg: null, // Not yet implemented - requires metrics collection service
          p95: null,
          p99: null,
        },
        uptime: {
          percentage: null, // Not yet implemented - requires uptime monitoring service
          lastIncident: null,
        },
      },
    })
  } catch (error: unknown) {
    logger.error('Monitoring overview API error', { error })
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
