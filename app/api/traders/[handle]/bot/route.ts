/**
 * GET /api/traders/[handle]/bot?source=
 *
 * Bot-instance header metadata (spec §1.3) for a serving-mode bot profile.
 * Returns null payload for non-bot traders. Static-ish data → edge-cacheable.
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withPublic } from '@/lib/api/middleware'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getBotHeader, type BotHeader } from '@/lib/data/serving/bot-header'

const handleSchema = z.string().min(1).max(255)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const { handle: rawHandle } = await params

  const handler = withPublic(async ({ supabase, request: req }) => {
    const parsedHandle = handleSchema.safeParse(rawHandle)
    if (!parsedHandle.success) throw ApiError.validation('Invalid handle parameter')
    const decodedHandle = decodeURIComponent(parsedHandle.data)
    const source = req.nextUrl.searchParams.get('source') || undefined

    const resolved = await resolveServingTrader(supabase, { handle: decodedHandle, source })
    if (!resolved) throw ApiError.notFound('Trader not found')

    const bot = await getBotHeader(supabase, {
      source: resolved.source,
      traderKey: resolved.exchangeTraderId,
    })

    // Bot metadata changes slowly (runtime ticks daily); cache generously.
    return withCache(apiSuccess<BotHeader | null>(bot), {
      maxAge: 300,
      staleWhileRevalidate: 1800,
    })
  })

  return handler(request)
}
