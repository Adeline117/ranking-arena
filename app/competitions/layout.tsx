import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Trading Competitions | Arena',
  description: 'Compete with traders worldwide. Join trading competitions on Arena to test your skills and climb the leaderboard.',
  alternates: {
    canonical: `${BASE_URL}/competitions`,
  },
  openGraph: {
    title: 'Trading Competitions | Arena',
    description: 'Compete with traders worldwide on Arena.',
    url: `${BASE_URL}/competitions`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Competitions' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Competitions | Arena',
    description: 'Compete with traders worldwide on Arena.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function Layout({ children }: { children: React.ReactNode }) { return children }
