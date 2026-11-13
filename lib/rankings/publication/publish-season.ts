/**
 * One complete, all-or-nothing public leaderboard publication for one season.
 *
 * Database protocol (see docs/RANK_PUBLICATION_PROTOCOL.md for line numbers):
 *
 *   1. read the score-input publish bundle + the season's expected sources
 *   2. refuse unless EVERY expected source has fresh (<48h) PASSED evidence
 *   3. score the fresh rows and keep only rows the DB eligibility policy admits
 *   4. claim one fenced generation (claim_leaderboard_rank_generation)
 *   5. upsert every row with rank_publication_id = score cohort
 *   6. cleanup_leaderboard_rank_publication  (delete every other authority row)
 *   7. rerank_leaderboard_publication        (season-global ROW_NUMBER)
 *   8. seal_leaderboard_rank_publication     (receipt + freshness proofs; the
 *      freshness trigger then advances the public serving head)
 *   9. confirm the season is now served by public_ranked_leaderboard
 *
 * Every step runs inside ONE READ COMMITTED transaction owned by the caller's
 * `database.transaction`. Any failure rolls back the claim, the row writes and
 * the cleanup together, so the previously sealed serving head keeps serving
 * (a committed partial write would bump the season mutation fence and blank
 * the public view until the next successful seal).
 *
 * This module has no Next.js, Supabase-client, Redis, or environment
 * dependency; the worker supplies a pg transaction and the cohort scorer.
 */

import { createHash, randomUUID } from 'node:crypto'

import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { claimLeaderboardRankGeneration } from './claim-rank-generation'
import { cleanupLeaderboardRankPublication } from './cleanup-rank-publication'
import { createPgRpcClient, type RankPublicationSqlExecutor } from './pg-rpc-client'
import { readSourcePublicationBundle } from './read-source-publication-bundle'
import { rerankLeaderboardPublication } from './rerank-rank-publication'
import { scoreTraders, type ScoredTrader } from './score-traders'
import type { ArenaFollowerCountSource } from './scoring-helpers'
import { sealLeaderboardRankPublication } from './seal-rank-publication'
import {
  buildSourcePublicationRows,
  type ParsedSourcePublicationEvidence,
  type PublicationWindow,
  type SourcePublicationRow,
} from './source-publication-evidence'
import type { TraderRow } from './trader-row'

/**
 * Claim lease (15s database minimum). Once the season is sealed and served,
 * the same transaction releases it through
 * release_leaderboard_rank_generation_lease (20261113010326), so a committed
 * publication no longer blocks the next one. Before that migration exists the
 * lease simply expires after COMMIT, as before.
 */
export const RANK_PUBLICATION_LEASE_SECONDS = 15
/** Claim RPC: the module requires timeout <= lease/3 (5s). */
export const RANK_PUBLICATION_CLAIM_TIMEOUT_MS = 5_000
/**
 * The server cancels the claim (e.g. waiting on a concurrent publisher's head
 * row lock) before the client deadline, so the outcome is a deterministic
 * error, never an ambiguous retry on an aborted transaction.
 */
export const RANK_PUBLICATION_CLAIM_STATEMENT_TIMEOUT = '4s'
export const RANK_PUBLICATION_STEP_TIMEOUT_MS = 60_000
export const RANK_PUBLICATION_STEP_STATEMENT_TIMEOUT = '50s'
export const RANK_PUBLICATION_WRITE_CHUNK = 1_000
const MAX_ROWS_PER_GENERATION = 64_000

export type RankPublicationErrorCode =
  | 'season_authority_empty'
  | 'expected_source_not_fresh'
  | 'no_publishable_rows'
  | 'too_many_rows'
  | 'duplicate_identity'
  | 'write_incomplete'
  | 'not_serving_after_seal'

export class RankPublicationError extends Error {
  constructor(
    public readonly code: RankPublicationErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'RankPublicationError'
  }
}

