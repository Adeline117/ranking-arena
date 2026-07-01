/**
 * GET /api/cron/broadcast-trader-events
 *
 * Proactive alerts (Option B): when a trader that users FOLLOW makes a notable
 * day-over-day move (rank / ROI / PnL past the thresholds in
 * lib/constants/trader-events), notify ALL their followers — not just users who
 * hand-configured a per-trader alert. Following a trader is the opt-in; users
 * can opt out via user_profiles.notify_trader_events.
 *
 * Reuses existing infra: trader_follows (audience), leaderboard_ranks (current),
 * rank_history + trader_daily_snapshots (yesterday), notifications table + push.
 *
 * Schedule: daily (add to vercel.json). Sends GET with CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import { getPushNotificationService } from '@/lib/services/push-notification'
import {
  EVENT_RANK_MOVE,
  EVENT_ROI_MOVE_PCT,
  EVENT_PNL_MOVE_USD,
} from '@/lib/constants/trader-events'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

interface TraderEvent {
  title: string
  message: string
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const releaseLock = await acquireCronLock('broadcast-trader-events', { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const plog = await PipelineLogger.start('broadcast-trader-events')
  try {
    const supabase = getSupabaseAdmin()

    // 1. Audience: who follows which trader.
    const { data: follows, error: fErr } = await supabase
      .from('trader_follows')
      .select('user_id, trader_id, source')
    if (fErr) throw fErr
    if (!follows?.length) {
      await plog.success(0, { message: 'no trader follows' })
      return NextResponse.json({ status: 'ok', events: 0 })
    }

    const followersByTrader = new Map<string, string[]>() // `${trader_id}_${source}` → userIds
    const traderIdSet = new Set<string>()
    for (const f of follows) {
      const key = `${f.trader_id}_${f.source ?? ''}`
      const arr = followersByTrader.get(key)
      if (arr) arr.push(f.user_id)
      else followersByTrader.set(key, [f.user_id])
      traderIdSet.add(f.trader_id)
    }
    const traderIds = [...traderIdSet]

    // 2. Current metrics (90D serving).
    const { data: lr, error: lrErr } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, source, rank, roi, pnl')
      .in('source_trader_id', traderIds)
      .eq('season_id', '90D')
    if (lrErr) throw lrErr
    const curMap = new Map<
      string,
      { rank: number | null; roi: number | null; pnl: number | null }
    >()
    for (const r of lr ?? []) {
      curMap.set(`${r.source_trader_id}_${r.source ?? ''}`, {
        rank: r.rank ?? null,
        roi: r.roi ?? null,
        pnl: r.pnl ?? null,
      })
    }

    // 3. Yesterday: rank from rank_history, roi/pnl from daily snapshots.
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yStr = yesterday.toISOString().split('T')[0]

    const prevRank = new Map<string, number>()
    const { data: rh } = await supabase
      .from('rank_history')
      .select('trader_key, platform, rank')
      .in('trader_key', traderIds)
      .eq('period', '90D')
      .eq('snapshot_date', yStr)
    for (const r of rh ?? []) {
      if (r.rank != null) prevRank.set(`${r.trader_key}_${r.platform ?? ''}`, r.rank)
    }

    const prevMetric = new Map<string, { roi: number | null; pnl: number | null }>()
    const { data: ds } = await supabase
      .from('trader_daily_snapshots')
      .select('trader_key, platform, roi, pnl')
      .in('trader_key', traderIds)
      .eq('date', yStr)
    for (const s of ds ?? []) {
      prevMetric.set(`${s.trader_key}_${s.platform ?? ''}`, {
        roi: s.roi ?? null,
        pnl: s.pnl ?? null,
      })
    }

    // 4. Detect one notable event per followed trader (priority rank > roi > pnl).
    const events = new Map<string, TraderEvent>() // key → event
    for (const key of followersByTrader.keys()) {
      const [traderId] = key.split('_')
      const cur = curMap.get(key)
      if (!cur) continue
      const pRank = prevRank.get(key)
      const pMet = prevMetric.get(key)

      let ev: TraderEvent | null = null
      if (cur.rank != null && pRank != null && Math.abs(cur.rank - pRank) >= EVENT_RANK_MOVE) {
        const up = cur.rank < pRank
        ev = {
          title: up ? 'A trader you follow is climbing' : 'A trader you follow dropped',
          message: `${traderId} moved ${up ? 'up' : 'down'} ${Math.abs(cur.rank - pRank)} ranks (#${pRank} → #${cur.rank})`,
        }
      } else if (
        cur.roi != null &&
        pMet?.roi != null &&
        Math.abs(cur.roi - pMet.roi) >= EVENT_ROI_MOVE_PCT
      ) {
        const up = cur.roi > pMet.roi
        ev = {
          title: 'Big ROI move from a trader you follow',
          message: `${traderId} ROI ${up ? 'up' : 'down'} ${Math.abs(cur.roi - pMet.roi).toFixed(1)}% (${pMet.roi.toFixed(1)}% → ${cur.roi.toFixed(1)}%)`,
        }
      } else if (
        cur.pnl != null &&
        pMet?.pnl != null &&
        Math.abs(cur.pnl - pMet.pnl) >= EVENT_PNL_MOVE_USD
      ) {
        const up = cur.pnl > pMet.pnl
        const d = Math.abs(cur.pnl - pMet.pnl)
        ev = {
          title: 'Big PnL move from a trader you follow',
          message: `${traderId} PnL ${up ? 'up' : 'down'} $${d.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        }
      }
      if (ev) events.set(key, ev)
    }

    if (events.size === 0) {
      await plog.success(0, { message: 'no notable events' })
      return NextResponse.json({ status: 'ok', events: 0 })
    }

    // 5. Filter audience by opt-out (notify_trader_events).
    const candidateUserIds = new Set<string>()
    for (const key of events.keys())
      for (const uid of followersByTrader.get(key) ?? []) candidateUserIds.add(uid)
    const optedOut = new Set<string>()
    const { data: prefs } = await supabase
      .from('user_profiles')
      .select('id, notify_trader_events')
      .in('id', [...candidateUserIds])
    for (const p of prefs ?? []) {
      if (p.notify_trader_events === false) optedOut.add(p.id)
    }

    // 6. Build notification rows (one per follower per triggered trader).
    const rows: Array<{
      user_id: string
      type: string
      title: string
      message: string
      link: string
      reference_id: string
    }> = []
    for (const [key, ev] of events) {
      const [traderId, source] = key.split('_')
      const link = `/trader/${encodeURIComponent(traderId)}${source ? `?platform=${source}` : ''}`
      for (const uid of followersByTrader.get(key) ?? []) {
        if (optedOut.has(uid)) continue
        rows.push({
          user_id: uid,
          type: 'ranking_change',
          title: ev.title,
          message: ev.message,
          link,
          reference_id: traderId,
        })
      }
    }

    if (rows.length === 0) {
      await plog.success(0, { events: events.size, message: 'all recipients opted out' })
      return NextResponse.json({ status: 'ok', events: events.size, notified: 0 })
    }

    const { error: insErr } = await supabase.from('notifications').insert(rows)
    if (insErr) {
      logger.error('[broadcast-trader-events] notifications insert failed:', insErr.message)
      throw insErr
    }

    // Push (best-effort, batched).
    try {
      const push = getPushNotificationService()
      const BATCH = 10
      for (let i = 0; i < rows.length; i += BATCH) {
        await Promise.allSettled(
          rows.slice(i, i + BATCH).map((r) =>
            push.sendToUser(r.user_id, {
              title: r.title,
              body: r.message,
              data: { url: r.link, type: 'ranking_change' },
            })
          )
        )
      }
    } catch (pushErr) {
      logger.warn('[broadcast-trader-events] push failed', { error: pushErr })
    }

    logger.info(
      `[broadcast-trader-events] events=${events.size} notified=${rows.length} optedOut=${optedOut.size}`
    )
    await plog.success(rows.length, { events: events.size })
    return NextResponse.json({ status: 'ok', events: events.size, notified: rows.length })
  } catch (err) {
    logger.error('[broadcast-trader-events] failed', err)
    await plog.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  } finally {
    releaseLock()
  }
}
