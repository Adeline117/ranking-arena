/**
 * Admin API: Anomaly List
 * GET /api/admin/anomalies - List all anomalies with filtering
 *
 * @module app/api/admin/anomalies
 */

import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { successWithPagination } from '@/lib/api/response'
import { getAllAnomalies, type GetAnomaliesOptions } from '@/lib/services/anomaly-manager'

export const GET = withAdminAuth(
  async ({ request }) => {
    // Parse query parameters
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') as GetAnomaliesOptions['status'] | null
    const severity = searchParams.get('severity') as GetAnomaliesOptions['severity'] | null
    const platform = searchParams.get('platform')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10) || 50, 200)
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0)

    // Fetch anomalies
    const options: GetAnomaliesOptions & { platform?: string } = {
      limit,
      offset,
    }

    if (status) options.status = status
    if (severity) options.severity = severity
    if (platform) options.platform = platform

    const anomalies = await getAllAnomalies(options)

    return successWithPagination(
      anomalies,
      {
        limit,
        offset,
        has_more: anomalies.length === limit,
      }
    )
  },
  { name: 'admin-anomalies' }
)
