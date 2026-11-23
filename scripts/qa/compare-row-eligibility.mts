/**
 * Offline before/after comparison of the public rank row eligibility rule.
 *
 * Runs the real publication scorer and writer projection twice in one
 * process, once per PUBLIC_RANKING_ROW_ELIGIBILITY value ('four_metrics' =
 * before, 'roi_pnl' = after), over the same score-input rows, and prints what
 * changes. It opens no connection of any kind: input is a JSON file or the
 * built-in synthetic cohort.
 *
 *   npx --no-install tsx scripts/qa/compare-row-eligibility.mts \
 *     [--bundle bundle-7d.json] [--season 7D] [--sources a,b,c] \
 *     [--zero-share 0.7] [--idle-zero-risk-share 0.5] [--seed 20261122] [--json]
 *
 * --bundle   the JSON returned by
 *            public.arena_score_inputs_publish_bundle_json('<season>', 1000, 48)
 *            (an object with `scoreRows`, or the bare array). Exported by the
 *            release owner; this script never reads production.
 * --sources  restrict to the sources that are on the board (the tool cannot
 *            reproduce source isolation: freshness, evidence, the 50% rule).
 * Without --bundle a synthetic 7D cohort is generated from the per-source
 * candidate / four-metric counts of the 2026-11-22 production read
 * (SYNTHETIC_SOURCES below). Its row counts are those real counts; its metric
 * VALUES are invented. Two inputs are ASSUMPTIONS, not measurements:
 *   --zero-share            share of non-positive rows that are idle accounts
 *                           (ROI exactly 0 and PnL exactly 0)
 *   --idle-zero-risk-share  share of idle accounts WITH all four metrics whose
 *                           drawdown and win rate are both exactly 0
 */
import { readFileSync } from 'node:fs'

import {
  mapArenaScoreRowToTraderRow,
  type ArenaScoreRowForTrader,
} from '@/lib/rankings/publication/arena-score-row-mapper'
import {
  classifyPublishableRow,
  orderRowsForWrite,
} from '@/lib/rankings/publication/publish-season'
import { scoreTraders } from '@/lib/rankings/publication/score-traders'
import {
  lacksRequiredMetricEvidence,
  type SourcePublicationScoreRow,
} from '@/lib/rankings/publication/source-publication-evidence'
import {
  isPublicRankingSourceAllowed,
  type PublicRankingRowEligibility,
} from '@/lib/rankings/publication-policy'
import type { Period } from '@/lib/utils/arena-score'

type ScoreRow = ArenaScoreRowForTrader &
  Pick<SourcePublicationScoreRow, 'unevidenced_metrics'> & { profit_factor?: null }

interface RankedRow {
  key: string
  source: string
  rank: number
  arena_score: number
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  score_completeness: 'full' | 'partial' | 'minimal'
}

/** candidates = rows in each source's top 1,000; fourOk = of those, all four metrics. */
const SYNTHETIC_SOURCES: ReadonlyArray<{
  source: string
  candidates: number
  fourOk: number
  /** Share of candidates with ROI <= 0 or PnL <= 0 (production read where known). */
  nonPositiveShare: number
}> = [
  { source: 'bybit', candidates: 1000, fourOk: 1000, nonPositiveShare: 0.595 },
  { source: 'gateio', candidates: 693, fourOk: 687, nonPositiveShare: 0.55 },
  { source: 'gate_cfd', candidates: 422, fourOk: 421, nonPositiveShare: 0.6 },
  { source: 'lbank', candidates: 192, fourOk: 192, nonPositiveShare: 0.74 },
  { source: 'toobit_futures', candidates: 1000, fourOk: 472, nonPositiveShare: 0.942 },
  { source: 'bitunix', candidates: 1000, fourOk: 178, nonPositiveShare: 0.783 },
  { source: 'blofin', candidates: 578, fourOk: 64, nonPositiveShare: 0.95 },
  { source: 'xt', candidates: 1000, fourOk: 23, nonPositiveShare: 0.98 },
  { source: 'binance_spot', candidates: 1000, fourOk: 0, nonPositiveShare: 0.803 },
  { source: 'bitget_spot', candidates: 1000, fourOk: 0, nonPositiveShare: 0.998 },
  { source: 'blofin_spot', candidates: 129, fourOk: 0, nonPositiveShare: 0.9 },
]

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** mulberry32: deterministic, so two runs print the same report. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round = (value: number, digits: number) => Number(value.toFixed(digits))

