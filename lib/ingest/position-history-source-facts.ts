import { z } from 'zod'

import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
  type SelectedHistoryTerminalVerifier,
} from './history-acquisition'
import { strictCanonicalJson, strictCanonicalSha256 } from './strict-canonical-json'
import { binancePositionHistorySourceFactContract } from './adapters/binance/position-history-source-facts'
import { binancePositionHistoryTerminalVerifier } from './adapters/binance/history-terminal'
import { okxPositionHistorySourceFactContract } from './adapters/okx/position-history-source-facts'
import { okxPositionHistoryTerminalVerifier } from './adapters/okx/history-terminal'

export const POSITION_HISTORY_SOURCE_FACT_LEDGER_CONTRACT =
  'arena.ingest.position-history-source-fact-ledger@1' as const

const duplicatePolicies = ['forbid', 'exact_cross_segment'] as const

const canonicalIdentitySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim() === value, 'must not have surrounding whitespace')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'must not contain control characters')
const canonicalNullableTextSchema = canonicalIdentitySchema.nullable()
const canonicalSourceScalarSchema = canonicalIdentitySchema
  .max(256)
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)), 'must encode a finite numeric source scalar')
  .nullable()
const canonicalTimestampSchema = z.string().refine((value) => {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}, 'must be a canonical ISO timestamp')
const nullableTimestampSchema = canonicalTimestampSchema.nullable()
const nullableFiniteNumberSchema = z
  .number()
  .refine((value) => Number.isFinite(value) && !Object.is(value, -0), {
    message: 'must be finite and not negative zero',
  })
  .nullable()
const safePositiveIntegerSchema = z
  .number()
  .refine(
    (value) => Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0),
    'must be a positive safe integer'
  )
const safeNonNegativeIntegerSchema = z
  .number()
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
    'must be a non-negative safe integer'
  )
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const sourceSlugSchema = z.string().regex(/^[a-z0-9_]+$/)
const segmentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,63}$/)
const pathKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)
const candidatePathSchema = z.array(pathKeySchema).min(1)
const terminalVerifierContractSchema = z
  .string()
  .regex(/^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*@[1-9][0-9]*$/)
const sourceFactContractSchema = z
  .string()
  .regex(/^arena\.ingest\.position-history-source-facts\.[a-z0-9_]+(?:\.[a-z0-9_]+)*@[1-9][0-9]*$/)

const canonicalSourceNumericScalarsSchema = z
  .object({
    sourceReturn: canonicalSourceScalarSchema,
    leverage: canonicalSourceScalarSchema,
    size: canonicalSourceScalarSchema,
    entryPrice: canonicalSourceScalarSchema,
    exitPrice: canonicalSourceScalarSchema,
    realizedPnl: canonicalSourceScalarSchema,
  })
  .strict()

/**
 * The source contract must always emit every key. A null means the source did
 * not provide a trustworthy value; it must never be replaced with zero or an
 * inferred value. This is acquisition evidence, not parser/rank eligibility.
 */
export const canonicalPositionHistorySourceFactSchema = z
  .object({
    sourceFactId: canonicalIdentitySchema,
    sourceLifecycleMarker: canonicalNullableTextSchema,
    sourceReturn: nullableFiniteNumberSchema,
    openedAt: nullableTimestampSchema,
    closedAt: nullableTimestampSchema,
    symbol: canonicalNullableTextSchema,
    side: canonicalNullableTextSchema,
    leverage: nullableFiniteNumberSchema,
    size: nullableFiniteNumberSchema,
    entryPrice: nullableFiniteNumberSchema,
    exitPrice: nullableFiniteNumberSchema,
    realizedPnl: nullableFiniteNumberSchema,
    /** String inputs preserve their captured spelling; decoded JSON numbers cannot recover wire text. */
    sourceNumericScalars: canonicalSourceNumericScalarsSchema,
  })
  .strict()

export type CanonicalPositionHistorySourceFact = z.infer<
  typeof canonicalPositionHistorySourceFactSchema
>

const candidateInspectionSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('source_fact'),
      sourceFact: canonicalPositionHistorySourceFactSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('unavailable'),
      reason: canonicalIdentitySchema.max(256),
    })
    .strict(),
])

