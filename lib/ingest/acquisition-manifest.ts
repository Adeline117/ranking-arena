import { z } from 'zod'

import type { RankingTimeframe, RawPage, SourceRow } from './core/types'
import {
  exhaustionBindingIssues,
  exhaustionCompletenessHolds,
  exhaustionEndSignalHolds,
  leaderboardExhaustionCompletenessSchema,
  type LeaderboardExhaustionCompleteness,
  type LeaderboardExhaustionManifestFacts,
} from './acquisition-exhaustion'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const LEADERBOARD_ACQUISITION_MANIFEST_V2_CONTRACT =
  'arena.ingest.leaderboard-acquisition-manifest@2' as const
export const LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT =
  'arena.ingest.leaderboard-acquisition-manifest@3' as const
export const LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT =
  'arena.ingest.leaderboard-acquisition-manifest@4' as const
export const LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT =
  'arena.ingest.leaderboard-acquisition-attempt-binding@1' as const
export const LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT =
  'arena.ingest.partitioned-numeric-report-sum@1' as const
export const LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT =
  'arena.ingest.partitioned-numeric-parser-page@1' as const

/** Legacy builder/parser alias retained until the Tier-A @3 cutover. */
export const LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT =
  LEADERBOARD_ACQUISITION_MANIFEST_V2_CONTRACT

const SHA256 = /^[0-9a-f]{64}$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const captureEvidenceStates = ['verified', 'unavailable'] as const
const terminationReasons = [
  'reported_population_reached',
  'reported_page_count_reached',
  'short_page',
  'empty_page',
  'cursor_exhausted',
  'single_snapshot',
  'end_signal_reached',
  'degenerate_page',
  'caller_limit',
  'safety_limit',
  'upstream_error',
  'unknown',
] as const
const acquisitionStates = ['complete', 'partial', 'unknown'] as const
const populationStates = ['verified', 'partial', 'unknown'] as const
const aggregateReportStates = ['consistent', 'conflicting', 'unknown'] as const
const numericPartitionTerminationReasons = [
  'reported_population_reached',
  'reported_page_count_reached',
  'short_page',
  'empty_page',
  'degenerate_page',
  'caller_limit',
  'safety_limit',
  'upstream_error',
  'unknown',
] as const

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
const partitionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'must be a canonical partition id')
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
    current_page: reportEvidenceSchema,
    page_size: reportEvidenceSchema,
  })
  .strict()

const paginationPositionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('page_index'),
      request_page_index: safePositiveIntegerSchema,
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

const partitionedNumericPaginationPositionSchema = z
  .object({
    kind: z.literal('partitioned_page_index'),
    partition_ordinal: safePositiveIntegerSchema,
    partition_id: partitionIdSchema,
    request_page_index: safePositiveIntegerSchema,
  })
  .strict()

const captureConfigSchema = z
  .object({
    caller_page_cap: safePositiveIntegerSchema.nullable(),
    safety_page_cap: safePositiveIntegerSchema,
  })
  .strict()

const parserTransformationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('identity_projection'),
      source_page_ordinals: z.array(safePositiveIntegerSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dedupe_rechunk'),
      source_page_ordinals: z.array(safePositiveIntegerSchema),
      algorithm_contract: nonEmptyCanonicalStringSchema,
      output_row_count: safeNonNegativeIntegerSchema,
      output_page_size: safePositiveIntegerSchema,
    })
    .strict(),
])

const partitionedNumericParserTransformationSchema = z
  .object({
    kind: z.literal('partitioned_numeric_projection'),
    source_page_ordinals: z.array(safePositiveIntegerSchema),
    algorithm_contract: z.literal(LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT),
    page_bindings: z.array(
      z
        .object({
          source_page_ordinal: safePositiveIntegerSchema,
          partition_ordinal: safePositiveIntegerSchema,
          partition_id: partitionIdSchema,
          request_page_index: safePositiveIntegerSchema,
          request_page_size: safePositiveIntegerSchema,
        })
        .strict()
    ),
  })
  .strict()

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

const partitionedNumericSourcePageInputSchema = sourcePageInputSchema
  .omit({ pagination_position: true })
  .extend({ pagination_position: partitionedNumericPaginationPositionSchema.nullable() })
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

const partitionedNumericSourceInputSchema = sourceInputSchema
  .extend({ configured_partition_ids: z.array(partitionIdSchema).min(2) })
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
    capture_config: captureConfigSchema,
    source_pages: z.array(sourcePageInputSchema),
    parse_pages: z.array(rawPageSchema),
    parser_transformation: parserTransformationSchema,
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

const durablePartitionedNumericSourcePageSchema = durableSourcePageSchema
  .omit({ pagination_position: true })
  .extend({ pagination_position: partitionedNumericPaginationPositionSchema.nullable() })
  .strict()

const aggregateReportSchema = z
  .object({
    state: z.enum(aggregateReportStates),
    value: safeNonNegativeIntegerSchema.nullable(),
  })
  .strict()

