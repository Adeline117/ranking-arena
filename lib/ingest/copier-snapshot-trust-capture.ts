import { isProxy } from 'node:util/types'

import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  type BuildCopierSnapshotArtifactInput,
  type CopierSnapshotArtifact,
} from './copier-snapshot-artifact'
import {
  buildCopierSnapshotArtifactV2,
  type CopierSnapshotArtifactAnchor,
  type CopierSnapshotArtifactV2Result,
} from './copier-snapshot-artifact-v2'
import {
  buildCopierCandidateLedger,
  deriveCopierCandidateReplayBinding,
  verifyCopierParserConservation,
} from './copier-candidate-conservation'
import {
  buildCopierSnapshotParserContext,
  replayCopierSnapshotParser,
  selectCopierSnapshotParserContract,
} from './copier-parser-replay'
import type { ParsedHistoryRow } from './core/types'
import { strictCanonicalJson } from './strict-canonical-json'

const CAPTURE_INPUT_FIELDS = Object.freeze([
  'src',
  'traderId',
  'exchangeTraderId',
  'lane',
  'requestTimeframe',
  'pages',
  'callerLimited',
] as const)

function captureError(detail: string): Error {
  return new Error(`[ingest] copier snapshot trust capture failed: ${detail}`)
}

/**
 * Detach the complete call before inspecting any capture coordinate. Besides
 * rejecting accessors and proxies, this prevents a caller from changing the
 * source variant or page payload between the @1 and @2 replay passes.
 */
function captureInput(value: unknown): BuildCopierSnapshotArtifactInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw captureError('input must be a non-proxy plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw captureError('input must be a non-proxy plain object')
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== CAPTURE_INPUT_FIELDS.length ||
    ownKeys.some(
      (key) => typeof key !== 'string' || !CAPTURE_INPUT_FIELDS.some((field) => field === key)
    )
  ) {
    throw captureError('input must have the exact capture fields')
  }

  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const field of CAPTURE_INPUT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw captureError('input must contain enumerable data properties')
    }
    captured[field] = descriptor.value
  }

  try {
    return JSON.parse(strictCanonicalJson(captured)) as BuildCopierSnapshotArtifactInput
  } catch (cause) {
    throw captureError(
      `input is not strict canonical JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

function snapshotAnchor(snapshot: CopierSnapshotArtifact): CopierSnapshotArtifactAnchor {
  return Object.freeze({
    sourceRunId: copierSnapshotSourceRunId(snapshot),
    sourceId: snapshot.source.id,
    sourceSlug: snapshot.source.slug,
    traderId: snapshot.trader.id,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
  })
}

/**
 * Convert one just-captured copier page set into neutral, self-contained @2
 * evidence. The caller supplies capture coordinates and RAW pages only: every
 * ledger, parser row, proof, and digest is derived here through the retained
 * replay catalogs. The result grants neither completeness nor publication or
 * rank eligibility.
 */
export function captureCopierSnapshotTrustArtifactV2(
  input: BuildCopierSnapshotArtifactInput
): CopierSnapshotArtifactV2Result {
  const captured = captureInput(input)
  const snapshot = buildCopierSnapshotArtifact(captured)
  const expectedSnapshot = snapshotAnchor(snapshot)
  const candidateLedger = buildCopierCandidateLedger({
    src: captured.src,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
    pages: snapshot.pages,
  })
  const candidateBinding = deriveCopierCandidateReplayBinding(captured.src)
  const parserContract = selectCopierSnapshotParserContract(candidateBinding.adapter_slug)
  const parserContext = buildCopierSnapshotParserContext({
    adapterSlug: candidateBinding.adapter_slug,
    parserContract,
    productType: candidateBinding.product_type,
    sourceSlug: snapshot.source.slug,
    currency: snapshot.source.currency,
    scrapedAt: snapshot.observed_at,
  })

  const rows: ParsedHistoryRow[] = []
  for (const page of snapshot.pages) {
    rows.push(
      ...replayCopierSnapshotParser({
        adapterSlug: candidateBinding.adapter_slug,
        parserContract,
        raw: page.payload,
        ctx: parserContext,
      })
    )
  }
  const parserProof = verifyCopierParserConservation({ ledger: candidateLedger, rows })

  return buildCopierSnapshotArtifactV2({
    src: captured.src,
    snapshot,
    expectedSnapshot,
    candidateLedger,
    parserProof,
    rows,
  })
}