export type PositionHistoryCandidateInspection = z.infer<typeof candidateInspectionSchema>

export interface ReviewedPositionHistorySourceFactContract {
  readonly contract: string
  readonly sourceSlug: string
  readonly terminalVerifierContract: string
  readonly candidatePathBySegment: Readonly<Record<string, readonly [string, ...string[]]>>
  readonly duplicatePolicy: (typeof duplicatePolicies)[number]
  /** Binance genesis requires closing and opening to contain the same fact set. */
  readonly requireIdenticalSegmentFactSets: boolean
  /**
   * Receives exactly one framework-enumerated, deeply frozen RAW candidate.
   * It never receives pages, counts, or ledger coordinates.
   */
  readonly inspectCandidate: (input: {
    readonly rawCandidate: Readonly<Record<string, unknown>>
    readonly sourceId: number
    readonly sourceSlug: string
    readonly exchangeTraderId: string
  }) => PositionHistoryCandidateInspection
}

interface ReviewedSourceFactRegistryEntry {
  readonly sourceFactContract: ReviewedPositionHistorySourceFactContract
  readonly terminalVerifier: SelectedHistoryTerminalVerifier
  readonly activeForBuild: boolean
}

/**
 * Closed, code-reviewed registry. Runtime callers cannot supply candidate
 * paths, inspectors, duplicate policy, or terminal verifiers.
 */
const reviewedSourceFactRegistry: readonly ReviewedSourceFactRegistryEntry[] = Object.freeze([
  Object.freeze({
    sourceFactContract: binancePositionHistorySourceFactContract,
    terminalVerifier: binancePositionHistoryTerminalVerifier,
    activeForBuild: true,
  }),
  Object.freeze({
    sourceFactContract: okxPositionHistorySourceFactContract,
    terminalVerifier: okxPositionHistoryTerminalVerifier,
    activeForBuild: true,
  }),
])

const sourceFactEntrySchema = z
  .object({
    source_fact_id: canonicalIdentitySchema,
    canonical_fact_sha256: sha256Schema,
    fact: canonicalPositionHistorySourceFactSchema,
  })
  .strict()

const occurrenceSchema = z
  .object({
    row_ordinal: safePositiveIntegerSchema,
    raw_candidate_sha256: sha256Schema,
    source_fact_id: canonicalIdentitySchema,
    canonical_fact_sha256: sha256Schema,
  })
  .strict()

const ledgerPageSchema = z
  .object({
    page_ordinal: safePositiveIntegerSchema,
    candidate_count: safeNonNegativeIntegerSchema,
    occurrences: z.array(occurrenceSchema),
  })
  .strict()

