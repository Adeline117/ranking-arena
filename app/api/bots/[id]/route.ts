/**
 * GET /api/bots/[id]
 * Returns detailed bot info + all window snapshots
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('bots-api')

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { id } = await params
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Fetch bot source - try by slug first, then by UUID
    let botQuery = supabase.from('bot_sources').select('id, slug, name, description, avatar_url, exchange, strategy_type, status, created_at, updated_at')
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    botQuery = isUuid ? botQuery.eq('id', id) : botQuery.eq('slug', id)

    const { data: bot, error: botError } = await botQuery.single()
    if (botError || !bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    // Fetch all snapshots and equity curve in parallel
    const [{ data: snapshots }, { data: equityCurve }] = await Promise.all([
      supabase
        .from('bot_snapshots')
        .select('id, bot_id, season_id, roi, pnl, win_rate, max_drawdown, trades_count, arena_score, captured_at')
        .eq('bot_id', bot.id)
        .order('season_id'),
      supabase
        .from('bot_equity_curve')
        .select('timestamp, roi_pct, pnl_usd')
        .eq('bot_id', bot.id)
        .order('timestamp', { ascending: true })
        .limit(365),
    ])

    return NextResponse.json({
      bot,
      snapshots: snapshots || [],
      equity_curve: equityCurve || [],
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
      },
    })
  } catch (err: unknown) {
    logger.error('Bot detail API error', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
