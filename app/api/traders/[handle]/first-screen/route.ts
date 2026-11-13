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
import { unstable_cache } from 'next/cache'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { error as apiError, success as apiSuccess } from '@/lib/api/response'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getPublicFirstScreen } from '@/lib/data/serving/first-screen'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import {
  METRIC_AUTHORITY_NO_STORE_HEADERS,
  servingMetricAuthorityCacheKey,
} from '@/lib/data/serving/cache-policy'
import { getDataMode } from '@/lib/constants/serving-cutover'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { logger } from '@/lib/logger'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import type { TraderFirstScreen, TraderFirstScreenResponse } from '@/lib/data/serving/types'
import { decodeRouteParam } from '@/lib/utils/decode-route-param'

const handleSchema = z.string().min(1).max(255)
const sourceSchema = z.string().min(1).max(64)

// The capability-matrix RPC scans trader_stats for observed metric coverage —
// ~30s cold. Near-static data (spec §6), so serve it from an authority-versioned
// Next data-cache entry, and never let a cold miss stall this route past the
// client's fetch timeout: race 2s → null capability
// (the client degrades gracefully — record surfaces gate off, core still loads).
const cachedCapabilitiesISR = unstable_cache(
  async () => getSourceCapabilities(getReadReplica()),
  [servingMetricAuthorityCacheKey('arena-source-capabilities')],
  { revalidate: 300 }
)
const cachedCapabilities = async () => {
  try {
    return await Promise.race([
      cachedCapabilitiesISR(),
      new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 2_000)),
    ])
  } catch (err) {
    // The 2s race resolves {} on cold-miss timeout (expected, no throw); this
    // catch only fires on a genuine capability-RPC failure — surface it so a
    // broken capability matrix (drift) doesn't silently gate off record surfaces.
    logger.warn(
      '[first-screen] source capabilities fetch failed:',
      err instanceof Error ? err.message : String(err)
    )
    return {}
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
      const decodedHandle = decodeRouteParam(parsedHandle.data)

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
        // The helper reads the current sealed public cohort before publishing
        // rank/ROI/PnL; raw arena_first_screen values remain identity/extras only.
        getPublicFirstScreen(supabase, resolved.source, resolved.exchangeTraderId),
        cachedCapabilities(),
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
