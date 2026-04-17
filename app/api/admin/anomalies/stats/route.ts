/**
 * Admin API: Anomaly Statistics
 * GET /api/admin/anomalies/stats - Get aggregated anomaly statistics
 *
 * @module app/api/admin/anomalies/stats
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success } from '@/lib/api/response'
import { getAnomalyStats } from '@/lib/services/anomaly-manager'

export const GET = withAdminAuth(async () => {
  const stats = await getAnomalyStats()
  return success(stats)
}, { name: 'admin-anomaly-stats' })
