/**
 * Pipeline Self-Healing Service
 *
 * Tracks per-platform consecutive failures and data anomalies in Redis.
 * Used by the check-data-freshness cron to send targeted Telegram alerts
 * and by route-config to auto-failover between routes.
 *
 * Redis keys:
 * - pipeline:failures:{platform}        — consecutive zero-data fetches (TTL 24h)
 * - pipeline:last_count:{platform}      — last successful record count (TTL 48h)
 * - route:failures:{platform}:{route}   — consecutive route failures (TTL 24h)
 * - route:preferred:{platform}          — cached preferred route override (TTL 6h)
 */

import * as cache from '@/lib/cache'
import { sendAlert, sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { getRouteConfig, type RouteType } from '@/lib/connectors/route-config'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { logger } from '@/lib/logger'

// ============================================
// Constants
// ============================================

const FAILURE_KEY_PREFIX = 'pipeline:failures:'
const LAST_COUNT_KEY_PREFIX = 'pipeline:last_count:'
const ROUTE_FAILURE_PREFIX = 'route:failures:'
const ROUTE_PREFERRED_PREFIX = 'route:preferred:'

const FAILURE_TTL = 24 * 60 * 60 // 24h
const LAST_COUNT_TTL = 48 * 60 * 60 // 48h
const ROUTE_FAILURE_TTL = 24 * 60 * 60 // 24h
const ROUTE_PREFERRED_TTL = 6 * 60 * 60 // 6h

const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 2
const DATA_DROP_ALERT_THRESHOLD = 0.3 // alert if < 30% of historical average
const STALE_ALERT_HOURS = 12

// ============================================
// Failure Tracking
// ============================================

/**
 * Record a fetch result for a platform.
 * If recordCount is 0, increment the consecutive failure counter.
 * If recordCount > 0, reset it and store the count for future comparison.
 */
export async function recordPlatformFetchResult(
  platform: string,
  recordCount: number
): Promise<void> {
  const failureKey = `${FAILURE_KEY_PREFIX}${platform}`
  const lastCountKey = `${LAST_COUNT_KEY_PREFIX}${platform}`

  if (recordCount === 0) {
    // Increment consecutive failures
    const current = await cache.get<number>(failureKey)
    const newCount = (current ?? 0) + 1
    await cache.set(failureKey, newCount, { ttl: FAILURE_TTL })
    logger.warn(`[SelfHeal] ${platform} consecutive zero-data: ${newCount}`)
  } else {
    // Reset failures
    await cache.set(failureKey, 0, { ttl: FAILURE_TTL })

    // Check for data drop compared to historical
    const lastCount = await cache.get<number>(lastCountKey)
    if (lastCount != null && lastCount > 0) {
      const ratio = recordCount / lastCount
      if (ratio < DATA_DROP_ALERT_THRESHOLD) {
        const displayName = EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]?.name || platform
        await sendAlert({
          title: `数据量骤降: ${displayName}`,
          message: `${displayName} 数据量从 ${lastCount} 降至 ${recordCount} (${Math.round(ratio * 100)}%)`,
          level: 'warning',
          details: {
            platform,
            previousCount: lastCount,
            currentCount: recordCount,
            ratio: `${Math.round(ratio * 100)}%`,
          },
        })
      }
    }

    // Update last known good count
    await cache.set(lastCountKey, recordCount, { ttl: LAST_COUNT_TTL })
  }
}

/**
 * Get consecutive failure count for a platform from Redis.
 */
export async function getConsecutiveFailures(platform: string): Promise<number> {
  const failureKey = `${FAILURE_KEY_PREFIX}${platform}`
  const count = await cache.get<number>(failureKey)
  return count ?? 0
}

// ============================================
// Alert Evaluation (called by check-data-freshness cron)
// ============================================

export interface PlatformAlertCheck {
  platform: string
  displayName: string
  consecutiveFailures: number
  ageHours: number | null
  alertType: 'consecutive_zero' | 'stale' | 'data_drop' | null
  alertLevel: 'warning' | 'critical' | null
}

/**
 * Evaluate all platforms and send alerts for those that need attention.
 * Returns the list of platforms that triggered alerts.
 */
