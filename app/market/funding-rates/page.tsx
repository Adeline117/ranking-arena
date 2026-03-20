import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import FundingRatesClient from './FundingRatesClient'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Funding Rates | Arena',
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
    title: 'Funding Rates | Arena',
    description: 'Real-time perpetual futures funding rates across major exchanges.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

export const revalidate = 900 // 15 minutes

interface FundingRateRow {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

async function getFundingRates(): Promise<FundingRateRow[]> {
  const supabase = getSupabaseAdmin()

  // Get the latest funding rate for each platform+symbol combination
  // by selecting distinct on platform, symbol ordered by funding_time desc
  const { data, error } = await supabase
    .from('funding_rates')
    .select('platform, symbol, funding_rate, funding_time')
    .order('funding_time', { ascending: false })
    .limit(200)

  if (error) {
    console.error('[funding-rates] fetch error:', error.message)
    return []
  }

  // Deduplicate: keep only the latest entry per platform+symbol
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
