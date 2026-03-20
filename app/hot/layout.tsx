import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: '热门动态',
  description:
    'Trending discussions, trade ideas, and market analysis from top crypto traders on Arena.',
  alternates: {
    canonical: `${BASE_URL}/hot`,
  },
  openGraph: {
    title: '热门动态',
    description: 'Trending discussions and trade ideas from top crypto traders.',
    url: `${BASE_URL}/hot`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Hot Posts' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '热门动态',
    description: 'Trending discussions and trade ideas from top crypto traders.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

export default function HotLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
