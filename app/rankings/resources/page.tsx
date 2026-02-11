import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { LibraryItem } from '@/lib/types/library'
import ResourcesClient from './ResourcesClient'
import { logger } from '@/lib/logger'
import ErrorBoundary from '@/app/components/error/ErrorBoundary'

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
      .eq('type', 'book')
      .order('rating', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(6)

    return (data || []).filter((i: LibraryItem) => i.cover_url)
  } catch {
    return []
  }
}

export default async function ResourcesPage() {
  const [{ items, total }, featured] = await Promise.all([
    fetchLibraryItems(),
    fetchFeatured(),
  ])

  return (
    <ErrorBoundary pageType="library">
      <Suspense>
        <ResourcesClient
          initialItems={items}
          initialFeatured={featured}
          initialTotal={total}
        />
      </Suspense>
    </ErrorBoundary>
  )
}
