import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Market Overview',
  description:
    'Real-time crypto market overview — sentiment, sector treemaps, spot prices, and trending tokens across major exchanges.',
  alternates: {
    canonical: `${BASE_URL}/market`,
  },
  openGraph: {
    title: 'Market Overview',
    description: 'Real-time crypto market sentiment, sector performance, and spot prices.',
    url: `${BASE_URL}/market`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Market Overview' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Market Overview',
    description: 'Real-time crypto market sentiment, sector performance, and spot prices.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

export default function MarketLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
