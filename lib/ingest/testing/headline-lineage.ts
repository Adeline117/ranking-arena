/**
 * Test helper: resolve parsed board rows against the source's registered
 * metric contract the way the shadow metric-trust publisher does.
 *
 * Rows go through staging first (staging drops a claim whose value it
 * rewrote). For every registered field of every row, a non-null value must
 * carry a claim on exactly the contract's field path, and a null value must
 * carry none; anything else would be recorded as `field_lineage_unknown` or
 * `field_lineage_mismatch`. The page ordinal is framework-bound later and is
 * not the parser's concern.
 *
 * Not used by production code.
 */

import { getRegisteredMetricSourceContract } from '@/lib/metric-trust'
import type { ParsedLeaderboardRow } from '../core/types'
import { validateLeaderboardRows } from '../staging/validate'

const VALUE: Record<string, (row: ParsedLeaderboardRow) => number | null | undefined> = {
  roi: (row) => row.headlineRoi,
  pnl: (row) => row.headlinePnl,
  win_rate: (row) => row.headlineWinRate,
  mdd: (row) => row.headlineMdd,
  sharpe: (row) => row.headlineSharpe,
}

export function resolveHeadlineLineage(
  rows: ParsedLeaderboardRow[],
  sourceId: string
): { resolved: number; unresolved: string[] } {
  const contract = getRegisteredMetricSourceContract(sourceId)
  if (!contract) return { resolved: 0, unresolved: [`${sourceId}: no registered contract`] }
  const { valid } = validateLeaderboardRows(rows)
  let resolved = 0
  const unresolved: string[] = []
  for (const row of valid) {
    for (const field of contract.fields) {
      const value = VALUE[field.metric](row) ?? null
      const claim = row.headlineMetricSources?.[field.metric]
      if (value === null) {
        if (claim) unresolved.push(`${row.exchangeTraderId} ${field.metric}: claim on null value`)
      } else if (claim?.fieldPath === field.fieldPath) {
        resolved += 1
      } else {
        unresolved.push(
          `${row.exchangeTraderId} ${field.metric}: ${claim?.fieldPath ?? 'no claim'} != ${field.fieldPath}`
        )
      }
    }
  }
  return { resolved, unresolved }
}