const ledgerSegmentSchema = z
  .object({
    segment_id: segmentIdSchema,
    candidate_path: candidatePathSchema,
    pages: z.array(ledgerPageSchema).min(1),
  })
  .strict()

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export const positionHistorySourceFactLedgerSchema = z
  .object({
    contract: z.literal(POSITION_HISTORY_SOURCE_FACT_LEDGER_CONTRACT),
    acquisition_contract: z.literal('arena.ingest.history-acquisition-artifact@1'),
    acquisition_source_run_id: sha256Schema,
    source_id: safePositiveIntegerSchema,
    source_slug: sourceSlugSchema,
    trader_id: safePositiveIntegerSchema,
    exchange_trader_id: canonicalIdentitySchema,
    terminal_verifier_contract: terminalVerifierContractSchema,
    source_fact_contract: sourceFactContractSchema,
    duplicate_policy: z.enum(duplicatePolicies),
    require_identical_segment_fact_sets: z.boolean(),
    observed_candidate_count: safeNonNegativeIntegerSchema,
    unique_source_fact_count: safeNonNegativeIntegerSchema,
    fact_set_sha256: sha256Schema,
    segments: z.array(ledgerSegmentSchema).min(1),
    source_facts: z.array(sourceFactEntrySchema),
  })
  .strict()
  .superRefine((ledger, ctx) => {
    if (
      ledger.require_identical_segment_fact_sets &&
      ledger.duplicate_policy !== 'exact_cross_segment'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['require_identical_segment_fact_sets'],
        message: 'identical segment fact sets require exact cross-segment duplicates',
      })
    }

    const factById = new Map<string, (typeof ledger.source_facts)[number]>()
    let previousFactId: string | null = null
    ledger.source_facts.forEach((entry, index) => {
      if (
        previousFactId !== null &&
        compareCanonicalText(previousFactId, entry.source_fact_id) >= 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['source_facts', index, 'source_fact_id'],
          message: 'source facts must be unique and sorted by raw UTF-16 code units',
        })
      }
      previousFactId = entry.source_fact_id
      if (entry.fact.sourceFactId !== entry.source_fact_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['source_facts', index, 'fact', 'sourceFactId'],
          message: 'source fact identity does not match its ledger key',
        })
      }
      try {
        if (strictCanonicalSha256(entry.fact) !== entry.canonical_fact_sha256) {
          ctx.addIssue({
            code: 'custom',
            path: ['source_facts', index, 'canonical_fact_sha256'],
            message: 'canonical fact digest does not match the fact',
          })
        }
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['source_facts', index, 'fact'],
          message: error instanceof Error ? error.message : 'fact is not strict canonical JSON',
        })
      }
      factById.set(entry.source_fact_id, entry)
    })

    if (ledger.unique_source_fact_count !== ledger.source_facts.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['unique_source_fact_count'],
        message: 'unique fact count must equal the normalized fact ledger length',
      })
    }

    const expectedFactSet = ledger.source_facts.map((entry) => ({
      source_fact_id: entry.source_fact_id,
      canonical_fact_sha256: entry.canonical_fact_sha256,
    }))
    try {
      if (strictCanonicalSha256(expectedFactSet) !== ledger.fact_set_sha256) {
        ctx.addIssue({
          code: 'custom',
          path: ['fact_set_sha256'],
          message: 'fact-set digest does not match the normalized fact ledger',
        })
      }
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['fact_set_sha256'],
        message: error instanceof Error ? error.message : 'fact set is not canonical JSON',
      })
    }

    const segmentIds = new Set<string>()
    const globalOccurrences = new Map<
      string,
      Array<{ segmentId: string; canonicalFactSha256: string }>
    >()
    const segmentFactSets: Set<string>[] = []
    let expectedPageOrdinal = 1
    let observedCandidateCount = 0

    ledger.segments.forEach((segment, segmentIndex) => {
      if (segmentIds.has(segment.segment_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['segments', segmentIndex, 'segment_id'],
          message: 'segment ids must be unique',
        })
      }
      segmentIds.add(segment.segment_id)
      const localFactIds = new Set<string>()

      segment.pages.forEach((page, pageIndex) => {
        if (page.page_ordinal !== expectedPageOrdinal) {
          ctx.addIssue({
            code: 'custom',
            path: ['segments', segmentIndex, 'pages', pageIndex, 'page_ordinal'],
            message: 'ledger pages must be globally contiguous and start at one',
          })
        }
        expectedPageOrdinal += 1
        if (page.candidate_count !== page.occurrences.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['segments', segmentIndex, 'pages', pageIndex, 'candidate_count'],
            message: 'page candidate count must equal its occurrence count',
          })
        }
        observedCandidateCount += page.occurrences.length

        page.occurrences.forEach((occurrence, occurrenceIndex) => {
          if (occurrence.row_ordinal !== occurrenceIndex + 1) {
            ctx.addIssue({
              code: 'custom',
              path: [
                'segments',
                segmentIndex,
                'pages',
                pageIndex,
                'occurrences',
                occurrenceIndex,
                'row_ordinal',
              ],
              message: 'row ordinals must be contiguous and start at one',
            })
          }
          if (localFactIds.has(occurrence.source_fact_id)) {
            ctx.addIssue({
              code: 'custom',
              path: [
                'segments',
                segmentIndex,
                'pages',
                pageIndex,
                'occurrences',
                occurrenceIndex,
                'source_fact_id',
              ],
              message: 'a source fact may occur only once within a segment',
            })
          }
          localFactIds.add(occurrence.source_fact_id)

          const fact = factById.get(occurrence.source_fact_id)
          if (!fact || fact.canonical_fact_sha256 !== occurrence.canonical_fact_sha256) {
            ctx.addIssue({
              code: 'custom',
              path: [
                'segments',
                segmentIndex,
                'pages',
                pageIndex,
                'occurrences',
                occurrenceIndex,
                'canonical_fact_sha256',
              ],
              message: 'occurrence must reference the exact normalized source fact',
            })
          }
          const occurrences = globalOccurrences.get(occurrence.source_fact_id) ?? []
          occurrences.push({
            segmentId: segment.segment_id,
            canonicalFactSha256: occurrence.canonical_fact_sha256,
          })
          globalOccurrences.set(occurrence.source_fact_id, occurrences)
        })
      })
      segmentFactSets.push(localFactIds)
    })

    if (observedCandidateCount !== ledger.observed_candidate_count) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed_candidate_count'],
        message: 'observed count must equal every framework-owned occurrence',
      })
    }
    if (globalOccurrences.size !== ledger.source_facts.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['source_facts'],
        message: 'every normalized source fact must be referenced by an occurrence',
      })
    }

    for (const [sourceFactId, occurrences] of globalOccurrences) {
      if (ledger.duplicate_policy === 'forbid' && occurrences.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['duplicate_policy'],
          message: `duplicate source fact is forbidden: ${sourceFactId}`,
        })
      }
      const segmentCount = new Set(occurrences.map((item) => item.segmentId)).size
      if (segmentCount !== occurrences.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['segments'],
          message: `source fact is duplicated within a segment: ${sourceFactId}`,
        })
      }
      if (new Set(occurrences.map((item) => item.canonicalFactSha256)).size !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['segments'],
          message: `cross-segment source fact is not canonically identical: ${sourceFactId}`,
        })
      }
    }

    if (ledger.require_identical_segment_fact_sets && segmentFactSets.length > 1) {
      const first = segmentFactSets[0]
      for (const [index, factSet] of segmentFactSets.slice(1).entries()) {
        if (
          factSet.size !== first.size ||
          [...first].some((sourceFactId) => !factSet.has(sourceFactId))
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['segments', index + 1],
            message: 'all segment source-fact sets must be identical',
          })
        }
      }
    }
  })

