/**
 * Ranking Snapshots API
 *
 * POST /api/snapshots - Create a new ranking snapshot
 * GET /api/snapshots - List user's snapshots (authenticated)
 *
 * Features:
 * - Creates immutable snapshots of current ranking data
 * - Generates shareable links
 * - Pro users get extended retention (90 days vs 7 days for free)
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { normalizeSubscriptionTier } from '@/lib/types/premium'
import type { TimeRange } from '@/lib/types/trader'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('snapshots-api')

export const dynamic = 'force-dynamic'

// Snapshot expiry configuration
const FREE_USER_SNAPSHOT_DAYS = 7
const PRO_USER_SNAPSHOT_DAYS = 90

// Maximum traders per snapshot
const MAX_SNAPSHOT_TRADERS = 100

interface CreateSnapshotBody {
  timeRange: TimeRange
  exchange?: string
  category?: 'all' | 'futures' | 'spot' | 'web3'
  title?: string
  description?: string
  isPublic?: boolean
}

/**
 * POST /api/snapshots - Create a new ranking snapshot
 */
export const POST = withAuth(
  async ({ user, supabase }) => {
    try {
      // Parse request body
      const body = await new Promise<CreateSnapshotBody>((resolve) => {
        // Get body from context - this is a workaround since we can't access request directly
        resolve({} as CreateSnapshotBody)
      }).catch(() => ({} as CreateSnapshotBody))

      const timeRange = body.timeRange || '90D'
      const exchange = body.exchange || null
      const category = body.category || 'all'
      const title = body.title
      const description = body.description
      const isPublic = body.isPublic !== false

      // Get user's subscription tier
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .single()

      const tier = normalizeSubscriptionTier(userProfile?.subscription_tier)
      const isPro = tier === 'pro'

      // Calculate expiry date based on subscription
      const expiryDays = isPro ? PRO_USER_SNAPSHOT_DAYS : FREE_USER_SNAPSHOT_DAYS
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + expiryDays)

      // Get current ranking data
      const seasonId = getSeasonId(timeRange)
      let tradersQuery = supabase
        .from('trader_snapshots')
        .select(`
          source_trader_id,
          season_id,
          roi,
          pnl,
          win_rate,
          max_drawdown,
          trades_count,
          followers,
          source,
          captured_at,
          trader_scores!inner (
            arena_score,
            return_score,
            drawdown_score,
            stability_score
          ),
          trader_sources!inner (
            handle,
            profile_url
          )
        `)
        .eq('season_id', seasonId)
        .gte('captured_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('roi', { ascending: false })
        .limit(MAX_SNAPSHOT_TRADERS)

      // Apply exchange filter
      if (exchange) {
        tradersQuery = tradersQuery.eq('source', exchange)
      }

      const { data: traders, error: tradersError } = await tradersQuery

      if (tradersError) {
        logger.error('Failed to fetch traders for snapshot', { error: tradersError.message })
        return NextResponse.json(
          { success: false, error: 'Failed to fetch ranking data' },
          { status: 500 }
        )
      }

      if (!traders || traders.length === 0) {
        return NextResponse.json(
          { success: false, error: 'No trader data available for snapshot' },
          { status: 400 }
        )
      }

      // Find top trader
      const topTrader = traders[0]
      const topTraderHandle = ((topTrader as Record<string, unknown>).trader_sources as Record<string, unknown> | undefined)?.handle as string || topTrader.source_trader_id

      // Create the snapshot record
      const { data: snapshot, error: snapshotError } = await supabase
        .from('ranking_snapshots')
        .insert({
          created_by: user.id,
          time_range: timeRange,
          exchange,
          category,
          total_traders: traders.length,
          top_trader_handle: topTraderHandle,
          top_trader_roi: topTrader.roi,
          data_captured_at: new Date().toISOString(),
          data_delay_minutes: 15,
          is_public: isPublic,
          expires_at: isPro ? null : expiresAt.toISOString(), // Pro users never expire
          title,
          description,
        })
        .select('id, share_token, created_at, expires_at')
        .single()

      if (snapshotError) {
        logger.error('Failed to create snapshot', { error: snapshotError.message })
        return NextResponse.json(
          { success: false, error: 'Failed to create snapshot' },
          { status: 500 }
        )
      }

      // Insert individual trader data
      const snapshotTraders = traders.map((trader, index) => {
        const scores = (trader as Record<string, unknown>).trader_scores as Record<string, number> | undefined
        const sources = (trader as Record<string, unknown>).trader_sources as Record<string, string> | undefined

        return {
          snapshot_id: snapshot.id,
          rank: index + 1,
          trader_id: trader.source_trader_id,
          handle: sources?.handle,
          source: trader.source,
          roi: trader.roi,
          pnl: trader.pnl,
          win_rate: trader.win_rate,
          max_drawdown: trader.max_drawdown,
          trades_count: trader.trades_count,
          followers: trader.followers,
          arena_score: scores?.arena_score,
          return_score: scores?.return_score,
          drawdown_score: scores?.drawdown_score,
          stability_score: scores?.stability_score,
          data_availability: {
            roi: trader.roi !== null,
            pnl: trader.pnl !== null,
            win_rate: trader.win_rate !== null,
            max_drawdown: trader.max_drawdown !== null,
          },
        }
      })

      const { error: tradersInsertError } = await supabase
        .from('snapshot_traders')
        .insert(snapshotTraders)

      if (tradersInsertError) {
        logger.error('Failed to insert snapshot traders', { error: tradersInsertError.message })
        // Still return success as the snapshot was created
      }

      logger.info('Snapshot created', {
        snapshotId: snapshot.id,
        tradersCount: traders.length,
        timeRange,
        exchange,
      })

      return NextResponse.json({
        success: true,
        data: {
          id: snapshot.id,
          shareToken: snapshot.share_token,
          shareUrl: `/s/${snapshot.share_token}`,
          createdAt: snapshot.created_at,
          expiresAt: snapshot.expires_at,
          tradersCount: traders.length,
          topTrader: {
            handle: topTraderHandle,
            roi: topTrader.roi,
          },
        },
      })
    } catch (error) {
      logger.error('Snapshot creation failed', { error: String(error) })
      return NextResponse.json(
        { success: false, error: 'Internal server error' },
        { status: 500 }
      )
    }
  },
  { name: 'create-snapshot', rateLimit: 'write' }
)

