import { z } from 'zod'

import type { HistoryKind, RawPage, SourceRow } from './core/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const HISTORY_TERMINAL_CLAIM_CONTRACT = 'arena.ingest.history-terminal-claim@1' as const
export const HISTORY_ACQUISITION_ARTIFACT_CONTRACT =
  'arena.ingest.history-acquisition-artifact@1' as const

const terminalClaimReasons = [
  'empty_page',
  'short_page',
  'reported_end',
  'cursor_overlap',
  'snapshot_complete',
] as const
const terminalEvidenceStates = [
  'verified',
  'missing',
  'invalid',
  'verifier_missing',
  'rejected',
  'caller_limited',
  'upstream_error',
] as const
const scanTerminalStates = ['exhausted', 'cursor_overlap', 'partial', 'unknown'] as const
const blockerReasons = [
  'terminal_claim_missing',
  'terminal_claim_invalid',
  'terminal_verifier_missing',
  'terminal_claim_rejected',
  'caller_limit',
  'upstream_error',
] as const

export type HistoryTerminalClaimReason = (typeof terminalClaimReasons)[number]
export type HistoryTerminalEvidenceState = (typeof terminalEvidenceStates)[number]
export type HistoryScanTerminalState = (typeof scanTerminalStates)[number]
export type HistoryAcquisitionBlockerReason = (typeof blockerReasons)[number]

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0)
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
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

const safePositiveIntegerSchema = z
  .number()
  .refine(isSafePositiveInteger, 'must be a positive safe integer and not negative zero')
const canonicalTimestampSchema = z
  .string()
  .refine(isCanonicalTimestamp, 'must be a canonical ISO timestamp')
const canonicalHttpUrlSchema = z
  .string()
  .refine(
    isCanonicalHttpUrl,
    'must be an absolute http(s) URL without whitespace, userinfo, or fragment'
  )
const canonicalIdentitySchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must not have surrounding whitespace')
const sourceSlugSchema = z.string().regex(/^[a-z0-9_]+$/, 'must be lower snake case')
const segmentIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_]{0,63}$/, 'must be a canonical lower-snake-case segment id')
const terminalVerifierContractSchema = z
  .string()
  .regex(
    /^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*@[1-9][0-9]*$/,
    'must be a versioned history terminal verifier contract'
  )
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 digest')

const historyTerminalObservationSchema = z
  .object({
    segment_id: segmentIdSchema,
    reason: z.enum(terminalClaimReasons),
    page_ordinal: safePositiveIntegerSchema,
  })
  .strict()

export const historyTerminalClaimSchema = z
  .object({
    contract: z.literal(HISTORY_TERMINAL_CLAIM_CONTRACT),
    observations: z.array(historyTerminalObservationSchema).min(1).max(8),
  })
  .strict()
  .superRefine((claim, ctx) => {
    const segmentIds = new Set<string>()
    let previousOrdinal = 0
    claim.observations.forEach((observation, index) => {
      if (segmentIds.has(observation.segment_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['observations', index, 'segment_id'],
          message: 'terminal segment ids must be unique',
        })
      }
      segmentIds.add(observation.segment_id)
      if (observation.page_ordinal <= previousOrdinal) {
        ctx.addIssue({
          code: 'custom',
          path: ['observations', index, 'page_ordinal'],
          message: 'terminal observation page ordinals must be strictly increasing',
        })
      }
      previousOrdinal = observation.page_ordinal
    })
  })

export type HistoryTerminalClaim = z.infer<typeof historyTerminalClaimSchema>

const historyArtifactPageSchema = z
  .object({
    ordinal: safePositiveIntegerSchema,
    stored_page_index: safePositiveIntegerSchema,
    url: canonicalHttpUrlSchema,
    fetched_at: canonicalTimestampSchema,
    payload_sha256: sha256Schema,
    payload: z.unknown(),
  })
  .strict()

