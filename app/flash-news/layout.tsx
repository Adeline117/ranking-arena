import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Flash News - Arena',
  description:
    'Real-time crypto market news, DeFi updates, macro events, and regulatory changes curated for traders.',
  alternates: {
    canonical: `${BASE_URL}/flash-news`,
  },
  openGraph: {
    title: 'Flash News - Arena',
    description: 'Real-time crypto market news and updates curated for traders.',
    url: `${BASE_URL}/flash-news`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Flash News' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Flash News - Arena',
    description: 'Real-time crypto market news curated for traders.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

export default function FlashNewsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
