import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: '快讯',
  description:
    'Real-time crypto market news, DeFi updates, macro events, and regulatory changes curated for traders.',
  alternates: {
    canonical: `${baseUrl}/flash-news`,
  },
  openGraph: {
    title: '快讯',
    description: 'Real-time crypto market news and updates curated for traders.',
    url: `${baseUrl}/flash-news`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Flash News' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '快讯',
    description: 'Real-time crypto market news curated for traders.',
    images: [`${baseUrl}/og.png`],
  },
}

export default function FlashNewsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
