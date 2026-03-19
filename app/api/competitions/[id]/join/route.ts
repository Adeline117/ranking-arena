/**
 * POST /api/competitions/[id]/join - Join a competition (auth required)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Rate limit
  const rateLimitResult = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResult.response) return rateLimitResult.response

  // Auth check
  const user = await getAuthUser(request)
  if (!user) {
    return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
  }

  const { id: competitionId } = await params
  const body = await request.json()
  const { trader_id, platform } = body

  if (!trader_id || !platform) {
    return NextResponse.json(
      { success: false, error: 'trader_id and platform are required' },
      { status: 400 }
    )
  }

  const supabase = getSupabaseAdmin()

  // Fetch competition
  const { data: competition, error: compError } = await supabase
    .from('competitions')
    .select('*')
    .eq('id', competitionId)
    .single()

  if (compError || !competition) {
    return NextResponse.json({ success: false, error: 'Competition not found' }, { status: 404 })
  }

  // Check status — allow joining upcoming or active
  if (competition.status !== 'upcoming' && competition.status !== 'active') {
    return NextResponse.json(
      { success: false, error: 'Competition is not open for entries' },
      { status: 400 }
    )
  }

  // Check max participants
  const { count } = await supabase
    .from('competition_entries')
    .select('id', { count: 'exact', head: true })
    .eq('competition_id', competitionId)

  if (count != null && count >= competition.max_participants) {
    return NextResponse.json(
      { success: false, error: 'Competition is full' },
      { status: 400 }
    )
  }

  // Get baseline value from leaderboard_ranks
  let baselineValue: number | null = null
  const { data: traderData } = await supabase
    .from('leaderboard_ranks')
    .select('roi, pnl, sharpe_ratio, max_drawdown')
    .eq('source', platform)
    .eq('source_trader_id', trader_id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (traderData) {
    const metricMap: Record<string, number | null> = {
      roi: traderData.roi,
      pnl: traderData.pnl,
      sharpe: traderData.sharpe_ratio,
      max_drawdown: traderData.max_drawdown,
    }
    baselineValue = metricMap[competition.metric] ?? null
  }

  // Insert entry (unique constraint prevents duplicate joins)
  const { data: entry, error: insertError } = await supabase
    .from('competition_entries')
    .insert({
      competition_id: competitionId,
      user_id: user.id,
      trader_id,
      platform,
      baseline_value: baselineValue,
      current_value: baselineValue,
      rank: null,
    })
    .select()
    .single()

  if (insertError) {
    // Check for unique constraint violation
    if (insertError.code === '23505') {
      return NextResponse.json(
        { success: false, error: 'You have already joined this competition' },
        { status: 409 }
      )
    }
    return NextResponse.json({ success: false, error: 'Failed to join competition' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: entry })
}
