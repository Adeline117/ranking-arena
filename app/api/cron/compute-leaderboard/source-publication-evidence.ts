import { z } from 'zod'

export const SOURCE_PUBLICATION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000
export const DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS = 48

const publicationWindowSchema = z.enum(['7D', '30D', '90D'])
const identifierSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'must not have surrounding whitespace')
const nullableFiniteNumberSchema = z.number().nullable()
const nonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.min(1)

const scoreRowSchema = z
  .object({
    platform: identifierSchema,
    market_type: z.enum(['spot', 'futures']),
    trader_key: identifierSchema,
    board_rank: positiveSafeIntegerSchema.nullable(),
    roi_pct: nullableFiniteNumberSchema,
    pnl_usd: nullableFiniteNumberSchema,
    win_rate: nullableFiniteNumberSchema,
    max_drawdown: nullableFiniteNumberSchema,
    copiers: nonNegativeSafeIntegerSchema.nullable(),
    trades_count: nonNegativeSafeIntegerSchema.nullable(),
    sharpe_ratio: nullableFiniteNumberSchema,
    sortino_ratio: nullableFiniteNumberSchema,
    calmar_ratio: nullableFiniteNumberSchema,
    volatility_pct: nullableFiniteNumberSchema,
    trader_kind: z.string().nullable(),
    handle: z.string().nullable(),
    avatar_url: z.string().nullable(),
    currency: identifierSchema,
    as_of: identifierSchema,
    board_as_of: identifierSchema,
  })
  .strict()

const physicalBoardSchema = z
  .object({
    registry_slug: identifierSchema,
    filter_source: identifierSchema,
    window: publicationWindowSchema,
    snapshot_id: positiveSafeIntegerSchema.nullable(),
    scraped_at: identifierSchema.nullable(),
    actual_count: nonNegativeSafeIntegerSchema.nullable(),
    entry_count: nonNegativeSafeIntegerSchema.nullable(),
    rank_limit: positiveSafeIntegerSchema,
    rank_limited_entry_count: nonNegativeSafeIntegerSchema.nullable(),
    evidence_status: z.enum([
      'passed',
      'missing',
      'failed',
      'future',
      'stale',
      'entry_count_mismatch',
      'ambiguous_latest',
      'latest_attempt_failed',
    ]),
    latest_passed_tie_count: nonNegativeSafeIntegerSchema,
    latest_attempt_id: positiveSafeIntegerSchema.nullable(),
    latest_attempt_scraped_at: identifierSchema.nullable(),
    latest_attempt_passed: z.boolean().nullable(),
  })
  .strict()

const scoreInputPublishBundleSchema = z
  .object({
    scoreRows: z.array(scoreRowSchema),
    physicalBoards: z.array(physicalBoardSchema).min(1),
  })
  .strict()

export type PublicationWindow = z.infer<typeof publicationWindowSchema>
export type SourcePublicationScoreRow = z.infer<typeof scoreRowSchema>
export type SourcePublicationPhysicalBoard = z.infer<typeof physicalBoardSchema>
type PhysicalBoardRow = SourcePublicationPhysicalBoard
type PhysicalEvidenceStatus = PhysicalBoardRow['evidence_status']

export type SourcePublicationRetainReason =
  | 'missing'
  | 'failed'
  | 'future'
  | 'stale'
  | 'count_mismatch'
  | 'ambiguous_latest'
  | 'latest_attempt_failed'

export type SourcePublicationEvidenceErrorCode =
  | 'invalid_bundle'
  | 'invalid_window'
  | 'invalid_count'
  | 'invalid_timestamp'
  | 'unattested_first_party_input'
  | 'rank_limit_exceeded'
  | 'duplicate_score_identity'
  | 'duplicate_registry_slug'
  | 'duplicate_snapshot_id'
  | 'unknown_alias'
  | 'watermark_mismatch'
  | 'query_omission'
  | 'invalid_publish_id'
  | 'missing_rank_count'
  | 'retained_rank_count'
  | 'unsafe_count_expansion'
  | 'unsafe_empty_publication'

export class SourcePublicationEvidenceError extends Error {
  constructor(
    public readonly code: SourcePublicationEvidenceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SourcePublicationEvidenceError'
  }
}

interface ParsedTimestamp {
  raw: string
  epochMicros: bigint
}

interface ParsedPhysicalBoard extends PhysicalBoardRow {
  scrapedTimestamp: ParsedTimestamp | null
  denialReasons: SourcePublicationRetainReason[]
}

