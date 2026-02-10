import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { LibraryItem } from '@/lib/types/library'
import LibraryClient from './LibraryClient'
import { logger } from '@/lib/logger'
import ErrorBoundary from '@/app/components/error/ErrorBoundary'

// ISR: revalidate every 5 minutes for fresh library content
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
    logger.error('[Library] Failed to prefetch:', e)
    return { items: [], total: 0 }
  }
}

async function fetchFeatured(): Promise<LibraryItem[]> {
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('library_items')
      .select('*')
      .order('rating', { ascending: false })
      .limit(6)

    return (data || []).filter((i: LibraryItem) => i.cover_url || i.rating)
  } catch {
    return []
  }
}

export default async function LibraryPage() {
  const [{ items, total }, featured] = await Promise.all([
    fetchLibraryItems(),
    fetchFeatured(),
  ])

  return (
    <ErrorBoundary 
      pageType="library" 
      onError={(error, errorInfo) => {
        console.error('Library page error:', error, errorInfo)
      }}
    >
      <Suspense>
        <LibraryClient
          initialItems={items}
          initialFeatured={featured}
          initialTotal={total}
        />
      </Suspense>
    </ErrorBoundary>
  )
}
