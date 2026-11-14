/**
 * GET /api/cron/compute-leaderboard-watchdog — Vercel-side detector for a
 * stalled leaderboard publication.
 *
 * WHY: leaderboard scoring + sealing runs in-process in the `arena-worker`
 * (`worker/src/index.ts`, `score:compute` every 2h). If that process dies or
 * every publication is refused, the public leaderboard silently keeps serving
 * the last seal. This watchdog alerts when a season has no fresh SEALED
 * publication.
 *
 * Judgement (2026-11 audit P1-1): sealed publication, never
 * `leaderboard_ranks.computed_at` (rows can be written without ever being
 * sealed, docs/SLO.md §3). A season is healthy only when
 *   - `public_ranked_leaderboard` serves at least one row for it, and
 *   - its newest seal (`leaderboard_source_freshness.recorded_at`, written by
 *     the seal RPC as the publication time) is younger than STALE_MS.
 *
 * Alert only. The repair path is the worker's in-process publication; there
 * is no HTTP route that can publish (compute-leaderboard is a 410 tombstone)
 * and the worker's BullMQ Redis is not reachable from Vercel, so the watchdog
 * never claims to have triggered a recovery.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Publication runs every 2h; intervene at 3h — one full cycle definitively
// missed, before the public health SLO trips.
const STALE_MS = 3 * 3600_000

const SEASONS = ['90D', '30D', '7D'] as const

interface SeasonPublication {
  season: (typeof SEASONS)[number]
  served: boolean
  sealedAt: string | null
  ageMin: number | null
}

export const GET = withCron(
  'compute-leaderboard-watchdog',
  async (_request: NextRequest, { supabase }) => {
    // Per season: seasons publish independently, so a global newest seal
    // would hide a single stalled season behind a healthy one.
    const results = await Promise.all(
      SEASONS.map(async (season) => {
        const [seal, serving] = await Promise.all([
          supabase
            .from('leaderboard_source_freshness')
            .select('recorded_at')
            .eq('season_id', season)
            .order('recorded_at', { ascending: false })
            .limit(1),
          supabase.from('public_ranked_leaderboard').select('id').eq('season_id', season).limit(1),
        ])
        const error = seal.error?.message ?? serving.error?.message ?? null
        const sealedAt = (seal.data?.[0]?.recorded_at as string | undefined) ?? null
        const sealedMs = sealedAt ? Date.parse(sealedAt) : NaN
        const publication: SeasonPublication = {
          season,
          served: (serving.data?.length ?? 0) > 0,
          sealedAt,
          ageMin: Number.isFinite(sealedMs) ? Math.round((Date.now() - sealedMs) / 60_000) : null,
        }
        return { publication, error }
      })
    )

    const blind = results.find((r) => r.error)
    if (blind) {
      logger.error('[compute-watchdog] publication query failed:', blind.error)
      await sendAlert({
        level: 'critical',
        title: 'compute-leaderboard 看门狗失明',
        message: `看门狗无法读取 ${blind.publication.season} 的封存发布状态,本轮无法判断是否停更。`,
        details: { season: blind.publication.season, error: blind.error },
      }).catch((e) => logger.error('[compute-watchdog] alert failed:', e))
      // Throw so withCron records the run as failed instead of success.
      throw new Error(`compute-watchdog publication query failed: ${blind.error}`)
    }

    const publications = results.map((r) => r.publication)
    const stale = publications.filter(
      (p) => !p.served || p.ageMin === null || p.ageMin * 60_000 > STALE_MS
    )
    if (stale.length === 0) {
      return { stale: false, publications }
    }

    const describe = (p: SeasonPublication) =>
      `${p.season}(${p.served ? '' : '公开视图未服务;'}${
        p.ageMin === null ? '从未封存' : `最近封存 ${p.ageMin}min 前`
      })`
    await sendAlert({
      level: 'critical',
      title: 'compute-leaderboard 看门狗:封存发布停更',
      message:
        `公开榜单这些 season 超过 3h 没有新的封存发布:${stale.map(describe).join(', ')}。` +
        '看门狗只告警、不兜底:修复路径是 arena-worker 进程内发布(score:compute),需人工检查 arena-worker 与发布拒绝告警。',
      details: { stale },
    }).catch((e) => logger.error('[compute-watchdog] alert failed:', e))

    return { stale: true, staleSeasons: stale.map((p) => p.season), publications }
  },
  { maxDurationSec: maxDuration }
)
