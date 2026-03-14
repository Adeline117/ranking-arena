import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import BookDetailClient from './BookDetailClient'
import type { BookDetail, RatingOverview, SimilarItem, LanguageVersion } from './BookDetailClient'

export const revalidate = 300 // ISR: 5 minutes

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

const BOOK_COLUMNS = 'id, title, title_en, title_zh, author, description, category, subcategory, source, source_url, pdf_url, cover_url, tags, publish_date, download_count, is_free, buy_url, content_url, publisher, isbn, page_count, language, language_group_id, rating, rating_count, file_key, epub_url'

const getBookData = cache(async function getBookData(id: string) {
  const supabase = getSupabaseAdmin()

  const { data: item, error } = await supabase
    .from('library_items')
    .select(BOOK_COLUMNS)
    .eq('id', id)
    .single()

  if (error || !item) return null

  // Parallel fetches
  const [ratingsResult, similarResult, langResult] = await Promise.all([
    supabase
      .from('book_ratings')
      .select('rating')
      .eq('library_item_id', id)
      .not('rating', 'is', null)
      .limit(1000),
    supabase
      .from('library_items')
      .select('id, title, author, cover_url, category, rating, rating_count')
      .eq('category', item.category)
      .neq('id', id)
      .order('download_count', { ascending: false })
      .limit(6),
    item.language_group_id
      ? supabase
          .from('library_items')
          .select('id, title, language')
          .eq('language_group_id', item.language_group_id)
          .neq('id', id)
      : Promise.resolve({ data: [] }),
  ])

  // Calculate rating overview
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let sum = 0
  let count = 0
  if (ratingsResult.data) {
    for (const r of ratingsResult.data) {
      if (r.rating >= 1 && r.rating <= 5) {
        distribution[r.rating as number]++
        sum += r.rating as number
        count++
      }
    }
  }

  const overview: RatingOverview | null = count > 0
    ? { average: sum / count, count, distribution }
    : null

  return {
    book: item as BookDetail,
    overview,
    similar: (similarResult.data || []) as SimilarItem[],
    langVersions: (langResult.data || []) as LanguageVersion[],
  }
})

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const data = await getBookData(id)

  if (!data) {
    return { title: 'Book Not Found' }
  }

  const item = data.book
  const title = item.title_en || item.title
  const description = item.description?.slice(0, 160) || `${title} by ${item.author || 'Unknown'}`

  return {
    title: `${title} Library`,
    description,
    alternates: {
      canonical: `${BASE_URL}/library/${id}`,
    },
    openGraph: {
      title: `${title} Library`,
      description,
      url: `${BASE_URL}/library/${id}`,
      siteName: 'Arena',
      type: 'article',
      ...(item.cover_url ? { images: [{ url: item.cover_url, alt: title }] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} Library`,
      description,
    },
  }
}

export default async function BookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const data = await getBookData(id)

  if (!data) {
    notFound()
  }

  const { book, overview, similar, langVersions } = data
  const canonicalUrl = `${BASE_URL}/library/${id}`

  // JSON-LD with server-side URL
  const avg = overview?.average || 0
  const count = overview?.count || 0
  const bookJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: book.title,
    ...(book.author ? { author: { '@type': 'Person', name: book.author } } : {}),
    ...(book.isbn ? { isbn: book.isbn } : {}),
    ...(book.description ? { description: book.description.slice(0, 500) } : {}),
    ...(book.cover_url ? { image: book.cover_url } : {}),
    ...(book.publisher ? { publisher: { '@type': 'Organization', name: book.publisher } } : {}),
    ...(book.language ? { inLanguage: book.language } : {}),
    ...(book.page_count ? { numberOfPages: book.page_count } : {}),
    ...(avg > 0 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: avg.toFixed(1), reviewCount: count } } : {}),
    url: canonicalUrl,
  }

  return (
    <>
      <JsonLd data={bookJsonLd} />
      <BookDetailClient
        book={book}
        initialOverview={overview}
        initialSimilar={similar}
        initialLangVersions={langVersions}
        canonicalUrl={canonicalUrl}
      />
    </>
  )
}
