import { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Watchlist | Arena',
  description: 'Track your favorite crypto traders. Monitor ROI, Arena Score, and performance changes in real-time.',
  alternates: {
    canonical: `${BASE_URL}/watchlist`,
  },
  openGraph: {
    title: 'Trader Watchlist',
    description: 'Track your favorite crypto traders and monitor their performance.',
    url: `${BASE_URL}/watchlist`,
    siteName: 'Arena',
    type: 'website',
  },
}

// Client component handles auth + data fetching
import WatchlistClient from './WatchlistClient'

export default function WatchlistPage() {
  return <WatchlistClient />
}
