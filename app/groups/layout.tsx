import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Groups',
  description: 'Join trading discussion groups on Arena. Share strategies, market analysis, and connect with fellow traders.',
  alternates: {
    canonical: `${baseUrl}/groups`,
  },
  openGraph: {
    title: 'Groups',
    description: 'Join trading discussion groups on Arena.',
    url: `${baseUrl}/groups`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Groups' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Groups',
    description: 'Join trading discussion groups on Arena.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

export default function Layout({ children }: { children: React.ReactNode }) { return children }
