/**
 * GET /api/sources/capabilities
 *
 * Capability matrix for all active arena sources (spec §6: "capability
 * matrix is data, not code"). The expensive RPC is held in a short,
 * authority-versioned server data cache; public responses are no-store so a
 * withdrawn metric cannot survive through edge SWR.
 */

import { NextRequest } from 'next/server'
import { unstable_cache } from 'next/cache'
import { withPublic } from '@/lib/api/middleware'
import { success as apiSuccess } from '@/lib/api/response'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import { getReadReplica } from '@/lib/supabase/read-replica'
import {
  METRIC_AUTHORITY_NO_STORE_HEADERS,
  servingMetricAuthorityCacheKey,
} from '@/lib/data/serving/cache-policy'

export const dynamic = 'force-dynamic'

const cachedCapabilities = unstable_cache(
  async () => getSourceCapabilities(getReadReplica()),
  [servingMetricAuthorityCacheKey('arena-source-capabilities')],
  { revalidate: 300 }
)

export async function GET(request: NextRequest) {
  const handler = withPublic(
    async () => {
      const capabilities = await cachedCapabilities()
      return apiSuccess(capabilities, 200, METRIC_AUTHORITY_NO_STORE_HEADERS)
    },
    { name: 'sources-capabilities', rateLimit: 'public' }
  )
  return handler(request)
}
