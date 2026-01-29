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
async function fetchInternalAPI(path: string): Promise<any> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        'Cache-Control': 'no-cache',
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
  scraperHealth: { fresh: number; stale: number; critical: number }
  overdueTraders: number
  totalTraders: number
  pendingAnomalies: number
}): number {
  const { scraperHealth, overdueTraders, totalTraders, pendingAnomalies } = metrics

  let score = 100

  // Scraper health impact (max -30 points)
  const totalScrapers = scraperHealth.fresh + scraperHealth.stale + scraperHealth.critical
  if (totalScrapers > 0) {
    const stalePercent = (scraperHealth.stale / totalScrapers) * 100
    const criticalPercent = (scraperHealth.critical / totalScrapers) * 100
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
      color: '#7CFFB2',
      message: 'System operating normally',
    }
  } else if (score >= 60) {
    return {
      status: 'warning',
      color: '#FFD700',
      message: 'Minor issues detected',
    }
  } else {
    return {
      status: 'critical',
      color: '#FF7C7C',
      message: 'Critical issues require attention',
    }
  }
}

/**
 * Generate alerts based on metrics
 */
function generateAlerts(data: {
  schedulerStats: any
  anomalyStats: any
  generalStats: any
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
    const [generalStats, schedulerStats, anomalyStats] = await Promise.all([
      fetchInternalAPI('/api/admin/stats'),
      fetchInternalAPI('/api/admin/scheduler/stats'),
      fetchInternalAPI('/api/admin/anomalies/stats'),
    ])

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
      system: generalStats?.ok ? {
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
          avg: null, // TODO: Implement with metrics collection
          p95: null,
          p99: null,
        },
        uptime: {
          percentage: null, // TODO: Implement with uptime monitoring
          lastIncident: null,
        },
      },
    })
  } catch (error: unknown) {
    logger.error('Monitoring overview API error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
