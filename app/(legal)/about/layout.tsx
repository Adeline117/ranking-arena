import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'About Arena — Crypto Trader Rankings & Community Platform',
  description: 'Arena aggregates trader rankings from 30+ exchanges including Binance, Bitget, and Bybit. Discover top crypto traders, compare performance metrics, and join our trading community.',
  alternates: {
    canonical: `${baseUrl}/about`,
  },
  openGraph: {
    title: 'About Arena — Crypto Trader Rankings Platform',
    description: 'Arena aggregates trader rankings from 30+ exchanges including Binance, Bitget, and Bybit. Discover top crypto traders, compare performance metrics, and join our trading community.',
    url: `${baseUrl}/about`,
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
    title: 'About Arena — Crypto Trader Rankings Platform',
    description: 'Arena aggregates trader rankings from 30+ exchanges including Binance, Bitget, and Bybit.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return children
}
