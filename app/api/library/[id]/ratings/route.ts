import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = getSupabaseAdmin()

    // Get all ratings with user info
    const { data: ratings, error } = await supabase
      .from('book_ratings')
      .select(`
        id, rating, review, created_at, updated_at,
        user_id,
        users!book_ratings_user_id_fkey ( id, nickname )
      `)
      .eq('library_item_id', id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Get aggregate
    const { data: item } = await supabase
      .from('library_items')
      .select('rating, rating_count')
      .eq('id', id)
      .single()

    return NextResponse.json({
      ratings: ratings || [],
      average: item?.rating || 0,
      count: item?.rating_count || 0,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
