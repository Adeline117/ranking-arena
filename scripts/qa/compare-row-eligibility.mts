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
 *     [--bundle bundle-7d.json] [--season 7D] [--before-top top500-7d-before.csv] \
 *     [--sources a,b,c] [--markdown out.md] [--identities] [--json] \
 *     [--zero-share 0.7] [--idle-zero-risk-share 0.5] [--seed 20261122]
 *
 * --bundle      the JSON returned by
 *               public.arena_score_inputs_publish_bundle_json('<season>', 1000, 48)
 *               (an object with `scoreRows`, or the bare array). Exported by
 *               the release owner; this script never reads production.
 * --before-top  CSV of the board as served before the change
 *               (rank,source,source_trader_id,arena_score,roi,pnl,win_rate,max_drawdown).
 *               When given, "top 100 retention" is measured against the REAL
 *               previous top 100; the simulated 'four_metrics' board is only
 *               the fallback and a fidelity check.
 * --sources     restrict to the sources that are on the board (the tool cannot
 *               reproduce source isolation: freshness, evidence, the 50% rule).
 * --markdown    append the report as a Markdown section to this file.
 * --label       title of that section (default: the season).
 * --top20-markdown  append "previous top 20 / new top 20" tables (platform,
 *               handle, ROI, PnL, drawdown, win rate, old rank, new rank) to
 *               this file. Real handles: same rule as --identities.
 * --identities  list the new top-100 entrants by source and trader key in the
 *               Markdown report. Real trader identities: keep that file out of
 *               the repository and out of pull requests.
 *
 * Without --bundle a synthetic 7D cohort is generated from the per-source
 * candidate / four-metric counts of the 2026-11-22 production read
 * (SYNTHETIC_SOURCES below). Its row counts are those real counts; its metric
 * VALUES are invented. Two inputs are ASSUMPTIONS, not measurements:
 *   --zero-share            share of non-positive rows that are idle accounts
 *                           (ROI exactly 0 and PnL exactly 0)
 *   --idle-zero-risk-share  share of idle accounts WITH all four metrics whose
 *                           drawdown and win rate are both exactly 0
 */
import { appendFileSync, readFileSync } from 'node:fs'

import {
  mapArenaScoreRowToTraderRow,
  type ArenaScoreRowForTrader,
} from '@/lib/rankings/publication/arena-score-row-mapper'
import {
  classifyPublishableRow,
  orderRowsForWrite,
} from '@/lib/rankings/publication/publish-season'
import {
  hasSignMismatch,
  isIdleWindowRow,
  scoreTraders,
} from '@/lib/rankings/publication/score-traders'
import {
  lacksRequiredMetricEvidence,
  type SourcePublicationScoreRow,
} from '@/lib/rankings/publication/source-publication-evidence'
import {
  isPublicRankingSourceAllowed,
  type PublicRankingRowEligibility,
} from '@/lib/rankings/publication-policy'
import type { Period } from '@/lib/utils/arena-score'

type ScoreRow = ArenaScoreRowForTrader & Pick<SourcePublicationScoreRow, 'unevidenced_metrics'>