interface SourceAliasAccumulator {
  source: string
  boards: ParsedPhysicalBoard[]
  scoreRowCount: number
}

interface SourceAliasEvidenceBase {
  source: string
  source_as_of: string | null
  raw_actual_count: number | null
  rank_limited_entry_count: number | null
  score_row_count: number
  registry_slugs: string[]
  snapshot_ids: number[]
  explicit_empty: boolean
}

export interface FreshSourcePublicationEvidence extends SourceAliasEvidenceBase {
  state: 'fresh'
  source_as_of: string
  raw_actual_count: number
  rank_limited_entry_count: number
  denial_reasons: []
}

export interface RetainedSourcePublicationEvidence extends SourceAliasEvidenceBase {
  state: 'retain'
  denial_reasons: SourcePublicationRetainReason[]
}

export type SourceAliasPublicationEvidence =
  | FreshSourcePublicationEvidence
  | RetainedSourcePublicationEvidence

export interface ParsedSourcePublicationEvidence {
  window: PublicationWindow
  scoreRows: SourcePublicationScoreRow[]
  physicalBoards: SourcePublicationPhysicalBoard[]
  freshScoreRows: SourcePublicationScoreRow[]
  aliases: SourceAliasPublicationEvidence[]
  freshAliases: FreshSourcePublicationEvidence[]
  retainedAliases: RetainedSourcePublicationEvidence[]
}

export interface SourcePublicationRow {
  source: string
  source_as_of: string
  published_rank_count: number
  score_cohort_id: string
  registry_slugs: string[]
  snapshot_ids: number[]
}

export interface ParseSourcePublicationEvidenceOptions {
  window: PublicationWindow
  rankLimit: number
  now?: Date
  maxAgeHours?: number
}

export interface BuildSourcePublicationRowsOptions {
  publishId: string
  finalRankCounts: ReadonlyMap<string, number>
}

const RFC3339_MICROSECOND_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RETAIN_REASON_ORDER: readonly SourcePublicationRetainReason[] = [
  'missing',
  'failed',
  'future',
  'stale',
  'count_mismatch',
  'ambiguous_latest',
  'latest_attempt_failed',
]

function fail(code: SourcePublicationEvidenceErrorCode, message: string): never {
  throw new SourcePublicationEvidenceError(code, message)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseTimestamp(value: string, field: string): ParsedTimestamp {
  const match = RFC3339_MICROSECOND_PATTERN.exec(value)
  if (!match) fail('invalid_timestamp', `${field} must be an RFC3339 timestamp with timezone`)

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const probe = new Date(baseMs)

  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    fail('invalid_timestamp', `${field} is not a real calendar timestamp`)
  }

  let offsetMinutes = 0
  if (zone !== 'Z') {
    const sign = match[9] === '+' ? 1 : -1
    const offsetHours = Number(match[10])
    const offsetMinutePart = Number(match[11])
    if (offsetHours > 23 || offsetMinutePart > 59) {
      fail('invalid_timestamp', `${field} has an invalid timezone offset`)
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart)
  }

  const fractionMicros = BigInt((fraction ?? '').padEnd(6, '0') || '0')
  return {
    raw: value,
    epochMicros: BigInt(baseMs - offsetMinutes * 60_000) * 1000n + fractionMicros,
  }
}

function describeZodFailure(error: z.ZodError): string {
  const issue = error.issues[0]
  const path = issue?.path.length ? issue.path.join('.') : 'bundle'
  return `${path}: ${issue?.message ?? 'invalid value'}`
}

function requireUniqueScoreIdentities(rows: readonly SourcePublicationScoreRow[]): void {
  const traderKeysByPlatform = new Map<string, Set<string>>()

  for (const row of rows) {
    const canonicalTraderKey = row.trader_key.startsWith('0x')
      ? row.trader_key.toLowerCase()
      : row.trader_key
    const traderKeys = traderKeysByPlatform.get(row.platform) ?? new Set<string>()
    if (traderKeys.has(canonicalTraderKey)) {
      fail(
        'duplicate_score_identity',
        `duplicate score identity: platform=${row.platform}, trader_key=${canonicalTraderKey}`
      )
    }
    traderKeys.add(canonicalTraderKey)
    traderKeysByPlatform.set(row.platform, traderKeys)
  }
}