const historyTerminationSchema = z
  .object({
    evidence_state: z.enum(terminalEvidenceStates),
    claim_observations: z.array(historyTerminalObservationSchema).max(8),
    verifier_contract: terminalVerifierContractSchema.nullable(),
    scan_terminal_state: z.enum(scanTerminalStates),
    terminal_cursor_value: canonicalTimestampSchema.nullable(),
    overlap_event_at: canonicalTimestampSchema.nullable(),
    blocker_reasons: z.array(z.enum(blockerReasons)),
  })
  .strict()

const expectedTerminationShape: Record<
  HistoryTerminalEvidenceState,
  Readonly<{
    scanTerminalState: HistoryScanTerminalState | null
    blockerReasons: readonly HistoryAcquisitionBlockerReason[]
    claimRequired: boolean
    verifierRequired: boolean
  }>
> = {
  verified: {
    scanTerminalState: null,
    blockerReasons: [],
    claimRequired: true,
    verifierRequired: true,
  },
  missing: {
    scanTerminalState: 'unknown',
    blockerReasons: ['terminal_claim_missing'],
    claimRequired: false,
    verifierRequired: false,
  },
  invalid: {
    scanTerminalState: 'unknown',
    blockerReasons: ['terminal_claim_invalid'],
    claimRequired: false,
    verifierRequired: false,
  },
  verifier_missing: {
    scanTerminalState: 'unknown',
    blockerReasons: ['terminal_verifier_missing'],
    claimRequired: true,
    verifierRequired: false,
  },
  rejected: {
    scanTerminalState: 'unknown',
    blockerReasons: ['terminal_claim_rejected'],
    claimRequired: true,
    verifierRequired: true,
  },
  caller_limited: {
    scanTerminalState: 'partial',
    blockerReasons: ['caller_limit'],
    claimRequired: false,
    verifierRequired: false,
  },
  upstream_error: {
    scanTerminalState: 'partial',
    blockerReasons: ['upstream_error'],
    claimRequired: false,
    verifierRequired: false,
  },
}

