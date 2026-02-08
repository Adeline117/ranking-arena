import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Library · Arena',
  description:
    'Curated trading books, guides, and educational resources for crypto traders. Build your trading knowledge.',
  alternates: {
    canonical: `${baseUrl}/library`,
  },
  openGraph: {
    title: 'Library · Arena',
    description: 'Curated trading books and educational resources for crypto traders.',
    url: `${baseUrl}/library`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og.png`, width: 1200, height: 630, alt: 'Arena Library' }],
  },
  twitter: {
    card: 'summary',
    title: 'Library · Arena',
    description: 'Curated trading books and resources for crypto traders.',
  },
}

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
