import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Compare Traders · Arena',
  description:
    'Compare crypto traders side by side — ROI, win rate, drawdown, Arena Score, and equity curves across exchanges.',
  alternates: {
    canonical: `${baseUrl}/compare`,
  },
  openGraph: {
    title: 'Compare Traders · Arena',
    description: 'Compare crypto traders side by side across 22+ exchanges.',
    url: `${baseUrl}/compare`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Compare' }],
  },
  twitter: {
    card: 'summary',
    title: 'Compare Traders · Arena',
    description: 'Compare crypto traders side by side across exchanges.',
  },
}

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
