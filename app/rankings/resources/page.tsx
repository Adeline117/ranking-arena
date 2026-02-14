import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { LibraryItem } from '@/lib/types/library'
import ResourcesClient from './ResourcesClient'
import { logger } from '@/lib/logger'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'

export const revalidate = 300

async function fetchLibraryItems(): Promise<{ items: LibraryItem[]; total: number }> {
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

export default async function ResourcesPage() {
  const [{ items, total }, featured, topBooks, topPapers, topWhitepapers] = await Promise.all([
    fetchLibraryItems(),
    fetchFeatured(),
    fetchTopByCategory('book'),
    fetchTopByCategory('paper'),
    fetchTopByCategory('whitepaper'),
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
        />
      </Suspense>
    </ErrorBoundary>
  )
}
