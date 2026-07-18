/**
 * GET /api/traders/[handle]/core?source=&tf=
 *
 * Core modules, one request per timeframe (spec §2.4-2). Serving-mode
 * sources only — legacy sources keep using /api/traders/[handle].
 *
 * Cache ladder:
 *   warm  — arena.trader_stats fresh within TTL → edge-cacheable (s-maxage=30)
 *   stale — return stale payload immediately, fire-and-forget Tier-C refresh,
 *           cacheState 'pending' keeps the client polling (no-store)
 *   cold  — enqueue Tier-C (single-flight jobId) + poll the worker's Redis
 *           result key ≤8s → 'cold-fetched', else 200 {cacheState:'pending'}.
 *           NEVER 5xx (spec §2.4 graceful degradation).
 */

import { NextRequest, after } from 'next/server'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getCoreModules, hasRequiredProfileSeries, isFresh, tfToInt } from '@/lib/data/serving/core'
import { requestTierC, coreModulesFromTierC } from '@/lib/data/serving/tier-c'
import type { ServingTimeframe, TraderCoreResponse } from '@/lib/data/serving/types'

const handleSchema = z.string().min(1).max(255)
const tfSchema = z.enum(['7', '30', '90', 'inception']).default('90')

/** profile_cache_ttl default (spec §2.3 Tier C, sources default '6h'). */
const CORE_FRESH_TTL_SECONDS = 6 * 3600

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const { handle: rawHandle } = await params

  const handler = withPublic(
    async ({ supabase, request: req }) => {
      const parsedHandle = handleSchema.safeParse(rawHandle)
      if (!parsedHandle.success) throw ApiError.validation('Invalid handle parameter')
      const decodedHandle = decodeURIComponent(parsedHandle.data)

      const parsedTf = tfSchema.safeParse(req.nextUrl.searchParams.get('tf') ?? undefined)
      if (!parsedTf.success) throw ApiError.validation('Invalid tf parameter')
      const tf: ServingTimeframe =
        parsedTf.data === 'inception' ? 'inception' : (Number(parsedTf.data) as 7 | 30 | 90)

      const source = req.nextUrl.searchParams.get('source') || undefined

      const resolved = await resolveServingTrader(supabase, { handle: decodedHandle, source })
      if (!resolved) throw ApiError.notFound('Trader not found')

      const warm = await getCoreModules(supabase, resolved.source, resolved.exchangeTraderId, tf)

      // A trader can have FRESH Tier-A stats but NO series/deep fields: Tier-A
      // writes headline stats for every ranked trader, but charts come from
      // the Tier-B/C profile crawl which only covers topN. Treating
      // stats-fresh as fully-warm left ~99% of serving traders with an empty
      // chart that never self-healed (the cold path never fired). So a warm
      // answer must ALSO have chart series; otherwise it's stale → trigger a
      // background Tier-C deep fetch while serving what we have.
      const hasRequiredSeries = !!warm && hasRequiredProfileSeries(warm)

      // Warm hit — the only edge-cacheable answer.
      if (warm && hasRequiredSeries && isFresh(warm.provenance.asOf, CORE_FRESH_TTL_SECONDS)) {
        return withCache(apiSuccess<TraderCoreResponse>(warm), {
          maxAge: 30,
          staleWhileRevalidate: 120,
        })
      }

      const tierCReq = {
        sourceSlug: resolved.source,
        fetchRegion: resolved.fetchRegion,
        exchangeTraderId: resolved.exchangeTraderId,
        timeframe: tfToInt(tf),
        surface: 'profile' as const,
      }

      // Stale hit — render immediately, refresh in the background (§2.4).
      // after() guarantees the enqueue runs after the response flushes:
      // a bare `void requestTierC(...)` could be dropped when Vercel freezes
      // the lambda before the BullMQ enqueue flushes → the background chart/
      // stats refresh silently never fires (the ~99%-empty-chart bug).
      if (warm) {
        after(() => requestTierC(tierCReq, { fireAndForget: true }))
        return apiSuccess<TraderCoreResponse>({ ...warm, cacheState: 'pending' }, 200, {
          'Cache-Control': 'no-store',
        })
      }

      // Cold miss — single-flight enqueue + poll ≤8s.
      const payload = await requestTierC(tierCReq)
      if (payload) {
        const fetched = coreModulesFromTierC(resolved.source, tfToInt(tf), payload)
        if (fetched) {
          return apiSuccess<TraderCoreResponse>(fetched, 200, { 'Cache-Control': 'no-store' })
        }
      }

      return apiSuccess<TraderCoreResponse>({ timeframe: tf, cacheState: 'pending' }, 200, {
        'Cache-Control': 'no-store',
      })
    },
    { name: 'trader-core', rateLimit: 'public' }
  )

  return handler(request)
}
