import type { Metadata } from 'next'
import { unstable_cache } from 'next/cache'
import { Suspense } from 'react'
import MarketPageClient from './MarketPageClient'
import { BASE_URL } from '@/lib/constants/urls'
import {
  fetchCoinGeckoSpot,
  type MarketSpotSnapshot,
} from '@/lib/market/market-spot-client-contract'

export const revalidate = 60 // ISR: 1 min

export const metadata: Metadata = {
  title: 'Crypto Market Overview | Prices, Gainers & Losers',
  description:
    'Track available crypto prices, gainers, losers, volume, and market cap across up to 100 tokens. Provider coverage and update timing may vary.',
  alternates: {
    canonical: `${BASE_URL}/market`,
  },
  openGraph: {
    title: 'Crypto Market Overview',
    description:
      'Track available crypto prices, gainers, losers, volume, and market cap across up to 100 tokens.',
    url: `${BASE_URL}/market`,
    siteName: 'Arena',
    type: 'website',
    images: [
      {
        url: `${BASE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: 'Arena - Crypto Market Overview',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crypto Market Overview',
    description: 'Track available crypto prices, gainers, losers, volume, and market cap.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

// Prefetch spot market data server-side via CoinGecko
const getSpotMarketData = unstable_cache(
  async (): Promise<MarketSpotSnapshot> => fetchCoinGeckoSpot(undefined, 4_000),
  // A rejected fetch is not converted to an empty success and therefore is not
  // cached as healthy market data. Versioned for the provider-receipt shape.
  ['market-spot-ssr-v3'],
  { revalidate: 60, tags: ['market'] }
)

export async function MarketPageWithSeed() {
  let initialSpotSnapshot: MarketSpotSnapshot | undefined
  let initialError = false
  try {
    initialSpotSnapshot = await getSpotMarketData()
  } catch {
    initialError = true
  }

  return <MarketPageClient initialSpotSnapshot={initialSpotSnapshot} initialError={initialError} />
}

export default function MarketPage() {
  return (
    <Suspense fallback={<MarketPageClient />}>
      <MarketPageWithSeed />
    </Suspense>
  )
}
