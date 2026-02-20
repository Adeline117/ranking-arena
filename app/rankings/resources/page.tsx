import type { Metadata } from 'next'
import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { LibraryItem } from '@/lib/types/library'
import ResourcesClient from './ResourcesClient'
import { logger } from '@/lib/logger'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'

export const metadata: Metadata = {
  title: 'Trading Resources — Arena',
  description: 'Curated trading resources, guides, and tools for crypto traders.',
  openGraph: {
    title: 'Trading Resources — Arena',
    description: 'Curated trading resources, guides, and tools for crypto traders.',
    url: 'https://www.arenafi.org/rankings/resources',
    siteName: 'Arena',
    type: 'website',
  },
}

export const revalidate = 300

async function fetchLibraryItems(): Promise<{ items: LibraryItem[]; total: number }> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return { items: [], total: 0 }
  try {
    const supabase = getSupabaseAdmin()
    const { data, count } = await supabase
      .from('library_items')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(0, 23)

    return { items: data || [], total: count || 0 }
  } catch (e) {
    logger.error('[Resources] Failed to prefetch:', e)
    return { items: [], total: 0 }
  }
}

async function fetchFeatured(): Promise<LibraryItem[]> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return []
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('library_items')
      .select('*')
      .not('cover_url', 'is', null)
      .eq('category', 'book')
      .order('rating', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(6)

    return (data || []).filter((i: LibraryItem) => i.cover_url)
  } catch {
    return []
  }
}

const TOP_FIELDS = 'id,title,title_en,title_zh,author,category,cover_url,rating,rating_count,view_count,language'

async function fetchTopByCategory(category: string): Promise<LibraryItem[]> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return []
  try {
    const supabase = getSupabaseAdmin()
    // Try rated items first
    const { data } = await supabase
      .from('library_items')
      .select(TOP_FIELDS)
      .eq('category', category)
      .not('rating', 'is', null)
      .order('rating', { ascending: false })
      .limit(10)
    if (data && data.length >= 5) return data as LibraryItem[]
    // Fallback: most viewed
    const { data: fallback } = await supabase
      .from('library_items')
      .select(TOP_FIELDS)
      .eq('category', category)
      .order('view_count', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(10)
    return (fallback || []) as LibraryItem[]
  } catch {
    return []
  }
}

async function fetchCategoryCounts(): Promise<Record<string, number>> {
  if (process.env.NEXT_PHASE === 'phase-production-build') return {}
  try {
    const supabase = getSupabaseAdmin()
    const cats = ['book', 'paper', 'whitepaper', 'research', 'academic_paper']
    const [totalResult, ...catResults] = await Promise.all([
      supabase.from('library_items').select('id', { count: 'exact', head: true }),
      ...cats.map(cat =>
        supabase.from('library_items').select('id', { count: 'exact', head: true }).eq('category', cat)
      ),
    ])
    const counts: Record<string, number> = { all: totalResult.count || 0 }
    cats.forEach((cat, i) => {
      counts[cat] = catResults[i].count || 0
    })
    return counts
  } catch {
    return {}
  }
}

export default async function ResourcesPage() {
  const [{ items, total }, featured, topBooks, topPapers, topWhitepapers, categoryCounts] = await Promise.all([
    fetchLibraryItems(),
    fetchFeatured(),
    fetchTopByCategory('book'),
    fetchTopByCategory('paper'),
    fetchTopByCategory('whitepaper'),
    fetchCategoryCounts(),
  ])

  return (
    <ErrorBoundary pageType="library">
      <Suspense>
        <ResourcesClient
          initialItems={items}
          initialFeatured={featured}
          initialTotal={total}
          topBooks={topBooks}
          topPapers={topPapers}
          recentItems={topWhitepapers}
          categoryCounts={categoryCounts}
        />
      </Suspense>
    </ErrorBoundary>
  )
}
