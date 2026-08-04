import { z } from 'zod'

import {
  historyAcquisitionArtifactSchema,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
} from './history-acquisition'
import {
  buildPositionHistorySourceFactEvidence,
  positionHistorySourceFactLedgerSchema,
  revalidatePositionHistorySourceFactLedger,
  type PositionHistoryAcquisitionAnchor,
} from './position-history-source-facts'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT =
  'arena.ingest.history-acquisition-artifact@2' as const

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

export const positionHistoryAcquisitionArtifactV2Schema = z
  .object({
    contract: z.literal(POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT),
    serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
    acquisition: historyAcquisitionArtifactSchema,
    acquisition_source_run_id: sha256Schema,
    candidate_ledger: positionHistorySourceFactLedgerSchema,
    candidate_ledger_sha256: sha256Schema,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (
      artifact.acquisition.history_kind !== 'position_history' ||
      artifact.acquisition.termination.evidence_state !== 'verified'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition'],
        message: 'v2 requires a terminal-verified position-history acquisition',
      })
    }

    try {
      if (strictCanonicalSha256(artifact.acquisition) !== artifact.acquisition_source_run_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['acquisition_source_run_id'],
          message: 'acquisition source-run digest does not match the nested @1 artifact',
        })
      }
      if (strictCanonicalSha256(artifact.candidate_ledger) !== artifact.candidate_ledger_sha256) {
        ctx.addIssue({
          code: 'custom',
          path: ['candidate_ledger_sha256'],
          message: 'candidate-ledger digest does not match the embedded ledger',
        })
      }
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: error instanceof Error ? error.message : 'v2 artifact is not canonical JSON',
      })
    }

    const acquisition = artifact.acquisition
    const ledger = artifact.candidate_ledger
    if (
      ledger.acquisition_source_run_id !== artifact.acquisition_source_run_id ||
      ledger.source_id !== acquisition.source.id ||
      ledger.source_slug !== acquisition.source.slug ||
      ledger.trader_id !== acquisition.trader.id ||
      ledger.exchange_trader_id !== acquisition.trader.exchange_trader_id ||
      ledger.terminal_verifier_contract !== acquisition.termination.verifier_contract
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidate_ledger'],
        message: 'candidate ledger is not bound to the exact nested acquisition coordinates',
      })
    }
  })

export type PositionHistoryAcquisitionArtifactV2 = z.infer<
  typeof positionHistoryAcquisitionArtifactV2Schema
>

export type BuiltPositionHistoryAcquisitionArtifactV2 =
  | Readonly<{
      state: 'verified'
      artifact: PositionHistoryAcquisitionArtifactV2
      sourceRunId: string
    }>
  | Readonly<{ state: 'unavailable'; reason: string }>

export type PositionHistoryAcquisitionArtifactV2Verification =
  | Readonly<{
      verified: true
      artifact: PositionHistoryAcquisitionArtifactV2
      sourceRunId: string
      candidateLedgerSha256: string
    }>
  | Readonly<{ verified: false; reason: string }>

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

function unavailable(reason: string): BuiltPositionHistoryAcquisitionArtifactV2 {
  return Object.freeze({ state: 'unavailable', reason })
}

function acquisitionAnchor(
  acquisition: HistoryAcquisitionArtifact
): PositionHistoryAcquisitionAnchor {
  return Object.freeze({
    sourceRunId: strictCanonicalSha256(acquisition),
    sourceId: acquisition.source.id,
    sourceSlug: acquisition.source.slug,
    traderId: acquisition.trader.id,
    exchangeTraderId: acquisition.trader.exchange_trader_id,
  })
}

/**
 * Upgrade an immutable @1 capture into a self-contained @2 acquisition proof.
 * The expected @1 coordinates come from the capture result or an existing @1
 * RAW receipt. They prevent accidental cross-run/account mixing; the persisted
 * outer @2 RAW pointer is the long-lived authenticity anchor.
 */
