import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '交易书库',
  description:
    'Free crypto trading books and educational resources — technical analysis, DeFi strategies, risk management, and market psychology.',
  alternates: {
    canonical: `${baseUrl}/rankings/resources`,
  },
  openGraph: {
    title: 'Trading Library | Arena',
    description: 'Free crypto trading books and educational resources for traders of all levels.',
    url: `${baseUrl}/rankings/resources`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Trading Library' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Library | Arena',
    description: 'Free crypto trading books and educational resources.',
    images: [`${baseUrl}/og.png`],
  },
}

export default function ResourcesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
