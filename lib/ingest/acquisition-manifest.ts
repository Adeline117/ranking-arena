import { z } from 'zod'

import type { RankingTimeframe, RawPage, SourceRow } from './core/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT =
  'arena.ingest.leaderboard-acquisition-manifest@1' as const

const SHA256 = /^[0-9a-f]{64}$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/

const captureEvidenceStates = ['verified', 'unavailable'] as const
const terminationReasons = [
  'reported_population_reached',
  'reported_page_count_reached',
  'short_page',
  'empty_page',
  'cursor_exhausted',
  'single_snapshot',
  'degenerate_page',
  'caller_limit',
  'safety_limit',
  'upstream_error',
  'unknown',
] as const
const acquisitionStates = ['complete', 'partial', 'unknown'] as const
const populationStates = ['verified', 'partial', 'unknown'] as const
const aggregateReportStates = ['consistent', 'conflicting', 'unknown'] as const

type CaptureEvidenceState = (typeof captureEvidenceStates)[number]
type TerminationReason = (typeof terminationReasons)[number]
type AcquisitionState = (typeof acquisitionStates)[number]
type PopulationState = (typeof populationStates)[number]
type AggregateReportState = (typeof aggregateReportStates)[number]

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0)
}

function isSafeNonNegativeInteger(value: number): boolean {
  return isSafeInteger(value) && value >= 0
}

function isSafePositiveInteger(value: number): boolean {
  return isSafeInteger(value) && value > 0
}

function isNonzeroDigest(value: string): boolean {
  return !/^0+$/.test(value)
}

function isCanonicalHttpUrl(value: string): boolean {
  if (value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

const safeNonNegativeIntegerSchema = z
  .number()
  .refine(isSafeNonNegativeInteger, 'must be a non-negative safe integer and not negative zero')
const safePositiveIntegerSchema = z
  .number()
  .refine(isSafePositiveInteger, 'must be a positive safe integer and not negative zero')
const canonicalTimestampSchema = z
  .string()
  .refine(isCanonicalTimestamp, 'must be a canonical ISO timestamp')
const sha256Schema = z
  .string()
  .regex(SHA256, 'must be a lowercase SHA-256 digest')
  .refine(isNonzeroDigest, 'digest must not be all zeroes')
const gitShaSchema = z
  .string()
  .regex(FULL_GIT_SHA, 'must be a full lowercase git SHA')
  .refine(isNonzeroDigest, 'git SHA must not be all zeroes')
const nonEmptyCanonicalStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must not have surrounding whitespace')
const canonicalHttpUrlSchema = z
  .string()
  .refine(
    isCanonicalHttpUrl,
    'must be an absolute http(s) URL without whitespace, userinfo, or fragment'
  )

const configuredPaginationKindSchema = z.enum([
  'numeric',
  'next_prev',
  'infinite_scroll',
  'api_cursor',
])

const rawPageSchema = z
  .object({
    pageIndex: safePositiveIntegerSchema,
    payload: z.unknown(),
    url: canonicalHttpUrlSchema,
    fetchedAt: canonicalTimestampSchema,
  })
  .strict()

const reportEvidenceSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('reported'),
      value: safeNonNegativeIntegerSchema,
    })
    .strict(),
  z.object({ state: z.literal('not_reported') }).strict(),
])

const sourceReportsSchema = z
  .object({
    population: reportEvidenceSchema,
    page_count: reportEvidenceSchema,
  })
  .strict()

const paginationPositionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('page_index'),
      page_index: safePositiveIntegerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cursor'),
      request_cursor_sha256: sha256Schema.nullable(),
      response_next_cursor_sha256: sha256Schema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('single_snapshot') }).strict(),
])

const sourcePageInputSchema = z
  .object({
    raw_page: rawPageSchema,
    source_row_count: safeNonNegativeIntegerSchema,
    request_sha256: sha256Schema.nullable(),
    http_status: safePositiveIntegerSchema
      .refine((value) => value >= 100 && value <= 599, 'must be an HTTP status')
      .nullable(),
    pagination_position: paginationPositionSchema.nullable(),
    source_reports: sourceReportsSchema.nullable(),
  })
  .strict()

const sourceInputSchema = z
  .object({
    id: safePositiveIntegerSchema,
    slug: nonEmptyCanonicalStringSchema,
    adapter_slug: nonEmptyCanonicalStringSchema,
    configured_page_size: safePositiveIntegerSchema.nullable(),
    configured_pagination_kind: configuredPaginationKindSchema.nullable(),
  })
  .strict()

