import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Top Crypto Trader Rankings — Arena | ROI, Win Rate & Arena Score',
  description: 'Discover the top crypto traders ranked by ROI, win rate, max drawdown, and Arena Score across all platforms. Real-time performance data from 30+ exchanges including Binance, Bitget, and Bybit.',
  alternates: {
    canonical: `${baseUrl}/rankings/traders`,
  },
  openGraph: {
    title: 'Top Crypto Trader Rankings — Arena',
    description: 'Discover the top crypto traders ranked by ROI, win rate, max drawdown, and Arena Score across all platforms.',
    url: `${baseUrl}/rankings/traders`,
    siteName: 'Arena',
    type: 'website',
    images: [{ 
      url: `${baseUrl}/og-image.png`, 
      width: 1200, 
      height: 630, 
      alt: 'Arena - Top Trader Rankings' 
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Top Crypto Trader Rankings — Arena',
    description: 'Discover the top crypto traders ranked by ROI, win rate, and Arena Score across all platforms.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function TradersPage() {
  redirect('/')
}