export type PositionHistorySourceFactLedger = z.infer<typeof positionHistorySourceFactLedgerSchema>

export type PositionHistorySourceFactEvidence =
  | Readonly<{
      state: 'verified'
      ledger: PositionHistorySourceFactLedger
      ledgerSha256: string
    }>
  | Readonly<{
      state: 'unavailable'
      reason: string
    }>

export type PositionHistorySourceFactLedgerVerification =
  Readonly<{ verified: true; ledgerSha256: string }> | Readonly<{ verified: false; reason: string }>

const acquisitionAnchorSchema = z
  .object({
    sourceRunId: sha256Schema,
    sourceId: safePositiveIntegerSchema,
    sourceSlug: sourceSlugSchema,
    traderId: safePositiveIntegerSchema,
    exchangeTraderId: canonicalIdentitySchema,
  })
  .strict()

export type PositionHistoryAcquisitionAnchor = z.infer<typeof acquisitionAnchorSchema>

type Dict = Record<string, unknown>

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreezeJson(item))
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => deepFreezeJson(item))
    return Object.freeze(value)
  }
  return value
}

function canonicalClone<T>(value: T): T {
  return deepFreezeJson(JSON.parse(strictCanonicalJson(value))) as T
}

function unavailable(reason: string): PositionHistorySourceFactEvidence {
  return Object.freeze({ state: 'unavailable', reason })
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareCanonicalText)
  const sortedExpected = [...expected].sort(compareCanonicalText)
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  )
}

function resolveOwnPath(root: unknown, path: readonly string[]): unknown {
  let value = root
  for (const key of path) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return undefined
    value = descriptor.value
  }
  return value
}

