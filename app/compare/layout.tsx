import type { Metadata } from 'next'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

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
    ? `${baseUrl}/api/og/compare?ids=${idList.join(',')}`
    : `${baseUrl}/og-image.png`

  const title = 'Compare Traders'
  const description = idList.length > 0
    ? `Comparing ${idList.length} traders side-by-side on Arena`
    : 'Compare traders side-by-side across exchanges.'

  return {
    title,
    description,
    alternates: {
      canonical: `${baseUrl}/compare`,
    },
    openGraph: {
      title,
      description,
      url: `${baseUrl}/compare${ids ? '?ids=' + ids : ''}`,
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