const buildInputSchema = z
  .object({
    source: sourceInputSchema,
    surface: z.literal('tier_a_leaderboard'),
    timeframe: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    started_at: canonicalTimestampSchema,
    completed_at: canonicalTimestampSchema,
    runner_git_sha: gitShaSchema.nullable(),
    observation_cycle_id: nonEmptyCanonicalStringSchema.nullable(),
    capture_evidence_state: z.enum(captureEvidenceStates),
    termination_reason: z.enum(terminationReasons),
    source_pages: z.array(sourcePageInputSchema),
    parse_pages: z.array(rawPageSchema),
    accepted_population: safeNonNegativeIntegerSchema,
    rejected_row_count: safeNonNegativeIntegerSchema,
  })
  .strict()

const durableSourcePageSchema = z
  .object({
    ordinal: safePositiveIntegerSchema,
    stored_page_index: safePositiveIntegerSchema,
    url: canonicalHttpUrlSchema,
    fetched_at: canonicalTimestampSchema,
    payload: z
      .object({
        serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
        sha256: sha256Schema,
      })
      .strict(),
    source_row_count: safeNonNegativeIntegerSchema,
    request_sha256: sha256Schema.nullable(),
    http_status: safePositiveIntegerSchema
      .refine((value) => value >= 100 && value <= 599, 'must be an HTTP status')
      .nullable(),
    pagination_position: paginationPositionSchema.nullable(),
    source_reports: sourceReportsSchema.nullable(),
  })
  .strict()

const aggregateReportSchema = z
  .object({
    state: z.enum(aggregateReportStates),
    value: safeNonNegativeIntegerSchema.nullable(),
  })
  .strict()

const durableManifestStructuralSchema = z
  .object({
    data_contract: z.literal(LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT),
    source: sourceInputSchema,
    surface: z.literal('tier_a_leaderboard'),
    timeframe: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    started_at: canonicalTimestampSchema,
    completed_at: canonicalTimestampSchema,
    runner_git_sha: gitShaSchema.nullable(),
    observation_cycle_id: nonEmptyCanonicalStringSchema.nullable(),
    capture_evidence_state: z.enum(captureEvidenceStates),
    termination_reason: z.enum(terminationReasons),
    source_pages: z.array(durableSourcePageSchema),
    parser_input: z
      .object({
        serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
        sha256: sha256Schema,
        page_count: safeNonNegativeIntegerSchema,
      })
      .strict(),
    population: z
      .object({
        observed_row_count: safeNonNegativeIntegerSchema,
        accepted_population: safeNonNegativeIntegerSchema,
        rejected_row_count: safeNonNegativeIntegerSchema,
        deduplicated_row_count: safeNonNegativeIntegerSchema,
        reports: z
          .object({
            population: aggregateReportSchema,
            page_count: aggregateReportSchema,
          })
          .strict(),
      })
      .strict(),
    caller_limited: z.boolean(),
    safety_limited: z.boolean(),
    assessment: z
      .object({
        acquisition_state: z.enum(acquisitionStates),
        population_state: z.enum(populationStates),
      })
      .strict(),
  })
  .strict()

export type LeaderboardAcquisitionPaginationPosition = z.infer<typeof paginationPositionSchema>
export type LeaderboardAcquisitionReportEvidence = z.infer<typeof reportEvidenceSchema>
export type LeaderboardAcquisitionSourcePageInput = z.input<typeof sourcePageInputSchema>

export interface BuildLeaderboardAcquisitionManifestInput {
  source: {
    id: SourceRow['id']
    slug: SourceRow['slug']
    adapter_slug: SourceRow['adapter_slug']
    configured_page_size: SourceRow['page_size']
    configured_pagination_kind: SourceRow['pagination_kind']
  }
  surface: 'tier_a_leaderboard'
  timeframe: RankingTimeframe
  started_at: string
  completed_at: string
  runner_git_sha: string | null
  observation_cycle_id: string | null
  capture_evidence_state: CaptureEvidenceState
  termination_reason: TerminationReason
  /** Exact parsed JSON values returned by the upstream, before normalization. */
  source_pages: Array<{
    raw_page: RawPage
    /** Count from the upstream collection, before parser validation. */
    source_row_count: number
    request_sha256: string | null
    http_status: number | null
    pagination_position: LeaderboardAcquisitionPaginationPosition | null
    source_reports: {
      population: LeaderboardAcquisitionReportEvidence
      page_count: LeaderboardAcquisitionReportEvidence
    } | null
  }>
  /** Deterministic parser inputs. These may be normalized projections of source_pages. */
  parse_pages: RawPage[]
  accepted_population: number
  rejected_row_count: number
}