function normalizedContract(selected: ReviewedPositionHistorySourceFactContract): Readonly<{
  contract: string
  sourceSlug: string
  terminalVerifierContract: string
  candidatePathBySegment: Record<string, string[]>
  duplicatePolicy: (typeof duplicatePolicies)[number]
  requireIdenticalSegmentFactSets: boolean
  inspectCandidate: ReviewedPositionHistorySourceFactContract['inspectCandidate']
}> | null {
  if (
    !isRecord(selected) ||
    !exactKeys(selected, [
      'contract',
      'sourceSlug',
      'terminalVerifierContract',
      'candidatePathBySegment',
      'duplicatePolicy',
      'requireIdenticalSegmentFactSets',
      'inspectCandidate',
    ]) ||
    typeof selected.inspectCandidate !== 'function'
  ) {
    return null
  }
  let metadata: unknown
  try {
    metadata = canonicalClone({
      contract: selected.contract,
      sourceSlug: selected.sourceSlug,
      terminalVerifierContract: selected.terminalVerifierContract,
      candidatePathBySegment: selected.candidatePathBySegment,
      duplicatePolicy: selected.duplicatePolicy,
      requireIdenticalSegmentFactSets: selected.requireIdenticalSegmentFactSets,
    })
  } catch {
    return null
  }
  const parsed = z
    .object({
      contract: sourceFactContractSchema,
      sourceSlug: sourceSlugSchema,
      terminalVerifierContract: terminalVerifierContractSchema,
      candidatePathBySegment: z.record(segmentIdSchema, candidatePathSchema),
      duplicatePolicy: z.enum(duplicatePolicies),
      requireIdenticalSegmentFactSets: z.boolean(),
    })
    .strict()
    .safeParse(metadata)
  if (!parsed.success || Object.keys(parsed.data.candidatePathBySegment).length === 0) {
    return null
  }
  if (
    parsed.data.requireIdenticalSegmentFactSets &&
    parsed.data.duplicatePolicy !== 'exact_cross_segment'
  ) {
    return null
  }
  return Object.freeze({ ...parsed.data, inspectCandidate: selected.inspectCandidate })
}

interface ArtifactView {
  artifact: HistoryAcquisitionArtifact
  acquisitionSourceRunId: string
  sourceId: number
  sourceSlug: string
  traderId: number
  exchangeTraderId: string
  terminalVerifierContract: string
  pages: HistoryAcquisitionArtifact['pages']
  observations: HistoryAcquisitionArtifact['termination']['claim_observations']
}

function verifiedArtifactView(raw: unknown): ArtifactView | null {
  let artifact: HistoryAcquisitionArtifact
  try {
    artifact = parseHistoryAcquisitionArtifact(raw)
  } catch {
    return null
  }
  if (
    artifact.history_kind !== 'position_history' ||
    !isRecord(artifact.source) ||
    typeof artifact.source.slug !== 'string' ||
    !isRecord(artifact.trader) ||
    typeof artifact.trader.exchange_trader_id !== 'string' ||
    !Array.isArray(artifact.pages) ||
    artifact.pages.length === 0 ||
    !isRecord(artifact.termination) ||
    artifact.termination.evidence_state !== 'verified' ||
    typeof artifact.termination.verifier_contract !== 'string' ||
    !Array.isArray(artifact.termination.claim_observations) ||
    artifact.termination.claim_observations.length === 0
  ) {
    return null
  }

  let previousTerminalOrdinal = 0
  const segmentIds = new Set<string>()
  for (const observation of artifact.termination.claim_observations) {
    if (
      !isRecord(observation) ||
      typeof observation.segment_id !== 'string' ||
      !Number.isSafeInteger(observation.page_ordinal) ||
      observation.page_ordinal <= previousTerminalOrdinal ||
      observation.page_ordinal > artifact.pages.length ||
      segmentIds.has(observation.segment_id)
    ) {
      return null
    }
    previousTerminalOrdinal = observation.page_ordinal
    segmentIds.add(observation.segment_id)
  }
  if (previousTerminalOrdinal !== artifact.pages.length) return null

  for (const [index, page] of artifact.pages.entries()) {
    if (!isRecord(page) || page.ordinal !== index + 1 || typeof page.payload_sha256 !== 'string') {
      return null
    }
    try {
      if (strictCanonicalSha256(page.payload) !== page.payload_sha256) return null
    } catch {
      return null
    }
  }

  return {
    artifact,
    acquisitionSourceRunId: strictCanonicalSha256(artifact),
    sourceId: artifact.source.id,
    sourceSlug: artifact.source.slug,
    traderId: artifact.trader.id,
    exchangeTraderId: artifact.trader.exchange_trader_id,
    terminalVerifierContract: artifact.termination.verifier_contract,
    pages: artifact.pages,
    observations: artifact.termination.claim_observations,
  }
}