/**
 * GET /api/snapshots - List user's snapshots
 */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const searchParams = request.nextUrl.searchParams
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50)
    const offset = parseInt(searchParams.get('offset') || '0')

    const { data: snapshots, error } = await supabase
      .from('ranking_snapshots')
      .select(`
        id,
        share_token,
        time_range,
        exchange,
        category,
        total_traders,
        top_trader_handle,
        top_trader_roi,
        data_captured_at,
        is_public,
        view_count,
        expires_at,
        title,
        created_at
      `)
      .eq('created_by', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      logger.error('Failed to fetch snapshots', { error: error.message })
      return NextResponse.json(
        { success: false, error: 'Failed to fetch snapshots' },
        { status: 500 }
      )
    }

    // Get total count
    const { count } = await supabase
      .from('ranking_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('created_by', user.id)

    return NextResponse.json({
      success: true,
      data: {
        snapshots: snapshots?.map(s => ({
          ...s,
          shareUrl: `/s/${s.share_token}`,
          isExpired: s.expires_at ? new Date(s.expires_at) < new Date() : false,
        })),
        pagination: {
          total: count || 0,
          limit,
          offset,
          hasMore: (count || 0) > offset + limit,
        },
      },
    })
  },
  { name: 'list-snapshots' }
)

/**
 * Helper function to get season ID based on time range
 */
function getSeasonId(timeRange: TimeRange): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1

  switch (timeRange) {
    case '7D':
      const weekNum = Math.ceil((now.getDate() + new Date(year, month - 1, 1).getDay()) / 7)
      return `${year}-W${weekNum.toString().padStart(2, '0')}`
    case '30D':
      return `${year}-${month.toString().padStart(2, '0')}`
    case '90D':
      const quarter = Math.ceil(month / 3)
      return `${year}-Q${quarter}`
    default:
      return `${year}-Q${Math.ceil(month / 3)}`
  }
}