export async function evaluateAndAlert(
  platformStatuses: Array<{
    platform: string
    ageHours: number | null
    recordCount: number
  }>
): Promise<PlatformAlertCheck[]> {
  const alerts: PlatformAlertCheck[] = []

  for (const { platform, ageHours } of platformStatuses) {
    const displayName = EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]?.name || platform
    const consecutiveFailures = await getConsecutiveFailures(platform)

    let alertType: PlatformAlertCheck['alertType'] = null
    let alertLevel: PlatformAlertCheck['alertLevel'] = null

    // Check 1: Consecutive zero-data fetches
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD) {
      alertType = 'consecutive_zero'
      alertLevel = 'critical'
    }
    // Check 2: Data stale > 12h
    else if (ageHours != null && ageHours > STALE_ALERT_HOURS) {
      alertType = 'stale'
      alertLevel = 'warning'
    }

    if (alertType) {
      alerts.push({ platform, displayName, consecutiveFailures, ageHours, alertType, alertLevel })
    }
  }

  // Send consolidated alert if there are issues
  if (alerts.length > 0) {
    const criticals = alerts.filter(a => a.alertLevel === 'critical')
    const warnings = alerts.filter(a => a.alertLevel === 'warning')
    const isCritical = criticals.length > 0

    const lines: string[] = []
    if (criticals.length > 0) {
      lines.push('CRITICAL (连续零数据):')
      criticals.forEach(a => {
        lines.push(`  ${a.displayName}: ${a.consecutiveFailures} 次连续失败`)
      })
    }
    if (warnings.length > 0) {
      lines.push('WARNING (数据过期):')
      warnings.forEach(a => {
        lines.push(`  ${a.displayName}: ${a.ageHours?.toFixed(1)}h 未更新`)
      })
    }

    // Rate-limit consolidated self-heal alerts: same platforms = same key, 6h cooldown
    const platformKey = alerts.map(a => a.platform).sort().join(',')
    await sendRateLimitedAlert({
      title: isCritical ? '管道自愈: 严重告警' : '管道自愈: 数据过期告警',
      message: lines.join('\n'),
      level: isCritical ? 'critical' : 'warning',
      details: {
        criticalCount: criticals.length,
        warningCount: warnings.length,
        platforms: alerts.map(a => a.platform).join(', '),
      },
    }, `self-heal:${isCritical ? 'critical' : 'warning'}:${platformKey}`, 6 * 60 * 60 * 1000)
  }

  return alerts
}

// ============================================
// Route Auto-Failover
// ============================================

/**
 * Record a route success/failure for a platform.
 * After 3 consecutive failures on a route, mark the next route as preferred.
 */
export async function recordRouteResult(
  platform: string,
  route: RouteType,
  success: boolean
): Promise<void> {
  const failureKey = `${ROUTE_FAILURE_PREFIX}${platform}:${route}`

  if (success) {
    // Reset failure count
    await cache.set(failureKey, 0, { ttl: ROUTE_FAILURE_TTL })
    return
  }

  // Increment failure count
  const current = await cache.get<number>(failureKey)
  const newCount = (current ?? 0) + 1
  await cache.set(failureKey, newCount, { ttl: ROUTE_FAILURE_TTL })

  // If 3+ consecutive failures, switch to next route
  if (newCount >= 3) {
    const config = getRouteConfig(platform)
    const currentIndex = config.routes.indexOf(route)
    const nextRoute = config.routes[currentIndex + 1]

    if (nextRoute) {
      await cache.set(`${ROUTE_PREFERRED_PREFIX}${platform}`, nextRoute, {
        ttl: ROUTE_PREFERRED_TTL,
      })
      logger.warn(`[SelfHeal] Route failover: ${platform} ${route} -> ${nextRoute} (${newCount} consecutive failures)`)

      await sendAlert({
        title: `路由切换: ${platform}`,
        message: `${platform} 路由从 ${route} 自动切换到 ${nextRoute}\n原因: ${route} 连续 ${newCount} 次失败`,
        level: 'warning',
        details: {
          platform,
          fromRoute: route,
          toRoute: nextRoute,
          failureCount: newCount,
        },
      })
    }
  }
}

/**
 * Get the preferred route for a platform.
 * Returns the cached preferred route, or the first configured route if no override.
 */
export async function getPreferredRoute(platform: string): Promise<RouteType> {
  const cached = await cache.get<RouteType>(`${ROUTE_PREFERRED_PREFIX}${platform}`)
  if (cached) return cached

  const config = getRouteConfig(platform)
  return config.routes[0] || 'direct'
}

/**
 * Get route failure counts for a platform (for dashboard display).
 */
export async function getRouteFailureCounts(platform: string): Promise<Record<RouteType, number>> {
  const config = getRouteConfig(platform)
  const counts: Record<string, number> = {}

  for (const route of config.routes) {
    const failureKey = `${ROUTE_FAILURE_PREFIX}${platform}:${route}`
    const count = await cache.get<number>(failureKey)
    counts[route] = count ?? 0
  }

  return counts as Record<RouteType, number>
}

/**
 * Reset preferred route for a platform (manual override).
 */
export async function resetPreferredRoute(platform: string): Promise<void> {
  await cache.del(`${ROUTE_PREFERRED_PREFIX}${platform}`)
}
