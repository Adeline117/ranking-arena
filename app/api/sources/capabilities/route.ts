/**
 * GET /api/sources/capabilities
 *
 * Capability matrix for all active arena sources (spec §6: "capability
 * matrix is data, not code"). Near-static — edge-cached for 1h; SSR reads
 * the same RPC directly (page.tsx cachedCapabilities) to avoid flicker.
 */

import { NextRequest } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'

export const revalidate = 3600

export async function GET(request: NextRequest) {
  const handler = withPublic(
    async ({ supabase }) => {
      const capabilities = await getSourceCapabilities(supabase)
      return withCache(apiSuccess(capabilities), {
        maxAge: 3600,
        staleWhileRevalidate: 7200,
      })
    },
    { name: 'sources-capabilities', rateLimit: 'public' }
  )
  return handler(request)
}