export interface RankPublicationDatabase {
  /**
   * Run `work` inside one READ COMMITTED transaction on one connection.
   * Commit when it resolves, roll back when it throws.
   */
  transaction<T>(work: (tx: RankPublicationSqlExecutor) => Promise<T>): Promise<T>
}

export interface RankPublicationScoringContext {
  /** The publication transaction (reads only; never commit/rollback here). */
  tx: RankPublicationSqlExecutor
  /** Display handle/avatar carried by the same score-input bundle rows. */
  handleMap: Map<string, { handle: string | null; avatar_url: string | null }>
}

export type RankPublicationCohortScorer = (
  traderRows: TraderRow[],
  season: PublicationWindow,
  context: RankPublicationScoringContext
) => Promise<ScoredTrader[]>

/**
 * Default scorer: the existing Arena Score v4 path (`scoreTraders`) with Arena
 * follower counts read through the same transaction. Returns the publishable
 * cohort (`scoredFiltered`).
 */
export function createDefaultCohortScorer(): RankPublicationCohortScorer {
  return async (traderRows, season, { tx, handleMap }) => {
    const followers: ArenaFollowerCountSource = {
      async countTraderAccountFollowers(traderIds, sources) {
        const result = await tx.query<{ trader_id: string; source: string; cnt: number | string }>(
          `SELECT counted.trader_id, counted.source, counted.cnt
             FROM public.count_trader_account_followers(
               p_trader_ids => $1::text[], p_sources => $2::text[]
             ) AS counted`,
          [traderIds, sources]
        )
        return result.rows.map((row) => ({
          trader_id: row.trader_id,
          source: row.source,
          cnt: Number(row.cnt),
        }))
      },
    }
    const { scoredFiltered } = await scoreTraders(
      traderRows,
      handleMap,
      new Set(),
      season,
      followers
    )
    return scoredFiltered
  }
}

/**
 * One operator-facing alert raised by a publication. The orchestrator never
 * depends on the alert channel: delivery failures are logged and swallowed so
 * the publication outcome (commit or rollback) is decided only by the data.
 */
export interface RankPublicationAlert {
  season: PublicationWindow
  /** 'critical' = the season was not published; 'warning' = published, degraded. */
  severity: 'critical' | 'warning'
  code: 'excluded_rows_over_threshold' | 'season_publication_refused' | 'sources_isolated'
  message: string
  details: Record<string, unknown>
}

export type RankPublicationAlertSink = (alert: RankPublicationAlert) => Promise<void> | void

export interface PublishLeaderboardSeasonDependencies {
  database: RankPublicationDatabase
  /** Must return the publishable cohort (scoreTraders' `scoredFiltered`). */
  scoreCohort: RankPublicationCohortScorer
  newScoreCohortId?: () => string
  log?: (message: string) => void
  /** Operator alert channel (worker: lib/ingest/alerting). Optional. */
  alert?: RankPublicationAlertSink
}

/** Why a scored trader did not become a published row. */
export type RankRowExclusionReason =
  | 'source_not_expected'
  | 'invalid_identity'
  | 'incomplete_or_estimated'
  | 'outlier'
  | 'arena_score_out_of_range'
  | 'roi_out_of_range'
  | 'pnl_out_of_range'
  | 'win_rate_missing_or_out_of_range'
  | 'max_drawdown_missing'
  | 'max_drawdown_liquidated'
  | 'max_drawdown_negative'

export interface RankRowExclusionSummary {
  /** Scored traders considered (expected + unexpected sources). */
  scored: number
  excluded: number
  byReason: Partial<Record<RankRowExclusionReason, number>>
  /** source -> reason -> count (expected sources only). */
  bySource: Record<string, Partial<Record<RankRowExclusionReason, number>>>
}

/**
 * Alert (not refuse) when more than this share of a season's scored rows, or
 * of one expected source's scored rows (with at least
 * RANK_EXCLUSION_ALERT_MIN_SOURCE_ROWS of them), is excluded. Mass exclusion
 * is how a silent upstream metric regression (e.g. NULL drawdowns from a stale
 * trader_stats join) would otherwise shrink the public board unnoticed.
 */