function requireAttestedBoardRanks(
  rows: readonly SourcePublicationScoreRow[],
  rankLimit: number
): void {
  for (const row of rows) {
    if (row.board_rank === null) {
      fail(
        'unattested_first_party_input',
        `score row has no physical board rank: platform=${row.platform}, trader_key=${row.trader_key}`
      )
    }
    if (row.board_rank > rankLimit) {
      fail(
        'rank_limit_exceeded',
        `score row rank ${row.board_rank} exceeds rank limit ${rankLimit}: platform=${row.platform}, trader_key=${row.trader_key}`
      )
    }
  }
}

function requireSnapshotShape(board: PhysicalBoardRow): void {
  const snapshotFields = [
    board.snapshot_id,
    board.scraped_at,
    board.actual_count,
    board.entry_count,
  ]
  const hasSnapshot = board.snapshot_id !== null

  if (hasSnapshot !== snapshotFields.every((value) => value !== null)) {
    fail(
      'invalid_bundle',
      `${board.registry_slug} must provide all or none of snapshot_id/scraped_at/counts`
    )
  }

  if (hasSnapshot) {
    if (board.rank_limited_entry_count === null || board.latest_passed_tie_count < 1) {
      fail(
        'invalid_bundle',
        `${board.registry_slug} snapshot must provide rank-limited count and a PASSED tie count`
      )
    }
    if (board.entry_count !== null && board.rank_limited_entry_count > board.entry_count) {
      fail(
        'invalid_bundle',
        `${board.registry_slug} rank-limited count exceeds its snapshot entry count`
      )
    }
  } else if (board.rank_limited_entry_count !== null || board.latest_passed_tie_count !== 0) {
    fail(
      'invalid_bundle',
      `${board.registry_slug} without a snapshot must have null rank-limited count and zero PASSED ties`
    )
  }

  const attemptFields = [
    board.latest_attempt_id,
    board.latest_attempt_scraped_at,
    board.latest_attempt_passed,
  ]
  const hasAttempt = board.latest_attempt_id !== null
  if (hasAttempt !== attemptFields.every((value) => value !== null)) {
    fail('invalid_bundle', `${board.registry_slug} has a partial latest-attempt diagnostic`)
  }

  if (board.evidence_status === 'missing') {
    if (hasSnapshot || hasAttempt) {
      fail(
        'invalid_bundle',
        `${board.registry_slug} missing evidence must have no snapshot attempt`
      )
    }
    return
  }

  if (board.evidence_status === 'failed') {
    if (hasSnapshot || !hasAttempt || board.latest_attempt_passed !== false) {
      fail('invalid_bundle', `${board.registry_slug} failed evidence has an invalid shape`)
    }
    return
  }

  const hasAmbiguousLatest = hasSnapshot && board.latest_passed_tie_count > 1
  const hasLaterFailedAttempt = hasSnapshot && board.latest_attempt_passed === false

  if (
    (board.evidence_status === 'ambiguous_latest') !== hasAmbiguousLatest ||
    (board.evidence_status === 'latest_attempt_failed') !==
      (hasLaterFailedAttempt && !hasAmbiguousLatest)
  ) {
    fail(
      'invalid_bundle',
      `${board.registry_slug} evidence status does not match tie-first snapshot diagnostics`
    )
  }

  if (!hasSnapshot || !hasAttempt) {
    fail(
      'invalid_bundle',
      `${board.registry_slug} ${board.evidence_status} evidence needs a snapshot`
    )
  }
}

function sortedReasons(reasons: ReadonlySet<SourcePublicationRetainReason>) {
  return RETAIN_REASON_ORDER.filter((reason) => reasons.has(reason))
}

