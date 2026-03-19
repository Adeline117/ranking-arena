import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import OpenInterestClient from './OpenInterestClient'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Open Interest | Arena',
  description:
    'Real-time open interest data across Binance, Bybit, OKX, and Bitget. Track total outstanding futures positions and market depth.',
  alternates: {
    canonical: `${baseUrl}/market/open-interest`,
  },
  openGraph: {
    title: 'Open Interest',
    description: 'Real-time open interest data across major crypto exchanges.',
    url: `${baseUrl}/market/open-interest`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Open Interest' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Open Interest | Arena',
    description: 'Real-time open interest data across major crypto exchanges.',
    images: [`${baseUrl}/og-image.png`],
  },
}

export const revalidate = 900 // 15 minutes

interface OpenInterestRow {
  platform: string
  symbol: string
  open_interest_usd: number
  open_interest_contracts: number | null
  timestamp: string
}

async function getOpenInterest(): Promise<OpenInterestRow[]> {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('open_interest')
    .select('platform, symbol, open_interest_usd, open_interest_contracts, timestamp')
    .order('timestamp', { ascending: false })
    .limit(200)

  if (error) {
    console.error('[open-interest] fetch error:', error.message)
    return []
  }

  // Deduplicate: keep only the latest entry per platform+symbol
  const seen = new Set<string>()
  const deduped: OpenInterestRow[] = []
  for (const row of data || []) {
    const key = `${row.platform}:${row.symbol}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(row)
    }
  }

  return deduped
}

export default async function OpenInterestPage() {
  const rows = await getOpenInterest()

  return <OpenInterestClient rows={rows} />
}
