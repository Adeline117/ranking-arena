/**
 * compute-leaderboard / phase1-select
 *
 * Phase-1 ranking inputs come from the arena pipeline (arena_score_inputs).
 *
 * History: a COMPUTE_READ_SOURCE env flag once switched between the legacy
 * trader_latest reader and arena (with a 'diff' shadow gate) during the cutover.
 * The cutover is complete and trader_latest is retired (2026-06-15), so the
 * legacy reader + diff gate were removed; arena is the sole source.
 */

import { getSupabaseAdmin } from '@/lib/api'
import type { Period } from '@/lib/utils/arena-score'
import { fetchPhase1FromArena } from './fetch-phase1-arena'
import { type TraderRow } from './trader-row'

export type Phase1ReadSource = 'arena'

/** Retained for the cron response metadata; arena is the only source now. */
export function getPhase1ReadSource(): Phase1ReadSource {
  return 'arena'
}

/** Run Phase-1: pull ranking inputs from the arena pipeline. */
export async function runPhase1(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  _traderMap: Map<string, TraderRow>,
  addToTraderMap: (row: TraderRow) => void
): Promise<void> {
  await fetchPhase1FromArena(supabase, season, addToTraderMap)
}