function syntheticRows(seed: number, zeroShare: number, idleZeroRiskShare: number): ScoreRow[] {
  const random = prng(seed)
  const asOf = '2026-11-22T12:00:00.000Z'
  const rows: ScoreRow[] = []
  for (const spec of SYNTHETIC_SOURCES) {
    for (let index = 0; index < spec.candidates; index += 1) {
      const complete = index < spec.fourOk
      const nonPositive = random() < spec.nonPositiveShare
      // An idle account: exactly zero return and zero PnL. Among complete rows
      // they exist too (bybit), but far fewer; the bulk is in the new rows.
      const idle = nonPositive && random() < (complete ? zeroShare / 4 : zeroShare)
      const roi = idle
        ? 0
        : nonPositive
          ? -round(random() ** 2 * 80, 2)
          : round(random() ** 3 * 400 + 0.01, 2)
      const pnl = idle
        ? 0
        : nonPositive
          ? -round(random() ** 3 * 20_000, 2)
          : round(random() ** 4 * 500_000 + 0.5, 2)
      // Sources that publish only one of the two metrics.
      const hasWinRate = complete || (!idle && random() < 0.35)
      const hasDrawdown = complete || (!idle && !hasWinRate && random() < 0.3)
      // An idle account that reports risk metrics often reports them as 0.
      const zeroRisk = idle && complete && random() < idleZeroRiskShare
      rows.push({
        platform: spec.source,
        trader_key: `${spec.source}-${String(index).padStart(4, '0')}`,
        roi_pct: roi,
        pnl_usd: pnl,
        // 0 occurs as a real value in a few percent of rows.
        win_rate: hasWinRate
          ? zeroRisk || random() < 0.03
            ? 0
            : round(20 + random() * 70, 2)
          : null,
        max_drawdown: hasDrawdown
          ? zeroRisk || random() < 0.03
            ? 0
            : round(random() ** 2 * 90, 2)
          : null,
        copiers: null,
        trades_count: random() < 0.5 ? null : Math.floor(random() * 400),
        sharpe_ratio: null,
        sortino_ratio: null,
        calmar_ratio: null,
        trader_kind: null,
        as_of: asOf,
        board_as_of: asOf,
        unevidenced_metrics: [],
      })
    }
  }
  return rows
}

function loadBundle(path: string): ScoreRow[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const rows = Array.isArray(parsed) ? parsed : (parsed as { scoreRows?: unknown }).scoreRows
  if (!Array.isArray(rows)) throw new Error(`${path}: no scoreRows array`)
  return rows as ScoreRow[]
}

async function publish(
  scoreRows: readonly ScoreRow[],
  season: Period,
  rowEligibility: PublicRankingRowEligibility
): Promise<{ ranked: RankedRow[]; excluded: Record<string, number> }> {
  const excluded: Record<string, number> = {}
  const count = (reason: string) => void (excluded[reason] = (excluded[reason] ?? 0) + 1)

  const scorerRows = scoreRows.filter((row) => {
    if (!lacksRequiredMetricEvidence(row as SourcePublicationScoreRow, rowEligibility)) return true
    count('score_input_evidence_missing')
    return false
  })
  const { scoredFiltered } = await scoreTraders(
    scorerRows.map(mapArenaScoreRowToTraderRow),
    new Map(),
    new Set(),
    season,
    // Arena follower counts do not enter the score.
    { countTraderAccountFollowers: async () => [] },
    { rowEligibility }
  )
  const dropped = scorerRows.length - scoredFiltered.length
  if (dropped > 0) excluded.filtered_by_scorer = dropped

  const rows = []
  for (const trader of scoredFiltered) {
    const verdict = classifyPublishableRow(trader, rowEligibility)
    if ('reason' in verdict) count(verdict.reason)
    else rows.push(verdict.row)
  }
  // rerank: arena_score DESC NULLS LAST, id; a first-time row takes its id in
  // write order. (Existing rows keep their id in production; a fresh table is
  // assumed here.)
  const ranked = orderRowsForWrite(rows).map((row, index) => ({
    key: `${row.source}\u0000${row.source_trader_id}`,
    source: row.source,
    rank: index + 1,
    arena_score: row.arena_score,
    roi: row.roi,
    pnl: row.pnl,
    win_rate: row.win_rate,
    max_drawdown: row.max_drawdown,
    score_completeness: row.score_completeness,
  }))
  return { ranked, excluded }
}

function quantiles(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { min: sorted[0], p25: at(0.25), median: at(0.5), p75: at(0.75), max: at(1) }
}

