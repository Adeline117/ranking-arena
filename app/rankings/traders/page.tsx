import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 600 // ISR: 10 min

export const metadata: Metadata = {
  title: 'Top Crypto Traders | ROI & Arena Score',
  description: 'Top crypto traders ranked by ROI, win rate, and Arena Score across 30+ exchanges. Real-time data from Binance, Bitget, and Bybit. Updated every 3 hours.',
  alternates: {
    canonical: `${BASE_URL}/rankings/traders`,
  },
  openGraph: {
    title: 'Top Crypto Trader Rankings',
    description: 'Discover the top crypto traders ranked by ROI, win rate, max drawdown, and Arena Score across all platforms.',
    url: `${BASE_URL}/rankings/traders`,
    siteName: 'Arena',
    type: 'website',
    images: [{ 
      url: `${BASE_URL}/og-image.png`, 
      width: 1200, 
      height: 630, 
      alt: 'Arena - Top Trader Rankings' 
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Top Crypto Trader Rankings',
    description: 'Discover the top crypto traders ranked by ROI, win rate, and Arena Score across all platforms.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function TradersPage() {
  redirect('/')
}