export const RANK_EXCLUSION_ALERT_RATIO = 0.25
export const RANK_EXCLUSION_ALERT_SOURCE_RATIO = 0.5
export const RANK_EXCLUSION_ALERT_MIN_SOURCE_ROWS = 20

export interface PublishedSourceSummary {
  source: string
  source_as_of: string
  published_rank_count: number
}

export interface PublishLeaderboardSeasonResult {
  season: PublicationWindow
  scoreCohortId: string
  generationSeq: number
  computedAt: string
  publishedAt: string
  publishedRankCount: number
  deletedRankCount: number
  sources: PublishedSourceSummary[]
  exclusions: RankRowExclusionSummary
  /** True when the claim lease was released inside the publishing transaction. */
  leaseReleased: boolean
}

interface PublishableRow {
  source: string
  source_type: string
  source_trader_id: string
  arena_score: number
  arena_score_v3: number | null
  arena_score_v4: number | null
  score_factors: unknown
  roi: number
  pnl: number
  win_rate: number
  max_drawdown: number
  followers: number | null
  copiers: number | null
  trades_count: number | null
  handle: string | null
  avatar_url: string | null
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  score_completeness: 'full'
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  profit_factor: number | null
  calmar_ratio: number | null
  trader_type: string | null
  is_outlier: false
  metrics_estimated: false
}

const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

/** Round to a numeric(precision, scale) column; null when it cannot be stored. */
export function fitNumeric(
  value: number | null | undefined,
  precision: number,
  scale: number
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** scale
  const rounded = Math.round(value * factor) / factor
  const limit = 10 ** (precision - scale)
  if (Math.abs(rounded) >= limit) return null
  return rounded
}

function fitInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= -2_147_483_648 && rounded <= 2_147_483_647 ? rounded : null
}

/**
 * Project one scored trader onto the persisted leaderboard_ranks codec
 * (20261111140053 column types) and the database row policy
 * arena.leaderboard_rank_row_is_public_eligible. Returns null when the row
 * could never be sealed; optional ratios that overflow their numeric(10,4)
 * columns become NULL instead of failing the whole season.
 */
export function toPublishableRow(trader: ScoredTrader): PublishableRow | null {
  const verdict = classifyPublishableRow(trader)
  return 'row' in verdict ? verdict.row : null
}

/**
 * Same projection as toPublishableRow, but says WHY a row is excluded so the
 * publication can count and report exclusions instead of dropping them
 * silently. The first failing rule wins (identity, then completeness, then the
 * numeric policy in column order).
 */