function selectRegistryEntry(
  artifact: ArtifactView,
  sourceFactContract: string | null
): ReviewedSourceFactRegistryEntry | null {
  const matches = reviewedSourceFactRegistry.filter(
    (entry) =>
      entry.sourceFactContract.sourceSlug === artifact.sourceSlug &&
      entry.sourceFactContract.terminalVerifierContract === artifact.terminalVerifierContract &&
      entry.terminalVerifier.contract === artifact.terminalVerifierContract &&
      (sourceFactContract === null
        ? entry.activeForBuild
        : entry.sourceFactContract.contract === sourceFactContract)
  )
  return matches.length === 1 ? matches[0] : null
}

function terminalVerificationMatchesArtifact(
  artifact: ArtifactView,
  verification: unknown
): boolean {
  if (!isRecord(verification) || verification.verified !== true) return false
  const terminal = artifact.artifact.termination
  if (terminal.scan_terminal_state === 'exhausted') {
    return (
      exactKeys(verification, ['verified', 'scanTerminalState']) &&
      verification.scanTerminalState === 'exhausted'
    )
  }
  return (
    terminal.scan_terminal_state === 'cursor_overlap' &&
    exactKeys(verification, ['verified', 'scanTerminalState', 'overlapEventAt']) &&
    verification.scanTerminalState === 'cursor_overlap' &&
    verification.overlapEventAt === terminal.overlap_event_at
  )
}

function revalidateTerminalEvidence(
  artifact: ArtifactView,
  terminalVerifier: SelectedHistoryTerminalVerifier
): boolean {
  try {
    const verification = terminalVerifier.verify({
      claim: canonicalClone({
        contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
        observations: artifact.observations,
      }),
      pages: Object.freeze(
        artifact.artifact.pages.map((page) =>
          Object.freeze({
            pageIndex: page.stored_page_index,
            url: page.url,
            fetchedAt: page.fetched_at,
            payload: page.payload,
          })
        )
      ),
      cursor: artifact.artifact.starting_cursor,
      source: Object.freeze({
        id: artifact.artifact.source.id,
        slug: artifact.artifact.source.slug,
      }),
      traderId: artifact.artifact.trader.id,
      exchangeTraderId: artifact.artifact.trader.exchange_trader_id,
      kind: 'position_history',
    })
    return terminalVerificationMatchesArtifact(artifact, verification)
  } catch {
    return false
  }
}

