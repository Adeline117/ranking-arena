/**
 * GET /api/traders/[handle]/first-screen?source=
 *
 * Tier-A first screen + capability for ONE explicitly-requested account.
 *
 * Exists for the client-side ?platform= account disambiguation: the trader
 * page is ISR-static (one cached HTML serves every ?platform= variant), so
 * the server component CANNOT read searchParams and resolves the handle
 * WITHOUT a platform hint — for a handle that exists on multiple serving
 * sources (e.g. okx_futures + okx_spot sharing an exchange_trader_id) it may
 * pick the wrong account. TraderProfileClient detects the mismatch and
 * re-fetches the requested account here, header numbers included.
 *
 * A legacy source returns a request-bound `source_not_serving` 404 proof; only
 * that proof permits the client to query the legacy detail boundary. A missing
 * trader on an already-serving source is a generic 404 and stays fail-closed.
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { error as apiError, success as apiSuccess } from '@/lib/api/response'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getFirstScreen } from '@/lib/data/serving/first-screen'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import { METRIC_AUTHORITY_NO_STORE_HEADERS } from '@/lib/data/serving/cache-policy'
import { getDataMode } from '@/lib/constants/serving-cutover'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import { logger } from '@/lib/logger'
import type { TraderFirstScreen, TraderFirstScreenResponse } from '@/lib/data/serving/types'

const handleSchema = z.string().min(1).max(255)
const sourceSchema = z.string().min(1).max(64)

async function requestScopedCapabilities(
  supabase: Parameters<typeof getSourceCapabilities>[0]
): Promise<Awaited<ReturnType<typeof getSourceCapabilities>>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      getSourceCapabilities(supabase),
      new Promise<Record<string, never>>((resolve) => {
        timeout = setTimeout(() => resolve({}), 2_000)
      }),
    ])
  } catch (error) {
    logger.warn(
      '[first-screen] request-scoped source capabilities fetch failed:',
      error instanceof Error ? error.message : String(error)
    )
    return {}
  } finally {
    if (timeout) clearTimeout(timeout)
  }
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

      const parsedSource = sourceSchema.safeParse(req.nextUrl.searchParams.get('source'))
      if (!parsedSource.success) throw ApiError.validation('Invalid source parameter')
      const source = parsedSource.data

      // A legacy source and a missing trader on an already-serving source are
      // materially different. Only this exact, request-bound reason authorizes
      // the client to try the legacy detail boundary; a generic 404 must stay
      // closed so cut-over sources cannot resurrect stale legacy rows.
      if ((await getDataMode(source)) !== 'serving') {
        const response = apiError(
          'Source does not publish a serving first screen',
          404,
          ErrorCode.NOT_FOUND,
          {
            reason: 'source_not_serving',
            request: { platform: source, handle: decodedHandle },
          }
        )
        for (const [name, value] of Object.entries(METRIC_AUTHORITY_NO_STORE_HEADERS)) {
          response.headers.set(name, value)
        }
        return response
      }

      // arena_resolve_trader already constrains the row to the requested source
      // via `s.slug = p_source OR s.meta->>'legacy_platform' = p_source`, so a
      // non-null result is GUARANTEED to belong to the requested source — either
      // by its arena slug or by its legacy platform alias. Do NOT additionally
      // compare `resolved.source === source`: for legacy-alias platforms the RPC
      // returns the arena slug (e.g. 'bitunix_futures') while `source` is the
      // alias the search href carries (e.g. 'bitunix'), and the string mismatch
      // was false-404ing every search→trader click on alias sources
      // (bitunix/xt/blofin/btcc) plus defeating ?platform= disambiguation there.
      const resolved = await resolveServingTrader(supabase, { handle: decodedHandle, source })
      if (!resolved) throw ApiError.notFound('Trader not found')

      const [firstScreenRaw, capabilities, verifiedKeys] = await Promise.all([
        getFirstScreen(supabase, resolved.source, resolved.exchangeTraderId),
        // Capability includes the live source-authority verdict. Do not read it
        // through a process-global/read-replica cache. Keep the old 2s
        // availability bound while pre-cutover databases still run the
        // expensive metric scan; a timeout yields a fail-closed empty seed.
        requestScopedCapabilities(supabase),
        getVerifiedTraderKeys(supabase),
      ])

      // Same synthesis the page's server component does on a first-screen miss:
      // the identity is already resolved, entries=[] is a valid empty board.
      const firstScreen: TraderFirstScreen = firstScreenRaw ?? {
        source: resolved.source,
        exchangeTraderId: resolved.exchangeTraderId,
        nickname: resolved.nickname,
        avatarMirrorUrl: resolved.avatarMirrorUrl,
        avatarOriginUrl: resolved.avatarOriginUrl,
        avatarSrc: getTraderAvatarSrc({
          avatarMirrorUrl: resolved.avatarMirrorUrl,
          avatarOriginUrl: resolved.avatarOriginUrl,
        }),
        walletAddress: null,
        traderKind: 'human',
        botStrategy: null,
        entries: [],
      }

      return apiSuccess<TraderFirstScreenResponse>(
        {
          request: { platform: source, handle: decodedHandle },
          subject: { platform: resolved.source, traderKey: resolved.exchangeTraderId },
          firstScreen,
          capability: capabilities[resolved.source] ?? null,
          is_verified_data: verifiedKeys.has(
            verifiedTraderKey(resolved.source, resolved.exchangeTraderId)
          ),
        },
        200,
        METRIC_AUTHORITY_NO_STORE_HEADERS
      )
    },
    { name: 'trader-first-screen', rateLimit: 'public' }
  )

  return handler(request)
}
