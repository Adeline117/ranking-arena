import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ items: [] })
    }

    const supabase = getSupabaseAdmin()
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.substring(7))
    if (authError || !user) {
      return NextResponse.json({ items: [] })
    }

    // Get user's bookshelf items (want_to_read or read)
    const { data: ratings } = await supabase
      .from('book_ratings')
      .select('library_item_id, status, rating')
      .eq('user_id', user.id)
      .in('status', ['want_to_read', 'read'])
      .order('updated_at', { ascending: false })

    if (!ratings || ratings.length === 0) {
      return NextResponse.json({ items: [] })
    }

    const itemIds = ratings.map(r => r.library_item_id)

    const { data: items } = await supabase
      .from('library_items')
      .select('*')
      .in('id', itemIds)

    // Merge status info and maintain order
    const itemMap = new Map((items || []).map(i => [i.id, i]))
    const result = ratings
      .map(r => {
        const item = itemMap.get(r.library_item_id)
        if (!item) return null
        return { ...item, status: r.status, user_rating: r.rating }
      })
      .filter(Boolean)

    return NextResponse.json({ items: result })
  } catch (e: any) {
    return NextResponse.json({ error: e.message, items: [] }, { status: 500 })
  }
}
