/**
 * Canonical digest of the score-input rows one source contributed to a sealed
 * cohort (contract arena-score-input-set@1).
 *
 * The orchestrator records it per source in
 * arena.leaderboard_rank_publication_source_evidence.score_input_sha256
 * (20261116210657), in the sealing transaction, so the sealed scores can be
 * recomputed from the same evidence: re-read arena.publication_score_rows_json
 * for the bound snapshots, drop the rows counted as
 * score_input_evidence_missing, and hash them the same way.
 *
 * Canonical form: JSON of { contract, season, source, rows }, rows sorted by
 * trader_key (code-unit order), each row the fixed-order tuple below. Values
 * are exactly what the publication bundle returned (JSON numbers / null).
 */

import { createHash } from 'node:crypto'

import type { PublicationWindow, SourcePublicationScoreRow } from './source-publication-evidence'

export const SCORE_INPUT_SET_CONTRACT = 'arena-score-input-set@1'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function scoreInputSetSha256(
  season: PublicationWindow,
  source: string,
  rows: readonly SourcePublicationScoreRow[]
): string {
  const canonical = rows
    .filter((row) => row.platform === source)
    .map((row) => [
      row.trader_key,
      row.board_rank,
      row.roi_pct,
      row.pnl_usd,
      row.win_rate,
      row.max_drawdown,
      row.copiers,
      row.trades_count,
      row.sharpe_ratio,
      row.sortino_ratio,
      row.calmar_ratio,
      row.volatility_pct,
      row.as_of,
      row.board_as_of,
    ])
    .sort((left, right) => compareText(String(left[0]), String(right[0])))
  return createHash('sha256')
    .update(JSON.stringify({ contract: SCORE_INPUT_SET_CONTRACT, season, source, rows: canonical }))
    .digest('hex')
}
