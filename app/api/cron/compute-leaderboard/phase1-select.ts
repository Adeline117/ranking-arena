/**
 * compute-leaderboard / phase1-select  (ENDGAME cutover switch)
 *
 * Chooses which Phase-1 reader feeds the leaderboard, gated by the
 * COMPUTE_READ_SOURCE env flag so the cutover from trader_latest to the arena
 * pipeline is flippable WITHOUT a deploy and trivially reversible:
 *
 *   'trader_latest' (default) — legacy reader; what production has always run.
 *   'arena'                   — read ranking inputs from arena_score_inputs RPC.
 *   'diff'                    — publish the LEGACY result (zero risk) AND read
 *                               arena into a throwaway map, logging the delta.
 *                               This is the shadow phase: run it for a few
 *                               cycles, eyeball the diff, then flip to 'arena'.
 *
 * Same shadow→serving discipline the per-source detail-page cutover used: a
 * read-path swap on the live ranking chain is the highest-risk action, so it
 * never goes direct — it goes through a diff gate first.
 */

import { getSupabaseAdmin } from '@/lib/api'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { fetchPhase1FromV2 } from './fetch-phase1'
import { fetchPhase1FromArena } from './fetch-phase1-arena'
import { makeAddToTraderMap, type TraderRow } from './trader-row'

const logger = createLogger('compute-leaderboard')

export type Phase1ReadSource = 'trader_latest' | 'arena' | 'diff'

export function getPhase1ReadSource(): Phase1ReadSource {
  const v = (process.env.COMPUTE_READ_SOURCE ?? '').toLowerCase()
  if (v === 'arena' || v === 'diff') return v
  return 'trader_latest'
}

/**
 * Log a structured comparison of the two readers' per-platform coverage so a
 * human can judge cutover readiness from the cron logs. Pure logging — never
 * touches the published map.
 */
function logDiff(season: Period, legacy: Map<string, number>, arena: Map<string, number>): void {
  const platforms = new Set([...legacy.keys(), ...arena.keys()])
  const legacyTotal = [...legacy.values()].reduce((a, b) => a + b, 0)
  const arenaTotal = [...arena.values()].reduce((a, b) => a + b, 0)
  const onlyLegacy: string[] = []
  const onlyArena: string[] = []
  const bigDelta: string[] = []
  for (const p of platforms) {
    const l = legacy.get(p) ?? 0
    const a = arena.get(p) ?? 0
    if (a === 0 && l > 0) onlyLegacy.push(`${p}(${l})`)
    else if (l === 0 && a > 0) onlyArena.push(`${p}(${a})`)
    else if (Math.abs(l - a) / Math.max(l, a) > 0.25) bigDelta.push(`${p}(${l}→${a})`)
  }
  logger.info(
    `[${season}] PHASE1-DIFF legacy=${legacyTotal}rows/${legacy.size}plat ` +
      `arena=${arenaTotal}rows/${arena.size}plat | ` +
      `onlyLegacy=[${onlyLegacy.join(',')}] onlyArena=[${onlyArena.join(',')}] ` +
      `bigDelta(>25%)=[${bigDelta.join(',')}]`
  )
}

/**
 * Run the selected Phase-1 reader. In 'diff' mode the legacy reader populates
 * the real traderMap (publish path unchanged) and the arena reader runs into a
 * discarded map purely to log the delta.
 */
export async function runPhase1(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  traderMap: Map<string, TraderRow>,
  addToTraderMap: (row: TraderRow) => void
): Promise<void> {
  const source = getPhase1ReadSource()

  if (source === 'arena') {
    await fetchPhase1FromArena(supabase, season, addToTraderMap)
    return
  }

  if (source === 'diff') {
    const legacyCounts = await fetchPhase1FromV2(supabase, season, addToTraderMap)
    // Shadow read into a throwaway map — published result stays legacy.
    const shadow = new Map<string, TraderRow>()
    const arenaCounts = await fetchPhase1FromArena(supabase, season, makeAddToTraderMap(shadow))
    logDiff(season, legacyCounts, arenaCounts)
    return
  }

  await fetchPhase1FromV2(supabase, season, addToTraderMap)
}
