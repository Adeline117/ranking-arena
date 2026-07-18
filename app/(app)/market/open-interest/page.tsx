import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import OpenInterestClient from './OpenInterestClient'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('open-interest')

export const metadata: Metadata = {
  title: 'Open Interest',
  description:
    'Real-time open interest data across Binance, Bybit, OKX, and Bitget. Track total outstanding futures positions and market depth.',
  alternates: {
    canonical: `${BASE_URL}/market/open-interest`,
  },
  openGraph: {
    title: 'Open Interest',
    description: 'Real-time open interest data across major crypto exchanges.',
    url: `${BASE_URL}/market/open-interest`,
    siteName: 'Arena',
    type: 'website',
    images: [
      { url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Open Interest' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Open Interest',
    description: 'Real-time open interest data across major crypto exchanges.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

// ISR: open-interest data is request-independent (single RPC, no cookies/headers/
// searchParams) and refreshes on a ~15-min cron, so it's an ideal cache candidate.
// force-dynamic previously opted the route out of the Full Route Cache entirely,
// making revalidate dead and forcing a Supabase RPC on EVERY visit. Removed so
// revalidate actually takes effect and the DB hit leaves the hot path.
export const revalidate = 900 // 15 minutes

interface OpenInterestRow {
  platform: string
  symbol: string
  open_interest_usd: number
  open_interest_contracts: number | null
  timestamp: string
}

async function getOpenInterest(): Promise<{ rows: OpenInterestRow[]; loadError: boolean }> {
  const supabase = getSupabaseAdmin()

  // Use DB-side deduplication via RPC (DISTINCT ON is far more efficient)
  try {
    const { data, error } = await supabase.rpc('get_latest_open_interest')
    if (!error && Array.isArray(data)) {
      return { rows: data as OpenInterestRow[], loadError: false }
    }
  } catch {
    // RPC not available, fall back to client-side dedup
  }

  try {
    // Fallback: fetch and deduplicate in memory
    const { data, error } = await supabase
      .from('open_interest')
      .select('platform, symbol, open_interest_usd, open_interest_contracts, timestamp')
      .order('timestamp', { ascending: false })
      .limit(500)

    if (error) {
      logger.error('[open-interest] fetch error:', error.message)
      return { rows: [], loadError: true }
    }

    const seen = new Set<string>()
    const deduped: OpenInterestRow[] = []
    for (const row of data || []) {
      const key = `${row.platform}:${row.symbol}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(row)
      }
    }
    return { rows: deduped, loadError: false }
  } catch (error) {
    logger.error('[open-interest] unexpected fetch error:', error)
    return { rows: [], loadError: true }
  }
}

export default async function OpenInterestPage() {
  const { rows, loadError } = await getOpenInterest()

  return <OpenInterestClient rows={rows} loadError={loadError} />
}