export type LeaderboardAcquisitionManifest = z.infer<typeof durableManifestStructuralSchema>

export interface BuiltLeaderboardAcquisitionManifest {
  manifest: LeaderboardAcquisitionManifest
  canonicalJson: string
  sourceRunId: string
}

interface AggregateReport {
  state: AggregateReportState
  value: number | null
}

interface DerivedAssessment {
  acquisition_state: AcquisitionState
  population_state: PopulationState
}

function safeIntegerSum(values: readonly number[], label: string): number {
  let sum = 0
  for (const value of values) {
    sum += value
    if (!isSafeNonNegativeInteger(sum)) {
      throw new TypeError(`${label} exceeds the safe-integer range`)
    }
  }
  return sum
}

function deriveAggregateReport(
  pages: readonly LeaderboardAcquisitionManifest['source_pages'][number][],
  field: 'population' | 'page_count'
): AggregateReport {
  const reports = pages.flatMap((page) => {
    const report = page.source_reports?.[field]
    return report?.state === 'reported' ? [report.value] : []
  })
  if (reports.length === 0) return { state: 'unknown', value: null }

  const values = new Set(reports)
  if (values.size !== 1) return { state: 'conflicting', value: null }
  return { state: 'consistent', value: reports[0] }
}

function hasVerifiedCaptureFoundation(manifest: LeaderboardAcquisitionManifest): boolean {
  return (
    manifest.capture_evidence_state === 'verified' &&
    manifest.runner_git_sha !== null &&
    manifest.source_pages.length > 0 &&
    manifest.source_pages.every(
      (page) =>
        page.request_sha256 !== null &&
        page.http_status !== null &&
        page.http_status >= 200 &&
        page.http_status <= 299 &&
        page.pagination_position !== null &&
        page.source_reports !== null
    )
  )
}

function isNaturalTermination(
  manifest: LeaderboardAcquisitionManifest,
  populationReport: AggregateReport,
  pageCountReport: AggregateReport
): boolean {
  const pages = manifest.source_pages
  const lastPage = pages.at(-1)
  if (!lastPage) return false
  const position = lastPage.pagination_position
  if (!position) return false

  const populationMatchesTerminal =
    populationReport.state === 'unknown' ||
    (populationReport.state === 'consistent' &&
      manifest.population.observed_row_count >= populationReport.value!)
  const pageCountMatchesTerminal =
    pageCountReport.state === 'unknown' ||
    (pageCountReport.state === 'consistent' &&
      (position.kind === 'page_index'
        ? position.page_index === pageCountReport.value ||
          (manifest.termination_reason === 'empty_page' &&
            position.page_index === pageCountReport.value! + 1)
        : position.kind === 'cursor'
          ? pages.length === pageCountReport.value
          : pageCountReport.value === 1))
  const continuationClaimsMore =
    position.kind === 'cursor' && position.response_next_cursor_sha256 !== null
  const hasContradictoryContinuation =
    !populationMatchesTerminal || !pageCountMatchesTerminal || continuationClaimsMore

  switch (manifest.termination_reason) {
    case 'reported_population_reached':
      return (
        position.kind !== 'single_snapshot' &&
        populationReport.state === 'consistent' &&
        manifest.population.observed_row_count >= populationReport.value! &&
        pageCountMatchesTerminal &&
        !continuationClaimsMore
      )
    case 'reported_page_count_reached':
      return (
        pageCountReport.state === 'consistent' &&
        position.kind === 'page_index' &&
        position.page_index === pageCountReport.value &&
        populationMatchesTerminal
      )
    case 'short_page':
      return (
        position.kind === 'page_index' &&
        manifest.source.configured_page_size !== null &&
        lastPage.source_row_count > 0 &&
        lastPage.source_row_count < manifest.source.configured_page_size &&
        !hasContradictoryContinuation
      )
    case 'empty_page':
      return (
        position.kind !== 'cursor' &&
        lastPage.source_row_count === 0 &&
        !hasContradictoryContinuation
      )
    case 'cursor_exhausted':
      return (
        position.kind === 'cursor' &&
        position.response_next_cursor_sha256 === null &&
        populationMatchesTerminal &&
        pageCountMatchesTerminal
      )
    case 'single_snapshot':
      return (
        pages.length === 1 &&
        position.kind === 'single_snapshot' &&
        populationMatchesTerminal &&
        pageCountMatchesTerminal
      )
    case 'degenerate_page':
    case 'caller_limit':
    case 'safety_limit':
    case 'upstream_error':
    case 'unknown':
      return false
  }
}

