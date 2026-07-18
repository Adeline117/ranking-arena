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
import { loadBroadcastEventPreferences, loadBroadcastEventRows } from './event-data'
import { traderEventLink, traderEventReference } from './notification-identity'

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

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yStr = yesterday.toISOString().split('T')[0]

    // Read every input page before producing any event. The filtered datasets
    // also chunk trader ids so a large follow graph cannot overflow the
    // PostgREST URL. Any page failure rejects the complete input set.
    const {
      follows,
      currentRanks: lr,
      rankHistory: rh,
      dailySnapshots: ds,
    } = await loadBroadcastEventRows({
      follows: (from, to) =>
        supabase
          .from('trader_follows')
          .select('user_id, trader_id, source')
          .order('id', { ascending: true })
          .range(from, to),
      currentRanks: (traderIds, from, to) =>
        supabase
          .from('leaderboard_ranks')
          .select('source_trader_id, source, rank, roi, pnl')
          .in('source_trader_id', traderIds)
          .eq('season_id', '90D')
          .order('id', { ascending: true })
          .range(from, to),
      rankHistory: (traderIds, from, to) =>
        supabase
          .from('rank_history')
          .select('trader_key, platform, rank')
          .in('trader_key', traderIds)
          .eq('period', '90D')
          .eq('snapshot_date', yStr)
          .order('id', { ascending: true })
          .range(from, to),
      dailySnapshots: (traderIds, from, to) =>
        supabase
          .from('trader_daily_snapshots')
          .select('trader_key, platform, roi, pnl')
          .in('trader_key', traderIds)
          .eq('date', yStr)
          .order('id', { ascending: true })
          .range(from, to),
    })

    if (follows.length === 0) {
      await plog.success(0, { message: 'no trader follows' })
      return NextResponse.json({ status: 'ok', events: 0 })
    }

    // Key separator is '|' — trader ids and source slugs can both contain '_'
    // (e.g. bybit_copytrade), so '_' would be ambiguous to split back.
    const followersByTrader = new Map<string, string[]>() // `${trader_id}|${source}` → userIds
    for (const f of follows) {
      const key = `${f.trader_id}|${f.source ?? ''}`
      const arr = followersByTrader.get(key)
      if (arr) arr.push(f.user_id)
      else followersByTrader.set(key, [f.user_id])
    }

    // 2. Current metrics (90D serving).
    const curMap = new Map<
      string,
      { rank: number | null; roi: number | null; pnl: number | null }
    >()
    const sourcesByTrader = new Map<string, Set<string>>()
    for (const r of lr ?? []) {
      curMap.set(`${r.source_trader_id}|${r.source ?? ''}`, {
        rank: r.rank ?? null,
        roi: r.roi ?? null,
        pnl: r.pnl ?? null,
      })
      const sources = sourcesByTrader.get(r.source_trader_id)
      if (sources) sources.add(r.source)
      else sourcesByTrader.set(r.source_trader_id, new Set([r.source]))
    }

    // Older follows have no source because the UI did not pass it to /api/follow.
    // Resolve them only if the current board has exactly one account for that id.
    // Never guess between exchanges: missing a notification is safer than using
    // another trader account's performance to generate one.
    for (const [key, userIds] of [...followersByTrader]) {
      const [traderId, source] = key.split('|')
      if (source) continue
      const candidates = sourcesByTrader.get(traderId)
      if (!candidates || candidates.size !== 1) continue
      const resolvedKey = `${traderId}|${[...candidates][0]}`
      const existing = followersByTrader.get(resolvedKey)
      if (existing) existing.push(...userIds)
      else followersByTrader.set(resolvedKey, userIds)
      followersByTrader.delete(key)
    }

    // 3. Yesterday: rank from rank_history, roi/pnl from daily snapshots.
    const prevRank = new Map<string, number>()
    for (const r of rh ?? []) {
      if (r.rank != null) prevRank.set(`${r.trader_key}|${r.platform ?? ''}`, r.rank)
    }

    const prevMetric = new Map<string, { roi: number | null; pnl: number | null }>()
    for (const s of ds ?? []) {
      prevMetric.set(`${s.trader_key}|${s.platform ?? ''}`, {
        roi: s.roi ?? null,
        pnl: s.pnl ?? null,
      })
    }

    // 4. Detect one notable event per followed trader (priority rank > roi > pnl).
    const events = new Map<string, TraderEvent>() // key → event
    for (const key of followersByTrader.keys()) {
      const [traderId] = key.split('|')
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

    // 4b. New-position events. Pull each followed trader's CURRENT positions via
    // the existing serving RPC (resolves source name + exchange trader id server-
    // side) and diff against trader_position_seen (insert-once). A trader with no
    // seen rows yet is SEEDED silently — no first-run alert spam.
    const positionEvents = new Map<string, TraderEvent>()
    const POSITION_TRADER_CAP = 200 // bound RPC fan-out per run
    const followedKeys = [...followersByTrader.keys()].slice(0, POSITION_TRADER_CAP)
    for (const key of followedKeys) {
      const sep = key.indexOf('|')
      const traderId = key.slice(0, sep)
      const source = key.slice(sep + 1)
      if (!source) continue
      try {
        const { data: page, error: pageErr } = await supabase.rpc('arena_records_page', {
          p_source: source,
          p_trader: traderId,
          p_kind: 'positions',
          p_tf: undefined,
          p_cursor: undefined,
          p_limit: 50,
        })
        if (pageErr) {
          logger.warn(
            `[broadcast-trader-events] positions fetch failed for ${key}:`,
            pageErr.message
          )
          continue
        }
        const rows = Array.isArray((page as Record<string, unknown> | null)?.rows)
          ? ((page as Record<string, unknown>).rows as Array<Record<string, unknown>>)
          : []
        if (rows.length === 0) continue

        const current = rows
          .map((r) => ({
            symbol: typeof r.symbol === 'string' ? r.symbol : '',
            side: typeof r.side === 'string' ? r.side : '',
          }))
          .filter((p) => p.symbol)
        if (current.length === 0) continue

        const { data: seen, error: seenErr } = await supabase
          .from('trader_position_seen')
          .select('symbol, side')
          .eq('trader_id', traderId)
          .eq('source', source)
        if (seenErr) {
          logger.error(
            '[broadcast-trader-events] seen read failed (skipping trader):',
            seenErr.message
          )
          continue
        }
        const seenKeys = new Set((seen ?? []).map((s) => `${s.symbol}|${s.side}`))
        const isSeed = seenKeys.size === 0
        const fresh = current.filter((p) => !seenKeys.has(`${p.symbol}|${p.side}`))
        if (fresh.length === 0) continue

        const { error: upErr } = await supabase.from('trader_position_seen').upsert(
          fresh.map((p) => ({ trader_id: traderId, source, symbol: p.symbol, side: p.side })),
          { onConflict: 'trader_id,source,symbol,side', ignoreDuplicates: true }
        )
        if (upErr) {
          // Do NOT emit an event if we couldn't persist the seen-state — otherwise
          // the same "new" position would re-alert every run.
          logger.error('[broadcast-trader-events] seen upsert failed (no event):', upErr.message)
          continue
        }
        if (isSeed) continue // first sighting of this trader: seed silently

        const names = fresh.slice(0, 3).map((p) => `${p.symbol}${p.side ? ` ${p.side}` : ''}`)
        positionEvents.set(key, {
          title: 'New position from a trader you follow',
          message:
            fresh.length === 1
              ? `${traderId} opened ${names[0]}`
              : `${traderId} opened ${fresh.length} new positions (${names.join(', ')}${fresh.length > 3 ? ', …' : ''})`,
        })
      } catch (err) {
        logger.warn(`[broadcast-trader-events] position check failed for ${key}`, { error: err })
      }
    }
    // Merge: a trader can emit at most one metric event AND one position event.
    for (const [key, ev] of positionEvents) {
      if (!events.has(key)) events.set(key, ev)
      else events.set(`${key}#pos`, ev) // second slot; fan-out resolves followers via base key
    }

    if (events.size === 0) {
      await plog.success(0, { message: 'no notable events' })
      return NextResponse.json({ status: 'ok', events: 0 })
    }

    // 5. Filter audience by opt-out (notify_trader_events).
    // Event keys may carry a '#pos' second-slot suffix — strip it to resolve followers.
    const baseKey = (k: string) => (k.endsWith('#pos') ? k.slice(0, -4) : k)
    const candidateUserIds = new Set<string>()
    for (const key of events.keys())
      for (const uid of followersByTrader.get(baseKey(key)) ?? []) candidateUserIds.add(uid)
    const optedOut = new Set<string>()
    const prefs = await loadBroadcastEventPreferences([...candidateUserIds], (userIds, from, to) =>
      supabase
        .from('user_profiles')
        .select('id, notify_trader_events')
        .in('id', userIds)
        .order('id', { ascending: true })
        .range(from, to)
    )
    for (const p of prefs) {
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
      const bk = baseKey(key)
      const sep = bk.indexOf('|')
      const traderId = bk.slice(0, sep)
      const source = bk.slice(sep + 1)
      const kind = key.endsWith('#pos') ? 'position' : 'metric'
      const link = traderEventLink(traderId, source)
      for (const uid of followersByTrader.get(bk) ?? []) {
        if (optedOut.has(uid)) continue
        rows.push({
          user_id: uid,
          type: 'ranking_change',
          title: ev.title,
          message: ev.message,
          link,
          reference_id: traderEventReference(traderId, source, kind),
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
