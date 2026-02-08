import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Hot Posts · Arena',
  description:
    'Trending discussions, trade ideas, and market analysis from top crypto traders on Arena.',
  alternates: {
    canonical: `${baseUrl}/hot`,
  },
  openGraph: {
    title: 'Hot Posts · Arena',
    description: 'Trending discussions and trade ideas from top crypto traders.',
    url: `${baseUrl}/hot`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Hot Posts' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hot Posts · Arena',
    description: 'Trending discussions and trade ideas from top crypto traders.',
    images: [`${baseUrl}/og.png`],
  },
}

export default function HotLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
