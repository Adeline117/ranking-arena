import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Crypto Trader Rankings — Arena | Top Traders',
  description: 'Crypto trader rankings across 30+ exchanges. Compare ROI, win rate, and Arena Score from Binance, Bitget, Bybit, OKX. Updated every 3 hours.',
  alternates: {
    canonical: `${baseUrl}/rankings`,
  },
  openGraph: {
    title: 'Crypto Trader Rankings — Arena',
    description: 'Multi-dimensional trader rankings across 30+ exchanges. Compare ROI, win rate, Arena Score, and more. Updated every 3 hours.',
    url: `${baseUrl}/rankings`,
    siteName: 'Arena',
    type: 'website',
    images: [{ 
      url: `${baseUrl}/og-image.png`, 
      width: 1200, 
      height: 630, 
      alt: 'Arena - Crypto Trader Rankings' 
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crypto Trader Rankings — Arena',
    description: 'Multi-dimensional trader rankings across 30+ exchanges. Compare ROI, win rate, and Arena Score.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function RankingsPage() {
  redirect('/')
}
