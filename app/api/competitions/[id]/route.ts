/**
 * GET /api/competitions/[id] - Competition detail with entries + standings
 */

import { NextRequest, NextResponse } from 'next/server'
import { features } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!features.competitions) return NextResponse.json({ error: 'Not found' }, { status: 404 })
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
        // 前端([id]/page.tsx)用真列名 title/start_at/end_at/metric/status/description。
        // (旧代码读 name/start_date/prizes——表没有,且前端也不读那些。)
        .select(
          'id, title, description, start_at, end_at, status, metric, prize_pool_cents, rules, created_at, updated_at'
        )
        .eq('id', id)
        .single(),
      supabase
        .from('competition_entries')
        // 前端用 entry.platform/current_value/baseline_value/rank/trader_id/user_id(真列名)。
        // baseline_value 必须选(前端 formatDelta 用它算涨跌)——之前漏了。
        .select(
          'id, competition_id, user_id, trader_id, platform, rank, prev_rank, current_value, baseline_value, joined_at'
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
