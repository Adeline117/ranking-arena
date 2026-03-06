/**
 * Weex — Inline fetcher for Vercel serverless
 *
 * [DISCONTINUED] As of 2025, Weex copy trading API endpoints are non-functional:
 * - All API endpoints return "Page is Not Found" (404)
 * - POST endpoints require browser session cookies (x-sig, x-timestamp, etc.)
 * - janapw.com gateway returns 521 without client-side generated headers
 *
 * This fetcher returns a graceful skip to avoid polluting pipeline error metrics.
 * Re-enable if Weex restores public copy trading access.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { type FetchResult } from './shared'
import { logger } from '@/lib/logger'

const SOURCE = 'weex'

export async function fetchWeex(
  _supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  logger.info(`[${SOURCE}] Skipped — platform copy trading API discontinued (404/521)`)

  for (const period of periods) {
    result.periods[period] = {
      total: 0,
      saved: 0,
      error: 'Platform discontinued — API endpoints return 404/521',
    }
  }

  result.duration = Date.now() - start
  return result
}
