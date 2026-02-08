/**
 * WhiteBit — Inline fetcher for Vercel serverless
 *
 * [STUB] NO PUBLIC COPY-TRADING API: WhiteBit's public API v4
 * (https://whitebit.com/api/v4/public/) provides market data but does NOT
 * have copy-trading or leaderboard endpoints.
 *
 * WhiteBit does not currently offer a copy-trading feature on their platform.
 * Their API documentation at https://docs.whitebit.com/ confirms only market,
 * trading, and account endpoints exist.
 *
 * TODO: Monitor if WhiteBit launches copy-trading features.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { type FetchResult } from './shared'

const SOURCE = 'whitebit'

export async function fetchWhitebit(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    result.periods[period] = {
      total: 0,
      saved: 0,
      error: 'WhiteBit does not offer copy-trading — no leaderboard API available',
    }
  }

  result.duration = Date.now() - start
  return result
}
