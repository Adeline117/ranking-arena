import { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import LibraryBrowseClient from './LibraryBrowseClient'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Library | Arena',
  description:
    'Browse 60,000+ crypto trading resources. Books, research papers, guides, and educational content for traders.',
  alternates: {
    canonical: `${BASE_URL}/library`,
  },
  openGraph: {
    title: 'Trading Library',
    description: 'Browse 60,000+ crypto trading resources — books, papers, and educational content.',
    url: `${BASE_URL}/library`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Library' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Library | Arena',
    description: 'Browse 60,000+ crypto trading resources — books, papers, and educational content.',
    images: [`${BASE_URL}/og-image.png`],
  },
}

export const revalidate = 3600 // 1 hour

interface LibraryItem {
  id: string
  title: string
  author: string | null
  description: string | null
  category: string
  subcategory: string | null
  cover_url: string | null
  language: string | null
  rating: number | null
  rating_count: number
  view_count: number
  is_free: boolean
  publish_date: string | null
}

interface CategoryCount {
  category: string
  count: number
}

async function getLibraryData(): Promise<{
  recent: LibraryItem[]
  popular: LibraryItem[]
  categories: CategoryCount[]
  totalCount: number
}> {
  const supabase = getSupabaseAdmin()

  // Parallel queries
  const [recentResult, popularResult, countResult] = await Promise.all([
    // Recent additions
    supabase
      .from('library_items')
      .select('id, title, author, description, category, subcategory, cover_url, language, rating, rating_count, view_count, is_free, publish_date')
      .order('created_at', { ascending: false })
      .limit(20),

    // Most viewed
    supabase
      .from('library_items')
      .select('id, title, author, description, category, subcategory, cover_url, language, rating, rating_count, view_count, is_free, publish_date')
      .order('view_count', { ascending: false })
      .limit(20),

    // Total count
    supabase
      .from('library_items')
      .select('id', { count: 'exact', head: true }),
  ])

  // Get category distribution — use DB-side aggregation via RPC
  // Previous approach fetched ALL rows (60k+) just to count categories in memory
  let categories: CategoryCount[] = []
  try {
    const { data: catData } = await supabase.rpc('get_library_category_counts')
    if (catData && Array.isArray(catData)) {
      categories = (catData as Array<{ category: string; count: number }>)
        .sort((a, b) => b.count - a.count)
    }
  } catch {
    // Fallback: derive from recent+popular results (no extra query)
    const categoryMap = new Map<string, number>()
    for (const item of [...(recentResult.data || []), ...(popularResult.data || [])]) {
      const cat = (item as LibraryItem).category
      if (cat) categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1)
    }
    categories = Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
  }

  return {
    recent: (recentResult.data as LibraryItem[]) || [],
    popular: (popularResult.data as LibraryItem[]) || [],
    categories,
    totalCount: countResult.count || 0,
  }
}

export default async function LibraryPage() {
  const { recent, popular, categories, totalCount } = await getLibraryData()

  return (
    <LibraryBrowseClient
      recent={recent}
      popular={popular}
      categories={categories}
      totalCount={totalCount}
    />
  )
}
