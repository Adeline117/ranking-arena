/**
 * Server shell for /search (Wave-3 SSR conversion).
 *
 * The shell streams immediately (metadata lives here — layouts never receive searchParams); the
 * interactive body — useSearchParams, React Query, auth — stays in the
 * client leaf behind Suspense. No data fetching moved to the server yet.
 */

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BASE_URL } from '@/lib/constants/urls'
import { SearchPageSkeleton } from '@/app/components/ui/PageSkeleton'
import SearchPageClient from './SearchPageClient'

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string }>
}): Promise<Metadata> {
  const resolved = searchParams ? await searchParams : {}
  const query = resolved.q?.trim()

  // Root layout template appends ' | Arena' to the metadata title, so it must
  // not already include the suffix (else it doubles to '… | Arena | Arena').
  // OG/Twitter titles bypass the template, so they keep the explicit suffix.
  const title = query ? `"${query}" - Search Results` : 'Search Traders & Resources'
  const ogTitle = `${title} | Arena`

  const description = query
    ? `Search results for "${query}" — Find traders and resources across live ranking source boards.`
    : 'Search for top crypto traders and trading resources across live ranking source boards.'

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/search`,
    },
    openGraph: {
      title: ogTitle,
      description,
      url: `${BASE_URL}/search`,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: `${BASE_URL}/og-image.png`,
          width: 1200,
          height: 630,
          alt: 'Arena - Search',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
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

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchPageSkeleton />}>
      <SearchPageClient />
    </Suspense>
  )
}
