/**
 * What a profile may say about a trader's score in one ranking period.
 *
 * `idleWindows` is the list of periods ('7D' | '30D' | '90D') in which the
 * account is ranked but did no trading — an idle window. Such a row carries a
 * placeholder score that means "not scored": the profile shows "no trading this
 * period" and no score, no breakdown, no rank and no similar traders.
 *
 *   undefined  nothing was supplied (a caller that predates the flag) → scored
 *   null       the ranking read FAILED → unknown: withhold the score rather
 *              than show a placeholder as if it were one; say nothing about
 *              trading either, because that is not known
 */
export type IdleWindows = readonly string[] | null

export type ScoreDisplayState = 'scored' | 'idle' | 'unknown'

export function scoreDisplayState(
  idleWindows: IdleWindows | undefined,
  period: string
): ScoreDisplayState {
  if (idleWindows === undefined) return 'scored'
  if (idleWindows === null) return 'unknown'
  return idleWindows.includes(period.toUpperCase()) ? 'idle' : 'scored'
}

const SCORE_KEY = /^(arena_score(_.+)?|profitability_score|risk_control_score|execution_score)$/

/**
 * A copy of a performance payload with every score field emptied. The client
 * re-reads this payload from the API after the server render, so stripping it
 * on the server alone would let the placeholder back in.
 */
export function withoutScores<T extends Record<string, unknown>>(
  performance: T | null | undefined
): T | null | undefined {
  if (!performance) return performance
  const stripped: Record<string, unknown> = { ...performance }
  for (const key of Object.keys(stripped)) {
    if (SCORE_KEY.test(key)) stripped[key] = null
  }
  return stripped as T
}
