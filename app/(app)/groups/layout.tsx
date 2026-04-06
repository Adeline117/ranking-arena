import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Groups',
  description: 'Join trading discussion groups on Arena. Share strategies, market analysis, and connect with fellow traders.',
  alternates: {
    canonical: `${BASE_URL}/groups`,
  },
  openGraph: {
    title: 'Groups',
    description: 'Join trading discussion groups on Arena.',
    url: `${BASE_URL}/groups`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Groups' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Groups',
    description: 'Join trading discussion groups on Arena.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function Layout({ children }: { children: React.ReactNode }) { return children }