export const historyAcquisitionArtifactSchema = z
  .object({
    contract: z.literal(HISTORY_ACQUISITION_ARTIFACT_CONTRACT),
    serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
    source: z
      .object({
        id: safePositiveIntegerSchema,
        slug: sourceSlugSchema,
      })
      .strict(),
    trader: z
      .object({
        id: safePositiveIntegerSchema,
        exchange_trader_id: canonicalIdentitySchema,
      })
      .strict(),
    history_kind: z.enum(['position_history', 'orders', 'transfers', 'copiers']),
    attempt_started_at: canonicalTimestampSchema,
    starting_cursor: canonicalTimestampSchema.nullable(),
    capture_config: z
      .object({
        caller_page_cap: safePositiveIntegerSchema.nullable(),
      })
      .strict(),
    pages: z.array(historyArtifactPageSchema),
    termination: historyTerminationSchema,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    let previousFetchedAt = Date.parse(artifact.attempt_started_at)
    artifact.pages.forEach((page, index) => {
      if (page.ordinal !== index + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index, 'ordinal'],
          message: 'capture ordinals must be contiguous and start at one',
        })
      }
      const fetchedAt = Date.parse(page.fetched_at)
      if (fetchedAt < previousFetchedAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index, 'fetched_at'],
          message: 'page fetch times must not precede the attempt or move backward',
        })
      }
      previousFetchedAt = fetchedAt
      try {
        if (strictCanonicalSha256(page.payload) !== page.payload_sha256) {
          ctx.addIssue({
            code: 'custom',
            path: ['pages', index, 'payload_sha256'],
            message: 'payload digest does not match canonical payload',
          })
        }
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index, 'payload'],
          message: error instanceof Error ? error.message : 'payload is not canonical JSON',
        })
      }
    })

    const { termination } = artifact
    const expected = expectedTerminationShape[termination.evidence_state]
    if (
      expected.scanTerminalState !== null &&
      termination.scan_terminal_state !== expected.scanTerminalState
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['termination', 'scan_terminal_state'],
        message: `must be ${expected.scanTerminalState} for ${termination.evidence_state}`,
      })
    }
    if (
      termination.blocker_reasons.length !== expected.blockerReasons.length ||
      termination.blocker_reasons.some((reason, index) => reason !== expected.blockerReasons[index])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['termination', 'blocker_reasons'],
        message: `must exactly match the blockers for ${termination.evidence_state}`,
      })
    }

    const hasClaim = termination.claim_observations.length > 0
    if (hasClaim !== expected.claimRequired) {
      ctx.addIssue({
        code: 'custom',
        path: ['termination', 'claim_observations'],
        message: expected.claimRequired
          ? 'a normalized terminal claim is required'
          : 'a normalized terminal claim is not allowed',
      })
    }
    if ((termination.verifier_contract !== null) !== expected.verifierRequired) {
      ctx.addIssue({
        code: 'custom',
        path: ['termination', 'verifier_contract'],
        message: expected.verifierRequired
          ? 'the selected verifier contract is required'
          : 'a verifier contract is not allowed',
      })
    }
    const terminalSegmentIds = new Set<string>()
    let previousTerminalOrdinal = 0
    termination.claim_observations.forEach((observation, index) => {
      if (terminalSegmentIds.has(observation.segment_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['termination', 'claim_observations', index, 'segment_id'],
          message: 'terminal segment ids must be unique',
        })
      }
      terminalSegmentIds.add(observation.segment_id)
      if (observation.page_ordinal <= previousTerminalOrdinal) {
        ctx.addIssue({
          code: 'custom',
          path: ['termination', 'claim_observations', index, 'page_ordinal'],
          message: 'terminal observation page ordinals must be strictly increasing',
        })
      }
      previousTerminalOrdinal = observation.page_ordinal
      if (observation.page_ordinal > artifact.pages.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['termination', 'claim_observations', index, 'page_ordinal'],
          message: 'terminal claim must reference a captured page',
        })
      }
    })

    if (
      termination.evidence_state === 'verified' &&
      termination.scan_terminal_state !== 'exhausted' &&
      termination.scan_terminal_state !== 'cursor_overlap'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['termination', 'scan_terminal_state'],
        message: 'verified terminal evidence must prove exhaustion or cursor overlap',
      })
    }

    const isCursorOverlap =
      termination.evidence_state === 'verified' &&
      termination.scan_terminal_state === 'cursor_overlap'
    if (isCursorOverlap) {
      if (
        !termination.claim_observations.some(
          (observation) => observation.reason === 'cursor_overlap'
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['termination', 'claim_observations'],
          message: 'verified cursor overlap requires a cursor-overlap observation',
        })
      }
      if (
        termination.terminal_cursor_value === null ||
        termination.overlap_event_at === null ||
        termination.terminal_cursor_value !== artifact.starting_cursor
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['termination', 'overlap_event_at'],
          message:
            'verified cursor overlap requires the exact starting cursor and overlap event time',
        })
      } else if (
        Date.parse(termination.overlap_event_at) > Date.parse(termination.terminal_cursor_value)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['termination', 'overlap_event_at'],
          message: 'overlap event must be at or before the stored cursor',
        })
      }
    } else if (
      termination.evidence_state === 'verified' &&
      termination.claim_observations.some((observation) => observation.reason === 'cursor_overlap')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['termination', 'scan_terminal_state'],
        message: 'a cursor-overlap observation cannot prove exhaustion',
      })
    } else if (
      termination.terminal_cursor_value !== null ||
      termination.overlap_event_at !== null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['termination', 'terminal_cursor_value'],
        message: 'cursor evidence is allowed only for a verified cursor overlap',
      })
    }

    if (
      termination.evidence_state === 'caller_limited' &&
      artifact.capture_config.caller_page_cap !== artifact.pages.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['capture_config', 'caller_page_cap'],
        message: 'caller-limited captures must stop exactly at their configured page cap',
      })
    }
  })

export type HistoryAcquisitionArtifact = z.infer<typeof historyAcquisitionArtifactSchema>

export interface HistoryTerminalVerificationInput {
  claim: HistoryTerminalClaim
  pages: readonly Readonly<RawPage>[]
  cursor: string | null
  source: Pick<SourceRow, 'id' | 'slug'>
  traderId: number
  exchangeTraderId: string
  kind: HistoryKind
}