function buildPositionHistorySourceFactEvidenceWithRegistryEntry(
  artifact: ArtifactView,
  registryEntry: ReviewedSourceFactRegistryEntry
): PositionHistorySourceFactEvidence {
  const selected = normalizedContract(registryEntry.sourceFactContract)
  if (!selected) return unavailable('registered_source_fact_contract_invalid')
  if (!revalidateTerminalEvidence(artifact, registryEntry.terminalVerifier)) {
    return unavailable('terminal_evidence_revalidation_failed')
  }

  const observationSegmentIds = artifact.observations.map((item) => item.segment_id)
  if (observationSegmentIds.some((segmentId) => !selected.candidatePathBySegment[segmentId])) {
    return unavailable('candidate_segment_path_mismatch')
  }

  const sourceFactsById = new Map<
    string,
    { canonicalFactSha256: string; fact: CanonicalPositionHistorySourceFact }
  >()
  const segments: Array<z.infer<typeof ledgerSegmentSchema>> = []
  let previousEndOrdinal = 0
  let observedCandidateCount = 0

  for (const observation of artifact.observations) {
    const candidatePath = selected.candidatePathBySegment[observation.segment_id]
    if (!candidatePath) return unavailable('candidate_segment_path_mismatch')
    const pages: Array<z.infer<typeof ledgerPageSchema>> = []
    const localFactIds = new Set<string>()

    for (
      let pageOrdinal = previousEndOrdinal + 1;
      pageOrdinal <= observation.page_ordinal;
      pageOrdinal += 1
    ) {
      const artifactPage = artifact.pages[pageOrdinal - 1]
      if (!artifactPage) return unavailable('candidate_page_missing')
      const rawCandidates = resolveOwnPath(artifactPage.payload, candidatePath)
      if (!Array.isArray(rawCandidates)) return unavailable('candidate_path_not_array')

      const occurrences: Array<z.infer<typeof occurrenceSchema>> = []
      for (const [candidateIndex, rawCandidate] of rawCandidates.entries()) {
        let rawCandidateSha256: string
        try {
          rawCandidateSha256 = strictCanonicalSha256(rawCandidate)
        } catch {
          return unavailable('raw_candidate_not_canonical_json')
        }
        if (!isRecord(rawCandidate)) return unavailable('raw_candidate_not_object')

        let inspectionRaw: unknown
        try {
          const frozenCandidate = canonicalClone(rawCandidate) as Readonly<Dict>
          inspectionRaw = selected.inspectCandidate(
            Object.freeze({
              rawCandidate: frozenCandidate,
              sourceId: artifact.sourceId,
              sourceSlug: artifact.sourceSlug,
              exchangeTraderId: artifact.exchangeTraderId,
            })
          )
          inspectionRaw = canonicalClone(inspectionRaw)
        } catch {
          return unavailable('candidate_inspector_failed')
        }
        const inspection = candidateInspectionSchema.safeParse(inspectionRaw)
        if (!inspection.success) return unavailable('candidate_inspection_invalid')
        if (inspection.data.state === 'unavailable') {
          return unavailable(`candidate_unavailable:${inspection.data.reason}`)
        }

        const fact = canonicalClone(inspection.data.sourceFact)
        const sourceFactId = fact.sourceFactId
        const canonicalFactSha256 = strictCanonicalSha256(fact)
        if (localFactIds.has(sourceFactId)) {
          return unavailable('source_fact_duplicated_within_segment')
        }
        localFactIds.add(sourceFactId)

        const existing = sourceFactsById.get(sourceFactId)
        if (existing) {
          if (selected.duplicatePolicy === 'forbid') {
            return unavailable('source_fact_duplicate_forbidden')
          }
          if (existing.canonicalFactSha256 !== canonicalFactSha256) {
            return unavailable('source_fact_cross_segment_conflict')
          }
        } else {
          sourceFactsById.set(sourceFactId, { canonicalFactSha256, fact })
        }

        occurrences.push({
          row_ordinal: candidateIndex + 1,
          raw_candidate_sha256: rawCandidateSha256,
          source_fact_id: sourceFactId,
          canonical_fact_sha256: canonicalFactSha256,
        })
      }
      observedCandidateCount += rawCandidates.length
      pages.push({
        page_ordinal: pageOrdinal,
        candidate_count: rawCandidates.length,
        occurrences,
      })
    }
    segments.push({
      segment_id: observation.segment_id,
      candidate_path: [...candidatePath],
      pages,
    })
    previousEndOrdinal = observation.page_ordinal
  }

  if (selected.requireIdenticalSegmentFactSets && segments.length > 1) {
    const factSet = (segment: (typeof segments)[number]): Set<string> =>
      new Set(segment.pages.flatMap((page) => page.occurrences.map((item) => item.source_fact_id)))
    const first = factSet(segments[0])
    if (
      segments
        .slice(1)
        .map(factSet)
        .some(
          (current) =>
            current.size !== first.size ||
            [...first].some((sourceFactId) => !current.has(sourceFactId))
        )
    ) {
      return unavailable('segment_source_fact_set_mismatch')
    }
  }

  const sourceFacts = [...sourceFactsById.entries()]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([sourceFactId, entry]) => ({
      source_fact_id: sourceFactId,
      canonical_fact_sha256: entry.canonicalFactSha256,
      fact: entry.fact,
    }))
  const factSet = sourceFacts.map((entry) => ({
    source_fact_id: entry.source_fact_id,
    canonical_fact_sha256: entry.canonical_fact_sha256,
  }))
  const candidate = {
    contract: POSITION_HISTORY_SOURCE_FACT_LEDGER_CONTRACT,
    acquisition_contract: artifact.artifact.contract,
    acquisition_source_run_id: artifact.acquisitionSourceRunId,
    source_id: artifact.sourceId,
    source_slug: selected.sourceSlug,
    trader_id: artifact.traderId,
    exchange_trader_id: artifact.exchangeTraderId,
    terminal_verifier_contract: selected.terminalVerifierContract,
    source_fact_contract: selected.contract,
    duplicate_policy: selected.duplicatePolicy,
    require_identical_segment_fact_sets: selected.requireIdenticalSegmentFactSets,
    observed_candidate_count: observedCandidateCount,
    unique_source_fact_count: sourceFacts.length,
    fact_set_sha256: strictCanonicalSha256(factSet),
    segments,
    source_facts: sourceFacts,
  }

  const parsed = positionHistorySourceFactLedgerSchema.safeParse(candidate)
  if (!parsed.success) return unavailable('source_fact_ledger_invalid')
  const ledger = canonicalClone(parsed.data)
  return Object.freeze({
    state: 'verified',
    ledger,
    ledgerSha256: strictCanonicalSha256(ledger),
  })
}

