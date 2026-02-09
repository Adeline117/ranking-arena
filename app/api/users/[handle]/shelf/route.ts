import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'

/**
 * GET /api/users/[handle]/shelf
 * Public bookshelf for a user profile — returns books grouped by status
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const supabase = getSupabaseAdmin()

    // Resolve user id from handle
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', decodeURIComponent(handle))
      .maybeSingle()

    if (!profile) {
      return NextResponse.json({ items: [] })
    }

    // Get all book ratings for this user
    const { data: ratings } = await supabase
      .from('book_ratings')
      .select('library_item_id, status, rating, updated_at')
      .eq('user_id', profile.id)
      .in('status', ['want_to_read', 'reading', 'read'])
      .order('updated_at', { ascending: false })
      .limit(50)

    if (!ratings || ratings.length === 0) {
      return NextResponse.json({ items: [] })
    }

    const itemIds = ratings.map(r => r.library_item_id)

    const { data: items } = await supabase
      .from('library_items')
      .select('id, title, author, cover_url, category, rating, rating_count')
      .in('id', itemIds)

    const itemMap = new Map((items || []).map(i => [i.id, i]))
    const result = ratings
      .map(r => {
        const item = itemMap.get(r.library_item_id)
        if (!item) return null
        return {
          ...item,
          status: r.status,
          user_rating: r.rating,
          updated_at: r.updated_at,
        }
      })
      .filter(Boolean)

    return NextResponse.json({ items: result })
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), items: [] },
      { status: 500 }
    )
  }
}