export type HistoryTerminalVerification =
  | Readonly<{ verified: false }>
  | Readonly<{ verified: true; scanTerminalState: 'exhausted' }>
  | Readonly<{
      verified: true
      scanTerminalState: 'cursor_overlap'
      overlapEventAt: string
    }>

const historyTerminalVerificationSchema = z.union([
  z.object({ verified: z.literal(false) }).strict(),
  z
    .object({
      verified: z.literal(true),
      scanTerminalState: z.literal('exhausted'),
    })
    .strict(),
  z
    .object({
      verified: z.literal(true),
      scanTerminalState: z.literal('cursor_overlap'),
      overlapEventAt: canonicalTimestampSchema,
    })
    .strict(),
])

export type HistoryTerminalVerifier = (
  input: HistoryTerminalVerificationInput
) => HistoryTerminalVerification

export interface SelectedHistoryTerminalVerifier {
  contract: string
  verify: HistoryTerminalVerifier
}

export interface CaptureHistoryAcquisitionInput {
  source: Pick<SourceRow, 'id' | 'slug'>
  traderId: number
  exchangeTraderId: string
  kind: HistoryKind
  cursor: string | null
  attemptStartedAt: string
  callerPageCap?: number | null
  stream: AsyncIterable<RawPage>
  terminalVerifier?: SelectedHistoryTerminalVerifier
}

export interface CapturedHistoryAcquisition {
  artifact: HistoryAcquisitionArtifact
  sourceRunId: string
  pages: readonly Readonly<RawPage>[]
  error: unknown | null
}

