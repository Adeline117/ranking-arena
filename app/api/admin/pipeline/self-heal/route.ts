/**
 * Admin Pipeline Self-Heal Status API
 *
 * GET /api/admin/pipeline/self-heal
 * Returns per-platform health status with self-heal data:
 * - Data freshness from trader_snapshots_v2
 * - Consecutive failure counts from Redis
 * - Route failover status
 * - Health status (healthy/warning/critical)
 *
 * Auth: x-admin-token or Bearer CRON_SECRET
 */

import { NextRequest } from 'next/server'
import { success as apiSuccess, handleError } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getSupportedPlatforms } from '@/lib/cron/fetchers'
import { DEAD_BLOCKED_PLATFORMS, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { getConsecutiveFailures, getPreferredRoute, getRouteFailureCounts } from '@/lib/services/pipeline-self-heal'
import { getRouteConfig } from '@/lib/connectors/route-config'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    if (!(await verifyAdminAuth(request))) {
      throw ApiError.unauthorized()
    }

    const supabase = getSupabaseAdmin()
    const deadSet = new Set<string>([...DEAD_BLOCKED_PLATFORMS])
    const activePlatforms = getSupportedPlatforms().filter(p => !deadSet.has(p))
    const now = Date.now()

    const platforms = await Promise.all(activePlatforms.map(async (platform) => {
      const config = EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]
      const displayName = config?.name || platform
      const routeConfig = getRouteConfig(platform)

      const [
        latestRes,
        consecutiveFailures,
        preferredRoute,
        routeFailures,
      ] = await Promise.all([
        // Latest snapshot
        supabase
          .from('trader_snapshots_v2')
          .select('updated_at')
          .eq('platform', platform)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        getConsecutiveFailures(platform),
        getPreferredRoute(platform),
        getRouteFailureCounts(platform),
      ])

      // Also get recent record count — estimated to avoid per-platform
      // exact scans of trader_snapshots_v2 (~70M rows). Used for a
      // healthy/warning/critical band; approximate is sufficient.
      const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString()
      const { count: recentCount } = await supabase
        .from('trader_snapshots_v2')
        .select('id', { count: 'estimated', head: true })
        .eq('platform', platform)
        .gte('updated_at', sixHoursAgo)

      const lastUpdate = latestRes.data?.updated_at || null
      const ageHours = lastUpdate
        ? Math.round(((now - new Date(lastUpdate).getTime()) / (1000 * 60 * 60)) * 10) / 10
        : null

      let status: 'healthy' | 'warning' | 'critical' = 'healthy'
      if (consecutiveFailures >= 3 || (ageHours != null && ageHours > 12)) {
        status = 'critical'
      } else if (consecutiveFailures >= 1 || (ageHours != null && ageHours > 6)) {
        status = 'warning'
      }

      const defaultRoute = routeConfig.routes[0] || 'direct'
      const routeSwitched = preferredRoute !== defaultRoute

      return {
        platform,
        displayName,
        lastUpdate,
        ageHours,
        recentCount: recentCount || 0,
        consecutiveFailures,
        status,
        routes: {
          configured: routeConfig.routes,
          preferred: preferredRoute,
          default: defaultRoute,
          switched: routeSwitched,
          failures: routeFailures,
        },
      }
    }))

    // Sort: critical first, then warning, then healthy
    const statusOrder = { critical: 0, warning: 1, healthy: 2 }
    platforms.sort((a, b) => statusOrder[a.status] - statusOrder[b.status])

    const summary = {
      total: platforms.length,
      healthy: platforms.filter(p => p.status === 'healthy').length,
      warning: platforms.filter(p => p.status === 'warning').length,
      critical: platforms.filter(p => p.status === 'critical').length,
      routeSwitches: platforms.filter(p => p.routes.switched).length,
    }

    return apiSuccess({ summary, platforms, timestamp: new Date().toISOString() })
  } catch (error) {
    return handleError(error, 'admin-pipeline-self-heal')
  }
}
