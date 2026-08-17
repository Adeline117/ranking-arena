/**
 * Historical trader-metric endpoint.
 *
 * The retained daily snapshot relation has no immutable publication proof for
 * ROI, PnL, drawdown, or the derived chart values. Do not read its rows (or a
 * warm Redis value derived from them) until a public historical-metrics
 * authority exists.
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import {
  LEGACY_METRIC_NO_STORE_HEADERS,
  LEGACY_METRIC_PUBLICATION_UNAVAILABLE,
} from '@/lib/data/trader/history-quarantine'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'
export const revalidate = 0

type TimePeriod = '7D' | '30D' | '90D'

const HISTORY_RESPONSE_CONTRACT = 'arena.trader-history-evidence@1' as const
const PERIOD_DAYS: Record<TimePeriod, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}

function unavailableHistoryResponse() {
  const history: Record<TimePeriod, never[]> = {
    '7D': [],
    '30D': [],
    '90D': [],
  }
  const coverage = Object.fromEntries(
    (Object.entries(PERIOD_DAYS) as Array<[TimePeriod, number]>).map(([period, expectedCount]) => [
      period,
      {
        state: LEGACY_METRIC_PUBLICATION_UNAVAILABLE.state,
        reason: LEGACY_METRIC_PUBLICATION_UNAVAILABLE.reason,
        count: 0,
        expectedCount,
      },
    ])
  ) as Record<
    TimePeriod,
    {
      state: 'unknown'
      reason: 'historical_metric_publication_unavailable'
      count: number
      expectedCount: number
    }
  >

  return {
    contract: HISTORY_RESPONSE_CONTRACT,
    history,
    coverage,
    publication: LEGACY_METRIC_PUBLICATION_UNAVAILABLE,
    cacheState: 'quarantined' as const,
  }
}

interface RouteParams {
  params: Promise<{
    platform: string
    trader_key: string
  }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) {
    for (const [name, value] of Object.entries(LEGACY_METRIC_NO_STORE_HEADERS)) {
      rateLimitResponse.headers.set(name, value)
    }
    return rateLimitResponse
  }

  // Consume route params only to preserve the route contract. Looking up the
  // trader would itself create a legacy-history side channel with no public
  // publication authority.
  await params
  const periodParam = new URL(request.url).searchParams.get('period')
  if (periodParam !== null && !(periodParam in PERIOD_DAYS)) {
    return NextResponse.json(
      { error: 'invalid_period', allowedPeriods: Object.keys(PERIOD_DAYS) },
      { status: 400, headers: LEGACY_METRIC_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(unavailableHistoryResponse(), {
    headers: LEGACY_METRIC_NO_STORE_HEADERS,
  })
}
