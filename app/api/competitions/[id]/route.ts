/**
 * GET /api/competitions/[id] - Competition detail with entries + standings
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id) {
    return NextResponse.json({ success: false, error: 'Competition ID is required' }, { status: 400 })
  }

  try {
    const supabase = getSupabaseAdmin()

    // Fetch competition + entries in parallel
    const [compResult, entriesResult] = await Promise.all([
      supabase
        .from('competitions')
        .select('*')
        .eq('id', id)
        .single(),
      supabase
        .from('competition_entries')
        .select('*')
        .eq('competition_id', id)
        .order('rank', { ascending: true, nullsFirst: false }),
    ])

    if (compResult.error || !compResult.data) {
      return NextResponse.json({ success: false, error: 'Competition not found' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      data: {
        competition: compResult.data,
        entries: entriesResult.data || [],
        participant_count: entriesResult.data?.length || 0,
      },
    })
  } catch (_err) {
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
