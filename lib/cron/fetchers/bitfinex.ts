/**
 * Bitfinex — Inline fetcher for Vercel serverless
 *
 * [STUB] NO PUBLIC LEADERBOARD API: Bitfinex public API (api-pub.bitfinex.com/v2/)
 * does not have copy-trading or leaderboard endpoints. Bitfinex does offer
 * "Bitfinex Pulse" social trading but no public ranking API exists.
 *
 * Checked endpoints:
 * - https://api-pub.bitfinex.com/v2/rankings (404)
 * - https://api-pub.bitfinex.com/v2/leaderboard (404)
 * - https://api-pub.bitfinex.com/v2/copy-trading (404)
 *
 * Bitfinex Derivatives (previously known as Bitfinex Borrow) has no public
 * copy-trading feature as of 2025.
 *
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { type FetchResult } from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bitfinex'

export async function fetchBitfinex(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      result.periods[period] = {
        total: 0,
        saved: 0,
        error: 'No public leaderboard/copy-trading API available on Bitfinex',
      }
    }

    result.duration = Date.now() - start
    return result
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
    result.duration = Date.now() - start
    return result
  }
}
