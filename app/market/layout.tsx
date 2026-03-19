import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Market Overview',
  description:
    'Real-time crypto market overview — sentiment, sector treemaps, spot prices, and trending tokens across major exchanges.',
  alternates: {
    canonical: `${baseUrl}/market`,
  },
  openGraph: {
    title: 'Market Overview',
    description: 'Real-time crypto market sentiment, sector performance, and spot prices.',
    url: `${baseUrl}/market`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Market Overview' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Market Overview',
    description: 'Real-time crypto market sentiment, sector performance, and spot prices.',
    images: [`${baseUrl}/og-image.png`],
  },
}

export default function MarketLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
