/**
 * GET /api/traders/[handle]/records?kind=&source=&tf=&cursor=
 *
 * Heavy-tab records, lazy-fetched only when the user opens the tab
 * (spec §2.4-3). Keyset pagination via opaque cursors.
 *
 *   kind=positions|position_history|orders|transfers → RecordsPage
 *   kind=copiers → CopierAggregate ONLY (spec §6 PII rule: row access is
 *     blocked in SQL; this route never sees copier_label)
 *
 * Cold first pages bridge to the Tier-C queue with surface=kind; on
 * timeout the route answers 200 {cacheState:'pending'} — never 5xx.
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { tfToInt } from '@/lib/data/serving/core'
import {
  getRecordsPage,
  getCopierAggregate,
  recordsPageFromTierC,
} from '@/lib/data/serving/records'
import { requestTierC } from '@/lib/data/serving/tier-c'
import type { RecordsPage, ServingTimeframe } from '@/lib/data/serving/types'

const handleSchema = z.string().min(1).max(255)
const kindSchema = z.enum(['positions', 'position_history', 'orders', 'transfers', 'copiers'])
const tfSchema = z.enum(['7', '30', '90', 'inception']).default('90')
const cursorSchema = z.string().max(200).optional()

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

      const parsedKind = kindSchema.safeParse(req.nextUrl.searchParams.get('kind'))
      if (!parsedKind.success) throw ApiError.validation('Invalid kind parameter')
      const kind = parsedKind.data

      const parsedTf = tfSchema.safeParse(req.nextUrl.searchParams.get('tf') ?? undefined)
      if (!parsedTf.success) throw ApiError.validation('Invalid tf parameter')
      const tf: ServingTimeframe =
        parsedTf.data === 'inception' ? 'inception' : (Number(parsedTf.data) as 7 | 30 | 90)

      const parsedCursor = cursorSchema.safeParse(
        req.nextUrl.searchParams.get('cursor') ?? undefined
      )
      if (!parsedCursor.success) throw ApiError.validation('Invalid cursor parameter')
      const cursor = parsedCursor.data ?? null

      const source = req.nextUrl.searchParams.get('source') || undefined
      const resolved = await resolveServingTrader(supabase, { handle: decodedHandle, source })
      if (!resolved) throw ApiError.notFound('Trader not found')

      // ── copiers: AGGREGATE ONLY (spec §6) ──
      if (kind === 'copiers') {
        const aggregate = await getCopierAggregate(
          supabase,
          resolved.source,
          resolved.exchangeTraderId
        )
        if (aggregate) {
          return withCache(apiSuccess(aggregate), { maxAge: 300, staleWhileRevalidate: 600 })
        }
        return apiSuccess({ cacheState: 'pending' as const }, 200, { 'Cache-Control': 'no-store' })
      }

      // ── row records: warm keyset page ──
      const page = await getRecordsPage(
        supabase,
        resolved.source,
        resolved.exchangeTraderId,
        kind,
        cursor
      )
      // Cursor pages and non-empty first pages are warm truth; an empty
      // cursorless page may just be a cold cache → try the Tier-C bridge.
      if (page && (page.rows.length > 0 || cursor)) {
        return withCache(apiSuccess<RecordsPage>(page), {
          maxAge: 30,
          staleWhileRevalidate: 120,
        })
      }

      const payload = await requestTierC({
        sourceSlug: resolved.source,
        fetchRegion: resolved.fetchRegion,
        exchangeTraderId: resolved.exchangeTraderId,
        timeframe: tfToInt(tf),
        surface: kind,
      })
      if (payload) {
        const fetched = recordsPageFromTierC(resolved.source, payload)
        if (fetched) {
          return apiSuccess<RecordsPage>(fetched, 200, { 'Cache-Control': 'no-store' })
        }
      }

      const pending: RecordsPage = {
        rows: page?.rows ?? [],
        nextCursor: null,
        provenance: page?.provenance ?? { source: resolved.source, asOf: new Date().toISOString() },
        cacheState: 'pending',
      }
      return apiSuccess<RecordsPage>(pending, 200, { 'Cache-Control': 'no-store' })
    },
    { name: 'trader-records', rateLimit: 'public' }
  )

  return handler(request)
}
