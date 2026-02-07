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
    const { status } = body

    if (!['want_to_read', 'read'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    // Upsert - if switching to want_to_read, clear rating
    const upsertData: any = {
      user_id: user.id,
      library_item_id: id,
      status,
      updated_at: new Date().toISOString(),
    }

    if (status === 'want_to_read') {
      upsertData.rating = null
    }

    const { error } = await supabase
      .from('book_ratings')
      .upsert(upsertData, { onConflict: 'user_id,library_item_id' })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, status })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