function share(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${part}/${whole} (${((100 * part) / whole).toFixed(1)}%)`
}

const season = (argument('season') ?? '7D') as Period
const bundlePath = argument('bundle')
const zeroShare = Number(argument('zero-share') ?? '0.7')
const idleZeroRiskShare = Number(argument('idle-zero-risk-share') ?? '0.5')
const seed = Number(argument('seed') ?? '20261122')
const onlySources = argument('sources')?.split(',').filter(Boolean)

let scoreRows = bundlePath
  ? loadBundle(bundlePath)
  : syntheticRows(seed, zeroShare, idleZeroRiskShare)
if (onlySources) scoreRows = scoreRows.filter((row) => onlySources.includes(row.platform))
const notRankable = [...new Set(scoreRows.map((row) => row.platform))].filter(
  (source) => !isPublicRankingSourceAllowed(source)
)

// The scorer logs through the app logger; keep stdout for the report.
const before = await publish(scoreRows, season, 'four_metrics')
const after = await publish(scoreRows, season, 'roi_pnl')

const beforeByKey = new Map(before.ranked.map((row) => [row.key, row]))
const afterByKey = new Map(after.ranked.map((row) => [row.key, row]))
const added = after.ranked.filter((row) => !beforeByKey.has(row.key))
const removed = before.ranked.filter((row) => !afterByKey.has(row.key))

const sources = [...new Set(scoreRows.map((row) => row.platform))].sort()
const perSource = sources.map((source) => {
  const candidates = scoreRows.filter((row) => row.platform === source).length
  const was = before.ranked.filter((row) => row.source === source).length
  const now = after.ranked.filter((row) => row.source === source).length
  return { source, candidates, before: was, after: now, added: now - was }
})

const top = (rows: RankedRow[], n: number) => rows.slice(0, n)
const completenessIn = (rows: RankedRow[]) => ({
  full: rows.filter((row) => row.score_completeness === 'full').length,
  partial: rows.filter((row) => row.score_completeness === 'partial').length,
  minimal: rows.filter((row) => row.score_completeness === 'minimal').length,
})

const beforeTop100 = top(before.ranked, 100)
const afterTop100 = top(after.ranked, 100)
const afterTop100Keys = new Set(afterTop100.map((row) => row.key))
const top100Kept = beforeTop100.filter((row) => afterTop100Keys.has(row.key))
const top100Entrants = afterTop100.filter((row) => !beforeTop100.some((old) => old.key === row.key))
const top100RankShift = beforeTop100.map((row) => (afterByKey.get(row.key)?.rank ?? NaN) - row.rank)

// Among the rows ranked BEFORE, did their order relative to each other change?
// This isolates the scoring changes (null/0 split, missing = 0, larger cohort)
// from the mere arrival of new rows.
const survivors = before.ranked.filter((row) => afterByKey.has(row.key))
const afterOrderOfSurvivors = [...survivors].sort(
  (left, right) => afterByKey.get(left.key)!.rank - afterByKey.get(right.key)!.rank
)
const relativeRankAfter = new Map(afterOrderOfSurvivors.map((row, index) => [row.key, index + 1]))
const relativeShift = survivors.map((row, index) => relativeRankAfter.get(row.key)! - (index + 1))
const zeroMetricSurvivors = survivors.filter((row) => row.max_drawdown === 0 || row.win_rate === 0)
const zeroMetricShift = zeroMetricSurvivors.map(
  (row) => relativeRankAfter.get(row.key)! - (survivors.indexOf(row) + 1)
)

const isLoser = (row: RankedRow) => row.roi <= 0 || row.pnl <= 0
const isIdle = (row: RankedRow) => row.roi === 0 && row.pnl === 0
const profitable = after.ranked.filter((row) => row.roi > 0 && row.pnl > 0)
const idleAfter = after.ranked.filter(isIdle)
const lastProfitableRank = profitable.length ? Math.max(...profitable.map((row) => row.rank)) : 0
const firstIdleRank = idleAfter.length ? Math.min(...idleAfter.map((row) => row.rank)) : 0
const idleAheadOfAProfitable = idleAfter.filter((row) => row.rank < lastProfitableRank).length
// Idle accounts by what else they carry. An idle row with no risk metric has
// nothing but a low ROI percentile. An idle row that REPORTS a 0% drawdown is
// read as the best drawdown of the cohort (0 is a value), which lifts it.
const idleGroups = (
  [
    ['noRiskMetrics', (row: RankedRow) => row.win_rate === null && row.max_drawdown === null],
    ['drawdownExactlyZero', (row: RankedRow) => row.max_drawdown === 0],
    [
      'otherRiskMetrics',
      (row: RankedRow) =>
        row.max_drawdown !== 0 && !(row.win_rate === null && row.max_drawdown === null),
    ],
  ] as const
).map(([group, predicate]) => {
  const rows = idleAfter.filter(predicate)
  return {
    group,
    rows: rows.length,
    aheadOfAProfitableRow: rows.filter((row) => row.rank < lastProfitableRank).length,
    rankPercentile: quantiles(rows.map((row) => round(row.rank / after.ranked.length, 3))),
    score: quantiles(rows.map((row) => row.arena_score)),
    // Where the same rows stood before, as a percentile of the old board.
    rankPercentileBefore: quantiles(
      rows
        .map((row) => beforeByKey.get(row.key))
        .filter((row): row is RankedRow => row !== undefined)
        .map((row) => round(row.rank / before.ranked.length, 3))
    ),
  }
})

const tieSizes = new Map<number, number>()
for (const row of after.ranked)
  tieSizes.set(row.arena_score, (tieSizes.get(row.arena_score) ?? 0) + 1)
const tied = [...tieSizes.values()].filter((size) => size > 1)
const largestTies = [...tieSizes.entries()]
  .sort((left, right) => right[1] - left[1])
  .slice(0, 5)
  .map(([score, size]) => ({ score, rows: size }))

const report = {
  input: bundlePath
    ? { bundle: bundlePath, season, sources: onlySources ?? 'all' }
    : {
        synthetic: true,
        season,
        seed,
        assumedZeroShareAmongNonPositive: zeroShare,
        assumedZeroRiskShareAmongCompleteIdle: idleZeroRiskShare,
      },
  sourcesNotPubliclyRankable: notRankable,
  rows: {
    scoreInput: scoreRows.length,
    rankedBefore: before.ranked.length,
    rankedAfter: after.ranked.length,
    added: added.length,
    removed: removed.length,
  },
  excludedBefore: before.excluded,
  excludedAfter: after.excluded,
  perSource,
  completenessAfter: completenessIn(after.ranked),
  top100: {
    keptFromBefore: top100Kept.length,
    entrants: top100Entrants.length,
    entrantCompleteness: completenessIn(top100Entrants),
    completenessAfter: completenessIn(afterTop100),
    rankShiftOfPreviousTop100: quantiles(top100RankShift.filter(Number.isFinite)),
  },
  top500CompletenessAfter: completenessIn(top(after.ranked, 500)),
  previouslyRankedRows: {
    count: survivors.length,
    relativeOrderChanged: relativeShift.filter((shift) => shift !== 0).length,
    relativeRankShift: quantiles(relativeShift),
    absoluteRankShift: quantiles(survivors.map((row) => afterByKey.get(row.key)!.rank - row.rank)),
    withZeroDrawdownOrZeroWinRate: {
      count: zeroMetricSurvivors.length,
      relativeRankShift: quantiles(zeroMetricShift),
    },
  },
  losers: {
    before: share(before.ranked.filter(isLoser).length, before.ranked.length),
    after: share(after.ranked.filter(isLoser).length, after.ranked.length),
    rankPercentileAfter: quantiles(
      after.ranked.filter(isLoser).map((row) => round(row.rank / after.ranked.length, 3))
    ),
  },
  idleAccounts: {
    definition: 'roi = 0 and pnl = 0',
    amongAddedRows: share(added.filter(isIdle).length, added.length),
    amongAllRankedAfter: share(idleAfter.length, after.ranked.length),
    firstIdleRank,
    lastProfitableRank,
    idleRowsRankedAheadOfAProfitableRow: idleAheadOfAProfitable,
    scoreOfIdleRows: quantiles(idleAfter.map((row) => row.arena_score)),
    byRiskMetrics: idleGroups,
  },
  floor: {
    rowsAt001: after.ranked.filter((row) => row.arena_score === 0.01).length,
  },
  ties: {
    distinctScores: tieSizes.size,
    rowsSharingAScore: tied.reduce((total, size) => total + size, 0),
    largest: largestTies,
  },
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  const line = (label: string, value: unknown) =>
    process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
  line('input', report.input)
  if (notRankable.length > 0) line('sources not publicly rankable (dropped)', notRankable)
  line('rows', report.rows)
  line('excluded before', report.excludedBefore)
  line('excluded after', report.excludedAfter)
  process.stdout.write('per source (candidates / before / after / added):\n')
  for (const row of perSource) {
    process.stdout.write(
      `  ${row.source.padEnd(16)} ${String(row.candidates).padStart(5)} ${String(row.before).padStart(5)} ${String(row.after).padStart(5)} ${String(row.added).padStart(6)}\n`
    )
  }
  line('completeness after', report.completenessAfter)
  line('top 100', report.top100)
  line('top 500 completeness after', report.top500CompletenessAfter)
  line('previously ranked rows', report.previouslyRankedRows)
  line('losers (roi <= 0 or pnl <= 0)', report.losers)
  line('idle accounts', report.idleAccounts)
  line('rows at the 0.01 floor', report.floor.rowsAt001)
  line('ties', report.ties)
}
