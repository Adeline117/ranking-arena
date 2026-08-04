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

import { NextRequest, NextResponse } from 'next/server'
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
import {
  RECORDS_CURSOR_INVALIDATED_CODE,
  type RecordsPage,
  type ServingTimeframe,
} from '@/lib/data/serving/types'

const handleSchema = z.string().min(1).max(255)
const kindSchema = z.enum(['positions', 'position_history', 'orders', 'transfers', 'copiers'])
const tfSchema = z.enum(['7', '30', '90', 'inception']).default('90')
const cursorSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim(), 'Cursor must not have edge whitespace')
  .optional()

function cursorInvalidatedResponse() {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: RECORDS_CURSOR_INVALIDATED_CODE,
        message: 'Record pagination changed; restart from the first page',
        resetRequired: true,
      },
    },
    { status: 409, headers: { 'Cache-Control': 'no-store' } }
  )
}

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
        // An explicit depth=none is a source-level N/A declaration. Every
        // actual aggregate must be bound to one immutable snapshot receipt;
        // legacy/profile-only values are a cold-start signal, never public data.
        if (aggregate && (aggregate.receiptBound || aggregate.depth === 'none')) {
          return withCache(apiSuccess(aggregate), { maxAge: 300, staleWhileRevalidate: 600 })
        }

        // Copier data is a window-independent snapshot. Canonical timeframe=0
        // gives every 7/30/90/inception viewer one queue flight/result key.
        // The worker payload is only a readiness signal: never map or return it,
        // because individual copier rows are private. The public truth boundary
        // remains the strict aggregate RPC, re-read even after a bridge timeout.
        await requestTierC({
          sourceSlug: resolved.source,
          fetchRegion: resolved.fetchRegion,
          exchangeTraderId: resolved.exchangeTraderId,
          timeframe: 0,
          surface: 'copiers',
        })
        const refreshedAggregate = await getCopierAggregate(
          supabase,
          resolved.source,
          resolved.exchangeTraderId
        )
        if (
          refreshedAggregate &&
          (refreshedAggregate.receiptBound || refreshedAggregate.depth === 'none')
        ) {
          return withCache(apiSuccess(refreshedAggregate), {
            maxAge: 300,
            staleWhileRevalidate: 600,
          })
        }
        return apiSuccess({ cacheState: 'pending' as const }, 200, { 'Cache-Control': 'no-store' })
      }

      const isAppendOnlyHistory = kind !== 'positions'

      // ── row records: warm keyset page ──
      const page = await getRecordsPage(
        supabase,
        resolved.source,
        resolved.exchangeTraderId,
        kind,
        cursor
      )
      // A cursor is bound to one warm keyset snapshot. If the RPC rejects it
      // (including a quarantined legacy -> verified authority transition), never
      // substitute a Tier-C first-page preview as the next page. Tell the
      // client to rebuild the whole chain instead.
      if (
        cursor !== null &&
        (page === null || (kind === 'position_history' && page.completeness?.state !== 'complete'))
      ) {
        return cursorInvalidatedResponse()
      }

      // A position-history page is warm truth only after the exact @2 receipt
      // binding passes. Verified empty history is authoritative; unverified
      // legacy rows are quarantined and fall through to a bounded Tier-C
      // preview on page one.
      const warmPageIsServeable =
        page !== null && (kind !== 'position_history' || page.completeness?.state === 'complete')
      if (
        page &&
        warmPageIsServeable &&
        (page.rows.length > 0 || cursor || page.completeness?.state === 'complete')
      ) {
        return withCache(apiSuccess<RecordsPage>(page), {
          maxAge: 30,
          staleWhileRevalidate: 120,
        })
      }

      // Tier-C append-only history is a bounded, non-pageable preview. A stale
      // client may still send a legacy cursor; never turn that into a duplicate
      // first-page preview.
      const payload =
        isAppendOnlyHistory && cursor
          ? null
          : await requestTierC({
              sourceSlug: resolved.source,
              fetchRegion: resolved.fetchRegion,
              exchangeTraderId: resolved.exchangeTraderId,
              timeframe: tfToInt(tf),
              surface: kind,
            })
      if (payload) {
        const fetched = recordsPageFromTierC(resolved.source, kind, payload)
        if (fetched) {
          return apiSuccess<RecordsPage>(fetched, 200, { 'Cache-Control': 'no-store' })
        }
      }

      const pending: RecordsPage = {
        rows: kind === 'position_history' ? [] : (page?.rows ?? []),
        nextCursor: null,
        provenance: page?.provenance ?? {
          source: resolved.source,
          sourceAsOf: null,
          observedAt: null,
          publishedAt: null,
        },
        cacheState: 'pending',
        ...(isAppendOnlyHistory
          ? {
              completeness: page?.completeness ?? {
                state: 'unknown' as const,
                reason: 'history_evidence_not_bound' as const,
              },
            }
          : {}),
      }
      return apiSuccess<RecordsPage>(pending, 200, { 'Cache-Control': 'no-store' })
    },
    { name: 'trader-records', rateLimit: 'public' }
  )

  return handler(request)
}