interface NormalizedTerminal {
  evidence_state: HistoryTerminalEvidenceState
  claim_observations: HistoryTerminalClaim['observations']
  verifier_contract: string | null
  scan_terminal_state: HistoryScanTerminalState
  terminal_cursor_value: string | null
  overlap_event_at: string | null
  blocker_reasons: HistoryAcquisitionBlockerReason[]
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

function cloneCanonicalPayload(payload: unknown): unknown {
  return deepFreezeJson(JSON.parse(strictCanonicalJson(payload)))
}

function normalizePage(raw: RawPage): Readonly<RawPage> {
  const coordinates = z
    .object({
      pageIndex: safePositiveIntegerSchema,
      url: canonicalHttpUrlSchema,
      fetchedAt: canonicalTimestampSchema,
    })
    .strict()
    .parse({ pageIndex: raw.pageIndex, url: raw.url, fetchedAt: raw.fetchedAt })
  return Object.freeze({ ...coordinates, payload: cloneCanonicalPayload(raw.payload) })
}

function terminalWithoutClaim(
  evidenceState: 'missing' | 'invalid' | 'caller_limited' | 'upstream_error'
): NormalizedTerminal {
  const expected = expectedTerminationShape[evidenceState]
  return {
    evidence_state: evidenceState,
    claim_observations: [],
    verifier_contract: null,
    scan_terminal_state: expected.scanTerminalState ?? 'unknown',
    terminal_cursor_value: null,
    overlap_event_at: null,
    blocker_reasons: [...expected.blockerReasons],
  }
}

function terminalWithUntrustedClaim(
  evidenceState: 'verifier_missing' | 'rejected',
  claim: HistoryTerminalClaim,
  verifierContract: string | null
): NormalizedTerminal {
  return {
    evidence_state: evidenceState,
    claim_observations: claim.observations,
    verifier_contract: verifierContract,
    scan_terminal_state: 'unknown',
    terminal_cursor_value: null,
    overlap_event_at: null,
    blocker_reasons: [...expectedTerminationShape[evidenceState].blockerReasons],
  }
}

function verifiedTerminal(
  claim: HistoryTerminalClaim,
  verification: Extract<HistoryTerminalVerification, { verified: true }>,
  cursor: string | null,
  verifierContract: string
): NormalizedTerminal | null {
  if (verification.scanTerminalState === 'cursor_overlap') {
    if (!claim.observations.some((observation) => observation.reason === 'cursor_overlap')) {
      return null
    }
    if (!cursor) return null
    if (!isCanonicalTimestamp(verification.overlapEventAt)) return null
    if (Date.parse(verification.overlapEventAt) > Date.parse(cursor)) return null
    return {
      evidence_state: 'verified',
      claim_observations: claim.observations,
      verifier_contract: verifierContract,
      scan_terminal_state: 'cursor_overlap',
      terminal_cursor_value: cursor,
      overlap_event_at: verification.overlapEventAt,
      blocker_reasons: [],
    }
  }
  if (claim.observations.some((observation) => observation.reason === 'cursor_overlap')) {
    return null
  }
  return {
    evidence_state: 'verified',
    claim_observations: claim.observations,
    verifier_contract: verifierContract,
    scan_terminal_state: 'exhausted',
    terminal_cursor_value: null,
    overlap_event_at: null,
    blocker_reasons: [],
  }
}

function buildArtifact(
  input: Omit<CaptureHistoryAcquisitionInput, 'stream' | 'terminalVerifier'>,
  pages: readonly Readonly<RawPage>[],
  termination: NormalizedTerminal
): HistoryAcquisitionArtifact {
  const candidate = {
    contract: HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    source: input.source,
    trader: { id: input.traderId, exchange_trader_id: input.exchangeTraderId },
    history_kind: input.kind,
    attempt_started_at: input.attemptStartedAt,
    starting_cursor: input.cursor,
    capture_config: { caller_page_cap: input.callerPageCap ?? null },
    pages: pages.map((page, index) => ({
      ordinal: index + 1,
      stored_page_index: page.pageIndex,
      url: page.url,
      fetched_at: page.fetchedAt,
      payload_sha256: strictCanonicalSha256(page.payload),
      payload: page.payload,
    })),
    termination,
  }
  return deepFreezeJson(historyAcquisitionArtifactSchema.parse(candidate))
}

/**
 * Consume a one-shot history stream manually so its generator return value is
 * preserved. A normal return, an adapter-authored claim, or a caller page cap
 * can never imply completeness by itself: only a framework-selected verifier
 * may turn a strict claim that references captured RAW into terminal proof.
 */
export async function captureHistoryAcquisition(
  input: CaptureHistoryAcquisitionInput
): Promise<CapturedHistoryAcquisition> {
  const coordinates = deepFreezeJson(
    z
      .object({
        source: z.object({ id: safePositiveIntegerSchema, slug: sourceSlugSchema }).strict(),
        traderId: safePositiveIntegerSchema,
        exchangeTraderId: canonicalIdentitySchema,
        kind: z.enum(['position_history', 'orders', 'transfers', 'copiers']),
        cursor: canonicalTimestampSchema.nullable(),
        attemptStartedAt: canonicalTimestampSchema,
        callerPageCap: safePositiveIntegerSchema.nullable().optional(),
      })
      .strict()
      .parse({
        source: input.source,
        traderId: input.traderId,
        exchangeTraderId: input.exchangeTraderId,
        kind: input.kind,
        cursor: input.cursor,
        attemptStartedAt: input.attemptStartedAt,
        callerPageCap: input.callerPageCap,
      })
  )
  const terminalVerifier = input.terminalVerifier
    ? Object.freeze({
        contract: terminalVerifierContractSchema.parse(input.terminalVerifier.contract),
        verify: input.terminalVerifier.verify,
      })
    : null
  if (terminalVerifier !== null && typeof terminalVerifier.verify !== 'function') {
    throw new TypeError('[ingest] history terminal verifier must be a function')
  }

  const iterator = input.stream[Symbol.asyncIterator]() as AsyncIterator<RawPage, unknown, void>
  const pages: Readonly<RawPage>[] = []
  let terminalValue: unknown
  let evidenceState: 'returned' | 'caller_limited' | 'upstream_error' = 'returned'
  let error: unknown | null = null

  while (true) {
    if (
      coordinates.callerPageCap !== null &&
      coordinates.callerPageCap !== undefined &&
      pages.length >= coordinates.callerPageCap
    ) {
      evidenceState = 'caller_limited'
      try {
        await iterator.return?.()
      } catch (closeError) {
        error = closeError
      }
      break
    }

    let next: IteratorResult<RawPage, unknown>
    try {
      next = await iterator.next()
    } catch (fetchError) {
      evidenceState = 'upstream_error'
      error = fetchError
      break
    }
    if (next.done) {
      terminalValue = next.value
      break
    }
    try {
      const normalizedPage = normalizePage(next.value)
      const previousFetchedAt = pages.at(-1)?.fetchedAt ?? coordinates.attemptStartedAt
      if (Date.parse(normalizedPage.fetchedAt) < Date.parse(previousFetchedAt)) {
        throw new TypeError(
          '[ingest] history page fetch times must not precede the attempt or move backward'
        )
      }
      pages.push(normalizedPage)
    } catch (normalizationError) {
      evidenceState = 'upstream_error'
      error = normalizationError
      try {
        await iterator.return?.()
      } catch {
        // Preserve the first evidence-normalization failure for the caller.
      }
      break
    }
  }

  const capturedPages = Object.freeze([...pages])

  let termination: NormalizedTerminal
  if (evidenceState === 'caller_limited') {
    termination = terminalWithoutClaim('caller_limited')
  } else if (evidenceState === 'upstream_error') {
    termination = terminalWithoutClaim('upstream_error')
  } else {
    const parsedClaim = historyTerminalClaimSchema.safeParse(terminalValue)
    if (!parsedClaim.success) {
      termination = terminalWithoutClaim(terminalValue === undefined ? 'missing' : 'invalid')
    } else if (
      parsedClaim.data.observations.some(
        (observation) => observation.page_ordinal > capturedPages.length
      )
    ) {
      termination = terminalWithoutClaim('invalid')
    } else if (!terminalVerifier) {
      termination = terminalWithUntrustedClaim('verifier_missing', parsedClaim.data, null)
    } else {
      let verification: HistoryTerminalVerification
      const normalizedClaim = deepFreezeJson(parsedClaim.data)
      try {
        const verificationResult = terminalVerifier.verify({
          claim: normalizedClaim,
          pages: capturedPages,
          cursor: coordinates.cursor,
          source: coordinates.source,
          traderId: coordinates.traderId,
          exchangeTraderId: coordinates.exchangeTraderId,
          kind: coordinates.kind,
        })
        const parsedVerification = historyTerminalVerificationSchema.safeParse(verificationResult)
        if (!parsedVerification.success) {
          termination = terminalWithUntrustedClaim(
            'rejected',
            normalizedClaim,
            terminalVerifier.contract
          )
          const artifact = buildArtifact(coordinates, capturedPages, termination)
          return {
            artifact,
            sourceRunId: strictCanonicalSha256(artifact),
            pages: capturedPages,
            error,
          }
        }
        verification = parsedVerification.data
      } catch (verificationError) {
        error = verificationError
        termination = terminalWithUntrustedClaim(
          'rejected',
          normalizedClaim,
          terminalVerifier.contract
        )
        const artifact = buildArtifact(coordinates, capturedPages, termination)
        return {
          artifact,
          sourceRunId: strictCanonicalSha256(artifact),
          pages: capturedPages,
          error,
        }
      }
      const verified = verification.verified
        ? verifiedTerminal(
            normalizedClaim,
            verification,
            coordinates.cursor,
            terminalVerifier.contract
          )
        : null
      termination =
        verified ??
        terminalWithUntrustedClaim('rejected', normalizedClaim, terminalVerifier.contract)
    }
  }

  const artifact = buildArtifact(coordinates, capturedPages, termination)
  return {
    artifact,
    sourceRunId: strictCanonicalSha256(artifact),
    pages: capturedPages,
    error,
  }
}

export function parseHistoryAcquisitionArtifact(raw: unknown): HistoryAcquisitionArtifact {
  return deepFreezeJson(historyAcquisitionArtifactSchema.parse(raw))
}

export function historyAcquisitionSourceRunId(raw: unknown): string {
  return strictCanonicalSha256(parseHistoryAcquisitionArtifact(raw))
}
