import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import FundingRatesClient from './FundingRatesClient'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'
import { createBudget, withTimeout } from '@/lib/utils/timeout'
import {
  dedupeLatestFundingRates,
  hasUniqueFundingRateIdentities,
  readFundingRateRows,
  type FundingRateRow,
} from './funding-rates-data'

const logger = createLogger('funding-rates')

export const metadata: Metadata = {
  title: 'Funding Rates',
  description:
    'Real-time perpetual futures funding rates across Binance, Bybit, OKX, and Bitget. Track market sentiment through funding rate data.',
  alternates: {
    canonical: `${BASE_URL}/market/funding-rates`,
  },
  openGraph: {
    title: 'Funding Rates',
    description: 'Real-time perpetual futures funding rates across major exchanges.',
    url: `${BASE_URL}/market/funding-rates`,
    siteName: 'Arena',
    type: 'website',
    images: [
      { url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Funding Rates' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Funding Rates',
    description: 'Real-time perpetual futures funding rates across major exchanges.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

// ISR: funding-rate data is request-independent (single RPC, no cookies/headers/
// searchParams) and refreshes on a ~15-min cron, so it's an ideal cache candidate.
// force-dynamic previously opted the route out of the Full Route Cache entirely,
// making revalidate dead and forcing a Supabase RPC on EVERY visit. Removed so
// revalidate actually takes effect and the DB hit leaves the hot path.
export const revalidate = 900 // 15 minutes

interface FundingRatesLoadResult {
  rates: FundingRateRow[]
  loadError: boolean
  degraded: boolean
}

export const FUNDING_RATES_TOTAL_TIMEOUT_MS = 4_000
const FUNDING_RATES_RPC_TIMEOUT_MS = 1_750

type AbortableQuery<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>
}

async function settleFundingQuery<T>(
  query: AbortableQuery<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const controller = new AbortController()
  const pending =
    typeof query.abortSignal === 'function'
      ? Promise.resolve(query.abortSignal(controller.signal))
      : Promise.resolve(query)
  try {
    return await withTimeout(pending, timeoutMs, label)
  } finally {
    controller.abort()
  }
}

async function getFundingRates(): Promise<FundingRatesLoadResult> {
  try {
    const supabase = getSupabaseAdmin()
    const budget = createBudget(FUNDING_RATES_TOTAL_TIMEOUT_MS)

    // Use DB-side deduplication via RPC (DISTINCT ON is more complete and more
    // efficient than scanning a bounded fallback snapshot in application code).
    try {
      const { data, error } = await settleFundingQuery(
        supabase.rpc('get_latest_funding_rates'),
        Math.min(FUNDING_RATES_RPC_TIMEOUT_MS, budget.remaining()),
        'latest funding rates RPC'
      )
      const rows = !error ? readFundingRateRows(data) : null
      if (rows && hasUniqueFundingRateIdentities(rows)) {
        return { rates: rows, loadError: false, degraded: false }
      }
    } catch {
      // RPC not available, fall back to client-side dedup.
    }

    // Fallback: fetch and deduplicate in memory.
    const remainingMs = budget.remaining()
    const fallbackQuery = supabase
      .from('funding_rates')
      .select('platform, symbol, funding_rate, funding_time')
      .order('funding_time', { ascending: false })
      .limit(500)
    const { data, error } = await settleFundingQuery(
      fallbackQuery,
      remainingMs,
      'funding rates fallback'
    )

    if (error) {
      logger.error('[funding-rates] fetch error:', error.message)
      return { rates: [], loadError: true, degraded: false }
    }

    const rows = readFundingRateRows(data)
    if (!rows) {
      logger.error('[funding-rates] fetch error:', 'invalid funding rate response')
      return { rates: [], loadError: true, degraded: false }
    }
    return {
      rates: dedupeLatestFundingRates(rows),
      loadError: false,
      degraded: true,
    }
  } catch (error) {
    logger.error(
      '[funding-rates] fetch error:',
      error instanceof Error ? error.message : String(error)
    )
    return { rates: [], loadError: true, degraded: false }
  }
}

export default async function FundingRatesPage() {
  const { rates, loadError, degraded } = await getFundingRates()

  return <FundingRatesClient rates={rates} loadError={loadError} degraded={degraded} />
}
