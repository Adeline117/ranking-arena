/**
 * GET /api/bots
 *
 * Returns ranked Web3 bots for the leaderboard.
 *
 * Query params:
 *   window: '7D' | '30D' | '90D' (default '90D')
 *   category: 'tg_bot' | 'ai_agent' | 'vault' | 'strategy' (optional)
 *   sort_by: 'arena_score' | 'tvl' | 'volume' | 'users' | 'apy' (default 'arena_score')
 *   sort_dir: 'asc' | 'desc' (default 'desc')
 *   limit: number (default 50)
 *   offset: number (default 0)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('bots-api')

const VALID_WINDOWS = ['7D', '30D', '90D']
const VALID_CATEGORIES = ['tg_bot', 'ai_agent', 'vault', 'strategy']
const VALID_SORT = ['arena_score', 'tvl', 'total_volume', 'unique_users', 'apy', 'roi', 'market_cap']

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { searchParams } = new URL(request.url)
    const window = (searchParams.get('window') || '90D').toUpperCase()
    const category = searchParams.get('category')
    const sortBy = searchParams.get('sort_by') || 'arena_score'
    const sortDir = (searchParams.get('sort_dir') || 'desc') as 'asc' | 'desc'
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    if (!VALID_WINDOWS.includes(window)) {
      return NextResponse.json({ error: 'Invalid window' }, { status: 400 })
    }
    if (category && !VALID_CATEGORIES.includes(category)) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Join bot_sources with bot_snapshots
    let query = supabase
      .from('bot_snapshots')
      .select(`
        id,
        bot_id,
        season_id,
        total_volume,
        total_trades,
        unique_users,
        revenue,
        tvl,
        apy,
        roi,
        max_drawdown,
        sharpe_ratio,
        token_price,
        market_cap,
        token_holders,
        mindshare_score,
        twitter_followers,
        telegram_members,
        arena_score,
        captured_at,
        bot_sources!inner (
          id,
          name,
          slug,
          category,
          chain,
          contract_address,
          token_address,
          token_symbol,
          website_url,
          twitter_handle,
          telegram_url,
          logo_url,
          description,
          launch_date,
          is_active
        )
      `, { count: 'exact' })
      .eq('season_id', window)
      .eq('bot_sources.is_active', true)

    if (category) {
      query = query.eq('bot_sources.category', category)
    }

    // Sort
    const dbSortCol = VALID_SORT.includes(sortBy) ? sortBy : 'arena_score'
    query = query
      .order(dbSortCol, { ascending: sortDir === 'asc', nullsFirst: false })
      .range(offset, offset + limit - 1)

    const { data: rows, count, error } = await query

    if (error) {
      // Table may not exist yet in this environment — return empty list gracefully
      const isMissingTable =
        error.code === '42P01' ||
        error.message?.includes('does not exist')
      if (isMissingTable) {
        return NextResponse.json(
          { bots: [], window, total_count: 0, as_of: new Date().toISOString() },
          { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } }
        )
      }
      logger.error('Bots query failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to fetch bots' }, { status: 500 })
    }

    // Transform to a flat response shape
    const bots = (rows || []).map((row, idx) => {
      const src = (row as Record<string, unknown>).bot_sources as Record<string, unknown>
      return {
        id: src.id,
        slug: src.slug,
        name: src.name,
        category: src.category,
        chain: src.chain,
        logo_url: src.logo_url,
        token_symbol: src.token_symbol,
        website_url: src.website_url,
        twitter_handle: src.twitter_handle,
        description: src.description,
        launch_date: src.launch_date,
        rank: offset + idx + 1,
        metrics: {
          total_volume: row.total_volume,
          total_trades: row.total_trades,
          unique_users: row.unique_users,
          revenue: row.revenue,
          tvl: row.tvl,
          apy: row.apy,
          roi: row.roi,
          max_drawdown: row.max_drawdown,
          sharpe_ratio: row.sharpe_ratio,
          token_price: row.token_price,
          market_cap: row.market_cap,
          token_holders: row.token_holders,
          mindshare_score: row.mindshare_score,
          arena_score: row.arena_score,
        },
        captured_at: row.captured_at,
      }
    })

    const asOf = rows?.[0]?.captured_at || new Date().toISOString()
    const asOfDate = new Date(asOf)
    const staleDays = Math.floor((Date.now() - asOfDate.getTime()) / (1000 * 60 * 60 * 24))

    return NextResponse.json({
      bots,
      window,
      total_count: count || 0,
      as_of: asOf,
      ...(staleDays > 7 ? { stale: true, stale_days: staleDays } : {}),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
      },
    })
  } catch (err: unknown) {
    logger.error('Bots API error', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