function parsePhysicalBoard(
  board: PhysicalBoardRow,
  expectedWindow: PublicationWindow,
  expectedRankLimit: number,
  nowMicros: bigint,
  staleCutoffMicros: bigint
): ParsedPhysicalBoard {
  if (board.window !== expectedWindow) {
    fail(
      'invalid_window',
      `${board.registry_slug} declares ${board.window}, expected ${expectedWindow}`
    )
  }
  if (board.rank_limit !== expectedRankLimit) {
    fail(
      'invalid_count',
      `${board.registry_slug} declares rank_limit=${board.rank_limit}, expected ${expectedRankLimit}`
    )
  }

  requireSnapshotShape(board)
  const reasons = new Set<SourcePublicationRetainReason>()
  let scrapedTimestamp: ParsedTimestamp | null = null
  let latestAttemptTimestamp: ParsedTimestamp | null = null

  if (board.latest_attempt_scraped_at !== null) {
    latestAttemptTimestamp = parseTimestamp(
      board.latest_attempt_scraped_at,
      `${board.registry_slug}.latest_attempt_scraped_at`
    )
  }

  if (board.scraped_at !== null) {
    scrapedTimestamp = parseTimestamp(board.scraped_at, `${board.registry_slug}.scraped_at`)
    if (
      scrapedTimestamp.epochMicros >
      nowMicros + BigInt(SOURCE_PUBLICATION_FUTURE_TOLERANCE_MS) * 1000n
    ) {
      reasons.add('future')
    }
    if (scrapedTimestamp.epochMicros <= staleCutoffMicros) reasons.add('stale')
  }

  if (scrapedTimestamp !== null && latestAttemptTimestamp !== null) {
    if (board.latest_attempt_passed === true) {
      if (
        board.latest_attempt_id !== board.snapshot_id ||
        latestAttemptTimestamp.epochMicros !== scrapedTimestamp.epochMicros
      ) {
        fail(
          'invalid_bundle',
          `${board.registry_slug} latest PASSED attempt must equal the selected PASSED snapshot`
        )
      }
    } else {
      const failedAttemptPredatesSnapshot =
        latestAttemptTimestamp.epochMicros < scrapedTimestamp.epochMicros
      const equalTimestampNeedsLaterId =
        latestAttemptTimestamp.epochMicros === scrapedTimestamp.epochMicros &&
        (board.latest_attempt_id ?? 0) <= (board.snapshot_id ?? 0)
      if (failedAttemptPredatesSnapshot || equalTimestampNeedsLaterId) {
        fail(
          'invalid_bundle',
          `${board.registry_slug} failed latest attempt does not follow the selected PASSED snapshot`
        )
      }
    }
  }

  if (
    board.actual_count !== null &&
    board.entry_count !== null &&
    board.actual_count !== board.entry_count
  ) {
    reasons.add('count_mismatch')
  }

  const statusReason: Partial<Record<PhysicalEvidenceStatus, SourcePublicationRetainReason>> = {
    missing: 'missing',
    failed: 'failed',
    future: 'future',
    stale: 'stale',
    entry_count_mismatch: 'count_mismatch',
    ambiguous_latest: 'ambiguous_latest',
    latest_attempt_failed: 'latest_attempt_failed',
  }
  const explicitReason = statusReason[board.evidence_status]
  if (explicitReason) reasons.add(explicitReason)
  if (board.latest_passed_tie_count > 1) reasons.add('ambiguous_latest')
  if (board.snapshot_id !== null && board.latest_attempt_passed === false) {
    reasons.add('latest_attempt_failed')
  }

  return { ...board, scrapedTimestamp, denialReasons: sortedReasons(reasons) }
}

function aggregateAlias(accumulator: SourceAliasAccumulator): SourceAliasPublicationEvidence {
  const boards = [...accumulator.boards].sort((left, right) =>
    compareText(left.registry_slug, right.registry_slug)
  )
  const reasons = new Set(boards.flatMap((board) => board.denialReasons))
  const timestamps = boards
    .map((board) => board.scrapedTimestamp)
    .filter((timestamp): timestamp is ParsedTimestamp => timestamp !== null)
    .sort((left, right) =>
      left.epochMicros < right.epochMicros ? -1 : left.epochMicros > right.epochMicros ? 1 : 0
    )
  const allCountsPresent = boards.every((board) => board.actual_count !== null)
  const rawActualCount = allCountsPresent
    ? boards.reduce((sum, board) => sum + (board.actual_count ?? 0), 0)
    : null
  const allRankLimitedCountsPresent = boards.every(
    (board) => board.rank_limited_entry_count !== null
  )
  const rankLimitedEntryCount = allRankLimitedCountsPresent
    ? boards.reduce((sum, board) => sum + (board.rank_limited_entry_count ?? 0), 0)
    : null

  if (rawActualCount !== null && !Number.isSafeInteger(rawActualCount)) {
    fail('invalid_count', `${accumulator.source} aggregate actual_count is not a safe integer`)
  }
  if (rankLimitedEntryCount !== null && !Number.isSafeInteger(rankLimitedEntryCount)) {
    fail(
      'invalid_count',
      `${accumulator.source} aggregate rank_limited_entry_count is not a safe integer`
    )
  }

  const base = {
    source: accumulator.source,
    source_as_of: timestamps[0]?.raw ?? null,
    raw_actual_count: rawActualCount,
    rank_limited_entry_count: rankLimitedEntryCount,
    score_row_count: accumulator.scoreRowCount,
    registry_slugs: boards.map((board) => board.registry_slug),
    snapshot_ids: boards
      .map((board) => board.snapshot_id)
      .filter((snapshotId): snapshotId is number => snapshotId !== null)
      .sort((left, right) => left - right),
    explicit_empty: reasons.size === 0 && rawActualCount === 0,
  }

  if (reasons.size === 0) {
    if (base.source_as_of === null || rawActualCount === null || rankLimitedEntryCount === null) {
      fail('invalid_bundle', `${accumulator.source} fresh evidence is incomplete`)
    }
    return {
      ...base,
      state: 'fresh',
      source_as_of: base.source_as_of,
      raw_actual_count: rawActualCount,
      rank_limited_entry_count: rankLimitedEntryCount,
      denial_reasons: [],
    }
  }

  return {
    ...base,
    state: 'retain',
    denial_reasons: sortedReasons(reasons),
  }
}

