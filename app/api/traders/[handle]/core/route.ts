/**
 * GET /api/traders/[handle]/core?source=&tf=
 *
 * The former core transport exposed raw ROI/PnL, daily series, and arbitrary
 * extras through both the warm RPC and a Tier-C Redis result. Historical core
 * evidence is not publicly sealed, so every timeframe (including inception)
 * now receives one no-store structural empty projection.
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess } from '@/lib/api/response'
import { quarantinedPublicCoreModules } from '@/lib/data/serving/core-quarantine'
import { METRIC_AUTHORITY_NO_STORE_HEADERS } from '@/lib/data/serving/cache-policy'
import type { ServingTimeframe, TraderCoreResponse } from '@/lib/data/serving/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const handleSchema = z.string().min(1).max(255)
const tfSchema = z.enum(['7', '30', '90', 'inception']).default('90')

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const { handle: rawHandle } = await params

  const handler = withPublic(
    async ({ request: req }) => {
      if (!handleSchema.safeParse(rawHandle).success) {
        throw ApiError.validation('Invalid handle parameter')
      }

      const parsedTf = tfSchema.safeParse(req.nextUrl.searchParams.get('tf') ?? undefined)
      if (!parsedTf.success) throw ApiError.validation('Invalid tf parameter')
      const tf: ServingTimeframe =
        parsedTf.data === 'inception' ? 'inception' : (Number(parsedTf.data) as 7 | 30 | 90)

      return apiSuccess<TraderCoreResponse>(
        quarantinedPublicCoreModules(tf),
        200,
        METRIC_AUTHORITY_NO_STORE_HEADERS
      )
    },
    { name: 'trader-core', rateLimit: 'public' }
  )

  return handler(request)
}
