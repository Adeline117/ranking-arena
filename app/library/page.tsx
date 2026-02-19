import { redirect } from 'next/navigation'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Library',
  description: 'Browse trading books, papers, and whitepapers curated for crypto traders on Arena.',
  alternates: {
    canonical: '/library',
  },
  openGraph: {
    title: 'Library | Arena',
    description: 'Browse trading books, papers, and whitepapers curated for crypto traders.',
    url: '/library',
    siteName: 'Arena',
    type: 'website',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'Arena Library' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Library | Arena',
    description: 'Browse trading books, papers, and whitepapers curated for crypto traders.',
    images: ['/og-image.png'],
  },
}


export default function LibraryPage() {
  redirect('/rankings/resources')
}
