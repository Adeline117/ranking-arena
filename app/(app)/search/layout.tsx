import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>
}): Promise<Metadata> {
  const resolved = searchParams ? await searchParams : {}
  const query = resolved.q?.trim()

  const title = query
    ? `"${query}" - Search Results | Arena`
    : 'Search Traders & Resources | Arena'

  const description = query
    ? `Search results for "${query}" — Find traders and resources on Arena. Comprehensive search across 30+ exchanges.`
    : 'Search for top crypto traders and trading resources on Arena. Find performance data from 30+ exchanges.'

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/search`,
    },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/search`,
      siteName: 'Arena',
      type: 'website',
      images: [{ 
        url: `${BASE_URL}/og-image.png`, 
        width: 1200, 
        height: 630, 
        alt: 'Arena - Search' 
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: description.length > 160 ? description.substring(0, 157) + '...' : description,
      images: [`${BASE_URL}/og-image.png`],
      creator: '@arenafi',
    },
    robots: {
      index: !query, // 有搜索词时不索引（避免大量低质量页面）
      follow: true,
    },
  }
}

export default function SearchLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
