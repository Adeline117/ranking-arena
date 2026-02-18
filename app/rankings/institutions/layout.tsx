import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Institutions - Arena',
  description:
    'Explore top crypto institutions — exchanges, market makers, VCs, custody providers, and research firms. Community ratings and reviews.',
  alternates: {
    canonical: `${baseUrl}/rankings/institutions`,
  },
  openGraph: {
    title: 'Institution Rankings | Arena',
    description: 'Top crypto institutions ranked by community ratings — exchanges, market makers, VCs, and more.',
    url: `${baseUrl}/rankings/institutions`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena Institution Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Institution Rankings | Arena',
    description: 'Top crypto institutions ranked by community ratings.',
    images: [`${baseUrl}/og-image.png`],
  },
}

export default function InstitutionRankingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
