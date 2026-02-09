import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50)
    const offset = parseInt(searchParams.get('offset') || '0')

    // Resolve handle to user_id
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', decodeURIComponent(handle))
      .maybeSingle()

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { data: activities, error } = await supabase
      .from('user_activities')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ activities: activities || [], hasMore: (activities?.length || 0) === limit })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