const acquisitionAttemptBindingSchema = z
  .object({
    binding_contract: z.literal(LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT),
    attempt_id: z.string().regex(CANONICAL_UUID, 'must be a canonical lowercase UUID'),
    attempt_seq: safePositiveIntegerSchema,
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
    capture_config: captureConfigSchema,
    source_pages: z.array(durableSourcePageSchema),
    parser_input: z
      .object({
        serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
        sha256: sha256Schema,
        page_count: safeNonNegativeIntegerSchema,
        transformation: parserTransformationSchema,
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

const durableManifestV3StructuralSchema = durableManifestStructuralSchema
  .omit({ data_contract: true })
  .extend({
    data_contract: z.literal(LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT),
    acquisition_attempt: acquisitionAttemptBindingSchema,
    /** Present only for an exhausted-mode capture (acquisition-exhaustion.ts). */
    completeness: leaderboardExhaustionCompletenessSchema.optional(),
  })
  .strict()

const buildV3InputSchema = buildInputSchema
  .extend({
    acquisition_attempt: acquisitionAttemptBindingSchema,
    completeness: leaderboardExhaustionCompletenessSchema.optional(),
  })
  .strict()

const partitionedNumericBuildPartitionSchema = z
  .object({
    partition_id: partitionIdSchema,
    source_page_ordinals: z.array(safePositiveIntegerSchema),
    parser_page_ordinals: z.array(safePositiveIntegerSchema),
    termination_reason: z.enum(numericPartitionTerminationReasons),
    capture_config: captureConfigSchema,
  })
  .strict()

const partitionedNumericDurablePartitionSchema = partitionedNumericBuildPartitionSchema
  .extend({
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

const partitionedNumericBuildTopologySchema = z
  .object({
    kind: z.literal('partitioned_numeric'),
    aggregation_contract: z.literal(LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT),
    rank_scope: z.literal('partition_local_concatenated_for_storage'),
    partitions: z.array(partitionedNumericBuildPartitionSchema),
  })
  .strict()

const partitionedNumericDurableTopologySchema = partitionedNumericBuildTopologySchema
  .omit({ partitions: true })
  .extend({
    expected_partition_ids: z.array(partitionIdSchema).min(2),
    partitions: z.array(partitionedNumericDurablePartitionSchema),
  })
  .strict()

const durableManifestV4StructuralSchema = durableManifestStructuralSchema
  .omit({ data_contract: true, source: true, source_pages: true, parser_input: true })
  .extend({
    data_contract: z.literal(LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT),
    source: partitionedNumericSourceInputSchema,
    source_pages: z.array(durablePartitionedNumericSourcePageSchema),
    parser_input: z
      .object({
        serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
        sha256: sha256Schema,
        page_count: safeNonNegativeIntegerSchema,
        transformation: partitionedNumericParserTransformationSchema,
      })
      .strict(),
    acquisition_attempt: acquisitionAttemptBindingSchema,
    pagination_topology: partitionedNumericDurableTopologySchema,
  })
  .strict()

const buildV4InputSchema = buildInputSchema
  .omit({ source: true, source_pages: true, parser_transformation: true })
  .extend({
    source: partitionedNumericSourceInputSchema,
    source_pages: z.array(partitionedNumericSourcePageInputSchema),
    parser_transformation: partitionedNumericParserTransformationSchema,
    acquisition_attempt: acquisitionAttemptBindingSchema,
    pagination_topology: partitionedNumericBuildTopologySchema,
  })
  .strict()

export type LeaderboardAcquisitionPaginationPosition = z.infer<typeof paginationPositionSchema>
export type LeaderboardPartitionedNumericPaginationPosition = z.infer<
  typeof partitionedNumericPaginationPositionSchema
>
export type LeaderboardAcquisitionReportEvidence = z.infer<typeof reportEvidenceSchema>
export type LeaderboardAcquisitionParserTransformation = z.infer<typeof parserTransformationSchema>
export type LeaderboardPartitionedNumericParserTransformation = z.infer<
  typeof partitionedNumericParserTransformationSchema
>
export type LeaderboardPartitionedNumericParserPageBinding =
  LeaderboardPartitionedNumericParserTransformation['page_bindings'][number]
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
  capture_config: {
    caller_page_cap: number | null
    safety_page_cap: number
  }
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
      current_page: LeaderboardAcquisitionReportEvidence
      page_size: LeaderboardAcquisitionReportEvidence
    } | null
  }>
  /** Deterministic parser inputs. These may be normalized projections of source_pages. */
  parse_pages: RawPage[]
  parser_transformation: LeaderboardAcquisitionParserTransformation
  accepted_population: number
  rejected_row_count: number
}

export interface BuildLeaderboardAcquisitionManifestV3Input extends BuildLeaderboardAcquisitionManifestInput {
  acquisition_attempt: {
    binding_contract: typeof LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT
    attempt_id: string
    attempt_seq: number
  }
  /** Exhausted-mode completeness evidence from the capture (absent = reported-total mode). */
  completeness?: LeaderboardExhaustionCompleteness
}

export type BuildLeaderboardAcquisitionManifestV4Input = Omit<
  BuildLeaderboardAcquisitionManifestInput,
  'source' | 'source_pages' | 'parser_transformation'
> & {
  source: BuildLeaderboardAcquisitionManifestInput['source'] & {
    configured_partition_ids: string[]
  }
  source_pages: Array<
    Omit<
      BuildLeaderboardAcquisitionManifestInput['source_pages'][number],
      'pagination_position'
    > & {
      pagination_position: LeaderboardPartitionedNumericPaginationPosition | null
    }
  >
  parser_transformation: LeaderboardPartitionedNumericParserTransformation
  acquisition_attempt: BuildLeaderboardAcquisitionManifestV3Input['acquisition_attempt']
  pagination_topology: {
    kind: 'partitioned_numeric'
    aggregation_contract: typeof LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT
    rank_scope: 'partition_local_concatenated_for_storage'
    partitions: Array<{
      partition_id: string
      source_page_ordinals: number[]
      parser_page_ordinals: number[]
      termination_reason: (typeof numericPartitionTerminationReasons)[number]
      capture_config: BuildLeaderboardAcquisitionManifestInput['capture_config']
    }>
  }
}

export type LeaderboardAcquisitionManifest = z.infer<typeof durableManifestStructuralSchema>
export type LeaderboardAcquisitionManifestV3 = z.infer<typeof durableManifestV3StructuralSchema>
export type LeaderboardAcquisitionManifestV4 = z.infer<typeof durableManifestV4StructuralSchema>
type LeaderboardAcquisitionManifestLike =
  | LeaderboardAcquisitionManifest
  | LeaderboardAcquisitionManifestV3
  | LeaderboardAcquisitionManifestV4
type DurableLeaderboardSourcePage = LeaderboardAcquisitionManifestLike['source_pages'][number]

export interface BuiltLeaderboardAcquisitionManifest {
  manifest: LeaderboardAcquisitionManifest
  canonicalJson: string
  sourceRunId: string
}

export interface BuiltLeaderboardAcquisitionManifestV3 {
  manifest: LeaderboardAcquisitionManifestV3
  canonicalJson: string
  sourceRunId: string
}

export interface BuiltLeaderboardAcquisitionManifestV4 {
  manifest: LeaderboardAcquisitionManifestV4
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

export function projectPartitionedNumericParserPage(
  sourcePage: RawPage,
  binding: LeaderboardPartitionedNumericParserPageBinding
): RawPage {
  return {
    pageIndex: sourcePage.pageIndex,
    payload: {
      data_contract: LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
      partition_id: binding.partition_id,
      request_page_index: binding.request_page_index,
      request_page_size: binding.request_page_size,
      payload: sourcePage.payload,
    },
    url: sourcePage.url,
    fetchedAt: sourcePage.fetchedAt,
  }
}

function deriveAggregateReport(
  pages: readonly DurableLeaderboardSourcePage[],
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

function pageResponseMetadataMatches(
  manifest: LeaderboardAcquisitionManifestLike,
  page: DurableLeaderboardSourcePage
): boolean {
  const reports = page.source_reports
  const position = page.pagination_position
  if (!reports || !position) return false

  if (reports.current_page.state === 'reported') {
    if (
      (position.kind !== 'page_index' && position.kind !== 'partitioned_page_index') ||
      reports.current_page.value !== position.request_page_index
    ) {
      return false
    }
  }
  if (reports.page_size.state === 'reported') {
    if (
      reports.page_size.value === 0 ||
      (manifest.source.configured_page_size !== null &&
        reports.page_size.value !== manifest.source.configured_page_size)
    ) {
      return false
    }
  }
  return true
}

function manifestCompleteness(
  manifest: LeaderboardAcquisitionManifestLike
): LeaderboardExhaustionCompleteness | null {
  return 'completeness' in manifest && manifest.completeness ? manifest.completeness : null
}

function exhaustionFacts(
  manifest: LeaderboardAcquisitionManifestLike,
  populationReport: AggregateReport,
  terminationReason: TerminationReason = manifest.termination_reason
): LeaderboardExhaustionManifestFacts {
  return {
    termination_reason: terminationReason,
    configured_page_size: manifest.source.configured_page_size,
    population_report_state: populationReport.state,
    source_pages: manifest.source_pages.map((page) => ({
      ordinal: page.ordinal,
      request_sha256: page.request_sha256,
      payload_sha256: page.payload.sha256,
      source_row_count: page.source_row_count,
    })),
    observed_row_count: manifest.population.observed_row_count,
    accepted_population: manifest.population.accepted_population,
    rejected_row_count: manifest.population.rejected_row_count,
    deduplicated_row_count: manifest.population.deduplicated_row_count,
  }
}

function hasVerifiedCaptureFoundation(manifest: LeaderboardAcquisitionManifestLike): boolean {
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
        page.source_reports !== null &&
        pageResponseMetadataMatches(manifest, page)
    )
  )
}

function isNaturalTermination(
  manifest: LeaderboardAcquisitionManifestLike,
  populationReport: AggregateReport,
  pageCountReport: AggregateReport,
  terminationReason: TerminationReason = manifest.termination_reason
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
      (position.kind === 'page_index' || position.kind === 'partitioned_page_index'
        ? position.request_page_index === pageCountReport.value ||
          (terminationReason === 'empty_page' &&
            position.request_page_index === pageCountReport.value! + 1)
        : position.kind === 'cursor'
          ? pages.length === pageCountReport.value
          : pageCountReport.value === 1))
  const continuationClaimsMore =
    position.kind === 'cursor' && position.response_next_cursor_sha256 !== null
  const hasContradictoryContinuation =
    !populationMatchesTerminal || !pageCountMatchesTerminal || continuationClaimsMore

  switch (terminationReason) {
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
        (position.kind === 'page_index' || position.kind === 'partitioned_page_index') &&
        position.request_page_index === pageCountReport.value &&
        populationMatchesTerminal
      )
    case 'short_page':
      return (
        (position.kind === 'page_index' || position.kind === 'partitioned_page_index') &&
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
    case 'end_signal_reached': {
      // Only an exhausted-mode capture can end on a source end signal.
      const completeness = manifestCompleteness(manifest)
      return (
        completeness !== null &&
        position.kind === 'page_index' &&
        populationReport.state === 'unknown' &&
        pageCountMatchesTerminal &&
        exhaustionEndSignalHolds(
          completeness,
          exhaustionFacts(manifest, populationReport, terminationReason)
        )
      )
    }
    case 'degenerate_page':
    case 'caller_limit':
    case 'safety_limit':
    case 'upstream_error':
    case 'unknown':
      return false
  }
}

function deriveAssessment(
  manifest: LeaderboardAcquisitionManifestLike,
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

  const completeness = manifestCompleteness(manifest)
  if (completeness !== null) {
    return {
      acquisition_state: 'complete',
      population_state: exhaustionCompletenessHolds(
        completeness,
        exhaustionFacts(manifest, populationReport)
      )
        ? 'verified'
        : 'unknown',
    }
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

type PartitionEvidence =
  LeaderboardAcquisitionManifestV4['pagination_topology']['partitions'][number]

function isPartitionedNumericManifest(
  manifest: LeaderboardAcquisitionManifestLike
): manifest is LeaderboardAcquisitionManifestV4 {
  return manifest.data_contract === LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT
}

function partitionPages(
  manifest: LeaderboardAcquisitionManifestV4,
  partition: Pick<PartitionEvidence, 'source_page_ordinals'>
): LeaderboardAcquisitionManifestV4['source_pages'] {
  return partition.source_page_ordinals.flatMap((ordinal) => {
    const page = manifest.source_pages[ordinal - 1]
    return page ? [page] : []
  })
}

function partitionManifestView(
  manifest: LeaderboardAcquisitionManifestV4,
  partition: PartitionEvidence
): LeaderboardAcquisitionManifestV4 {
  return {
    ...manifest,
    source_pages: partitionPages(manifest, partition),
    termination_reason: partition.termination_reason,
    capture_config: partition.capture_config,
    population: {
      observed_row_count: partition.observed_row_count,
      accepted_population: partition.accepted_population,
      rejected_row_count: partition.rejected_row_count,
      deduplicated_row_count: partition.deduplicated_row_count,
      reports: partition.reports,
    },
    caller_limited: partition.caller_limited,
    safety_limited: partition.safety_limited,
    assessment: partition.assessment,
  }
}

function derivePartitionedAggregateReport(
  manifest: LeaderboardAcquisitionManifestV4,
  field: 'population' | 'page_count'
): AggregateReport {
  const topology = manifest.pagination_topology
  if (
    topology.partitions.length !== topology.expected_partition_ids.length ||
    topology.partitions.some(
      (partition, index) => partition.partition_id !== topology.expected_partition_ids[index]
    )
  ) {
    return { state: 'unknown', value: null }
  }
  const reports = topology.partitions.map((partition) => partition.reports[field])
  if (reports.some((report) => report.state === 'conflicting')) {
    return { state: 'conflicting', value: null }
  }
  if (reports.some((report) => report.state !== 'consistent' || report.value === null)) {
    return { state: 'unknown', value: null }
  }
  return {
    state: 'consistent',
    value: safeIntegerSum(
      reports.map((report) => report.value!),
      `partitioned ${field} report sum`
    ),
  }
}

function derivePartitionedAssessment(
  manifest: LeaderboardAcquisitionManifestV4,
  populationReport: AggregateReport
): DerivedAssessment {
  if (!hasVerifiedCaptureFoundation(manifest)) {
    return { acquisition_state: 'unknown', population_state: 'unknown' }
  }

  const partitions = manifest.pagination_topology.partitions
  const exactPartitionSet =
    partitions.length === manifest.pagination_topology.expected_partition_ids.length &&
    partitions.every(
      (partition, index) =>
        partition.partition_id === manifest.pagination_topology.expected_partition_ids[index]
    )
  if (!exactPartitionSet) {
    return { acquisition_state: 'unknown', population_state: 'unknown' }
  }

  const acquisitionStatesForPartitions = partitions.map(
    (partition) => partition.assessment.acquisition_state
  )
  if (acquisitionStatesForPartitions.some((state) => state === 'unknown')) {
    return { acquisition_state: 'unknown', population_state: 'unknown' }
  }
  if (acquisitionStatesForPartitions.some((state) => state === 'partial')) {
    return { acquisition_state: 'partial', population_state: 'partial' }
  }

  const partitionPopulationStates = partitions.map(
    (partition) => partition.assessment.population_state
  )
  if (partitionPopulationStates.some((state) => state === 'unknown')) {
    return { acquisition_state: 'complete', population_state: 'unknown' }
  }

  const populationVerified =
    partitionPopulationStates.every((state) => state === 'verified') &&
    populationReport.state === 'consistent' &&
    populationReport.value === manifest.population.accepted_population &&
    manifest.population.rejected_row_count === 0 &&
    manifest.population.deduplicated_row_count === 0

  return {
    acquisition_state: 'complete',
    population_state: populationVerified ? 'verified' : 'partial',
  }
}

function derivePartitionedTerminationReason(
  manifest: LeaderboardAcquisitionManifestV4,
  populationReport: AggregateReport
): TerminationReason {
  if (manifest.capture_evidence_state === 'unavailable') return 'unknown'
  const partitions = manifest.pagination_topology.partitions
  const reasons = partitions.map((partition) => partition.termination_reason)
  if (reasons.includes('upstream_error')) return 'upstream_error'
  if (reasons.includes('safety_limit')) return 'safety_limit'
  if (reasons.includes('caller_limit')) return 'caller_limit'
  if (reasons.includes('degenerate_page')) return 'degenerate_page'
  if (
    partitions.length === manifest.pagination_topology.expected_partition_ids.length &&
    partitions.every((partition) => partition.assessment.acquisition_state === 'complete') &&
    populationReport.state === 'consistent'
  ) {
    // This means the sum of every explicitly named partition report was
    // reached. It never claims that the provider exposed one global total.
    return 'reported_population_reached'
  }
  const first = reasons[0]
  return first && reasons.every((reason) => reason === first) ? first : 'unknown'
}

function addIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
}

function validatePartitionedNumericTopology(
  manifest: LeaderboardAcquisitionManifestV4,
  ctx: z.RefinementCtx
): void {
  const topology = manifest.pagination_topology
  const expected = topology.expected_partition_ids
  const configured = manifest.source.configured_partition_ids
  if (new Set(configured).size !== configured.length) {
    addIssue(ctx, ['source', 'configured_partition_ids'], 'configured partition ids must be unique')
  }
  if (new Set(expected).size !== expected.length) {
    addIssue(
      ctx,
      ['pagination_topology', 'expected_partition_ids'],
      'expected partition ids must be unique'
    )
  }
  if (
    expected.length !== configured.length ||
    expected.some((partitionId, index) => partitionId !== configured[index])
  ) {
    addIssue(
      ctx,
      ['pagination_topology', 'expected_partition_ids'],
      'expected partition ids must exactly match the source configuration'
    )
  }
  if (
    topology.partitions.length !== expected.length ||
    topology.partitions.some((partition, index) => partition.partition_id !== expected[index])
  ) {
    addIssue(
      ctx,
      ['pagination_topology', 'partitions'],
      'partitions must exactly match the configured partition ids and order'
    )
  }
  if (manifest.source.configured_pagination_kind !== 'numeric') {
    addIssue(
      ctx,
      ['source', 'configured_pagination_kind'],
      'partitioned numeric capture requires numeric source pagination'
    )
  }
  if (manifest.parser_input.transformation.kind !== 'partitioned_numeric_projection') {
    addIssue(
      ctx,
      ['parser_input', 'transformation', 'kind'],
      'manifest v4 requires a partitioned numeric parser projection'
    )
  }

  const citedSourceOrdinals: number[] = []
  const citedParserOrdinals: number[] = []
  for (const [partitionIndex, partition] of topology.partitions.entries()) {
    const path = ['pagination_topology', 'partitions', partitionIndex] as const
    let previousSourceOrdinal = 0
    for (const [index, ordinal] of partition.source_page_ordinals.entries()) {
      if (ordinal <= previousSourceOrdinal || ordinal > manifest.source_pages.length) {
        addIssue(
          ctx,
          [...path, 'source_page_ordinals', index],
          'partition source-page ordinals must be unique, increasing, and in range'
        )
      }
      previousSourceOrdinal = ordinal
      citedSourceOrdinals.push(ordinal)
    }
    let previousParserOrdinal = 0
    for (const [index, ordinal] of partition.parser_page_ordinals.entries()) {
      if (ordinal <= previousParserOrdinal || ordinal > manifest.parser_input.page_count) {
        addIssue(
          ctx,
          [...path, 'parser_page_ordinals', index],
          'partition parser-page ordinals must be unique, increasing, and in range'
        )
      }
      previousParserOrdinal = ordinal
      citedParserOrdinals.push(ordinal)
      const transformation = manifest.parser_input.transformation
      const binding =
        transformation.kind === 'partitioned_numeric_projection'
          ? transformation.page_bindings[ordinal - 1]
          : undefined
      if (
        !binding ||
        binding.partition_ordinal !== partitionIndex + 1 ||
        binding.partition_id !== partition.partition_id
      ) {
        addIssue(
          ctx,
          [...path, 'parser_page_ordinals', index],
          'partition parser-page ordinal must bind the same partition'
        )
      }
    }

    const pages = partitionPages(manifest, partition)
    for (const [localIndex, page] of pages.entries()) {
      const position = page.pagination_position
      if (
        !position ||
        position.kind !== 'partitioned_page_index' ||
        position.partition_ordinal !== partitionIndex + 1 ||
        position.partition_id !== partition.partition_id ||
        position.request_page_index !== localIndex + 1
      ) {
        addIssue(
          ctx,
          [...path, 'source_page_ordinals', localIndex],
          'partition request page indexes must be contiguous from one and bind the partition'
        )
      }
    }

    let observed = 0
    try {
      observed = safeIntegerSum(
        pages.map((page) => page.source_row_count),
        `partition ${partition.partition_id} observed row count`
      )
    } catch (error) {
      addIssue(ctx, [...path, 'observed_row_count'], (error as Error).message)
    }
    if (partition.observed_row_count !== observed) {
      addIssue(
        ctx,
        [...path, 'observed_row_count'],
        'partition observed_row_count must equal its source-page row sum'
      )
    }
    const accounted = partition.accepted_population + partition.rejected_row_count
    if (
      !isSafeNonNegativeInteger(accounted) ||
      accounted > observed ||
      partition.deduplicated_row_count !== observed - accounted
    ) {
      addIssue(
        ctx,
        [...path, 'deduplicated_row_count'],
        'partition accepted, rejected, and deduplicated counts must account for every row'
      )
    }

    const populationReport = deriveAggregateReport(pages, 'population')
    const pageCountReport = deriveAggregateReport(pages, 'page_count')
    if (
      partition.reports.population.state !== populationReport.state ||
      partition.reports.population.value !== populationReport.value
    ) {
      addIssue(
        ctx,
        [...path, 'reports', 'population'],
        'partition population report is not centrally derived'
      )
    }
    if (
      partition.reports.page_count.state !== pageCountReport.state ||
      partition.reports.page_count.value !== pageCountReport.value
    ) {
      addIssue(
        ctx,
        [...path, 'reports', 'page_count'],
        'partition page-count report is not centrally derived'
      )
    }

    const pageCount = pages.length
    const callerCap = partition.capture_config.caller_page_cap
    const safetyCap = partition.capture_config.safety_page_cap
    if (
      pageCount > safetyCap ||
      (callerCap !== null && callerCap <= safetyCap && pageCount > callerCap)
    ) {
      addIssue(ctx, [...path, 'capture_config'], 'partition pages exceed their effective cap')
    }
    if (
      partition.termination_reason === 'caller_limit' &&
      (callerCap === null || callerCap > safetyCap || pageCount !== callerCap)
    ) {
      addIssue(ctx, [...path, 'termination_reason'], 'partition caller limit was not reached')
    }
    if (
      partition.termination_reason === 'safety_limit' &&
      (pageCount !== safetyCap || (callerCap !== null && callerCap <= safetyCap))
    ) {
      addIssue(ctx, [...path, 'termination_reason'], 'partition safety limit was not reached first')
    }

    const view = partitionManifestView(manifest, partition)
    validateLimitTerminationPriority(view, populationReport, pageCountReport, ctx)
    const assessment = deriveAssessment(view, populationReport, pageCountReport)
    if (
      partition.assessment.acquisition_state !== assessment.acquisition_state ||
      partition.assessment.population_state !== assessment.population_state
    ) {
      addIssue(ctx, [...path, 'assessment'], 'partition assessment is not centrally derived')
    }
    if (partition.caller_limited !== (partition.termination_reason === 'caller_limit')) {
      addIssue(ctx, [...path, 'caller_limited'], 'partition caller_limited is not derived')
    }
    if (partition.safety_limited !== (partition.termination_reason === 'safety_limit')) {
      addIssue(ctx, [...path, 'safety_limited'], 'partition safety_limited is not derived')
    }
  }

  const expectedSourceOrdinals = manifest.source_pages.map((_, index) => index + 1)
  if (
    citedSourceOrdinals.length !== expectedSourceOrdinals.length ||
    citedSourceOrdinals.some((ordinal, index) => ordinal !== expectedSourceOrdinals[index])
  ) {
    addIssue(
      ctx,
      ['pagination_topology', 'partitions'],
      'every source page must belong to exactly one partition'
    )
  }
  const expectedParserOrdinals = Array.from(
    { length: manifest.parser_input.page_count },
    (_, index) => index + 1
  )
  if (
    citedParserOrdinals.length !== expectedParserOrdinals.length ||
    citedParserOrdinals.some((ordinal, index) => ordinal !== expectedParserOrdinals[index])
  ) {
    addIssue(
      ctx,
      ['pagination_topology', 'partitions'],
      'every parser page must belong to exactly one partition'
    )
  }

  for (const field of [
    'observed_row_count',
    'accepted_population',
    'rejected_row_count',
    'deduplicated_row_count',
  ] as const) {
    try {
      const partitionSum = safeIntegerSum(
        topology.partitions.map((partition) => partition[field]),
        `partitioned ${field}`
      )
      if (partitionSum !== manifest.population[field]) {
        addIssue(
          ctx,
          ['pagination_topology', 'partitions'],
          `partition ${field} values must sum to the top-level population`
        )
      }
    } catch (error) {
      addIssue(ctx, ['pagination_topology', 'partitions'], (error as Error).message)
    }
  }

  try {
    const expectedSafetyCap = safeIntegerSum(
      topology.partitions.map((partition) => partition.capture_config.safety_page_cap),
      'partitioned safety page cap'
    )
    const callerCaps = topology.partitions.map(
      (partition) => partition.capture_config.caller_page_cap
    )
    const expectedCallerCap = callerCaps.every((cap) => cap !== null)
      ? safeIntegerSum(callerCaps as number[], 'partitioned caller page cap')
      : null
    if (
      manifest.capture_config.safety_page_cap !== expectedSafetyCap ||
      manifest.capture_config.caller_page_cap !== expectedCallerCap
    ) {
      addIssue(
        ctx,
        ['capture_config'],
        'top-level page caps must be the explicit sum of partition caps'
      )
    }
  } catch (error) {
    addIssue(ctx, ['capture_config'], (error as Error).message)
  }
}

function validatePaginationPositions(
  manifest: LeaderboardAcquisitionManifestLike,
  ctx: z.RefinementCtx
): void {
  if (isPartitionedNumericManifest(manifest)) {
    validatePartitionedNumericTopology(manifest, ctx)
    return
  }
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
      if (position!.kind !== 'page_index' || position!.request_page_index !== index + 1) {
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

function validateCaptureLimits(
  manifest: LeaderboardAcquisitionManifestLike,
  ctx: z.RefinementCtx
): void {
  const pageCount = manifest.source_pages.length
  const { caller_page_cap: callerCap, safety_page_cap: safetyCap } = manifest.capture_config
  if (pageCount > safetyCap) {
    addIssue(ctx, ['capture_config', 'safety_page_cap'], 'source pages exceed the safety cap')
  }
  if (callerCap !== null && callerCap <= safetyCap && pageCount > callerCap) {
    addIssue(ctx, ['capture_config', 'caller_page_cap'], 'source pages exceed the caller cap')
  }
  if (
    manifest.termination_reason === 'caller_limit' &&
    (callerCap === null || callerCap > safetyCap || pageCount !== callerCap)
  ) {
    addIssue(
      ctx,
      ['termination_reason'],
      'caller_limit must bind the reached effective caller page cap'
    )
  }
  if (
    manifest.termination_reason === 'safety_limit' &&
    (pageCount !== safetyCap || (callerCap !== null && callerCap <= safetyCap))
  ) {
    addIssue(
      ctx,
      ['termination_reason'],
      'safety_limit must bind the reached safety cap before any caller cap'
    )
  }
}

function validateLimitTerminationPriority(
  manifest: LeaderboardAcquisitionManifestLike,
  populationReport: AggregateReport,
  pageCountReport: AggregateReport,
  ctx: z.RefinementCtx
): void {
  if (
    manifest.termination_reason !== 'caller_limit' &&
    manifest.termination_reason !== 'safety_limit'
  ) {
    return
  }
  if (
    manifest.source_pages.some(
      (page) => page.http_status !== null && (page.http_status < 200 || page.http_status > 299)
    )
  ) {
    addIssue(ctx, ['termination_reason'], 'limit termination cannot override an upstream error')
    return
  }

  const naturalReasons: readonly TerminationReason[] = [
    'empty_page',
    'reported_population_reached',
    'reported_page_count_reached',
    'short_page',
    'cursor_exhausted',
    'single_snapshot',
    'end_signal_reached',
  ]
  const naturalReason = naturalReasons.find((reason) =>
    isNaturalTermination(manifest, populationReport, pageCountReport, reason)
  )
  if (naturalReason) {
    addIssue(
      ctx,
      ['termination_reason'],
      `limit termination cannot override natural termination ${naturalReason}`
    )
  }
}

function validateParserTransformation(
  manifest: LeaderboardAcquisitionManifestLike,
  ctx: z.RefinementCtx
): void {
  const transformation = manifest.parser_input.transformation
  const ordinals = transformation.source_page_ordinals
  let previous = 0
  for (const [index, ordinal] of ordinals.entries()) {
    if (ordinal <= previous || ordinal > manifest.source_pages.length) {
      addIssue(
        ctx,
        ['parser_input', 'transformation', 'source_page_ordinals', index],
        'source page ordinals must be unique, increasing, and in range'
      )
    }
    previous = ordinal
  }

  if (transformation.kind === 'identity_projection') {
    if (ordinals.length !== manifest.parser_input.page_count) {
      addIssue(
        ctx,
        ['parser_input', 'transformation', 'source_page_ordinals'],
        'identity projection must bind every parser page to one source page'
      )
    }
    return
  }

  if (transformation.kind === 'partitioned_numeric_projection') {
    if (!isPartitionedNumericManifest(manifest)) {
      addIssue(
        ctx,
        ['parser_input', 'transformation', 'kind'],
        'partitioned parser projection requires acquisition manifest v4'
      )
      return
    }
    if (
      transformation.page_bindings.length !== manifest.parser_input.page_count ||
      transformation.source_page_ordinals.length !== manifest.parser_input.page_count
    ) {
      addIssue(
        ctx,
        ['parser_input', 'transformation', 'page_bindings'],
        'partitioned projection requires one exact binding per parser page'
      )
      return
    }
    for (const [index, binding] of transformation.page_bindings.entries()) {
      const sourceOrdinal = transformation.source_page_ordinals[index]
      const page = manifest.source_pages[sourceOrdinal - 1]
      const position = page?.pagination_position
      if (
        binding.source_page_ordinal !== sourceOrdinal ||
        !position ||
        position.kind !== 'partitioned_page_index' ||
        binding.partition_ordinal !== position.partition_ordinal ||
        binding.partition_id !== position.partition_id ||
        binding.request_page_index !== position.request_page_index ||
        manifest.source.configured_page_size !== binding.request_page_size
      ) {
        addIssue(
          ctx,
          ['parser_input', 'transformation', 'page_bindings', index],
          'partitioned parser binding conflicts with its exact source page'
        )
      }
    }
    const citedSourceOrdinals = new Set(transformation.source_page_ordinals)
    for (const [index, page] of manifest.source_pages.entries()) {
      if (page.source_row_count > 0 && !citedSourceOrdinals.has(index + 1)) {
        addIssue(
          ctx,
          ['parser_input', 'transformation', 'source_page_ordinals'],
          'partitioned projection must include every source page that contains rows'
        )
      }
    }
    return
  }

  if (manifest.parser_input.page_count > 0 && ordinals.length === 0) {
    addIssue(
      ctx,
      ['parser_input', 'transformation', 'source_page_ordinals'],
      'dedupe/rechunk parser input must cite its source pages'
    )
  }
  if (
    transformation.output_row_count > manifest.population.observed_row_count ||
    manifest.population.accepted_population > transformation.output_row_count
  ) {
    addIssue(
      ctx,
      ['parser_input', 'transformation', 'output_row_count'],
      'dedupe/rechunk output rows must fall between accepted and observed population'
    )
  }
  const expectedPages = Math.ceil(transformation.output_row_count / transformation.output_page_size)
  if (manifest.parser_input.page_count !== expectedPages) {
    addIssue(
      ctx,
      ['parser_input', 'page_count'],
      'dedupe/rechunk page count must match accepted population and output page size'
    )
  }
}

function validateManifestInvariants(
  manifest: LeaderboardAcquisitionManifestLike,
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
  if (!isPartitionedNumericManifest(manifest)) validateCaptureLimits(manifest, ctx)
  validateParserTransformation(manifest, ctx)

  let populationReport: AggregateReport = { state: 'unknown', value: null }
  let pageCountReport: AggregateReport = { state: 'unknown', value: null }
  try {
    populationReport = isPartitionedNumericManifest(manifest)
      ? derivePartitionedAggregateReport(manifest, 'population')
      : deriveAggregateReport(manifest.source_pages, 'population')
    pageCountReport = isPartitionedNumericManifest(manifest)
      ? derivePartitionedAggregateReport(manifest, 'page_count')
      : deriveAggregateReport(manifest.source_pages, 'page_count')
  } catch (error) {
    addIssue(ctx, ['population', 'reports'], (error as Error).message)
  }
  const completeness = manifestCompleteness(manifest)
  if (completeness !== null) {
    if (manifest.capture_evidence_state !== 'verified') {
      addIssue(ctx, ['completeness'], 'exhausted completeness requires verified capture evidence')
    }
    if (populationReport.state !== 'unknown') {
      addIssue(
        ctx,
        ['completeness'],
        'exhausted completeness is only for boards without a reported population'
      )
    }
    for (const issue of exhaustionBindingIssues(
      completeness,
      exhaustionFacts(manifest, populationReport)
    )) {
      addIssue(ctx, ['completeness'], issue)
    }
  }
  if (!isPartitionedNumericManifest(manifest)) {
    validateLimitTerminationPriority(manifest, populationReport, pageCountReport, ctx)
  } else {
    const terminationReason = derivePartitionedTerminationReason(manifest, populationReport)
    if (manifest.termination_reason !== terminationReason) {
      addIssue(
        ctx,
        ['termination_reason'],
        'partitioned termination reason is not centrally derived'
      )
    }
  }
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

  const assessment = isPartitionedNumericManifest(manifest)
    ? derivePartitionedAssessment(manifest, populationReport)
    : deriveAssessment(manifest, populationReport, pageCountReport)
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
export const leaderboardAcquisitionManifestV3Schema = durableManifestV3StructuralSchema.superRefine(
  validateManifestInvariants
)
export const leaderboardAcquisitionManifestV4Schema = durableManifestV4StructuralSchema.superRefine(
  validateManifestInvariants
)

export function parseLeaderboardAcquisitionManifest(raw: unknown): LeaderboardAcquisitionManifest {
  return leaderboardAcquisitionManifestSchema.parse(raw)
}

export function parseLeaderboardAcquisitionManifestV3(
  raw: unknown
): LeaderboardAcquisitionManifestV3 {
  return leaderboardAcquisitionManifestV3Schema.parse(raw)
}

export function parseLeaderboardAcquisitionManifestV4(
  raw: unknown
): LeaderboardAcquisitionManifestV4 {
  return leaderboardAcquisitionManifestV4Schema.parse(raw)
}

type ParsedBuildInput = z.infer<typeof buildInputSchema>
type ParsedV4BuildInput = z.infer<typeof buildV4InputSchema>
type ParsedBuildInputLike = ParsedBuildInput | ParsedV4BuildInput

function assertParserProjection(input: ParsedBuildInputLike): void {
  const transformation = input.parser_transformation
  if (transformation.kind === 'identity_projection') {
    if (transformation.source_page_ordinals.length !== input.parse_pages.length) {
      throw new TypeError('identity projection must bind every parser page to one source page')
    }
    for (const [index, ordinal] of transformation.source_page_ordinals.entries()) {
      const sourcePage = input.source_pages[ordinal - 1]?.raw_page
      if (
        sourcePage === undefined ||
        strictCanonicalJson(sourcePage) !== strictCanonicalJson(input.parse_pages[index])
      ) {
        throw new TypeError(
          'identity projection parser pages must exactly equal their cited source pages'
        )
      }
    }
    return
  }
  if (transformation.kind !== 'partitioned_numeric_projection') return
  if (
    transformation.source_page_ordinals.length !== input.parse_pages.length ||
    transformation.page_bindings.length !== input.parse_pages.length
  ) {
    throw new TypeError('partitioned projection must bind every parser page exactly once')
  }
  for (const [index, binding] of transformation.page_bindings.entries()) {
    const sourceOrdinal = transformation.source_page_ordinals[index]
    const sourcePage = input.source_pages[sourceOrdinal - 1]?.raw_page
    if (
      binding.source_page_ordinal !== sourceOrdinal ||
      sourcePage === undefined ||
      strictCanonicalJson(projectPartitionedNumericParserPage(sourcePage, binding)) !==
        strictCanonicalJson(input.parse_pages[index])
    ) {
      throw new TypeError(
        'partitioned projection parser page does not match its exact source-page binding'
      )
    }
  }
}

function buildDurableSourcePages(
  input: ParsedBuildInput
): LeaderboardAcquisitionManifest['source_pages'] {
  return input.source_pages.map((page, index) => ({
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
  }))
}

function buildDurablePartitionedSourcePages(
  input: ParsedV4BuildInput
): LeaderboardAcquisitionManifestV4['source_pages'] {
  return input.source_pages.map((page, index) => ({
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
  }))
}

function populationAccounting(input: ParsedBuildInputLike): {
  observedRowCount: number
  accounted: number
} {
  const observedRowCount = safeIntegerSum(
    input.source_pages.map((page) => page.source_row_count),
    'observed row count'
  )
  const accounted = input.accepted_population + input.rejected_row_count
  if (!isSafeNonNegativeInteger(accounted) || accounted > observedRowCount) {
    throw new TypeError('accepted and rejected counts cannot exceed observed_row_count')
  }
  return { observedRowCount, accounted }
}

export function buildLeaderboardAcquisitionManifest(
  rawInput: BuildLeaderboardAcquisitionManifestInput
): BuiltLeaderboardAcquisitionManifest {
  const input = buildInputSchema.parse(rawInput)
  assertParserProjection(input)
  const { observedRowCount, accounted } = populationAccounting(input)
  const sourcePages = buildDurableSourcePages(input)
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
    capture_config: input.capture_config,
    source_pages: sourcePages,
    parser_input: {
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      sha256: strictCanonicalSha256(input.parse_pages),
      page_count: input.parse_pages.length,
      transformation: input.parser_transformation,
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

/**
 * Build attempt-bound evidence without changing the still-live v2 path.
 * The physical attempt identity is part of the canonical body, so two
 * captures cannot share a source_run_id merely because their clocks and
 * upstream bytes happen to match.
 */
export function buildLeaderboardAcquisitionManifestV3(
  rawInput: BuildLeaderboardAcquisitionManifestV3Input
): BuiltLeaderboardAcquisitionManifestV3 {
  const input = buildV3InputSchema.parse(rawInput)
  const { acquisition_attempt: acquisitionAttempt, completeness, ...legacyInput } = input
  const legacy = buildLeaderboardAcquisitionManifest(legacyInput)
  const { data_contract: _legacyContract, ...body } = legacy.manifest
  const structural: LeaderboardAcquisitionManifestV3 = {
    ...body,
    data_contract: LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
    acquisition_attempt: acquisitionAttempt,
    ...(completeness ? { completeness } : {}),
  }
  if (completeness) {
    // The legacy body cannot see exhaustion evidence; assess it on the V3 body.
    structural.assessment = deriveAssessment(
      structural,
      body.population.reports.population,
      body.population.reports.page_count
    )
  }
  const manifest = parseLeaderboardAcquisitionManifestV3(structural)
  const canonicalJson = strictCanonicalJson(manifest)
  return {
    manifest,
    canonicalJson,
    sourceRunId: strictCanonicalSha256(manifest),
  }
}

/**
 * Build attempt-bound evidence for a source composed of independent numeric
 * pagination partitions. Top-level report values are explicitly the safe sum
 * of per-partition reports under `pagination_topology.aggregation_contract`;
 * they are never represented as one upstream-reported global population.
 */
export function buildLeaderboardAcquisitionManifestV4(
  rawInput: BuildLeaderboardAcquisitionManifestV4Input
): BuiltLeaderboardAcquisitionManifestV4 {
  const input = buildV4InputSchema.parse(rawInput)
  if (input.parser_transformation.kind !== 'partitioned_numeric_projection') {
    throw new TypeError('acquisition manifest v4 requires a partitioned parser projection')
  }
  assertParserProjection(input)
  const { observedRowCount, accounted } = populationAccounting(input)
  if (input.rejected_row_count !== 0 || accounted !== observedRowCount) {
    throw new TypeError(
      'partitioned numeric manifest requires zero rejected and deduplicated source rows'
    )
  }
  const sourcePages = buildDurablePartitionedSourcePages(input)

  const partitions: PartitionEvidence[] = input.pagination_topology.partitions.map((partition) => {
    const pages = partition.source_page_ordinals.flatMap((ordinal) => {
      const page = sourcePages[ordinal - 1]
      return page ? [page] : []
    })
    const observed = safeIntegerSum(
      pages.map((page) => page.source_row_count),
      `partition ${partition.partition_id} observed row count`
    )
    const accepted = safeIntegerSum(
      partition.parser_page_ordinals.flatMap((parserOrdinal) => {
        const sourceOrdinal = input.parser_transformation.source_page_ordinals[parserOrdinal - 1]
        const page = sourceOrdinal === undefined ? undefined : sourcePages[sourceOrdinal - 1]
        return page ? [page.source_row_count] : []
      }),
      `partition ${partition.partition_id} accepted population`
    )
    return {
      ...partition,
      observed_row_count: observed,
      accepted_population: accepted,
      rejected_row_count: 0,
      deduplicated_row_count: observed - accepted,
      reports: {
        population: deriveAggregateReport(pages, 'population'),
        page_count: deriveAggregateReport(pages, 'page_count'),
      },
      caller_limited: partition.termination_reason === 'caller_limit',
      safety_limited: partition.termination_reason === 'safety_limit',
      assessment: {
        acquisition_state: 'unknown',
        population_state: 'unknown',
      },
    }
  })

  const structuralManifest: LeaderboardAcquisitionManifestV4 = {
    data_contract: LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT,
    source: input.source,
    surface: input.surface,
    timeframe: input.timeframe,
    started_at: input.started_at,
    completed_at: input.completed_at,
    runner_git_sha: input.runner_git_sha,
    observation_cycle_id: input.observation_cycle_id,
    capture_evidence_state: input.capture_evidence_state,
    termination_reason: 'unknown',
    capture_config: input.capture_config,
    source_pages: sourcePages,
    parser_input: {
      serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
      sha256: strictCanonicalSha256(input.parse_pages),
      page_count: input.parse_pages.length,
      transformation: input.parser_transformation,
    },
    population: {
      observed_row_count: observedRowCount,
      accepted_population: input.accepted_population,
      rejected_row_count: input.rejected_row_count,
      deduplicated_row_count: observedRowCount - accounted,
      reports: {
        population: { state: 'unknown', value: null },
        page_count: { state: 'unknown', value: null },
      },
    },
    caller_limited: false,
    safety_limited: false,
    assessment: {
      acquisition_state: 'unknown',
      population_state: 'unknown',
    },
    acquisition_attempt: input.acquisition_attempt,
    pagination_topology: {
      kind: input.pagination_topology.kind,
      aggregation_contract: input.pagination_topology.aggregation_contract,
      rank_scope: input.pagination_topology.rank_scope,
      expected_partition_ids: input.source.configured_partition_ids,
      partitions,
    },
  }

  for (const partition of structuralManifest.pagination_topology.partitions) {
    const view = partitionManifestView(structuralManifest, partition)
    partition.assessment = deriveAssessment(
      view,
      partition.reports.population,
      partition.reports.page_count
    )
  }
  const populationReport = derivePartitionedAggregateReport(structuralManifest, 'population')
  const pageCountReport = derivePartitionedAggregateReport(structuralManifest, 'page_count')
  structuralManifest.population.reports = {
    population: populationReport,
    page_count: pageCountReport,
  }
  structuralManifest.termination_reason = derivePartitionedTerminationReason(
    structuralManifest,
    populationReport
  )
  if (input.termination_reason !== structuralManifest.termination_reason) {
    throw new TypeError('partitioned termination reason conflicts with its partition evidence')
  }
  structuralManifest.caller_limited = structuralManifest.termination_reason === 'caller_limit'
  structuralManifest.safety_limited = structuralManifest.termination_reason === 'safety_limit'
  structuralManifest.assessment = derivePartitionedAssessment(structuralManifest, populationReport)

  const manifest = parseLeaderboardAcquisitionManifestV4(structuralManifest)
  const canonicalJson = strictCanonicalJson(manifest)
  return {
    manifest,
    canonicalJson,
    sourceRunId: strictCanonicalSha256(manifest),
  }
}