export function parseSourcePublicationEvidence(
  rawBundle: unknown,
  options: ParseSourcePublicationEvidenceOptions
): ParsedSourcePublicationEvidence {
  const windowResult = publicationWindowSchema.safeParse(options.window)
  if (!windowResult.success) fail('invalid_window', 'expected publication window is invalid')

  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) fail('invalid_timestamp', 'now is invalid')
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS
  if (!Number.isSafeInteger(maxAgeHours) || maxAgeHours <= 0) {
    fail('invalid_count', 'maxAgeHours must be a positive safe integer')
  }
  if (!Number.isSafeInteger(options.rankLimit) || options.rankLimit <= 0) {
    fail('invalid_count', 'rankLimit must be a positive safe integer')
  }

  const parsedBundle = scoreInputPublishBundleSchema.safeParse(rawBundle)
  if (!parsedBundle.success) {
    fail(
      'invalid_bundle',
      `invalid score-input publish bundle: ${describeZodFailure(parsedBundle.error)}`
    )
  }

  requireUniqueScoreIdentities(parsedBundle.data.scoreRows)
  requireAttestedBoardRanks(parsedBundle.data.scoreRows, options.rankLimit)

  const nowMicros = BigInt(now.getTime()) * 1000n
  const staleCutoffMicros = nowMicros - BigInt(maxAgeHours) * 60n * 60n * 1_000_000n
  const registrySlugs = new Set<string>()
  const snapshotIds = new Set<number>()
  const aliases = new Map<string, SourceAliasAccumulator>()

  for (const rawBoard of parsedBundle.data.physicalBoards) {
    if (registrySlugs.has(rawBoard.registry_slug)) {
      fail('duplicate_registry_slug', `duplicate registry_slug: ${rawBoard.registry_slug}`)
    }
    registrySlugs.add(rawBoard.registry_slug)

    if (rawBoard.snapshot_id !== null) {
      if (snapshotIds.has(rawBoard.snapshot_id)) {
        fail('duplicate_snapshot_id', `duplicate snapshot_id: ${rawBoard.snapshot_id}`)
      }
      snapshotIds.add(rawBoard.snapshot_id)
    }

    const board = parsePhysicalBoard(
      rawBoard,
      windowResult.data,
      options.rankLimit,
      nowMicros,
      staleCutoffMicros
    )
    const accumulator = aliases.get(board.filter_source) ?? {
      source: board.filter_source,
      boards: [],
      scoreRowCount: 0,
    }
    accumulator.boards.push(board)
    aliases.set(board.filter_source, accumulator)
  }

  const aggregatedBySource = new Map(
    [...aliases.values()].map((accumulator) => [accumulator.source, aggregateAlias(accumulator)])
  )

  for (const row of parsedBundle.data.scoreRows) {
    const alias = aggregatedBySource.get(row.platform)
    if (!alias) fail('unknown_alias', `score row uses unknown alias: ${row.platform}`)

    const observationTimestamp = parseTimestamp(row.as_of, `${row.platform}.as_of`)
    if (
      observationTimestamp.epochMicros >
      nowMicros + BigInt(SOURCE_PUBLICATION_FUTURE_TOLERANCE_MS) * 1000n
    ) {
      fail('invalid_timestamp', `${row.platform}.as_of is more than five minutes in the future`)
    }
    if (observationTimestamp.epochMicros <= staleCutoffMicros) {
      fail(
        'invalid_timestamp',
        `${row.platform}.as_of must be newer than the publication freshness cutoff`
      )
    }

    const boardTimestamp = parseTimestamp(row.board_as_of, `${row.platform}.board_as_of`)
    if (alias.source_as_of === null) {
      fail('watermark_mismatch', `${row.platform} has score rows without PASSED board evidence`)
    }
    const aliasTimestamp = parseTimestamp(alias.source_as_of, `${row.platform}.source_as_of`)
    if (boardTimestamp.epochMicros !== aliasTimestamp.epochMicros) {
      fail(
        'watermark_mismatch',
        `${row.platform} board_as_of does not equal its physical-board MIN watermark`
      )
    }

    const accumulator = aliases.get(row.platform)
    if (!accumulator) fail('unknown_alias', `score row uses unknown alias: ${row.platform}`)
    accumulator.scoreRowCount += 1
  }

  const finalAliases = [...aliases.values()]
    .map((accumulator) => aggregateAlias(accumulator))
    .sort((left, right) => compareText(left.source, right.source))
  const freshAliases = finalAliases.filter(
    (alias): alias is FreshSourcePublicationEvidence => alias.state === 'fresh'
  )
  const retainedAliases = finalAliases.filter(
    (alias): alias is RetainedSourcePublicationEvidence => alias.state === 'retain'
  )

  for (const alias of freshAliases) {
    if (alias.raw_actual_count === 0 && alias.score_row_count !== 0) {
      fail('query_omission', `${alias.source} has score rows despite an explicitly empty raw board`)
    }
    if (alias.raw_actual_count > 0 && alias.score_row_count === 0) {
      fail('query_omission', `${alias.source} raw board is non-empty but score rows were omitted`)
    }
    if (alias.score_row_count > alias.raw_actual_count) {
      fail(
        'unsafe_count_expansion',
        `${alias.source} score rows exceed the physical raw board count`
      )
    }
    if (alias.score_row_count !== alias.rank_limited_entry_count) {
      fail(
        'query_omission',
        `${alias.source} score rows do not exactly match its physical rank-limited entries`
      )
    }
  }

  const freshSources = new Set(freshAliases.map((alias) => alias.source))
  return {
    window: windowResult.data,
    scoreRows: parsedBundle.data.scoreRows,
    // Zod returns a normalized clone. Retaining the exact validated physical
    // rows lets the publication manifest bind both halves of this one RPC
    // attempt without rereading mutable source tables.
    physicalBoards: parsedBundle.data.physicalBoards,
    freshScoreRows: parsedBundle.data.scoreRows.filter((row) => freshSources.has(row.platform)),
    aliases: finalAliases,
    freshAliases,
    retainedAliases,
  }
}