function deriveAssessment(
  manifest: LeaderboardAcquisitionManifest,
  populationReport: AggregateReport,
  pageCountReport: AggregateReport
): DerivedAssessment {
  if (!hasVerifiedCaptureFoundation(manifest)) {
    return { acquisition_state: 'unknown', population_state: 'unknown' }
  }

  if (
    manifest.termination_reason === 'caller_limit' ||
    manifest.termination_reason === 'safety_limit'
  ) {
    return { acquisition_state: 'partial', population_state: 'partial' }
  }
  if (manifest.termination_reason === 'degenerate_page') {
    return { acquisition_state: 'partial', population_state: 'unknown' }
  }
  if (
    manifest.termination_reason === 'upstream_error' ||
    manifest.termination_reason === 'unknown' ||
    !isNaturalTermination(manifest, populationReport, pageCountReport)
  ) {
    return { acquisition_state: 'unknown', population_state: 'unknown' }
  }

  if (populationReport.state !== 'consistent') {
    return { acquisition_state: 'complete', population_state: 'unknown' }
  }

  const populationVerified =
    populationReport.value === manifest.population.accepted_population &&
    manifest.population.rejected_row_count === 0 &&
    manifest.population.deduplicated_row_count === 0

  return {
    acquisition_state: 'complete',
    population_state: populationVerified ? 'verified' : 'partial',
  }
}

function addIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
}

function validatePaginationPositions(
  manifest: LeaderboardAcquisitionManifest,
  ctx: z.RefinementCtx
): void {
  if (manifest.capture_evidence_state !== 'verified' || manifest.source_pages.length === 0) {
    return
  }
  const positions = manifest.source_pages.map((page) => page.pagination_position)
  if (positions.some((position) => position === null)) return

  const kind = positions[0]!.kind
  if (positions.some((position) => position!.kind !== kind)) {
    addIssue(ctx, ['source_pages'], 'verified pagination positions must use one kind')
    return
  }

  const configuredKind = manifest.source.configured_pagination_kind
  const compatible =
    (configuredKind === 'numeric' && kind === 'page_index') ||
    ((configuredKind === 'api_cursor' ||
      configuredKind === 'next_prev' ||
      configuredKind === 'infinite_scroll') &&
      kind === 'cursor') ||
    (configuredKind === null && kind === 'single_snapshot')
  if (!compatible) {
    addIssue(
      ctx,
      ['source_pages', 0, 'pagination_position'],
      `pagination position ${kind} is incompatible with configured kind ${String(configuredKind)}`
    )
    return
  }

  if (kind === 'page_index') {
    for (const [index, position] of positions.entries()) {
      if (position!.kind !== 'page_index' || position!.page_index !== index + 1) {
        addIssue(
          ctx,
          ['source_pages', index, 'pagination_position'],
          'source page indexes must be contiguous from one'
        )
      }
    }
    return
  }

  if (kind === 'single_snapshot') {
    if (positions.length !== 1) {
      addIssue(ctx, ['source_pages'], 'single_snapshot capture must contain exactly one page')
    }
    return
  }

  const emittedCursors = new Set<string>()
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index]!
    if (position.kind !== 'cursor') continue
    if (index === 0 && position.request_cursor_sha256 !== null) {
      addIssue(
        ctx,
        ['source_pages', index, 'pagination_position', 'request_cursor_sha256'],
        'the first cursor request must not claim a predecessor'
      )
    }
    if (index > 0) {
      const previous = positions[index - 1]!
      if (
        previous.kind !== 'cursor' ||
        previous.response_next_cursor_sha256 === null ||
        position.request_cursor_sha256 !== previous.response_next_cursor_sha256
      ) {
        addIssue(
          ctx,
          ['source_pages', index, 'pagination_position', 'request_cursor_sha256'],
          'cursor requests must bind the preceding response cursor'
        )
      }
    }
    const nextCursor = position.response_next_cursor_sha256
    if (nextCursor !== null) {
      if (nextCursor === position.request_cursor_sha256 || emittedCursors.has(nextCursor)) {
        addIssue(
          ctx,
          ['source_pages', index, 'pagination_position', 'response_next_cursor_sha256'],
          'cursor responses must advance without cycles'
        )
      }
      emittedCursors.add(nextCursor)
    }
  }
}

