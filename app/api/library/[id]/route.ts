import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = getSupabaseAdmin()

    // Get book details
    const { data: item, error } = await supabase
      .from('library_items')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !item) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Get rating distribution
    const { data: ratings } = await supabase
      .from('book_ratings')
      .select('rating')
      .eq('library_item_id', id)
      .not('rating', 'is', null)

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    let sum = 0
    let count = 0
    if (ratings) {
      for (const r of ratings) {
        if (r.rating >= 1 && r.rating <= 5) {
          distribution[r.rating as keyof typeof distribution]++
          sum += r.rating
          count++
        }
      }
    }

    // Check user status if authenticated
    let userStatus = null
    let userRating = null
    const authHeader = req.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.substring(7))
      if (user) {
        const { data: ur } = await supabase
          .from('book_ratings')
          .select('rating, status, review')
          .eq('library_item_id', id)
          .eq('user_id', user.id)
          .single()
        if (ur) {
          userStatus = ur.status
          userRating = ur.rating
        }
      }
    }

    // Increment view count
    await supabase
      .from('library_items')
      .update({ view_count: (item.view_count || 0) + 1 })
      .eq('id', id)

    return NextResponse.json({
      item,
      ratingOverview: {
        average: count > 0 ? sum / count : 0,
        count,
        distribution,
      },
      userStatus,
      userRating,
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' }
    })
  } catch (e: unknown) {
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)) }, { status: 500 })
  }
}
