import { z } from 'zod'

import {
  historyAcquisitionArtifactSchema,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
} from './history-acquisition'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT =
  'arena.ingest.copier-publication-lane-artifact@1' as const
export const COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE = 'copier_snapshot' as const

export type CopierPublicationLane = 'tier_b' | 'tier_c'

const copierPublicationLaneSchema = z.enum(['tier_b', 'tier_c'])
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const selectedCopierVerifierContract =
  /^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$/

function artifactError(detail: string): Error {
  return new Error(`[ingest] copier publication lane artifact failed: ${detail}`)
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

export const copierPublicationLaneArtifactSchema = z
  .object({
    contract: z.literal(COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT),
    serialization_contract: z.literal(STRICT_CANONICAL_JSON_CONTRACT),
    publication_lane: copierPublicationLaneSchema,
    acquisition_source_run_id: sha256Schema,
    acquisition: historyAcquisitionArtifactSchema,
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const acquisition = artifact.acquisition
    if (artifact.acquisition_source_run_id !== strictCanonicalSha256(acquisition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition_source_run_id'],
        message: 'must be the strict canonical digest of the nested acquisition',
      })
    }
    if (acquisition.history_kind !== 'copiers') {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'history_kind'],
        message: 'publication lanes accept only copier acquisitions',
      })
    }
    if (acquisition.starting_cursor !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'starting_cursor'],
        message: 'copier publication requires a full scan from a null cursor',
      })
    }
    if (acquisition.capture_config.caller_page_cap !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'capture_config', 'caller_page_cap'],
        message: 'copier publication cannot be caller limited',
      })
    }
    if (acquisition.pages.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'pages'],
        message: 'copier publication requires at least one captured page',
      })
    }
    if (acquisition.termination.evidence_state !== 'verified') {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'termination', 'evidence_state'],
        message: 'copier publication requires verified terminal evidence',
      })
    }
    if (acquisition.termination.scan_terminal_state !== 'exhausted') {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'termination', 'scan_terminal_state'],
        message: 'copier publication requires a fully exhausted scan',
      })
    }
    if (acquisition.termination.blocker_reasons.length !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'termination', 'blocker_reasons'],
        message: 'copier publication cannot contain acquisition blockers',
      })
    }
    if (
      acquisition.termination.verifier_contract === null ||
      !selectedCopierVerifierContract.test(acquisition.termination.verifier_contract)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'termination', 'verifier_contract'],
        message: 'copier publication requires a selected copier verifier contract',
      })
    }
    if (acquisition.trader.exchange_trader_id.includes('\0')) {
      ctx.addIssue({
        code: 'custom',
        path: ['acquisition', 'trader', 'exchange_trader_id'],
        message: 'publication subject must be representable by PostgreSQL jsonb',
      })
    }
  })

export type CopierPublicationLaneArtifact = z.infer<typeof copierPublicationLaneArtifactSchema>

export interface BuildCopierPublicationLaneArtifactInput {
  lane: CopierPublicationLane
  acquisition: HistoryAcquisitionArtifact
}

function parseCanonicalCandidate(raw: unknown): CopierPublicationLaneArtifact {
  let canonicalClone: unknown
  try {
    canonicalClone = JSON.parse(strictCanonicalJson(raw))
  } catch (cause) {
    throw artifactError(
      `artifact is not strict canonical JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  try {
    return deepFreezeJson(copierPublicationLaneArtifactSchema.parse(canonicalClone))
  } catch (cause) {
    throw artifactError(
      `artifact contract is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

/**
 * Bind the publication authority lane to an already completed acquisition.
 * The nested digest preserves the acquisition identity while the wrapper hash
 * intentionally changes between Tier-B and Tier-C for the same capture.
 */
export function buildCopierPublicationLaneArtifact(
  input: BuildCopierPublicationLaneArtifactInput
): CopierPublicationLaneArtifact {
  let acquisition: HistoryAcquisitionArtifact
  try {
    acquisition = parseHistoryAcquisitionArtifact(input.acquisition)
  } catch (cause) {
    throw artifactError(
      `nested acquisition is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  return parseCanonicalCandidate({
    contract: COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    publication_lane: input.lane,
    acquisition_source_run_id: strictCanonicalSha256(acquisition),
    acquisition,
  })
}

/** Revalidate an untrusted wrapper without accepting omitted or extra fields. */
export function parseCopierPublicationLaneArtifact(raw: unknown): CopierPublicationLaneArtifact {
  return parseCanonicalCandidate(raw)
}

export function copierPublicationLaneSourceRunId(raw: unknown): string {
  return strictCanonicalSha256(parseCopierPublicationLaneArtifact(raw))
}

export function copierPublicationLaneObservedAt(raw: unknown): string {
  const artifact = parseCopierPublicationLaneArtifact(raw)
  return artifact.acquisition.pages.at(-1)!.fetched_at
}

export function copierPublicationLaneStoragePath(raw: unknown): string {
  const artifact = parseCopierPublicationLaneArtifact(raw)
  const sourceRunId = strictCanonicalSha256(artifact)
  return (
    `${artifact.acquisition.source.slug}/copier_publication/${artifact.publication_lane}/` +
    `${sourceRunId}/${COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE}_${sourceRunId}.json.gz`
  )
}
