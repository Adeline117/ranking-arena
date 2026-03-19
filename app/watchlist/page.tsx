import { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Watchlist | Arena',
  description: 'Track your favorite crypto traders. Monitor ROI, Arena Score, and performance changes in real-time.',
  alternates: {
    canonical: `${baseUrl}/watchlist`,
  },
  openGraph: {
    title: 'Trader Watchlist',
    description: 'Track your favorite crypto traders and monitor their performance.',
    url: `${baseUrl}/watchlist`,
    siteName: 'Arena',
    type: 'website',
  },
}

// Client component handles auth + data fetching
import WatchlistClient from './WatchlistClient'

export default function WatchlistPage() {
  return <WatchlistClient />
}
