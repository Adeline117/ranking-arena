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
 * 404 when the handle does not resolve on the requested serving source — a
 * stale/forged ?platform= link must NEVER replace a valid server-resolved
 * account (the client falls back to the server's pick on 404).
 */

import { NextRequest } from 'next/server'
import { unstable_cache } from 'next/cache'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getFirstScreen } from '@/lib/data/serving/first-screen'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import { getDataMode } from '@/lib/constants/serving-cutover'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import { getReadReplica } from '@/lib/supabase/read-replica'
import type { TraderFirstScreen, TraderFirstScreenResponse } from '@/lib/data/serving/types'

const handleSchema = z.string().min(1).max(255)
const sourceSchema = z.string().min(1).max(64)

// The capability-matrix RPC scans trader_stats for observed metric coverage —
// ~30s cold. Near-static data (spec §6), so serve it from the SAME Next data
// cache entry the trader page's server component keeps warm (identical key +
// revalidate as page.tsx cachedCapabilitiesISR), and never let a cold miss
// stall this route past the client's fetch timeout: race 2s → null capability
// (the client degrades gracefully — record surfaces gate off, core still loads).
const cachedCapabilitiesISR = unstable_cache(
  async () => getSourceCapabilities(getReadReplica()),
  ['arena-source-capabilities'],
  { revalidate: 3600 }
)
const cachedCapabilities = async () => {
  try {
    return await Promise.race([
      cachedCapabilitiesISR(),
      new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 2_000)),
    ])
  } catch {
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
      const decodedHandle = decodeURIComponent(parsedHandle.data)

      const parsedSource = sourceSchema.safeParse(req.nextUrl.searchParams.get('source'))
      if (!parsedSource.success) throw ApiError.validation('Invalid source parameter')
      const source = parsedSource.data

      // Only serving sources have a first screen; a legacy/unknown source hint
      // is a not-found, not an error (client falls back to the server account).
      if ((await getDataMode(source)) !== 'serving') throw ApiError.notFound('Trader not found')

      const resolved = await resolveServingTrader(supabase, { handle: decodedHandle, source })
      if (!resolved || resolved.source !== source) throw ApiError.notFound('Trader not found')

      const [firstScreenRaw, capabilities] = await Promise.all([
        getFirstScreen(supabase, resolved.source, resolved.exchangeTraderId),
        cachedCapabilities(),
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

      return withCache(
        apiSuccess<TraderFirstScreenResponse>({
          firstScreen,
          capability: capabilities[resolved.source] ?? null,
        }),
        { maxAge: 60, staleWhileRevalidate: 300 }
      )
    },
    { name: 'trader-first-screen', rateLimit: 'public' }
  )

  return handler(request)
}
