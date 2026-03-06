/**
 * Phemex — Inline fetcher for Vercel serverless
 *
 * [DISCONTINUED] As of 2026-02, Phemex copy trading APIs are non-functional:
 * - Main site endpoints return 403 (CloudFront geo-restriction)
 * - api.phemex.com returns 401 (requires API key auth)
 * - /copy-trading page redirects to /404
 *
 * This fetcher returns a graceful skip to avoid polluting pipeline error metrics.
 * Re-enable if Phemex restores public copy trading access.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { type FetchResult } from './shared'
import { logger } from '@/lib/logger'

const SOURCE = 'phemex'

export async function fetchPhemex(
  _supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  logger.info(`[${SOURCE}] Skipped — platform copy trading API discontinued (401/403/404)`)

  for (const period of periods) {
    result.periods[period] = {
      total: 0,
      saved: 0,
      error: 'Platform discontinued — copy trading API returns 401/403/404',
    }
  }

  result.duration = Date.now() - start
  return result
}
