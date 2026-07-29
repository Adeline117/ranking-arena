/**
 * GET /api/traders/aggregate?contract=2&platform=...&trader_key=...
 *
 * Public, subject-bound projection of live linked membership. Internal user IDs,
 * owner-private labels, unproven scores/ranks and currency-less PnL never cross
 * this boundary.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  handleError,
  badRequest,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getAggregatedStats, findUserByTrader } from '@/lib/data/linked-traders'
import {
  emptyPublicLinkedAggregate,
  serializePublicLinkedAggregate,
  type PublicLinkedSubject,
} from '@/lib/data/linked-trader-public'

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

function noStore<T extends NextResponse>(response: T): T {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

function exactSelector(value: string | null, maxLength: number): value is string {
  return !!value && value.length <= maxLength && value === value.trim()
}

function readSubject(searchParams: URLSearchParams): PublicLinkedSubject | null {
  const allowed = new Set(['contract', 'platform', 'trader_key'])
  if ([...searchParams.keys()].some((key) => !allowed.has(key))) return null
  if (
    searchParams.getAll('contract').length !== 1 ||
    searchParams.getAll('platform').length !== 1 ||
    searchParams.getAll('trader_key').length !== 1
  ) {
    return null
  }
  if (searchParams.get('contract') !== '2') return null

  const platform = searchParams.get('platform')
  const traderKey = searchParams.get('trader_key')
  if (!exactSelector(platform, 64) || !exactSelector(traderKey, 512)) return null
  return { platform, traderKey }
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return noStore(rateLimitResponse)

  try {
    const subject = readSubject(new URL(request.url).searchParams)
    if (!subject) {
      return noStore(
        badRequest('contract=2, platform, and trader_key are required public selectors')
      )
    }

    const supabase = getSupabaseAdmin()
    const userId = await findUserByTrader(supabase, subject.platform, subject.traderKey)
    if (!userId) {
      return noStore(
        NextResponse.json({ success: true, data: emptyPublicLinkedAggregate(subject) })
      )
    }

    const stats = await getAggregatedStats(supabase, userId)
    const data = serializePublicLinkedAggregate(stats, subject)
    return noStore(NextResponse.json({ success: true, data }))
  } catch (error: unknown) {
    return noStore(handleError(error, 'traders/aggregate GET'))
  }
}
