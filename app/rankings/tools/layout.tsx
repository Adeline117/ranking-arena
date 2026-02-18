import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Tools - Arena',
  description:
    'Discover top crypto trading tools — analytics platforms, portfolio trackers, on-chain explorers, and DeFi dashboards. Community ratings and reviews.',
  alternates: {
    canonical: `${baseUrl}/rankings/tools`,
  },
  openGraph: {
    title: 'Tool Rankings | Arena',
    description: 'Top crypto trading tools ranked by community ratings — analytics, trackers, and DeFi dashboards.',
    url: `${baseUrl}/rankings/tools`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Tool Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tool Rankings | Arena',
    description: 'Top crypto trading tools ranked by community ratings.',
    images: [`${baseUrl}/og-image.png`],
  },
}

export default function ToolRankingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