function validateManifestInvariants(
  manifest: LeaderboardAcquisitionManifest,
  ctx: z.RefinementCtx
): void {
  const startedAt = Date.parse(manifest.started_at)
  const completedAt = Date.parse(manifest.completed_at)
  if (startedAt > completedAt) {
    addIssue(ctx, ['completed_at'], 'completed_at must not precede started_at')
  }

  let previousFetchedAt = startedAt
  for (const [index, page] of manifest.source_pages.entries()) {
    const expectedIndex = index + 1
    if (page.ordinal !== expectedIndex) {
      addIssue(ctx, ['source_pages', index, 'ordinal'], 'page ordinals must be contiguous from one')
    }
    if (page.stored_page_index !== expectedIndex) {
      addIssue(
        ctx,
        ['source_pages', index, 'stored_page_index'],
        'stored page indexes must be contiguous from one'
      )
    }
    const fetchedAt = Date.parse(page.fetched_at)
    if (fetchedAt < startedAt || fetchedAt > completedAt) {
      addIssue(
        ctx,
        ['source_pages', index, 'fetched_at'],
        'page timestamp must fall inside the run'
      )
    }
    if (fetchedAt < previousFetchedAt) {
      addIssue(
        ctx,
        ['source_pages', index, 'fetched_at'],
        'page timestamps must not move backwards'
      )
    }
    previousFetchedAt = fetchedAt
  }

  let observedRowCount: number | null = null
  try {
    observedRowCount = safeIntegerSum(
      manifest.source_pages.map((page) => page.source_row_count),
      'observed row count'
    )
  } catch (error) {
    addIssue(ctx, ['population', 'observed_row_count'], (error as Error).message)
  }
  if (observedRowCount !== null && manifest.population.observed_row_count !== observedRowCount) {
    addIssue(
      ctx,
      ['population', 'observed_row_count'],
      'observed_row_count must equal the source-page row sum'
    )
  }

  const accounted = manifest.population.accepted_population + manifest.population.rejected_row_count
  const expectedDeduplicated = manifest.population.observed_row_count - accounted
  if (!isSafeNonNegativeInteger(accounted) || expectedDeduplicated < 0) {
    addIssue(ctx, ['population'], 'accepted and rejected counts cannot exceed observed_row_count')
  } else if (manifest.population.deduplicated_row_count !== expectedDeduplicated) {
    addIssue(
      ctx,
      ['population', 'deduplicated_row_count'],
      'deduplicated_row_count does not match the population count identity'
    )
  }
  if (manifest.population.accepted_population > 0 && manifest.parser_input.page_count === 0) {
    addIssue(ctx, ['parser_input', 'page_count'], 'accepted rows require parser input pages')
  }

  if (manifest.capture_evidence_state === 'unavailable') {
    if (manifest.termination_reason !== 'unknown') {
      addIssue(
        ctx,
        ['termination_reason'],
        'unavailable capture evidence requires unknown termination'
      )
    }
    for (const [index, page] of manifest.source_pages.entries()) {
      if (
        page.request_sha256 !== null ||
        page.http_status !== null ||
        page.pagination_position !== null ||
        page.source_reports !== null
      ) {
        addIssue(
          ctx,
          ['source_pages', index],
          'unavailable capture evidence requires null capture metadata'
        )
      }
    }
  } else {
    if (manifest.source_pages.length === 0) {
      addIssue(ctx, ['source_pages'], 'verified capture evidence requires at least one source page')
    }
    for (const [index, page] of manifest.source_pages.entries()) {
      if (
        page.request_sha256 === null ||
        page.http_status === null ||
        page.pagination_position === null ||
        page.source_reports === null
      ) {
        addIssue(
          ctx,
          ['source_pages', index],
          'verified capture evidence requires request, response, pagination, and report metadata'
        )
      }
    }
  }

  validatePaginationPositions(manifest, ctx)

  const populationReport = deriveAggregateReport(manifest.source_pages, 'population')
  const pageCountReport = deriveAggregateReport(manifest.source_pages, 'page_count')
  if (
    manifest.population.reports.population.state !== populationReport.state ||
    manifest.population.reports.population.value !== populationReport.value
  ) {
    addIssue(
      ctx,
      ['population', 'reports', 'population'],
      'population report is not centrally derived'
    )
  }
  if (
    manifest.population.reports.page_count.state !== pageCountReport.state ||
    manifest.population.reports.page_count.value !== pageCountReport.value
  ) {
    addIssue(
      ctx,
      ['population', 'reports', 'page_count'],
      'page-count report is not centrally derived'
    )
  }

  const callerLimited = manifest.termination_reason === 'caller_limit'
  const safetyLimited = manifest.termination_reason === 'safety_limit'
  if (manifest.caller_limited !== callerLimited) {
    addIssue(ctx, ['caller_limited'], 'caller_limited is not centrally derived')
  }
  if (manifest.safety_limited !== safetyLimited) {
    addIssue(ctx, ['safety_limited'], 'safety_limited is not centrally derived')
  }

  const assessment = deriveAssessment(manifest, populationReport, pageCountReport)
  if (
    manifest.assessment.acquisition_state !== assessment.acquisition_state ||
    manifest.assessment.population_state !== assessment.population_state
  ) {
    addIssue(ctx, ['assessment'], 'assessment is not centrally derived')
  }
}

