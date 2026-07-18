import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import FundingRatesClient from './FundingRatesClient'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'

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

interface FundingRateRow {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

interface FundingRatesLoadResult {
  rates: FundingRateRow[]
  loadError: boolean
}

async function getFundingRates(): Promise<FundingRatesLoadResult> {
  try {
    const supabase = getSupabaseAdmin()

    // Use DB-side deduplication via RPC (DISTINCT ON is far more efficient than
    // fetching 200 rows and deduplicating in memory).
    try {
      const { data, error } = await supabase.rpc('get_latest_funding_rates')
      if (!error && data) {
        return { rates: data as FundingRateRow[], loadError: false }
      }
    } catch {
      // RPC not available, fall back to client-side dedup.
    }

    // Fallback: fetch and deduplicate in memory.
    const { data, error } = await supabase
      .from('funding_rates')
      .select('platform, symbol, funding_rate, funding_time')
      .order('funding_time', { ascending: false })
      .limit(500)

    if (error) {
      logger.error('[funding-rates] fetch error:', error.message)
      return { rates: [], loadError: true }
    }

    const seen = new Set<string>()
    const deduped: FundingRateRow[] = []
    for (const row of data || []) {
      const key = `${row.platform}:${row.symbol}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(row)
      }
    }
    return { rates: deduped, loadError: false }
  } catch (error) {
    logger.error(
      '[funding-rates] fetch error:',
      error instanceof Error ? error.message : String(error)
    )
    return { rates: [], loadError: true }
  }
}

export default async function FundingRatesPage() {
  const { rates, loadError } = await getFundingRates()

  return <FundingRatesClient rates={rates} loadError={loadError} />
}
