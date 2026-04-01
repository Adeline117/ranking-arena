/**
 * Cron: Generate trader activity feed events
 * Schedule: Every 6 hours (after compute-leaderboard)
 *
 * Scans leaderboard_ranks for notable events and writes to trader_activities.
 * Dedup key prevents duplicate entries for the same event on the same day.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('cron:generate-activities')

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const EXCHANGE_NAMES: Record<string, string> = {
  binance_futures: 'Binance', hyperliquid: 'Hyperliquid', okx_futures: 'OKX',
  bitget_futures: 'Bitget', gmx: 'GMX', bybit: 'Bybit', dydx: 'dYdX',
  aevo: 'Aevo', drift: 'Drift', gains: 'Gains', mexc: 'MEXC',
  htx_futures: 'HTX', gateio: 'Gate.io', coinex: 'CoinEx',
}

function exchangeName(source: string): string {
  return EXCHANGE_NAMES[source] || source
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const plog = await PipelineLogger.start('generate-activities')
  const today = new Date().toISOString().split('T')[0]
  const now = new Date().toISOString()

  try {
    const activities: Array<{
      source: string; source_trader_id: string; handle: string | null
      avatar_url: string | null; activity_type: string; activity_text: string
      metric_value: number | null; metric_label: string | null
      dedup_key: string; occurred_at: string
    }> = []

    // Fetch top traders
    const { data: leaders } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, handle, avatar_url, rank, arena_score, roi, pnl')
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(200)

    if (!leaders?.length) {
      await plog.success(0, { reason: 'no leaderboard data' })
      return NextResponse.json({ ok: true, generated: 0 })
    }

    for (const t of leaders) {
      const name = t.handle || t.source_trader_id
      const ex = exchangeName(t.source)

      // Top 10 per platform
      if (t.rank != null && t.rank <= 10) {
        activities.push({
          source: t.source, source_trader_id: t.source_trader_id,
          handle: t.handle, avatar_url: t.avatar_url,
          activity_type: 'entered_top10',
          activity_text: `${name} ranked #${t.rank} on ${ex} with ${Number(t.roi).toFixed(1)}% ROI`,
          metric_value: t.arena_score, metric_label: 'Arena Score',
          dedup_key: `${t.source}:${t.source_trader_id}:top10:${today}`,
          occurred_at: now,
        })
      }

      // High ROI (>500%)
      if (Number(t.roi) > 500 && Number(t.arena_score) > 70) {
        activities.push({
          source: t.source, source_trader_id: t.source_trader_id,
          handle: t.handle, avatar_url: t.avatar_url,
          activity_type: 'roi_milestone',
          activity_text: `${name} achieved ${Math.round(Number(t.roi))}% ROI on ${ex}`,
          metric_value: Number(t.roi), metric_label: 'ROI %',
          dedup_key: `${t.source}:${t.source_trader_id}:roi500:${today}`,
          occurred_at: now,
        })
      }

      // Large profit (>$10K)
      if (Number(t.pnl) > 10000) {
        activities.push({
          source: t.source, source_trader_id: t.source_trader_id,
          handle: t.handle, avatar_url: t.avatar_url,
          activity_type: 'large_profit',
          activity_text: `${name} earned $${Math.round(Number(t.pnl)).toLocaleString()} profit`,
          metric_value: Number(t.pnl), metric_label: 'PnL USD',
          dedup_key: `${t.source}:${t.source_trader_id}:pnl10k:${today}`,
          occurred_at: now,
        })
      }
    }

    // Batch upsert (dedup key prevents duplicates)
    if (activities.length > 0) {
      const { error } = await supabase
        .from('trader_activities')
        .upsert(activities, { onConflict: 'dedup_key', ignoreDuplicates: true })

      if (error) {
        log.error('Failed to upsert activities', { error: error.message })
        await plog.error(error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    // Cleanup: remove activities older than 30 days
    await supabase
      .from('trader_activities')
      .delete()
      .lt('occurred_at', new Date(Date.now() - 30 * 86400000).toISOString())

    log.info(`Generated ${activities.length} activities`)
    await plog.success(activities.length)
    return NextResponse.json({ ok: true, generated: activities.length })
  } catch (err) {
    log.error('Unexpected error', { error: err instanceof Error ? err.message : String(err) })
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
