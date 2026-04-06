import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'About Arena — Crypto Trader Rankings & Community Platform',
  description: 'Arena aggregates trader rankings from 30+ exchanges including Binance, Bitget, and Bybit. Discover top crypto traders, compare performance metrics, and join our trading community.',
  alternates: {
    canonical: `${BASE_URL}/about`,
  },
  openGraph: {
    title: 'About Arena — Crypto Trader Rankings Platform',
    description: 'Arena aggregates trader rankings from 30+ exchanges including Binance, Bitget, and Bybit. Discover top crypto traders, compare performance metrics, and join our trading community.',
    url: `${BASE_URL}/about`,
    siteName: 'Arena',
    type: 'website',
    images: [{ 
      url: `${BASE_URL}/og-image.png`, 
      width: 1200, 
      height: 630, 
      alt: 'Arena - Crypto Trader Rankings' 
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'About Arena — Crypto Trader Rankings Platform',
    description: 'Arena aggregates trader rankings from 30+ exchanges including Binance, Bitget, and Bybit.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return children
}
