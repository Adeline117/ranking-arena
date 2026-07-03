/**
 * GET /api/competitions/[id] - Competition detail with entries + standings
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!id) {
    return NextResponse.json(
      { success: false, error: 'Competition ID is required' },
      { status: 400 }
    )
  }

  try {
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Fetch competition + entries in parallel
    const [compResult, entriesResult] = await Promise.all([
      supabase
        .from('competitions')
        // 读旧命名对不上表——建赛 insert(competitions/route.ts:118)证实真列是 title/start_at/
        // end_at/prize_pool_cents。别名保持前端 key，选真列；season_id 表无(去掉)。
        .select(
          'id, name:title, description, start_date:start_at, end_date:end_at, status, rules, prizes:prize_pool_cents, created_at, updated_at'
        )
        .eq('id', id)
        .single(),
      supabase
        .from('competition_entries')
        // 报名 insert(join/route.ts:97)证实真列 platform/current_value;roi/pnl/updated_at 表无
        // (只有 baseline_value/current_value,roi/pnl 应由前端从这俩派生)——去掉。
        .select(
          'id, competition_id, user_id, trader_id, source:platform, rank, prev_rank, score:current_value, joined_at'
        )
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
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