export const leaderboardAcquisitionManifestSchema = durableManifestStructuralSchema.superRefine(
  validateManifestInvariants
)

export function parseLeaderboardAcquisitionManifest(raw: unknown): LeaderboardAcquisitionManifest {
  return leaderboardAcquisitionManifestSchema.parse(raw)
}

export function buildLeaderboardAcquisitionManifest(
  rawInput: BuildLeaderboardAcquisitionManifestInput
): BuiltLeaderboardAcquisitionManifest {
  const input = buildInputSchema.parse(rawInput)
  const observedRowCount = safeIntegerSum(
    input.source_pages.map((page) => page.source_row_count),
    'observed row count'
  )
  const accounted = input.accepted_population + input.rejected_row_count
  if (!isSafeNonNegativeInteger(accounted) || accounted > observedRowCount) {
    throw new TypeError('accepted and rejected counts cannot exceed observed_row_count')
  }

  const sourcePages: LeaderboardAcquisitionManifest['source_pages'] = input.source_pages.map(
    (page, index) => ({
      ordinal: index + 1,
      stored_page_index: page.raw_page.pageIndex,
      url: page.raw_page.url,
      fetched_at: page.raw_page.fetchedAt,
      payload: {
        serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
        sha256: strictCanonicalSha256(page.raw_page.payload),
      },
      source_row_count: page.source_row_count,
      request_sha256: page.request_sha256,
      http_status: page.http_status,
      pagination_position: page.pagination_position,
      source_reports: page.source_reports,
    })
  )
  const populationReport = deriveAggregateReport(sourcePages, 'population')
  const pageCountReport = deriveAggregateReport(sourcePages, 'page_count')

  const structuralManifest: LeaderboardAcquisitionManifest = {
    data_contract: LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT,
    source: input.source,
    surface: input.surface,
    timeframe: input.timeframe,
    started_at: input.started_at,
    completed_at: input.completed_at,
    runner_git_sha: input.runner_git_sha,
    observation_cycle_id: input.observation_cycle_id,
    capture_evidence_state: input.capture_evidence_state,
    termination_reason: input.termination_reason,
    source_pages: sourcePages,
    parser_input: {
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      sha256: strictCanonicalSha256(input.parse_pages),
      page_count: input.parse_pages.length,
    },
    population: {
      observed_row_count: observedRowCount,
      accepted_population: input.accepted_population,
      rejected_row_count: input.rejected_row_count,
      deduplicated_row_count: observedRowCount - accounted,
      reports: {
        population: populationReport,
        page_count: pageCountReport,
      },
    },
    caller_limited: input.termination_reason === 'caller_limit',
    safety_limited: input.termination_reason === 'safety_limit',
    assessment: {
      acquisition_state: 'unknown',
      population_state: 'unknown',
    },
  }
  structuralManifest.assessment = deriveAssessment(
    structuralManifest,
    populationReport,
    pageCountReport
  )

  const manifest = parseLeaderboardAcquisitionManifest(structuralManifest)
  const canonicalJson = strictCanonicalJson(manifest)
  return {
    manifest,
    canonicalJson,
    sourceRunId: strictCanonicalSha256(manifest),
  }
}
