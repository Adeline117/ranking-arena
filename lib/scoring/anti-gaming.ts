/**
 * Anti-gaming flags — trust-facing statistical-anomaly badges.
 *
 * These surface on trader cards + the profile header as ⚠️ badges so users
 * can scrutinize metrics that are statistically implausible for genuine
 * directional trading (a classic wash-/self-trade tell). This SERVES trust:
 * it shows Arena actively scrutinizes the numbers rather than presenting every
 * leaderboard row at face value.
 *
 * Design guardrails (why the thresholds are deliberately conservative):
 *  - A wrong ⚠️ on a legitimate trader destroys trust — the exact opposite of
 *    the goal. Every flag here is tuned to be SPARSE and defensible, never a
 *    dragnet. Better one rock-solid flag than three that false-accuse.
 *  - Signals known to be noisy data artifacts are intentionally NOT flagged.
 *    e.g. ROI-vs-PnL sign divergence is a common field-mapping artifact
 *    (~2k/day, log-only in validate-before-write) — flagging the TRADER for
 *    our own pipeline quirk would be unfair, so it is excluded.
 *
 * Computed at read time from fields already on the serving row (no migration,
 * no cron/pipeline change → multi-session-safe). The return is an extensible
 * code array so deeper flags (wash-trade from order_records, single-symbol
 * concentration from positions) can be added as they are validated against the
 * arena.* partition data.
 */

export type AntiGamingFlagCode = 'implausible_win_rate'

export interface AntiGamingFlagInput {
  /** Win rate on a 0-100 scale (as stored on leaderboard_ranks). */
  winRate?: number | null
  /** Number of closed trades/positions backing the stats. */
  tradesCount?: number | null
}

/**
 * Compute anti-gaming flag codes for a trader from serving-row fields.
 * Returns [] when nothing is statistically implausible.
 */
export function computeAntiGamingFlags(input: AntiGamingFlagInput): AntiGamingFlagCode[] {
  const flags: AntiGamingFlagCode[] = []

  // Implausible win rate: ≥98% over a MEANINGFUL sample (≥30 trades) is
  // statistically implausible for directional trading and is the canonical
  // wash-/self-trade tell. The ≥30-trade floor is essential: it excludes
  // small-sample luck (e.g. 5/5 wins = 100%) so we never flag a trader who
  // simply has a short-but-clean history. ~2.8% of scored rows match — sparse
  // by design. win_rate is 0-100 scale.
  const wr = input.winRate
  const tc = input.tradesCount
  if (
    wr != null &&
    Number.isFinite(wr) &&
    tc != null &&
    Number.isFinite(tc) &&
    wr >= 98 &&
    tc >= 30
  ) {
    flags.push('implausible_win_rate')
  }

  return flags
}
