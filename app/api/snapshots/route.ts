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
import { query } from '@/lib/db'

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
  async ({ user, supabase, request }) => {
    try {
      // Parse request body
      const body: CreateSnapshotBody = await request.json().catch(() => ({} as CreateSnapshotBody))

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

      // Get current ranking data from trader_snapshots_v2
      const window = timeRangeToWindow(timeRange)
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

      const conditions: string[] = [`s."window" = $1`, `s.as_of_ts >= $2`]
      const params: unknown[] = [window, cutoff]
      let paramIdx = 3

      if (exchange) {
        conditions.push(`s.platform = $${paramIdx}`)
        params.push(exchange)
        paramIdx++
      }

      const whereClause = conditions.join(' AND ')

      let tradersResult: { rows: SnapshotRow[] }
      try {
        tradersResult = await query<SnapshotRow>(
          `SELECT s.platform, s.trader_key, s.roi_pct, s.pnl_usd,
                  s.win_rate_pct, s.max_drawdown_pct, s.trades_count,
                  s.copier_count, s.arena_score, s.metrics,
                  src.display_name
           FROM trader_snapshots_v2 s
           LEFT JOIN trader_sources_v2 src ON src.platform = s.platform AND src.trader_key = s.trader_key
           WHERE ${whereClause}
           ORDER BY s.roi_pct DESC NULLS LAST
           LIMIT $${paramIdx}`,
          [...params, MAX_SNAPSHOT_TRADERS],
        )
      } catch (dbError) {
        // Fallback: use Supabase client when direct DB connection fails
        logger.warn('Direct DB query failed, falling back to Supabase client', { error: String(dbError) })

        try {
          let supabaseQuery = supabase
            .from('trader_snapshots_v2')
            .select('platform, trader_key, roi_pct, pnl_usd, win_rate_pct, max_drawdown_pct, trades_count, copier_count, arena_score, metrics')
            .eq('window', window)
            .gte('as_of_ts', cutoff)
            .order('roi_pct', { ascending: false, nullsFirst: false })
            .limit(MAX_SNAPSHOT_TRADERS)

          if (exchange) {
            supabaseQuery = supabaseQuery.eq('platform', exchange)
          }

          const { data: fallbackData, error: fallbackError } = await supabaseQuery

          if (fallbackError) {
            throw fallbackError
          }

          // Fetch display names separately
          const traderKeys = (fallbackData || []).map(t => `${t.platform}:${t.trader_key}`)
          const displayNameMap = new Map<string, string>()

          if (traderKeys.length > 0) {
            const platforms = [...new Set((fallbackData || []).map(t => t.platform))]
            const keys = [...new Set((fallbackData || []).map(t => t.trader_key))]

            const { data: sourcesData } = await supabase
              .from('trader_sources_v2')
              .select('platform, trader_key, display_name')
              .in('platform', platforms)
              .in('trader_key', keys)

            if (sourcesData) {
              for (const src of sourcesData) {
                displayNameMap.set(`${src.platform}:${src.trader_key}`, src.display_name || '')
              }
            }
          }

          tradersResult = {
            rows: (fallbackData || []).map(row => ({
              ...row,
              display_name: displayNameMap.get(`${row.platform}:${row.trader_key}`) || null,
            })) as SnapshotRow[],
          }
        } catch (fallbackError) {
          logger.error('Supabase fallback also failed', { error: String(fallbackError) })
          return NextResponse.json(
            { success: false, error: 'Failed to fetch ranking data' },
            { status: 500 }
          )
        }
      }

      // Deduplicate by platform:trader_key
      const seen = new Set<string>()
      const traders = tradersResult.rows.filter((row) => {
        const key = `${row.platform}:${row.trader_key}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // If v2 table is empty, fallback to v1 trader_snapshots table
      if (traders.length === 0) {
        logger.warn('No v2 data found, trying v1 trader_snapshots fallback')

        const seasonId = window.toUpperCase() // v1 uses '7D'/'30D'/'90D'
        let v1Query = supabase
          .from('trader_snapshots')
          .select('source_trader_id, source, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score')
          .eq('season_id', seasonId)
          .order('arena_score', { ascending: false, nullsFirst: false })
          .limit(MAX_SNAPSHOT_TRADERS)

        if (exchange) {
          v1Query = v1Query.eq('source', exchange)
        }

        const { data: v1Data } = await v1Query

        if (v1Data && v1Data.length > 0) {
          // Fetch handles from trader_sources (v1)
          const v1TraderIds = v1Data.map(t => t.source_trader_id)
          const { data: v1Sources } = await supabase
            .from('trader_sources')
            .select('source_trader_id, handle')
            .in('source_trader_id', v1TraderIds)

          const v1HandleMap = new Map<string, string>()
          v1Sources?.forEach(s => {
            v1HandleMap.set(s.source_trader_id, s.handle || '')
          })

          // Deduplicate
          const v1Seen = new Set<string>()
          for (const row of v1Data) {
            const key = `${row.source}:${row.source_trader_id}`
            if (v1Seen.has(key)) continue
            v1Seen.add(key)
            traders.push({
              platform: row.source,
              trader_key: row.source_trader_id,
              roi_pct: row.roi,
              pnl_usd: row.pnl,
              win_rate_pct: row.win_rate != null ? (row.win_rate <= 1 ? row.win_rate * 100 : row.win_rate) : null,
              max_drawdown_pct: row.max_drawdown,
              trades_count: row.trades_count,
              copier_count: row.followers,
              arena_score: row.arena_score,
              metrics: null,
              display_name: v1HandleMap.get(row.source_trader_id) || null,
            } as SnapshotRow)
          }
        }
      }

      if (traders.length === 0) {
        return NextResponse.json(
          { success: false, error: 'No trader data available for snapshot' },
          { status: 400 }
        )
      }

      // Find top trader
      const topTrader = traders[0]
      const topTraderHandle = topTrader.display_name || topTrader.trader_key

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
          top_trader_roi: topTrader.roi_pct,
          data_captured_at: new Date().toISOString(),
          data_delay_minutes: 15,
          is_public: isPublic,
          expires_at: isPro ? null : expiresAt.toISOString(),
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
        const metrics = trader.metrics as Record<string, unknown> | null
        return {
          snapshot_id: snapshot.id,
          rank: index + 1,
          trader_id: trader.trader_key,
          handle: trader.display_name || trader.trader_key,
          source: trader.platform,
          roi: trader.roi_pct,
          pnl: trader.pnl_usd,
          win_rate: trader.win_rate_pct,
          max_drawdown: trader.max_drawdown_pct,
          trades_count: trader.trades_count,
          followers: trader.copier_count,
          arena_score: trader.arena_score,
          return_score: metrics?.return_score ?? null,
          drawdown_score: metrics?.drawdown_score ?? null,
          stability_score: metrics?.stability_score ?? null,
          data_availability: {
            roi: trader.roi_pct !== null,
            pnl: trader.pnl_usd !== null,
            win_rate: trader.win_rate_pct !== null,
            max_drawdown: trader.max_drawdown_pct !== null,
          },
        }
      })

      const { error: tradersInsertError } = await supabase
        .from('snapshot_traders')
        .insert(snapshotTraders)

      if (tradersInsertError) {
        logger.error('Failed to insert snapshot traders', { error: tradersInsertError.message })
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
            roi: topTrader.roi_pct,
          },
        },
      })
    } catch (error: unknown) {
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
      .select('id', { count: 'exact', head: true })
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

/** Row shape returned by the trader_snapshots_v2 query */
type SnapshotRow = Record<string, unknown> & {
  platform: string
  trader_key: string
  roi_pct: number | null
  pnl_usd: number | null
  win_rate_pct: number | null
  max_drawdown_pct: number | null
  trades_count: number | null
  copier_count: number | null
  arena_score: number | null
  metrics: Record<string, unknown> | null
  display_name: string | null
}

/**
 * Map TimeRange (7D/30D/90D) to v2 window format (7d/30d/90d)
 */
function timeRangeToWindow(timeRange: TimeRange): string {
  switch (timeRange) {
    case '7D': return '7d'
    case '30D': return '30d'
    case '90D': return '90d'
    default: return '90d'
  }
}
