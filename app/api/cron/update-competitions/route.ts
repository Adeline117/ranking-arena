/**
 * Cron: Update competition standings
 * Schedule: Every 30 minutes (12,42 * * * *)
 *
 * 1. Mark upcoming competitions as active when start_at has passed
 * 2. For active competitions: snapshot each entry's current value from leaderboard_ranks
 * 3. Recompute rankings per competition
 * 4. Mark completed competitions when end_at has passed
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createLogger } from '@/lib/utils/logger'
import { env } from '@/lib/env'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = createLogger('cron:update-competitions')

export async function GET(request: NextRequest) {
  // Auth check for cron
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log = await PipelineLogger.start('update-competitions')
  const now = new Date().toISOString()
  let processed = 0

  try {
    const supabase = getSupabaseAdmin() as SupabaseClient

    // 1. Activate upcoming competitions whose start_at has passed
    const { data: activated } = await supabase
      .from('competitions')
      .update({ status: 'active', updated_at: now })
      .eq('status', 'upcoming')
      .lte('start_at', now)
      .select('id')

    if (activated?.length) {
      logger.info(`Activated ${activated.length} competitions`)
    }

    // 2. Fetch all active competitions
    const { data: activeComps, error: fetchError } = await supabase
      .from('competitions')
      .select('id, metric')
      .eq('status', 'active')

    if (fetchError || !activeComps?.length) {
      await log.success(0, { activated: activated?.length || 0, active: 0 })
      return NextResponse.json({ success: true, activated: activated?.length || 0, updated: 0 })
    }

    // 3. For each active competition, update entries
    for (const comp of activeComps) {
      const { data: entries } = await supabase
        .from('competition_entries')
        .select('id, trader_id, platform')
        .eq('competition_id', comp.id)

      if (!entries?.length) continue

      // Batch fetch current values for ALL entries in one query (avoid N+1)
      const traderIds = entries.map(e => e.trader_id)
      const platforms = [...new Set(entries.map(e => e.platform))]

      const { data: allTraderData } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, roi, pnl, sharpe_ratio, max_drawdown')
        .in('source', platforms)
        .in('source_trader_id', traderIds)

      // Build lookup map: `${source}:${source_trader_id}` -> data
      const traderMap = new Map<string, { roi: number | null; pnl: number | null; sharpe_ratio: number | null; max_drawdown: number | null }>()
      for (const td of allTraderData || []) {
        traderMap.set(`${td.source}:${td.source_trader_id}`, td)
      }

      const updates: { id: string; current_value: number | null }[] = []
      for (const entry of entries) {
        const traderData = traderMap.get(`${entry.platform}:${entry.trader_id}`)
        if (traderData) {
          const metricMap: Record<string, number | null> = {
            roi: traderData.roi,
            pnl: traderData.pnl,
            sharpe: traderData.sharpe_ratio,
            max_drawdown: traderData.max_drawdown,
          }
          updates.push({ id: entry.id, current_value: metricMap[comp.metric] ?? null })
        }
      }

      // Batch update current values + ranks in parallel
      if (updates.length) {
        await Promise.all(
          updates.map(u =>
            supabase.from('competition_entries').update({ current_value: u.current_value }).eq('id', u.id)
          )
        )
      }

      // Recompute ranks: sort by (current_value - baseline_value) descending
      // For max_drawdown, lower is better so sort ascending
      const { data: allEntries } = await supabase
        .from('competition_entries')
        .select('id, baseline_value, current_value')
        .eq('competition_id', comp.id)

      if (allEntries?.length) {
        const isLowerBetter = comp.metric === 'max_drawdown'

        const sorted = allEntries
          .map((e) => ({
            id: e.id,
            delta: (e.current_value ?? 0) - (e.baseline_value ?? 0),
          }))
          .sort((a, b) => isLowerBetter ? a.delta - b.delta : b.delta - a.delta)

        // Batch update ranks in parallel
        await Promise.all(
          sorted.map((s, i) =>
            supabase.from('competition_entries').update({ rank: i + 1 }).eq('id', s.id)
          )
        )
      }

      processed++
    }

    // 4. Complete competitions whose end_at has passed
    const { data: completed } = await supabase
      .from('competitions')
      .update({ status: 'completed', updated_at: now })
      .eq('status', 'active')
      .lte('end_at', now)
      .select('id')

    if (completed?.length) {
      logger.info(`Completed ${completed.length} competitions`)
    }

    await log.success(processed, {
      activated: activated?.length || 0,
      updated: processed,
      completed: completed?.length || 0,
    })

    return NextResponse.json({
      success: true,
      activated: activated?.length || 0,
      updated: processed,
      completed: completed?.length || 0,
    })
  } catch (error) {
    logger.error('Failed to update competitions', { error: String(error) })
    await log.error(error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
