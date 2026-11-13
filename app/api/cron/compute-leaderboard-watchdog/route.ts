/**
 * GET /api/cron/compute-leaderboard-watchdog — Vercel-side safety net for the
 * compute-leaderboard chain.
 *
 * WHY: leaderboard scoring is NOT a Vercel cron — it is driven by the separate
 * legacy `arena-worker` process (`worker/src/index.ts` + `worker/src/scheduler.ts`,
 * every 2h), not by the ingest worker. If that process dies, serving
 * leaderboards silently stop recomputing. This watchdog detects a season
 * stale beyond one full compute cycle, tries the HTTP fallback and alerts.
 *
 * HONESTY CONTRACT (2026-11 audit P1-1 / P2-6):
 *   - a failed freshness query is a FAILED run (alert + throw → withCron logs
 *     error), never a quiet `{checked:false}` success;
 *   - a fallback is `triggered` only when compute-leaderboard answered 2xx
 *     (or the request was still running at our timeout). A 410 tombstone /
 *     401 / 5xx / network error is `triggered:false`, and the alert says the
 *     fallback FAILED and a human must act — never "已兜底".
 *
 * Note: freshness here is `leaderboard_ranks.computed_at`, which cannot prove
 * sealed publication (docs/SLO.md §3). The public, publication-aware signal is
 * /api/health, probed externally by .github/workflows/public-freshness-probe.yml.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
// Each stale season is deliberately kicked in sequence with a 60s request
// budget. Three stale seasons therefore need up to 180s before alert/finalize;
// the old 90s function budget killed the watchdog midway and left its own
// pipeline log stuck even though the detached computes kept running.
export const maxDuration = 240

// Compute runs every 2h normally; health tolerates 4h. Intervene at 3h — one
// full cycle definitively missed, but before the health SLO trips.
const STALE_MS = 3 * 3600_000

const SEASONS = ['90D', '30D', '7D'] as const

export const GET = withCron(
  'compute-leaderboard-watchdog',
  async (_request: NextRequest, { supabase }) => {
    // Freshness MUST be checked per-season, not globally. Seasons compute
    // independently; a single global-newest `computed_at` is dominated by
    // whichever season last succeeded, so if only 90D silently stalls while 7D
    // keeps computing, the global-newest stays fresh and the watchdog never
    // fires — the exact silent-stale-flagship failure this net exists to catch.
    const sb = supabase
    const freshness = await Promise.all(
      SEASONS.map(async (season) => {
        const { data, error } = await sb
          .from('leaderboard_ranks')
          .select('computed_at')
          .eq('season_id', season)
          .order('computed_at', { ascending: false })
          .limit(1)
        if (error) return { season, error: error.message, ageMs: null as number | null, ageMin: -1 }
        const iso = data?.[0]?.computed_at as string | undefined
        const ageMs = iso ? Date.now() - new Date(iso).getTime() : Infinity
        const ageMin = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : -1
        return { season, error: null as string | null, ageMs, ageMin }
      })
    )

    const queryErr = freshness.find((f) => f.error)
    if (queryErr) {
      logger.error('[compute-watchdog] freshness query failed:', queryErr.error)
      await sendAlert({
        level: 'critical',
        title: 'compute-leaderboard 看门狗失明',
        message: `看门狗无法读取 leaderboard 新鲜度(${queryErr.season}),本轮无法判断是否停更。`,
        details: { season: queryErr.season, error: queryErr.error },
      }).catch((e) => logger.error('[compute-watchdog] alert failed:', e))
      // Throw so withCron records the run as failed instead of success.
      throw new Error(`compute-watchdog freshness query failed: ${queryErr.error}`)
    }

    const staleSeasons = freshness.filter((f) => f.ageMs == null || (f.ageMs ?? 0) > STALE_MS)
    if (staleSeasons.length === 0) {
      return { stale: false, ages: freshness.map((f) => ({ [f.season]: f.ageMin })) }
    }

    // One or more seasons stalled > 3h — the arena-worker chain missed them.
    // Try the HTTP fallback per season. Only a 2xx answer (or a request still
    // running at our timeout — compute is long and continues on its own
    // invocation) counts as triggered. During V1 compute-leaderboard is a 410
    // tombstone, so this honestly reports triggered:false.
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.arenafi.org'
    const secret = process.env.CRON_SECRET
    const triggers: Array<{ season: string; triggered: boolean; note: string }> = []
    for (const s of staleSeasons) {
      if (!secret) {
        triggers.push({ season: s.season, triggered: false, note: 'CRON_SECRET missing' })
        continue
      }
      try {
        const resp = await fetch(`${base}/api/cron/compute-leaderboard?season=${s.season}`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(60_000),
        })
        triggers.push({ season: s.season, triggered: resp.ok, note: `HTTP ${resp.status}` })
      } catch (e) {
        const timedOut = e instanceof Error && e.name === 'TimeoutError'
        triggers.push({
          season: s.season,
          triggered: timedOut,
          note: timedOut ? 'kicked (still running at timeout)' : `err ${String(e)}`,
        })
      }
    }

    const staleDesc = staleSeasons.map((s) => `${s.season} ${s.ageMin}min`).join(', ')
    const kicked = triggers.filter((t) => t.triggered).map((t) => t.season)
    const failed = triggers.filter((t) => !t.triggered)
    const outcome =
      failed.length === 0
        ? `看门狗已兜底触发这些 season(${kicked.join(', ')}),请检查 arena-worker。`
        : `兜底触发失败:${failed.map((t) => `${t.season}(${t.note})`).join(', ')}` +
          (kicked.length > 0 ? `;已触发:${kicked.join(', ')}` : '') +
          '。需人工处理 arena-worker / 算分链。'
    await sendAlert({
      level: 'critical',
      title:
        failed.length === 0
          ? 'compute-leaderboard 看门狗触发'
          : 'compute-leaderboard 看门狗:停更且兜底失败',
      message: `服务层 leaderboard 部分 season 已 >3h 未重算(${staleDesc})——arena-worker 算分链可能已死。${outcome}`,
      details: { staleSeasons: staleSeasons.map((s) => ({ [s.season]: s.ageMin })), triggers },
    }).catch((e) => logger.error('[compute-watchdog] alert failed:', e))

    return { stale: true, staleSeasons: staleSeasons.map((s) => s.season), triggers }
  }
)
