/**
 * POST /api/trader/sync
 *
 * Sync authorized trader data from exchange API
 * Called by cron job or triggered after authorization
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { decrypt } from '@/lib/crypto/encryption'
import { BybitAdapter } from '@/lib/adapters/bybit-adapter'
import { BinanceAdapter } from '@/lib/adapters/binance-adapter'
import { OkxAdapter } from '@/lib/adapters/okx-adapter'
import { BitgetAdapter } from '@/lib/adapters/bitget-adapter'
import { logger } from '@/lib/logger'
import { calculateArenaScore } from '@/lib/utils/arena-score'
import type { Period } from '@/lib/utils/arena-score'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TraderData } from '@/lib/adapters/types'

/** Truncate timestamp to hour boundary for partitioned upsert dedup */
function truncateToHour(): string {
  const d = new Date()
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

interface SyncRequest {
  authorizationId?: string // Sync specific authorization
  userId?: string // Sync all authorizations for user
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  // Verify cron secret or admin auth
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  try {
    const body: SyncRequest = await request.json()
    const { authorizationId, userId } = body

    interface TraderAuthorization {
      id: string
      user_id: string
      trader_id: string
      platform: string
      encrypted_api_key: string
      encrypted_api_secret: string
      encrypted_passphrase: string | null
      sync_frequency: string
      status: string
      last_verified_at: string | null
      verification_error: string | null
    }

    const selectCols = 'id, user_id, trader_id, platform, encrypted_api_key, encrypted_api_secret, encrypted_passphrase, sync_frequency, status, last_verified_at, verification_error'

    let authorizations: TraderAuthorization[] = []

    if (authorizationId) {
      // Sync specific authorization
      const { data, error } = await supabase
        .from('trader_authorizations')
        .select(selectCols)
        .eq('id', authorizationId)
        .eq('status', 'active')
        .single()

      if (error || !data) {
        return NextResponse.json(
          { error: 'Authorization not found' },
          { status: 404 }
        )
      }

      authorizations = [data]
    } else if (userId) {
      // Sync all authorizations for user
      const { data, error } = await supabase
        .from('trader_authorizations')
        .select(selectCols)
        .eq('user_id', userId)
        .eq('status', 'active')

      if (error) {
        logger.dbError('fetch-user-authorizations', error, { userId })
        return NextResponse.json(
          { error: 'Failed to fetch authorizations' },
          { status: 500 }
        )
      }

      authorizations = data || []
    } else {
      // Sync all active authorizations (called by cron)
      const { data, error } = await supabase
        .from('trader_authorizations')
        .select(selectCols)
        .eq('status', 'active')

      if (error) {
        logger.dbError('fetch-all-authorizations', error, {})
        return NextResponse.json(
          { error: 'Failed to fetch authorizations' },
          { status: 500 }
        )
      }

      authorizations = data || []
    }

    // Filter by sync_frequency — only sync auths that are due
    if (!authorizationId && !userId) {
      const now = Date.now()
      authorizations = authorizations.filter(auth => {
        if (!auth.last_verified_at) return true // Never synced → sync now
        const lastSync = new Date(auth.last_verified_at).getTime()
        const elapsed = now - lastSync
        const freq = auth.sync_frequency || '15min'
        const intervalMs: Record<string, number> = {
          realtime: 5 * 60 * 1000,   // 5 min (practical minimum for cron)
          '5min': 5 * 60 * 1000,
          '15min': 15 * 60 * 1000,
          '1hour': 60 * 60 * 1000,
        }
        return elapsed >= (intervalMs[freq] || intervalMs['15min'])
      })
    }


    let synced = 0
    let errors = 0

    for (const auth of authorizations) {
      try {
        // Decrypt credentials
        const apiKey = decrypt(auth.encrypted_api_key)
        const apiSecret = decrypt(auth.encrypted_api_secret)
        const passphrase = auth.encrypted_passphrase ? decrypt(auth.encrypted_passphrase) : undefined

        // Sync data based on platform
        const result = await syncPlatformData(auth.platform, {
          apiKey,
          apiSecret,
          passphrase,
          traderId: auth.trader_id,
        })

        if (result.success) {
          // Store synced data
          await storeSyncedData(supabase, auth, result.data!)

          // Log success
          await supabase.from('authorization_sync_logs').insert({
            authorization_id: auth.id,
            sync_status: 'success',
            records_synced: result.recordsCount || 1,
            synced_data: result.data,
          })

          // Update last verified
          await supabase
            .from('trader_authorizations')
            .update({
              last_verified_at: new Date().toISOString(),
              verification_error: null,
            })
            .eq('id', auth.id)

          synced++
        } else {
          throw new Error(result.error)
        }
      } catch (error) {
        logger.error(
          '[Sync] Failed to sync authorization',
          { authorizationId: auth.id, platform: auth.platform },
          error instanceof Error ? error : new Error(String(error))
        )

        // Log error
        await supabase.from('authorization_sync_logs').insert({
          authorization_id: auth.id,
          sync_status: 'failed',
          error_message: error instanceof Error ? error.message : String(error),
        })

        // Update verification error
        await supabase
          .from('trader_authorizations')
          .update({
            verification_error: error instanceof Error ? error.message : String(error),
          })
          .eq('id', auth.id)

        errors++
      }
    }

    return NextResponse.json({
      success: true,
      synced,
      errors,
      total: authorizations.length,
    })
  } catch (error) {
    logger.apiError('/api/trader/sync', error, {})
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * Sync data from specific platform
 */
async function syncPlatformData(
  platform: string,
  credentials: { apiKey: string; apiSecret: string; passphrase?: string; traderId: string }
): Promise<{ success: boolean; data?: TraderData; error?: string; recordsCount?: number }> {
  const platformLower = platform.toLowerCase()

  try {
    let trader: TraderData | null = null

    if (platformLower.includes('bybit')) {
      const adapter = new BybitAdapter({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      })
      trader = await adapter.fetchTraderDetail({
        platform: 'bybit',
        traderId: credentials.traderId,
      })
    } else if (platformLower.includes('binance')) {
      const adapter = new BinanceAdapter({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      })
      trader = await adapter.fetchTraderDetail({
        platform: 'binance_futures',
        traderId: credentials.traderId,
      })
    } else if (platformLower.startsWith('okx')) {
      const adapter = new OkxAdapter({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        passphrase: credentials.passphrase,
      })
      trader = await adapter.fetchTraderDetail({
        platform: 'okx',
        traderId: credentials.traderId,
      })
    } else if (platformLower.includes('bitget')) {
      const adapter = new BitgetAdapter({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        passphrase: credentials.passphrase,
      })
      trader = await adapter.fetchTraderDetail({
        platform: 'bitget',
        traderId: credentials.traderId,
      })
    } else {
      return {
        success: false,
        error: `Platform ${platform} not yet supported for sync`,
      }
    }

    if (!trader) {
      return { success: false, error: 'Trader not found' }
    }

    return {
      success: true,
      data: trader,
      recordsCount: 1,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Store synced data into trader_snapshots
 */
async function storeSyncedData(
  supabase: SupabaseClient,
  authorization: { id: string; platform: string; trader_id: string },
  traderData: TraderData
) {
  // Calculate arena score
  const period: Period = traderData.periodDays === 30 ? '30D' : '7D'
  const arenaScore = calculateArenaScore(
    {
      roi: traderData.roi,
      pnl: traderData.pnl,
      maxDrawdown: traderData.maxDrawdown,
      winRate: traderData.winRate,
    },
    period
  )

  // Insert/update snapshot
  const { error } = await supabase.from('trader_snapshots_v2').upsert(
    {
      platform: authorization.platform,
      trader_key: authorization.trader_id,
      window: period,
      roi_pct: traderData.roi,
      pnl_usd: traderData.pnl,
      followers: traderData.followers,
      copiers: traderData.followers,
      trades_count: traderData.tradesCount,
      win_rate: traderData.winRate,
      max_drawdown: traderData.maxDrawdown,
      arena_score: arenaScore.totalScore,
      as_of_ts: truncateToHour(),
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: 'platform,market_type,trader_key,window,as_of_ts',
    }
  )

  if (error) {
    throw error
  }

  // Update trader_sources
  await supabase.from('trader_sources').upsert(
    {
      source: authorization.platform,
      source_trader_id: authorization.trader_id,
      nickname: traderData.nickname,
      avatar_url: traderData.avatar,
      description: traderData.description,
      verified: traderData.verified,
      last_updated: new Date().toISOString(),
    },
    {
      onConflict: 'source,source_trader_id',
    }
  )
}
