import { withAuth } from '@/lib/api/middleware'
import { reportMaintenanceResponse } from '@/lib/reports/maintenance'

export const dynamic = 'force-dynamic'

export const POST = withAuth(async () => reportMaintenanceResponse(), {
  name: 'report',
  rateLimit: false,
  skipCsrf: true,
})
