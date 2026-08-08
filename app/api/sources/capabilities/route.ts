/**
 * GET /api/sources/capabilities
 *
 * Capability matrix for all active arena sources (spec §6: "capability
 * matrix is data, not code"). This authority-bearing projection is read with
 * the request-scoped Supabase client and is never placed in Next's data cache
 * or an edge cache, so a source demotion is visible on the next request.
 */

import { NextRequest } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { success as apiSuccess } from '@/lib/api/response'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import { METRIC_AUTHORITY_NO_STORE_HEADERS } from '@/lib/data/serving/cache-policy'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const handler = withPublic(
    async ({ supabase }) => {
      const capabilities = await getSourceCapabilities(supabase)
      return apiSuccess(capabilities, 200, METRIC_AUTHORITY_NO_STORE_HEADERS)
    },
    { name: 'sources-capabilities', rateLimit: 'public' }
  )
  return handler(request)
}