export function buildPositionHistoryAcquisitionArtifactV2(input: {
  acquisition: unknown
  expectedAcquisition: PositionHistoryAcquisitionAnchor
}): BuiltPositionHistoryAcquisitionArtifactV2 {
  let acquisition: HistoryAcquisitionArtifact
  try {
    acquisition = parseHistoryAcquisitionArtifact(input.acquisition)
  } catch {
    return unavailable('position_history_acquisition_invalid')
  }

  try {
    if (
      strictCanonicalJson(acquisitionAnchor(acquisition)) !==
      strictCanonicalJson(input.expectedAcquisition)
    ) {
      return unavailable('acquisition_anchor_mismatch')
    }
  } catch {
    return unavailable('acquisition_anchor_invalid')
  }

  const sourceFacts = buildPositionHistorySourceFactEvidence({ artifact: acquisition })
  if (sourceFacts.state !== 'verified') return unavailable(sourceFacts.reason)
  const anchoredLedger = revalidatePositionHistorySourceFactLedger({
    artifact: acquisition,
    ledger: sourceFacts.ledger,
    expectedAcquisition: input.expectedAcquisition,
  })
  if (!anchoredLedger.verified) return unavailable(anchoredLedger.reason)

  const candidate = {
    contract: POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    acquisition,
    acquisition_source_run_id: strictCanonicalSha256(acquisition),
    candidate_ledger: sourceFacts.ledger,
    candidate_ledger_sha256: sourceFacts.ledgerSha256,
  }
  const parsed = positionHistoryAcquisitionArtifactV2Schema.safeParse(candidate)
  if (!parsed.success) return unavailable('position_history_acquisition_v2_invalid')
  const artifact = canonicalClone(parsed.data)
  return Object.freeze({
    state: 'verified',
    artifact,
    sourceRunId: strictCanonicalSha256(artifact),
  })
}

/** Structural parsing only; trust requires revalidation against an immutable outer source run. */
export function parsePositionHistoryAcquisitionArtifactV2(
  raw: unknown
): PositionHistoryAcquisitionArtifactV2 {
  return canonicalClone(positionHistoryAcquisitionArtifactV2Schema.parse(raw))
}

export function positionHistoryAcquisitionArtifactV2SourceRunId(raw: unknown): string {
  return strictCanonicalSha256(parsePositionHistoryAcquisitionArtifactV2(raw))
}

/**
 * Verify the complete wrapper against the immutable @2 RAW/source-run identity,
 * then replay terminal and source-fact evidence from the nested RAW pages. The
 * caller must first bind this expected hash to the pointer bytes, source/trader
 * coordinates, role, and exact metadata; a bare hash from the wrapper is not a
 * storage receipt.
 */
export function revalidatePositionHistoryAcquisitionArtifactV2(input: {
  artifact: unknown
  expectedSourceRunId: string
}): PositionHistoryAcquisitionArtifactV2Verification {
  const expectedSourceRunId = sha256Schema.safeParse(input.expectedSourceRunId)
  if (!expectedSourceRunId.success) {
    return Object.freeze({ verified: false, reason: 'position_history_v2_source_run_invalid' })
  }

  let artifact: PositionHistoryAcquisitionArtifactV2
  try {
    artifact = parsePositionHistoryAcquisitionArtifactV2(input.artifact)
  } catch {
    return Object.freeze({ verified: false, reason: 'position_history_acquisition_v2_invalid' })
  }
  const sourceRunId = strictCanonicalSha256(artifact)
  if (sourceRunId !== expectedSourceRunId.data) {
    return Object.freeze({ verified: false, reason: 'position_history_v2_source_run_mismatch' })
  }

  const ledgerVerification = revalidatePositionHistorySourceFactLedger({
    artifact: artifact.acquisition,
    ledger: artifact.candidate_ledger,
    expectedAcquisition: acquisitionAnchor(artifact.acquisition),
  })
  if (!ledgerVerification.verified) {
    return Object.freeze({
      verified: false,
      reason: `candidate_ledger_revalidation_failed:${ledgerVerification.reason}`,
    })
  }
  if (ledgerVerification.ledgerSha256 !== artifact.candidate_ledger_sha256) {
    return Object.freeze({ verified: false, reason: 'candidate_ledger_digest_mismatch' })
  }
  return Object.freeze({
    verified: true,
    artifact,
    sourceRunId,
    candidateLedgerSha256: ledgerVerification.ledgerSha256,
  })
}