interface RankedRow {
  key: string
  source: string
  traderKey: string
  rank: number
  arena_score: number
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  score_completeness: 'full' | 'partial' | 'minimal'
  idle: boolean
  /** The reported 0% drawdown was refused (losing window). */
  contradiction: boolean
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
const identity = (source: string, traderKey: string) => `${source}\u0000${traderKey}`

function syntheticRows(seed: number, zeroShare: number, idleZeroRiskShare: number): ScoreRow[] {
  const random = prng(seed)
  const asOf = '2026-11-22T12:00:00.000Z'
  const rows: ScoreRow[] = []
  for (const spec of SYNTHETIC_SOURCES) {
    for (let index = 0; index < spec.candidates; index += 1) {
      const complete = index < spec.fourOk
      const nonPositive = random() < spec.nonPositiveShare
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
      const hasWinRate = complete || (!idle && random() < 0.35)
      const hasDrawdown = complete || (!idle && !hasWinRate && random() < 0.3)
      const zeroRisk = idle && complete && random() < idleZeroRiskShare
      rows.push({
        platform: spec.source,
        trader_key: `${spec.source}-${String(index).padStart(4, '0')}`,
        roi_pct: roi,
        pnl_usd: pnl,
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

/** rank,source,source_trader_id,... with a header line; no quoted commas expected. */
function loadBeforeTop(path: string): Array<{ rank: number; key: string; source: string }> {
  const [header, ...lines] = readFileSync(path, 'utf8').trim().split(/\r?\n/)
  const columns = header.split(',')
  const at = (name: string) => {
    const index = columns.indexOf(name)
    if (index < 0) throw new Error(`${path}: no ${name} column`)
    return index
  }
  const [rank, source, trader] = [at('rank'), at('source'), at('source_trader_id')]
  return lines
    .map((line) => line.split(','))
    .map((cells) => ({
      rank: Number(cells[rank]),
      source: cells[source],
      key: identity(cells[source], cells[trader]),
    }))
    .sort((left, right) => left.rank - right.rank)
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
  const contradictions = new Set<string>()
  for (const trader of scoredFiltered) {
    const verdict = classifyPublishableRow(trader, rowEligibility)
    if ('reason' in verdict) count(verdict.reason)
    else {
      rows.push(verdict.row)
      if (trader.score_factors?.mdd_contradiction === true) {
        contradictions.add(identity(trader.source, trader.source_trader_id))
      }
    }
  }
  // rerank: arena_score DESC NULLS LAST, id; a first-time row takes its id in
  // write order. (Existing rows keep their id in production; a fresh table is
  // assumed here, so order inside one displayed score can differ from
  // production. Idle rows have a score of their own, so their block does not.)
  const ranked = orderRowsForWrite(rows).map((row, index) => ({
    key: identity(row.source, row.source_trader_id),
    source: row.source,
    traderKey: row.source_trader_id,
    rank: index + 1,
    arena_score: row.arena_score,
    roi: row.roi,
    pnl: row.pnl,
    win_rate: row.win_rate,
    max_drawdown: row.max_drawdown,
    score_completeness: row.score_completeness,
    idle: isIdleWindowRow(row),
    contradiction: contradictions.has(identity(row.source, row.source_trader_id)),
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

function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1]))
}

const season = (argument('season') ?? '7D') as Period
const bundlePath = argument('bundle')
const beforeTopPath = argument('before-top')
const markdownPath = argument('markdown')
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

const before = await publish(scoreRows, season, 'four_metrics')
const after = await publish(scoreRows, season, 'roi_pnl')

const beforeByKey = new Map(before.ranked.map((row) => [row.key, row]))
const afterByKey = new Map(after.ranked.map((row) => [row.key, row]))
const added = after.ranked.filter((row) => !beforeByKey.has(row.key))
const removed = before.ranked.filter((row) => !afterByKey.has(row.key))

// --- input facts (independent of either rule) ------------------------------
const inputIdle = scoreRows.filter(
  (row) => row.roi_pct !== null && row.pnl_usd !== null && row.roi_pct === 0 && row.pnl_usd === 0
)
const inputIdleZeroDrawdown = inputIdle.filter((row) => row.max_drawdown === 0)
// Stored as ROI 0.0000 / PnL 0.00 but not exactly zero: scored, not idle.
const roundsToZeroButScored = scoreRows.filter(
  (row) =>
    row.roi_pct !== null &&
    row.pnl_usd !== null &&
    !(row.roi_pct === 0 && row.pnl_usd === 0) &&
    Math.round(row.roi_pct * 1e4) === 0 &&
    Math.round(row.pnl_usd * 1e2) === 0
).length

// --- per source ------------------------------------------------------------
const sources = [...new Set(scoreRows.map((row) => row.platform))].sort()
const perSource = sources.map((source) => {
  const ranked = after.ranked.filter((row) => row.source === source)
  return {
    source,
    candidates: scoreRows.filter((row) => row.platform === source).length,
    before: before.ranked.filter((row) => row.source === source).length,
    after: ranked.length,
    added: ranked.length - before.ranked.filter((row) => row.source === source).length,
    idleAfter: ranked.filter((row) => row.idle).length,
  }
})

// --- top 100 / top 500 -----------------------------------------------------
const top = (rows: RankedRow[], n: number) => rows.slice(0, n)
const completenessIn = (rows: RankedRow[]) => ({
  full: rows.filter((row) => row.score_completeness === 'full').length,
  partial: rows.filter((row) => row.score_completeness === 'partial').length,
  minimal: rows.filter((row) => row.score_completeness === 'minimal').length,
})
const lacksRisk = (row: RankedRow) => row.score_completeness !== 'full'

const realBeforeTop = beforeTopPath ? loadBeforeTop(beforeTopPath) : null
const afterTop100 = top(after.ranked, 100)
const afterTop100Keys = new Set(afterTop100.map((row) => row.key))

/** Retention of a previous top 100 (given as identity keys, best first). */
function top100Against(previousKeys: string[]) {
  const previous = new Set(previousKeys)
  const entrants = afterTop100.filter((row) => !previous.has(row.key))
  const newRanks = previousKeys.map((key) => afterByKey.get(key)?.rank ?? NaN)
  return {
    keptInTop100: previousKeys.filter((key) => afterTop100Keys.has(key)).length,
    entrants: entrants.length,
    entrantsBySource: countBy(entrants, (row) => row.source),
    entrantsByCompleteness: completenessIn(entrants),
    entrantsRankedBeforeBelow100: entrants.filter((row) => beforeByKey.has(row.key)).length,
    entrantsNotRankedBefore: entrants.filter((row) => !beforeByKey.has(row.key)).length,
    // Why a previously ranked row moved up: a 0% drawdown is now read as the
    // best drawdown instead of as missing.
    entrantsWithDrawdownExactlyZero: entrants.filter((row) => row.max_drawdown === 0).length,
    entrantsWithDrawdownBelowOnePercent: entrants.filter(
      (row) => row.max_drawdown !== null && row.max_drawdown < 1
    ).length,
    entrantsWithWinRateExactlyZero: entrants.filter((row) => row.win_rate === 0).length,
    droppedOutWithDrawdownExactlyZero: previousKeys.filter(
      (key) => !afterTop100Keys.has(key) && afterByKey.get(key)?.max_drawdown === 0
    ).length,
    newRankOfPreviousTop100: quantiles(newRanks.filter(Number.isFinite)),
    previousTop100NoLongerRanked: newRanks.filter((rank) => !Number.isFinite(rank)).length,
    entrantRows: entrants,
  }
}
// Same input under both rules: isolates what this change does.
const top100VsSimulated = top100Against(top(before.ranked, 100).map((row) => row.key))
// The board as it was actually served: also contains everything else that
// moved between that publication and this export (new boards, new data).
const top100VsReal = realBeforeTop
  ? top100Against(realBeforeTop.slice(0, 100).map((row) => row.key))
  : null
const entrants = (top100VsReal ?? top100VsSimulated).entrantRows
const withoutRows = <T extends { entrantRows: unknown }>(value: T) => {
  const { entrantRows: _rows, ...rest } = value
  return rest
}

// How well the simulated 'four_metrics' board reproduces the real one.
const simulationFidelity = realBeforeTop
  ? {
      realTop100InSimulatedTop100: realBeforeTop
        .slice(0, 100)
        .filter((row) => top(before.ranked, 100).some((sim) => sim.key === row.key)).length,
      realTop500InSimulatedBoard: realBeforeTop.filter((row) => beforeByKey.has(row.key)).length,
      realTop500Rows: realBeforeTop.length,
      realTop500SourcesMissingFromBundle: [
        ...new Set(realBeforeTop.map((row) => row.source)),
      ].filter((source) => !sources.includes(source)),
      // Sources the simulated previous board ranks that the real top 500 does
      // not contain at all: probably not on the served board (isolated, or
      // their board became fresh after the last publication).
      simulatedBeforeSourcesAbsentFromRealTop500: Object.fromEntries(
        perSource
          .filter(
            (row) => row.before > 0 && !realBeforeTop.some((real) => real.source === row.source)
          )
          .map((row) => [row.source, row.before])
      ),
    }
  : null

// --- idle rows -------------------------------------------------------------
const idleAfter = after.ranked.filter((row) => row.idle)
const activeAfter = after.ranked.filter((row) => !row.idle)
const firstIdleRank = idleAfter.length ? Math.min(...idleAfter.map((row) => row.rank)) : null
const lastActiveRank = activeAfter.length ? Math.max(...activeAfter.map((row) => row.rank)) : null
const idleAheadOfActive =
  lastActiveRank === null ? 0 : idleAfter.filter((row) => row.rank < lastActiveRank).length

// Rows that are on the board today (simulated 'four_metrics'), idle, drawdown 0.
const previouslyRankedIdleZeroDrawdown = before.ranked.filter(
  (row) => row.roi === 0 && row.pnl === 0 && row.max_drawdown === 0
)
const idleZeroDrawdownMoves = previouslyRankedIdleZeroDrawdown.map((row) => ({
  source: row.source,
  before: row.rank,
  after: afterByKey.get(row.key)?.rank ?? NaN,
}))
const realTopByKey = new Map((realBeforeTop ?? []).map((row) => [row.key, row.rank]))
const idleZeroDrawdownInRealTop500 = previouslyRankedIdleZeroDrawdown.filter((row) =>
  realTopByKey.has(row.key)
)

// --- losing rows relative to idle rows -------------------------------------
const losingAfter = activeAfter.filter((row) => row.roi < 0 || row.pnl < 0)
const losingBelowIdle =
  firstIdleRank === null ? 0 : losingAfter.filter((row) => row.rank > firstIdleRank).length

// --- scores ----------------------------------------------------------------
const tieSizes = new Map<number, number>()
for (const row of after.ranked)
  tieSizes.set(row.arena_score, (tieSizes.get(row.arena_score) ?? 0) + 1)
const largestTies = [...tieSizes.entries()]
  .sort((left, right) => right[1] - left[1])
  .slice(0, 5)
  .map(([score, size]) => ({ score, rows: size }))

const survivors = before.ranked.filter((row) => afterByKey.has(row.key) && !row.idle)
const survivorsAfterOrder = [...survivors].sort(
  (left, right) => afterByKey.get(left.key)!.rank - afterByKey.get(right.key)!.rank
)
const relativeRankAfter = new Map(survivorsAfterOrder.map((row, index) => [row.key, index + 1]))
const relativeShift = survivors.map((row, index) => relativeRankAfter.get(row.key)! - (index + 1))

const report = {
  input: bundlePath
    ? {
        bundle: bundlePath,
        season,
        beforeTop: beforeTopPath ?? null,
        sources: onlySources ?? 'all',
      }
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
  inputIdle: {
    definition: 'roi_pct = 0 and pnl_usd = 0',
    rows: share(inputIdle.length, scoreRows.length),
    withDrawdownExactlyZero: inputIdleZeroDrawdown.length,
    withDrawdownExactlyZeroBySource: countBy(inputIdleZeroDrawdown, (row) => row.platform),
    withWinRateExactlyZero: inputIdle.filter((row) => row.win_rate === 0).length,
    withoutDrawdown: inputIdle.filter((row) => row.max_drawdown === null).length,
    roundToZeroAtColumnPrecisionButScored: roundsToZeroButScored,
  },
  perSource,
  completenessAfter: completenessIn(after.ranked),
  top100: {
    sameInputBothRules: withoutRows(top100VsSimulated),
    againstRealPreviousBoard: top100VsReal ? withoutRows(top100VsReal) : null,
    lacksRiskMetric: share(afterTop100.filter(lacksRisk).length, afterTop100.length),
    completeness: completenessIn(afterTop100),
    idleRows: afterTop100.filter((row) => row.idle).length,
  },
  top500: {
    lacksRiskMetric: share(
      top(after.ranked, 500).filter(lacksRisk).length,
      Math.min(500, after.ranked.length)
    ),
    completeness: completenessIn(top(after.ranked, 500)),
    idleRows: top(after.ranked, 500).filter((row) => row.idle).length,
  },
  simulationFidelity,
  idleRows: {
    ranked: share(idleAfter.length, after.ranked.length),
    amongAddedRows: share(added.filter((row) => row.idle).length, added.length),
    firstIdleRank,
    lastActiveRank,
    idleRowsAheadOfAnActiveRow: idleAheadOfActive,
    score: quantiles(idleAfter.map((row) => row.arena_score)),
    bySource: countBy(idleAfter, (row) => row.source),
  },
  previouslyRankedIdleWithZeroDrawdown: {
    rows: previouslyRankedIdleZeroDrawdown.length,
    bySource: countBy(previouslyRankedIdleZeroDrawdown, (row) => row.source),
    rankBefore: quantiles(idleZeroDrawdownMoves.map((move) => move.before)),
    rankAfter: quantiles(idleZeroDrawdownMoves.map((move) => move.after).filter(Number.isFinite)),
    rankChange: quantiles(
      idleZeroDrawdownMoves.map((move) => move.after - move.before).filter(Number.isFinite)
    ),
    inRealTop500: idleZeroDrawdownInRealTop500.length,
    inRealTop100: idleZeroDrawdownInRealTop500.filter((row) => realTopByKey.get(row.key)! <= 100)
      .length,
  },
  contradictoryDrawdown: {
    definition: 'ROI < 0 or PnL < 0 with a 0% max drawdown (stored precision): drawdown refused',
    rows: after.ranked.filter((row) => row.contradiction).length,
    bySource: countBy(
      after.ranked.filter((row) => row.contradiction),
      (row) => row.source
    ),
    exactZeroInInput: scoreRows.filter(
      (row) =>
        row.max_drawdown === 0 &&
        ((row.roi_pct !== null && row.roi_pct < 0) || (row.pnl_usd !== null && row.pnl_usd < 0))
    ).length,
    roiPositivePnlNegative: after.ranked.filter(
      (row) => row.contradiction && row.roi > 0 && row.pnl < 0
    ).length,
    rank: quantiles(after.ranked.filter((row) => row.contradiction).map((row) => row.rank)),
    inNewTop100: afterTop100.filter((row) => row.contradiction).length,
  },
  signMismatch: {
    definition: 'ROI and PnL have opposite signs (stored precision); counted only',
    rows: after.ranked.filter((row) => hasSignMismatch(row)).length,
    bySource: countBy(
      after.ranked.filter((row) => hasSignMismatch(row)),
      (row) => row.source
    ),
    roiPositivePnlNegative: after.ranked.filter((row) => hasSignMismatch(row) && row.roi > 0)
      .length,
    alsoContradictoryDrawdown: after.ranked.filter(
      (row) => hasSignMismatch(row) && row.contradiction
    ).length,
    inNewTop100: afterTop100.filter((row) => hasSignMismatch(row)).length,
    rank: quantiles(after.ranked.filter((row) => hasSignMismatch(row)).map((row) => row.rank)),
  },
  losingRows: {
    definition: 'roi < 0 or pnl < 0 (not idle)',
    ranked: share(losingAfter.length, after.ranked.length),
    belowAnyIdleRow: losingBelowIdle,
    rank: quantiles(losingAfter.map((row) => row.rank)),
    lowestLosingRank: losingAfter.length ? Math.max(...losingAfter.map((row) => row.rank)) : null,
  },
  previouslyRankedActiveRows: {
    count: survivors.length,
    relativeOrderChanged: relativeShift.filter((shift) => shift !== 0).length,
    relativeRankShift: quantiles(relativeShift),
  },
  scores: {
    rowsAtIdleScore001: after.ranked.filter((row) => row.arena_score === 0.01).length,
    rowsAtActiveFloor002: after.ranked.filter((row) => row.arena_score === 0.02).length,
    distinctScores: tieSizes.size,
    largestTies,
  },
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  for (const [label, value] of Object.entries(report)) {
    process.stdout.write(`${label}: ${JSON.stringify(value)}\n`)
  }
}

if (markdownPath) {
  const json = (value: unknown) => `\`${JSON.stringify(value)}\``
  const lines = [
    `## ${argument('label') ?? season}`,
    '',
    `Input: ${report.rows.scoreInput} score rows. Ranked before (simulated four-metric rule): ${report.rows.rankedBefore}. Ranked after: ${report.rows.rankedAfter} (+${report.rows.added}, -${report.rows.removed}).`,
    '',
    '### Per source (candidates / before / after / added / idle after)',
    '',
    '| source | candidates | before | after | added | idle after |',
    '|---|---:|---:|---:|---:|---:|',
    ...perSource.map(
      (row) =>
        `| ${row.source} | ${row.candidates} | ${row.before} | ${row.after} | ${row.added} | ${row.idleAfter} |`
    ),
    '',
    '### Top 100',
    '',
    `- Same input under both rules (isolates this change): kept ${report.top100.sameInputBothRules.keptInTop100}; entrants ${report.top100.sameInputBothRules.entrants}, by source ${json(report.top100.sameInputBothRules.entrantsBySource)}, by completeness ${json(report.top100.sameInputBothRules.entrantsByCompleteness)}, not ranked before ${report.top100.sameInputBothRules.entrantsNotRankedBefore}; new rank of the previous top 100 ${json(report.top100.sameInputBothRules.newRankOfPreviousTop100)}`,
    ...(report.top100.againstRealPreviousBoard
      ? [
          `- Against the real previous board (--before-top; includes everything else that moved since that publication): kept ${report.top100.againstRealPreviousBoard.keptInTop100}; entrants ${report.top100.againstRealPreviousBoard.entrants}, by source ${json(report.top100.againstRealPreviousBoard.entrantsBySource)}, by completeness ${json(report.top100.againstRealPreviousBoard.entrantsByCompleteness)}, not ranked in the simulated previous board ${report.top100.againstRealPreviousBoard.entrantsNotRankedBefore}; new rank of the real previous top 100 ${json(report.top100.againstRealPreviousBoard.newRankOfPreviousTop100)}; no longer ranked ${report.top100.againstRealPreviousBoard.previousTop100NoLongerRanked}`,
        ]
      : []),
    `- Of the entrants (same input), rows whose drawdown is exactly 0: ${report.top100.sameInputBothRules.entrantsWithDrawdownExactlyZero}; below 1%: ${report.top100.sameInputBothRules.entrantsWithDrawdownBelowOnePercent}; win rate exactly 0: ${report.top100.sameInputBothRules.entrantsWithWinRateExactlyZero}`,
    `- Rows lacking a risk metric in the new top 100: ${report.top100.lacksRiskMetric}; completeness ${json(report.top100.completeness)}; idle rows ${report.top100.idleRows}`,
    `- Rows lacking a risk metric in the new top 500: ${report.top500.lacksRiskMetric}; completeness ${json(report.top500.completeness)}; idle rows ${report.top500.idleRows}`,
    ...(simulationFidelity ? [`- Simulation fidelity: ${json(simulationFidelity)}`] : []),
    '',
    '### Idle rows (ROI 0 and PnL 0)',
    '',
    `- In the input: ${report.inputIdle.rows}; with drawdown exactly 0: ${report.inputIdle.withDrawdownExactlyZero} ${json(report.inputIdle.withDrawdownExactlyZeroBySource)}; with win rate exactly 0: ${report.inputIdle.withWinRateExactlyZero}; without a drawdown: ${report.inputIdle.withoutDrawdown}`,
    `- Ranked after: ${report.idleRows.ranked}; among the added rows: ${report.idleRows.amongAddedRows}`,
    `- First idle rank: ${report.idleRows.firstIdleRank}; last rank of a row with a profit or loss: ${report.idleRows.lastActiveRank}; idle rows ahead of such a row: ${report.idleRows.idleRowsAheadOfAnActiveRow}`,
    `- Idle rows by source: ${json(report.idleRows.bySource)}`,
    `- Rows that round to ROI 0.0000 / PnL 0.00 but are not exactly zero (scored, not idle): ${report.inputIdle.roundToZeroAtColumnPrecisionButScored}`,
    '',
    '### Idle rows with a 0% drawdown that are on the board today',
    '',
    `- Rows: ${report.previouslyRankedIdleWithZeroDrawdown.rows}; by source ${json(report.previouslyRankedIdleWithZeroDrawdown.bySource)}`,
    `- Rank before: ${json(report.previouslyRankedIdleWithZeroDrawdown.rankBefore)}`,
    `- Rank after: ${json(report.previouslyRankedIdleWithZeroDrawdown.rankAfter)}`,
    `- Rank change (after - before): ${json(report.previouslyRankedIdleWithZeroDrawdown.rankChange)}`,
    `- Of them in the real previous top 500: ${report.previouslyRankedIdleWithZeroDrawdown.inRealTop500}; in the real previous top 100: ${report.previouslyRankedIdleWithZeroDrawdown.inRealTop100}`,
    '',
    '### Contradictory drawdown (ROI < 0 or PnL < 0, with a 0% max drawdown)',
    '',
    `- Rows whose drawdown was refused: ${report.contradictoryDrawdown.rows}; by source ${json(report.contradictoryDrawdown.bySource)}; with a drawdown of exactly 0 in the input: ${report.contradictoryDrawdown.exactZeroInInput}; rank ${json(report.contradictoryDrawdown.rank)}; in the new top 100: ${report.contradictoryDrawdown.inNewTop100}`,
    '',
    '### Sign mismatch (ROI and PnL with opposite signs; counted only)',
    '',
    `- Rows: ${report.signMismatch.rows}; by source ${json(report.signMismatch.bySource)}; ROI positive with PnL negative: ${report.signMismatch.roiPositivePnlNegative}; also a refused drawdown: ${report.signMismatch.alsoContradictoryDrawdown}; in the new top 100: ${report.signMismatch.inNewTop100}; rank ${json(report.signMismatch.rank)}`,
    '',
    '### Losing rows relative to idle rows',
    '',
    `- Losing rows ranked: ${report.losingRows.ranked}; ranked below any idle row: ${report.losingRows.belowAnyIdleRow}; lowest losing rank: ${report.losingRows.lowestLosingRank}; rank ${json(report.losingRows.rank)}`,
    '',
    '### Other',
    '',
    `- Completeness after: ${json(report.completenessAfter)}`,
    `- Excluded before ${json(report.excludedBefore)}; excluded after ${json(report.excludedAfter)}`,
    `- Previously ranked rows with a profit or loss: ${json(report.previouslyRankedActiveRows)}`,
    `- Scores: ${json(report.scores)}`,
    ...(notRankable.length > 0
      ? [`- Sources not publicly rankable (dropped): ${json(notRankable)}`]
      : []),
    ...(process.argv.includes('--identities')
      ? [
          '',
          '### New top-100 entrants (real identities: do not commit or paste into a PR)',
          '',
          '| new rank | source | trader key | completeness | score | ranked before |',
          '|---:|---|---|---|---:|---|',
          ...entrants.map(
            (row) =>
              `| ${row.rank} | ${row.source} | ${row.traderKey} | ${row.score_completeness} | ${row.arena_score} | ${beforeByKey.has(row.key) ? `yes (#${beforeByKey.get(row.key)!.rank} simulated)` : 'no'} |`
          ),
        ]
      : []),
    '',
  ]
  appendFileSync(markdownPath, `${lines.join('\n')}\n`)
}

const top20Path = argument('top20-markdown')
if (top20Path) {
  const inputByKey = new Map(
    scoreRows.map((row) => [
      identity(row.platform, row.trader_key),
      row as ScoreRow & { handle?: string | null },
    ])
  )
  const cell = (value: number | null | undefined, digits: number) =>
    value === null || value === undefined ? '—' : value.toFixed(digits)
  const describe = (key: string) => {
    const input = inputByKey.get(key)
    const [source, traderKey] = key.split('\u0000')
    const handle = (input?.handle ?? '').replace(/\|/g, '/').trim() || traderKey
    return `| ${source} | ${handle} | ${cell(input?.roi_pct, 2)} | ${cell(input?.pnl_usd, 2)} | ${cell(input?.max_drawdown, 2)} | ${cell(input?.win_rate, 2)} |`
  }
  // Previous ranks: the served board when given (top 500 only), else simulated.
  const previousRank = (key: string): string =>
    realBeforeTop
      ? realTopByKey.has(key)
        ? String(realTopByKey.get(key))
        : beforeByKey.has(key)
          ? '>500'
          : '未上榜'
      : beforeByKey.has(key)
        ? String(beforeByKey.get(key)!.rank)
        : '未上榜'
  const newRank = (key: string): string => {
    const row = afterByKey.get(key)
    if (!row) return '不在导出里'
    return `${row.rank}${row.contradiction ? '（回撤拒收）' : ''}${row.idle ? '（空窗）' : ''}`
  }
  const previousTop20 = realBeforeTop
    ? realBeforeTop.slice(0, 20).map((row) => row.key)
    : top(before.ranked, 20).map((row) => row.key)
  const header = [
    '| # | 平台 | 昵称 | ROI % | PnL | 回撤 % | 胜率 % | 旧名次 | 新名次 |',
    '|---:|---|---|---:|---:|---:|---:|---:|---:|',
  ]
  const lines = [
    `### ${argument('label') ?? season}：旧前 20 名，以及它们的新名次`,
    '',
    `旧名次来自${realBeforeTop ? '线上榜单（top500 CSV）' : '模拟的旧规则榜单'}；指标是导出时的当前值。`,
    '',
    ...header,
    ...previousTop20.map(
      (key, index) => `| ${index + 1} ${describe(key)} ${previousRank(key)} | ${newRank(key)} |`
    ),
    '',
    `### ${argument('label') ?? season}：新前 20 名，以及它们的旧名次`,
    '',
    ...header,
    ...top(after.ranked, 20).map(
      (row, index) =>
        `| ${index + 1} ${describe(row.key)} ${previousRank(row.key)} | ${newRank(row.key)} |`
    ),
    '',
  ]
  appendFileSync(top20Path, `${lines.join('\n')}\n`)
}