export function classifyPublishableRow(
  trader: ScoredTrader
): { row: PublishableRow } | { reason: RankRowExclusionReason } {
  const source = trader.source
  const traderId = trader.source_trader_id
  if (
    !SOURCE_PATTERN.test(source) ||
    source !== source.trim().toLowerCase() ||
    traderId.trim() === '' ||
    traderId !== traderId.trim()
  ) {
    return { reason: 'invalid_identity' }
  }
  if (trader.score_completeness !== 'full' || trader.metrics_estimated !== false) {
    return { reason: 'incomplete_or_estimated' }
  }
  if (trader.is_outlier === true) return { reason: 'outlier' }
  const arenaScore = fitNumeric(trader.arena_score, 10, 2)
  const roi = fitNumeric(trader.roi, 12, 4)
  const pnl = fitNumeric(trader.pnl, 18, 2)
  const winRate = fitNumeric(trader.win_rate, 5, 2)
  const maxDrawdown = fitNumeric(trader.max_drawdown, 5, 2)
  if (arenaScore === null || arenaScore <= 0 || arenaScore > 100) {
    return { reason: 'arena_score_out_of_range' }
  }
  if (roi === null || roi < -10000 || roi > 10000) return { reason: 'roi_out_of_range' }
  if (pnl === null || pnl < -100_000_000 || pnl > 1_000_000_000) {
    return { reason: 'pnl_out_of_range' }
  }
  if (winRate === null || winRate < 0 || winRate > 100) {
    return { reason: 'win_rate_missing_or_out_of_range' }
  }
  if (maxDrawdown === null) {
    // A raw value that only overflowed numeric(5,2) is >= 1000 => liquidated.
    return {
      reason:
        trader.max_drawdown !== null &&
        trader.max_drawdown !== undefined &&
        Number.isFinite(trader.max_drawdown) &&
        trader.max_drawdown >= 100
          ? 'max_drawdown_liquidated'
          : 'max_drawdown_missing',
    }
  }
  if (maxDrawdown < 0) return { reason: 'max_drawdown_negative' }
  if (maxDrawdown >= 100) return { reason: 'max_drawdown_liquidated' }
  return {
    row: {
      source,
      source_type: SOURCE_TYPE_MAP[source] || 'futures',
      source_trader_id: traderId,
      arena_score: arenaScore,
      arena_score_v3: trader.arena_score_v3 ?? null,
      arena_score_v4: trader.arena_score_v4 ?? null,
      score_factors: trader.score_factors ?? null,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: fitInteger(trader.followers),
      copiers: fitInteger(trader.copiers),
      trades_count: fitInteger(trader.trades_count),
      handle: trader.handle,
      avatar_url: trader.avatar_url,
      profitability_score: fitNumeric(trader.profitability_score, 6, 2),
      risk_control_score: fitNumeric(trader.risk_control_score, 6, 2),
      execution_score: fitNumeric(trader.execution_score, 6, 2),
      score_completeness: 'full',
      trading_style: trader.trading_style,
      avg_holding_hours: fitNumeric(trader.avg_holding_hours, 10, 2),
      style_confidence: fitNumeric(trader.style_confidence, 6, 4),
      sharpe_ratio: fitNumeric(trader.sharpe_ratio, 10, 4),
      sortino_ratio: fitNumeric(trader.sortino_ratio, 10, 4),
      profit_factor: fitNumeric(trader.profit_factor, 10, 4),
      calmar_ratio: fitNumeric(trader.calmar_ratio, 10, 4),
      trader_type: trader.trader_type || (source === 'web3_bot' ? 'bot' : null),
      is_outlier: false,
      metrics_estimated: false,
    },
  }
}

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1
}

/** Exclusion alerts for a season that is otherwise publishable. */
export function exclusionAlertDetails(
  summary: RankRowExclusionSummary,
  scoredBySource: ReadonlyMap<string, number>
): {
  seasonRatio: number
  sources: Array<{ source: string; scored: number; excluded: number }>
} | null {
  const seasonRatio = summary.scored === 0 ? 0 : summary.excluded / summary.scored
  const sources: Array<{ source: string; scored: number; excluded: number }> = []
  for (const [source, reasons] of Object.entries(summary.bySource)) {
    const excluded = Object.values(reasons).reduce((total, count) => total + (count ?? 0), 0)
    const scored = scoredBySource.get(source) ?? 0
    if (
      scored >= RANK_EXCLUSION_ALERT_MIN_SOURCE_ROWS &&
      excluded / scored > RANK_EXCLUSION_ALERT_SOURCE_RATIO
    ) {
      sources.push({ source, scored, excluded })
    }
  }
  if (seasonRatio <= RANK_EXCLUSION_ALERT_RATIO && sources.length === 0) return null
  return { seasonRatio, sources }
}