/**
 * Enumerate the complete candidate denominator before any parser runs.
 * New evidence always uses the single active contract selected from the
 * closed registry; runtime input can provide neither contract nor verifier.
 */
export function buildPositionHistorySourceFactEvidence(input: {
  artifact: unknown
}): PositionHistorySourceFactEvidence {
  const artifact = verifiedArtifactView(input.artifact)
  if (!artifact) return unavailable('verified_position_history_artifact_required')
  const registryEntry = selectRegistryEntry(artifact, null)
  if (!registryEntry) return unavailable('source_fact_contract_unavailable')
  return buildPositionHistorySourceFactEvidenceWithRegistryEntry(artifact, registryEntry)
}

export function parsePositionHistorySourceFactLedger(
  raw: unknown
): PositionHistorySourceFactLedger {
  return canonicalClone(positionHistorySourceFactLedgerSchema.parse(raw))
}

/**
 * Rebuild from immutable RAW and compare canonical bytes; never trust ledger
 * counts alone. `expectedAcquisition` must come from the immutable RAW receipt,
 * not from the artifact/ledger pair being checked.
 */
export function revalidatePositionHistorySourceFactLedger(input: {
  artifact: unknown
  ledger: unknown
  expectedAcquisition: PositionHistoryAcquisitionAnchor
}): PositionHistorySourceFactLedgerVerification {
  const expectedAcquisition = acquisitionAnchorSchema.safeParse(input.expectedAcquisition)
  if (!expectedAcquisition.success) {
    return Object.freeze({ verified: false, reason: 'acquisition_anchor_invalid' })
  }
  let supplied: PositionHistorySourceFactLedger
  try {
    supplied = parsePositionHistorySourceFactLedger(input.ledger)
  } catch {
    return Object.freeze({ verified: false, reason: 'source_fact_ledger_invalid' })
  }
  if (
    supplied.acquisition_source_run_id !== expectedAcquisition.data.sourceRunId ||
    supplied.source_id !== expectedAcquisition.data.sourceId ||
    supplied.source_slug !== expectedAcquisition.data.sourceSlug ||
    supplied.trader_id !== expectedAcquisition.data.traderId ||
    supplied.exchange_trader_id !== expectedAcquisition.data.exchangeTraderId
  ) {
    return Object.freeze({ verified: false, reason: 'acquisition_anchor_mismatch' })
  }
  const artifact = verifiedArtifactView(input.artifact)
  if (!artifact) {
    return Object.freeze({
      verified: false,
      reason: 'verified_position_history_artifact_required',
    })
  }
  const registryEntry = selectRegistryEntry(artifact, supplied.source_fact_contract)
  if (!registryEntry) {
    return Object.freeze({ verified: false, reason: 'source_fact_contract_unavailable' })
  }
  const rebuilt = buildPositionHistorySourceFactEvidenceWithRegistryEntry(artifact, registryEntry)
  if (rebuilt.state !== 'verified') {
    return Object.freeze({ verified: false, reason: rebuilt.reason })
  }
  if (strictCanonicalJson(supplied) !== strictCanonicalJson(rebuilt.ledger)) {
    return Object.freeze({ verified: false, reason: 'source_fact_ledger_mismatch' })
  }
  return Object.freeze({ verified: true, ledgerSha256: rebuilt.ledgerSha256 })
}
