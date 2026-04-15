/**
 * GET /api/competitions/[id] - Competition detail with entries + standings
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!id) {
    return NextResponse.json({ success: false, error: 'Competition ID is required' }, { status: 400 })
  }

  try {
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Fetch competition + entries in parallel
    const [compResult, entriesResult] = await Promise.all([
      supabase
        .from('competitions')
        .select('id, name, description, season_id, start_date, end_date, status, rules, prizes, created_at, updated_at')
        .eq('id', id)
        .single(),
      supabase
        .from('competition_entries')
        .select('id, competition_id, user_id, trader_id, source, rank, score, roi, pnl, joined_at, updated_at')
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
