import type { Metadata } from 'next'

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>
}): Promise<Metadata> {
  const resolved = searchParams ? await searchParams : {}
  const query = resolved.q?.trim()

  const title = query
    ? `"${query}" - Search Results | Arena`
    : 'Search Traders & Community | Arena'

  const description = query
    ? `Search results for "${query}" — Find traders, posts, groups, and resources on Arena. Comprehensive search across 30+ exchanges and community content.`
    : 'Search for top crypto traders, community posts, discussion groups, and trading resources on Arena. Find performance data from 30+ exchanges.'

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

  return {
    title,
    description,
    alternates: {
      canonical: `${baseUrl}/search`,
    },
    openGraph: {
      title,
      description,
      url: `${baseUrl}/search`,
      siteName: 'Arena',
      type: 'website',
      images: [{ 
        url: `${baseUrl}/og-image.png`, 
        width: 1200, 
        height: 630, 
        alt: 'Arena - Search' 
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: description.length > 160 ? description.substring(0, 157) + '...' : description,
      images: [`${baseUrl}/og-image.png`],
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