export function buildSourcePublicationRows(
  evidence: ParsedSourcePublicationEvidence,
  options: BuildSourcePublicationRowsOptions
): SourcePublicationRow[] {
  if (!UUID_PATTERN.test(options.publishId)) {
    fail('invalid_publish_id', 'publishId must be a canonical UUID')
  }

  const knownAliases = new Set(evidence.aliases.map((alias) => alias.source))
  const freshAliases = new Set(evidence.freshAliases.map((alias) => alias.source))
  for (const [source, count] of options.finalRankCounts) {
    if (!knownAliases.has(source)) {
      fail('unknown_alias', `final rank count uses unknown alias: ${source}`)
    }
    if (!freshAliases.has(source)) {
      fail(
        'retained_rank_count',
        `${source} is retained and must not appear in final fresh rank counts`
      )
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      fail('invalid_count', `${source} final rank count must be a non-negative safe integer`)
    }
  }

  return evidence.freshAliases
    .map((alias) => {
      const publishedRankCount = options.finalRankCounts.get(alias.source)
      if (publishedRankCount === undefined) {
        fail('missing_rank_count', `${alias.source} final rank count was omitted`)
      }
      if (alias.raw_actual_count === 0 && publishedRankCount !== 0) {
        fail(
          'unsafe_empty_publication',
          `${alias.source} explicitly empty raw board must publish exactly zero ranks`
        )
      }
      if (publishedRankCount > alias.score_row_count) {
        fail(
          'unsafe_count_expansion',
          `${alias.source} published rank count exceeds its fresh score-row count`
        )
      }

      return {
        source: alias.source,
        source_as_of: alias.source_as_of,
        published_rank_count: publishedRankCount,
        score_cohort_id: options.publishId.toLowerCase(),
        registry_slugs: [...alias.registry_slugs],
        snapshot_ids: [...alias.snapshot_ids],
      }
    })
    .sort((left, right) => compareText(left.source, right.source))
}
