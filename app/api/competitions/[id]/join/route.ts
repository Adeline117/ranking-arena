/**
 * POST /api/competitions/[id]/join - Join a competition (auth required)
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:competitions/join')

/** Extract competition id from URL path */
function extractCompetitionId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('competitions')
  return pathParts[idx + 1]
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const competitionId = extractCompetitionId(request.url)

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
    }
    const { trader_id, platform } = body as { trader_id?: string; platform?: string }

    if (!trader_id || !platform) {
      return NextResponse.json(
        { success: false, error: 'trader_id and platform are required' },
        { status: 400 }
      )
    }

    const sb = supabase as SupabaseClient

    // Fetch competition
    const { data: competition, error: compError } = await sb
      .from('competitions')
      .select('id, status, max_participants, metric')
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
    // KEEP 'exact' — max_participants enforcement. Scoped per-comp
    // via (competition_id) index. Must be accurate to block overfill.
    const { count } = await sb
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
    const { data: traderData } = await sb
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
    const { data: entry, error: insertError } = await sb
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
      log.error('Failed to join competition', { error: insertError.message })
      return NextResponse.json({ success: false, error: 'Failed to join competition' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: entry })
  },
  { name: 'competitions/join', rateLimit: 'write' }
)
