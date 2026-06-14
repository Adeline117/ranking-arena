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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { id } = await params
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Fetch bot source - try by slug first, then by UUID.
    // Column set must match the real bot_sources schema (see /api/bots list route +
    // bot detail page field usage). Selecting non-existent columns (avatar_url/
    // exchange/strategy_type/status) makes .single() error → spurious 404.
    let botQuery = supabase
      .from('bot_sources')
      .select(
        'id, slug, name, description, category, chain, token_symbol, contract_address, token_address, website_url, twitter_handle, telegram_url, logo_url, launch_date, is_active'
      )
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    botQuery = isUuid ? botQuery.eq('id', id) : botQuery.eq('slug', id)

    const { data: bot, error: botError } = await botQuery.single()
    if (botError || !bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    }

    // Fetch all season snapshots. (bot_equity_curve is unused by the detail page
    // and has no rows — query dropped.) Columns match real bot_snapshots schema.
    const { data: snapshots } = await supabase
      .from('bot_snapshots')
      .select(
        'id, bot_id, season_id, roi, apy, tvl, revenue, total_volume, total_trades, unique_users, max_drawdown, arena_score, captured_at'
      )
      .eq('bot_id', bot.id)
      .order('season_id')

    return NextResponse.json(
      {
        bot,
        snapshots: snapshots || [],
        equity_curve: [],
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
        },
      }
    )
  } catch (err: unknown) {
    logger.error('Bot detail API error', {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
