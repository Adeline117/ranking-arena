import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export async function generateMetadata(
  props: {
    searchParams?: Promise<{ ids?: string }>
  }
): Promise<Metadata> {
  const resolved = props.searchParams ? await props.searchParams : {}
  const ids = resolved.ids
  const idList = ids ? ids.split(',').slice(0, 3) : []

  // Build OG image URL (compare OG route handles data fetching)
  const ogUrl = idList.length > 0
    ? `${BASE_URL}/api/og/compare?ids=${idList.join(',')}`
    : `${BASE_URL}/og-image.png`

  const title = 'Compare Traders'
  const description = idList.length > 0
    ? `Comparing ${idList.length} traders side-by-side on Arena`
    : 'Compare traders side-by-side across exchanges.'

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/compare`,
    },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/compare${ids ? '?ids=' + ids : ''}`,
      siteName: 'Arena',
      type: 'website',
      images: [{ url: ogUrl, width: 1200, height: 630, alt: 'Arena Trader Comparison' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogUrl],
      creator: '@arenafi',
    },
  }
}

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
