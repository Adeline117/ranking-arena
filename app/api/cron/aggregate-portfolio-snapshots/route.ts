/**
 * GET /api/cron/aggregate-portfolio-snapshots
 *
 * Rolls up each user's current connected-exchange positions (`user_positions`)
 * into one equity snapshot per portfolio in `user_portfolio_snapshots`, building
 * the historical net-worth time-series consumed by the /portfolio equity curve.
 *
 * This is the safe half of the portfolio pipeline: it only aggregates positions
 * that already exist in the DB — it never touches encrypted exchange API keys and
 * makes no outbound exchange calls. Positions themselves are populated by the
 * exchange-sync path (`/api/portfolio/sync`); until a portfolio has positions,
 * this cron writes nothing for it.
 *
 * Schedule: Daily (add to vercel.json crons). Sends GET with CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface PositionRow {
  portfolio_id: string
  size: number | string | null
  mark_price: number | string | null
  pnl: number | string | null
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('aggregate-portfolio-snapshots', { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const plog = await PipelineLogger.start('aggregate-portfolio-snapshots')
  try {
    const supabase = getSupabaseAdmin()
    const snapshotAt = new Date().toISOString()

    // Pull every position; aggregate per portfolio. Volume is small (positions are
    // per connected exchange, not market-wide), so a single scan is fine.
    const { data: positions, error } = await supabase
      .from('user_positions')
      .select('portfolio_id, size, mark_price, pnl')

    if (error) throw error

    if (!positions?.length) {
      await plog.success(0)
      return NextResponse.json({ status: 'ok', snapshots: 0, reason: 'no positions' })
    }

    const totals = new Map<string, { equity: number; pnl: number }>()
    for (const p of positions as PositionRow[]) {
      if (!p.portfolio_id) continue
      const equity = (Number(p.size) || 0) * (Number(p.mark_price) || 0)
      const pnl = Number(p.pnl) || 0
      const t = totals.get(p.portfolio_id)
      if (t) {
        t.equity += equity
        t.pnl += pnl
      } else {
        totals.set(p.portfolio_id, { equity, pnl })
      }
    }

    const rows = Array.from(totals.entries()).map(([portfolio_id, t]) => ({
      portfolio_id,
      total_equity: t.equity,
      total_pnl: t.pnl,
      total_pnl_pct: t.equity > 0 ? (t.pnl / t.equity) * 100 : 0,
      snapshot_at: snapshotAt,
    }))

    const { error: insertError } = await supabase.from('user_portfolio_snapshots').insert(rows)
    if (insertError) throw insertError

    logger.info(`[aggregate-portfolio-snapshots] wrote ${rows.length} snapshots`)
    await plog.success(rows.length)
    return NextResponse.json({ status: 'ok', snapshots: rows.length })
  } catch (err) {
    logger.error('[aggregate-portfolio-snapshots] failed', err)
    await plog.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  } finally {
    releaseLock()
  }
}
