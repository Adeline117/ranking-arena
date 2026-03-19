import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Trading Competitions | Arena',
  description: 'Compete with traders worldwide. Join trading competitions on Arena to test your skills and climb the leaderboard.',
  alternates: {
    canonical: `${baseUrl}/competitions`,
  },
  openGraph: {
    title: 'Trading Competitions | Arena',
    description: 'Compete with traders worldwide on Arena.',
    url: `${baseUrl}/competitions`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Competitions' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Competitions | Arena',
    description: 'Compete with traders worldwide on Arena.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function Layout({ children }: { children: React.ReactNode }) { return children }