async function deliverAlert(
  deps: PublishLeaderboardSeasonDependencies,
  log: (message: string) => void,
  alert: RankPublicationAlert
): Promise<void> {
  log(`[${alert.season}] ALERT ${alert.severity} ${alert.code}: ${alert.message}`)
  if (!deps.alert) return
  try {
    await deps.alert(alert)
  } catch (error) {
    // Alert delivery must never decide a publication outcome; log loudly.
    console.error(
      `[rank-publication] alert delivery failed for ${alert.season} ${alert.code}:`,
      error instanceof Error ? error.message : error
    )
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function restrictEvidence(
  evidence: ParsedSourcePublicationEvidence,
  expected: ReadonlySet<string>
): ParsedSourcePublicationEvidence {
  return {
    window: evidence.window,
    scoreRows: evidence.scoreRows.filter((row) => expected.has(row.platform)),
    freshScoreRows: evidence.freshScoreRows.filter((row) => expected.has(row.platform)),
    aliases: evidence.aliases.filter((alias) => expected.has(alias.source)),
    freshAliases: evidence.freshAliases.filter((alias) => expected.has(alias.source)),
    retainedAliases: evidence.retainedAliases.filter((alias) => expected.has(alias.source)),
  }
}

const WRITE_SQL = `
INSERT INTO public.leaderboard_ranks (
  season_id, source, source_type, source_trader_id, rank,
  arena_score, roi, pnl, win_rate, max_drawdown,
  followers, trades_count, handle, avatar_url, computed_at,
  profitability_score, risk_control_score, execution_score, score_completeness,
  trading_style, avg_holding_hours, style_confidence,
  sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio,
  trader_type, is_outlier, metrics_estimated, rank_change, is_new,
  copiers, arena_score_v4, arena_score_v3, score_factors, rank_publication_id
)
SELECT
  $2::text, r.source, r.source_type, r.source_trader_id, NULL::integer,
  r.arena_score, r.roi, r.pnl, r.win_rate, r.max_drawdown,
  r.followers, r.trades_count, r.handle, r.avatar_url, $3::timestamptz,
  r.profitability_score, r.risk_control_score, r.execution_score, r.score_completeness,
  r.trading_style, r.avg_holding_hours, r.style_confidence,
  r.sharpe_ratio, r.sortino_ratio, r.profit_factor, r.calmar_ratio,
  r.trader_type, r.is_outlier, r.metrics_estimated, NULL::integer, false,
  r.copiers, r.arena_score_v4, r.arena_score_v3, r.score_factors, $4::uuid
FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(
  source text, source_type text, source_trader_id text,
  arena_score numeric, roi numeric, pnl numeric, win_rate numeric, max_drawdown numeric,
  followers integer, trades_count integer, handle text, avatar_url text,
  profitability_score numeric, risk_control_score numeric, execution_score numeric,
  score_completeness text, trading_style text, avg_holding_hours numeric,
  style_confidence numeric, sharpe_ratio numeric, sortino_ratio numeric,
  profit_factor numeric, calmar_ratio numeric, trader_type text,
  is_outlier boolean, metrics_estimated boolean, copiers integer,
  arena_score_v4 numeric, arena_score_v3 numeric, score_factors jsonb
)
ON CONFLICT (season_id, source, source_trader_id) DO UPDATE SET
  source_type = EXCLUDED.source_type,
  rank = NULL,
  arena_score = EXCLUDED.arena_score,
  roi = EXCLUDED.roi,
  pnl = EXCLUDED.pnl,
  win_rate = EXCLUDED.win_rate,
  max_drawdown = EXCLUDED.max_drawdown,
  followers = EXCLUDED.followers,
  trades_count = EXCLUDED.trades_count,
  handle = EXCLUDED.handle,
  avatar_url = EXCLUDED.avatar_url,
  computed_at = EXCLUDED.computed_at,
  profitability_score = EXCLUDED.profitability_score,
  risk_control_score = EXCLUDED.risk_control_score,
  execution_score = EXCLUDED.execution_score,
  score_completeness = EXCLUDED.score_completeness,
  trading_style = EXCLUDED.trading_style,
  avg_holding_hours = EXCLUDED.avg_holding_hours,
  style_confidence = EXCLUDED.style_confidence,
  sharpe_ratio = EXCLUDED.sharpe_ratio,
  sortino_ratio = EXCLUDED.sortino_ratio,
  profit_factor = EXCLUDED.profit_factor,
  calmar_ratio = EXCLUDED.calmar_ratio,
  trader_type = EXCLUDED.trader_type,
  is_outlier = EXCLUDED.is_outlier,
  metrics_estimated = EXCLUDED.metrics_estimated,
  rank_change = NULL,
  is_new = false,
  copiers = EXCLUDED.copiers,
  arena_score_v4 = EXCLUDED.arena_score_v4,
  arena_score_v3 = EXCLUDED.arena_score_v3,
  score_factors = EXCLUDED.score_factors,
  rank_publication_id = EXCLUDED.rank_publication_id
`

function writeSetSha256(season: PublicationWindow, rows: readonly PublishableRow[]): string {
  const canonical = [...rows]
    .sort(
      (left, right) =>
        compareText(left.source, right.source) ||
        compareText(left.source_trader_id, right.source_trader_id)
    )
    .map((row) => [row.source, row.source_trader_id, row.arena_score, row.roi, row.pnl])
  return createHash('sha256')
    .update(JSON.stringify({ contract: 'arena-rank-write-set@1', season, rows: canonical }))
    .digest('hex')
}

/**
 * Publish one season. Resolves only after the season is confirmed served by
 * `public.public_ranked_leaderboard`; otherwise throws and the transaction is
 * rolled back by `database.transaction`.
 */
export async function publishLeaderboardSeason(
  season: PublicationWindow,
  deps: PublishLeaderboardSeasonDependencies
): Promise<PublishLeaderboardSeasonResult> {
  const log = deps.log ?? (() => undefined)
  const scoreCohortId = (deps.newScoreCohortId ?? randomUUID)().toLowerCase()

  return deps.database.transaction(async (tx) => {
    const rpc = createPgRpcClient(tx)
    await tx.query(`SET LOCAL statement_timeout = '${RANK_PUBLICATION_STEP_STATEMENT_TIMEOUT}'`)

    const clock = await tx.query<{ now: string }>(
      `SELECT pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`
    )
    const computedAt = clock.rows[0].now

    // 1. Season authority and score-input evidence.
    const authority = await tx.query<{ source: string }>(
      `SELECT DISTINCT expected.filter_source AS source
         FROM public.arena_freshness_expected_sources() AS expected
        WHERE expected.season_id = $1`,
      [season]
    )
    const expectedSources = authority.rows.map((row) => row.source).sort(compareText)
    if (expectedSources.length === 0) {
      throw new RankPublicationError(
        'season_authority_empty',
        `[${season}] no active serving source declares this season`
      )
    }
    const expected = new Set(expectedSources)
    const bundle = await readSourcePublicationBundle(rpc, season, { now: new Date(computedAt) })

    // 2. All-or-nothing freshness gate: a season is never published partially.
    const freshSources = new Set(bundle.evidence.freshAliases.map((alias) => alias.source))
    const notFresh = expectedSources
      .filter((source) => !freshSources.has(source))
      .map((source) => {
        const retained = bundle.evidence.retainedAliases.find((alias) => alias.source === source)
        return { source, reasons: retained ? retained.denial_reasons : ['missing'] }
      })
    if (notFresh.length > 0) {
      throw new RankPublicationError(
        'expected_source_not_fresh',
        `[${season}] ${notFresh.length}/${expectedSources.length} expected source(s) lack fresh evidence: ${notFresh
          .map((entry) => `${entry.source}(${entry.reasons.join('+')})`)
          .join(', ')}`,
        { notFresh }
      )
    }
    const evidence = restrictEvidence(bundle.evidence, expected)

    // 3. Score the fresh authority rows; keep only DB-sealable rows.
    const traderRows = bundle.traderRows.filter((row) => expected.has(row.source))
    const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
    for (const row of evidence.freshScoreRows) {
      handleMap.set(`${row.platform}:${row.trader_key}`, {
        handle: row.handle,
        avatar_url: row.avatar_url,
      })
    }
    const scored = await deps.scoreCohort(traderRows, season, { tx, handleMap })
    const rows: PublishableRow[] = []
    const identities = new Map<string, string[]>(expectedSources.map((source) => [source, []]))
    const seen = new Set<string>()
    const exclusions: RankRowExclusionSummary = {
      scored: scored.length,
      excluded: 0,
      byReason: {},
      bySource: {},
    }
    const scoredBySource = new Map<string, number>()
    for (const trader of scored) {
      if (!expected.has(trader.source)) {
        exclusions.excluded += 1
        bump(exclusions.byReason, 'source_not_expected')
        continue
      }
      scoredBySource.set(trader.source, (scoredBySource.get(trader.source) ?? 0) + 1)
      const verdict = classifyPublishableRow(trader)
      if ('reason' in verdict) {
        exclusions.excluded += 1
        bump(exclusions.byReason, verdict.reason)
        exclusions.bySource[trader.source] ??= {}
        bump(exclusions.bySource[trader.source], verdict.reason)
        continue
      }
      const row = verdict.row
      const key = JSON.stringify([row.source, row.source_trader_id])
      if (seen.has(key)) {
        throw new RankPublicationError(
          'duplicate_identity',
          `[${season}] scorer returned ${row.source}:${row.source_trader_id} twice`
        )
      }
      seen.add(key)
      rows.push(row)
      identities.get(row.source)?.push(row.source_trader_id)
    }
    if (rows.length === 0) {
      throw new RankPublicationError(
        'no_publishable_rows',
        `[${season}] no scored row satisfies the public eligibility policy`
      )
    }
    if (rows.length > MAX_ROWS_PER_GENERATION) {
      throw new RankPublicationError(
        'too_many_rows',
        `[${season}] ${rows.length} rows exceed the ${MAX_ROWS_PER_GENERATION}-row generation bound`
      )
    }
    log(
      `[${season}] ${rows.length} publishable rows across ${expectedSources.length} sources (${exclusions.excluded} excluded: ${JSON.stringify(exclusions.byReason)})`
    )
    const exclusionAlert = exclusionAlertDetails(exclusions, scoredBySource)

    const finalRankCounts = new Map(
      expectedSources.map((source) => [source, identities.get(source)?.length ?? 0])
    )
    const freshPublications: SourcePublicationRow[] = buildSourcePublicationRows(evidence, {
      publishId: scoreCohortId,
      finalRankCounts,
    })

    // 4. Claim one fenced generation (rolled back with everything else on failure).
    await tx.query(`SET LOCAL statement_timeout = '${RANK_PUBLICATION_CLAIM_STATEMENT_TIMEOUT}'`)
    const claim = await claimLeaderboardRankGeneration(
      rpc,
      {
        season,
        scoreCohortId,
        writeSetSha256: writeSetSha256(season, rows),
        expectedRankCount: rows.length,
        expectedBatchCount: Math.ceil(rows.length / RANK_PUBLICATION_WRITE_CHUNK),
        computedAt,
        leaseSeconds: RANK_PUBLICATION_LEASE_SECONDS,
      },
      { timeoutMs: RANK_PUBLICATION_CLAIM_TIMEOUT_MS }
    )
    await tx.query(`SET LOCAL statement_timeout = '${RANK_PUBLICATION_STEP_STATEMENT_TIMEOUT}'`)

    // 5. Write every row with the cohort token.
    let written = 0
    for (let offset = 0; offset < rows.length; offset += RANK_PUBLICATION_WRITE_CHUNK) {
      const chunk = rows.slice(offset, offset + RANK_PUBLICATION_WRITE_CHUNK)
      const result = await tx.query(WRITE_SQL, [
        JSON.stringify(chunk),
        season,
        computedAt,
        scoreCohortId,
      ])
      written += result.rowCount ?? 0
    }
    if (written !== rows.length) {
      throw new RankPublicationError(
        'write_incomplete',
        `[${season}] wrote ${written} of ${rows.length} rows`
      )
    }

    const stepOptions = { timeoutMs: RANK_PUBLICATION_STEP_TIMEOUT_MS }
    const finalEligibleIdentityMap: ReadonlyMap<string, readonly string[]> = identities

    // 6-8. Cleanup, global rerank, seal.
    const cleanup = await cleanupLeaderboardRankPublication(
      rpc,
      { season, scoreCohortId, freshPublications, finalEligibleIdentityMap },
      stepOptions
    )
    await rerankLeaderboardPublication(rpc, { season, scoreCohortId }, stepOptions)
    const seal = await sealLeaderboardRankPublication(
      rpc,
      { season, scoreCohortId, freshPublications, finalEligibleIdentityMap },
      stepOptions
    )

    // 9. The public view must now serve this season; otherwise roll back.
    const serving = await tx.query<{ season_id: string }>(
      `SELECT serving.season_id
         FROM arena.public_ranked_leaderboard_serving_seasons(pg_catalog.statement_timestamp())
           AS serving
        WHERE serving.season_id = $1`,
      [season]
    )
    if (serving.rows.length !== 1) {
      throw new RankPublicationError(
        'not_serving_after_seal',
        `[${season}] seal committed no serving head; rolling back`
      )
    }

    // 10. Release the claim lease, bound to this cohort and this transaction
    // (the release RPC requires the seal receipt this transaction inserted).
    const releaseAvailable = await tx.query<{ available: boolean }>(
      `SELECT pg_catalog.to_regprocedure(
         'public.release_leaderboard_rank_generation_lease(text,uuid)'
       ) IS NOT NULL AS available`
    )
    let leaseReleased = false
    if (releaseAvailable.rows[0]?.available === true) {
      await tx.query(
        `SELECT public.release_leaderboard_rank_generation_lease(
           p_season_id => $1, p_score_cohort_id => $2::uuid
         ) AS result`,
        [season, scoreCohortId]
      )
      leaseReleased = true
    } else {
      log(
        `[${season}] lease release RPC not installed; the ${RANK_PUBLICATION_LEASE_SECONDS}s claim lease expires after COMMIT`
      )
    }

    if (exclusionAlert) {
      // Raised inside the transaction only after the season is confirmed
      // served; a later COMMIT failure still surfaces as the job error.
      await deliverAlert(deps, log, {
        season,
        severity: 'warning',
        code: 'excluded_rows_over_threshold',
        message: `${exclusions.excluded}/${exclusions.scored} scored rows excluded (${(
          exclusionAlert.seasonRatio * 100
        ).toFixed(1)}%)${
          exclusionAlert.sources.length > 0
            ? `; sources over ${RANK_EXCLUSION_ALERT_SOURCE_RATIO * 100}%: ${exclusionAlert.sources
                .map((entry) => `${entry.source} ${entry.excluded}/${entry.scored}`)
                .join(', ')}`
            : ''
        }`,
        details: { byReason: exclusions.byReason, sources: exclusionAlert.sources },
      })
    }

    return {
      season,
      scoreCohortId,
      generationSeq: claim.generation_seq,
      computedAt,
      publishedAt: seal.published_at,
      publishedRankCount: seal.trader_count,
      deletedRankCount: cleanup.deleted_count,
      sources: seal.proofs.map((proof) => ({
        source: proof.source,
        source_as_of: proof.source_as_of,
        published_rank_count: proof.published_rank_count,
      })),
      exclusions,
      leaseReleased,
    }
  })
}

/**
 * Wrap a node-postgres style connection factory as a RankPublicationDatabase.
 * The connection is released after COMMIT/ROLLBACK; a failed ROLLBACK
 * discards the connection instead of returning it to the pool.
 */
export function pgRankPublicationDatabase(
  connect: () => Promise<RankPublicationSqlExecutor & { release: (destroy?: boolean) => void }>
): RankPublicationDatabase {
  return {
    async transaction(work) {
      const client = await connect()
      let destroy = false
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        try {
          const result = await work(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch {
            destroy = true
          }
          throw error
        }
      } finally {
        client.release(destroy)
      }
    },
  }
}
