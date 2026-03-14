import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Trading Library | Free Crypto Books & Educational Resources',
  description:
    'Explore our free crypto trading library — comprehensive books and educational resources covering technical analysis, DeFi strategies, risk management, market psychology, and trading fundamentals. Curated for traders of all levels.',
  alternates: {
    canonical: `${baseUrl}/rankings/resources`,
  },
  openGraph: {
    title: 'Trading Library | Free Crypto Books & Resources',
    description: 'Free crypto trading books and educational resources for traders of all levels — technical analysis, DeFi strategies, risk management, and market psychology.',
    url: `${baseUrl}/rankings/resources`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Trading Library' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Library | Free Crypto Books',
    description: 'Free crypto trading books and educational resources for traders of all levels.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function ResourcesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
