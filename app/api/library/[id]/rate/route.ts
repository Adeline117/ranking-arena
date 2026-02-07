import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.substring(7))
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { rating, review } = body

    if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return NextResponse.json({ error: 'Rating must be 1-5' }, { status: 400 })
    }

    // Upsert rating
    const { error: upsertError } = await supabase
      .from('book_ratings')
      .upsert({
        user_id: user.id,
        library_item_id: id,
        rating,
        review: review || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,library_item_id' })

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 })
    }

    // Get updated rating
    const { data: item } = await supabase
      .from('library_items')
      .select('rating, rating_count')
      .eq('id', id)
      .single()

    return NextResponse.json({
      success: true,
      rating: item?.rating,
      rating_count: item?.rating_count,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
