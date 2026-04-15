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
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Funding Rates' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Funding Rates',
    description: 'Real-time perpetual futures funding rates across major exchanges.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

export const dynamic = 'force-dynamic' // Skip static generation, render at request time
export const revalidate = 900 // 15 minutes

interface FundingRateRow {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

async function getFundingRates(): Promise<FundingRateRow[]> {
  const supabase = getSupabaseAdmin()

  // Use DB-side deduplication via RPC (DISTINCT ON is far more efficient than
  // fetching 200 rows and deduplicating in memory)
  try {
    const { data, error } = await supabase.rpc('get_latest_funding_rates')
    if (!error && data) return data as FundingRateRow[]
  } catch {
    // RPC not available, fall back to client-side dedup
  }

  // Fallback: fetch and deduplicate in memory
  const { data, error } = await supabase
    .from('funding_rates')
    .select('platform, symbol, funding_rate, funding_time')
    .order('funding_time', { ascending: false })
    .limit(500)

  if (error) {
    logger.error('[funding-rates] fetch error:', error.message)
    return []
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
  return deduped
}

export default async function FundingRatesPage() {
  const rates = await getFundingRates()

  return <FundingRatesClient rates={rates} />
}
