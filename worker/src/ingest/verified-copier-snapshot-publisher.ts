import type { SelectedCopierSnapshotVerifier, SourceAdapter } from '@/lib/ingest/core/adapter'
import type { ParseCtx, ParsedCopierRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import {
  captureHistoryAcquisition,
  historyAcquisitionSourceRunId,
  type CapturedHistoryAcquisition,
  type HistoryAcquisitionArtifact,
} from '@/lib/ingest/history-acquisition'
import {
  buildCopierPublicationLaneArtifact,
  copierPublicationLaneSourceRunId,
  copierPublicationLaneStoragePath,
  type CopierPublicationLane,
  type CopierPublicationLaneArtifact,
} from '@/lib/ingest/copier-publication-lane-artifact'
import {
  writeCopierPublicationLaneRawArtifact,
  type CopierPublicationLaneRawReceipt,
  type WriteCopierPublicationLaneRawInput,
} from '@/lib/ingest/copier-publication-lane-raw'
import type { RawObjectReceipt, WriteHistoryRawArtifactInput } from '@/lib/ingest/raw'
import {
  preflightCopierSnapshotV2Publication,
  publishCopierSnapshotV2,
  type CopierSnapshotPublicationV2Receipt,
  type PreflightCopierSnapshotV2PublicationInput,
  type PublishCopierSnapshotV2Input,
} from '@/lib/ingest/serving/publish'
import { runHistoryTransaction } from './history-transaction'
import { persistHistoryRawArtifactFirst } from './verified-position-history-publisher'

export interface CaptureAndPublishVerifiedCopierSnapshotInput {
  readonly adapter: SourceAdapter
  /** Fail closed when a record-only scheduled crawl yielded no response page. */
  readonly requireResponsePage?: boolean
  readonly session: FetchSession
  readonly source: SourceRow
  readonly trader: Readonly<{
    id: number
    exchange_trader_id: string
    meta: Record<string, unknown> | null
  }>
}

export interface CaptureAndPublishVerifiedCopierSnapshotResult {
  readonly rawObject: CopierPublicationLaneRawReceipt
  readonly receipt: CopierSnapshotPublicationV2Receipt
}

export interface PublishCapturedVerifiedCopierSnapshotInput {
  readonly acquisition: CapturedHistoryAcquisition
  readonly adapter: SourceAdapter
  readonly lane: CopierPublicationLane
  /** Fail closed when a scheduled record-only crawl yielded no response page. */
  readonly requireResponsePage?: boolean
  readonly source: SourceRow
  readonly trader: Readonly<{
    id: number
    exchange_trader_id: string
    meta: Record<string, unknown> | null
  }>
}

export interface VerifiedCopierSnapshotPublisherRuntime {
  readonly persistFallbackRawArtifact: (
    input: WriteHistoryRawArtifactInput
  ) => Promise<RawObjectReceipt>
  readonly persistLaneRawArtifact: (
    input: WriteCopierPublicationLaneRawInput
  ) => Promise<CopierPublicationLaneRawReceipt>
  readonly publishSnapshot: (
    input: PublishCopierSnapshotV2Input
  ) => Promise<CopierSnapshotPublicationV2Receipt>
}

function defaultRuntime(): VerifiedCopierSnapshotPublisherRuntime {
  return {
    persistFallbackRawArtifact: (input) => persistHistoryRawArtifactFirst(input),
    persistLaneRawArtifact: (input) =>
      writeCopierPublicationLaneRawArtifact(input, runHistoryTransaction),
    publishSnapshot: publishCopierSnapshotV2,
  }
}

function publisherError(detail: string): Error {
  return new Error(`[verified-copier-snapshot-publisher] ${detail}`)
}

function assertLaneRawObjectReceipt(
  value: unknown,
  artifact: CopierPublicationLaneArtifact
): asserts value is CopierPublicationLaneRawReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw publisherError('RAW receipt is invalid')
  }
  const prototype = Object.getPrototypeOf(value)
  const ownKeys = Reflect.ownKeys(value)
  const names = Object.getOwnPropertyNames(value).sort()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = ['contentHash', 'id', 'storagePath']
  const sourceRunId = copierPublicationLaneSourceRunId(artifact)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.some((key) => typeof key === 'symbol') ||
    names.length !== expectedKeys.length ||
    names.some((name, index) => name !== expectedKeys[index]) ||
    names.some((name) => {
      const descriptor = descriptors[name]
      return !descriptor.enumerable || !('value' in descriptor)
    }) ||
    typeof descriptors.id.value !== 'number' ||
    !Number.isSafeInteger(descriptors.id.value) ||
    descriptors.id.value <= 0 ||
    Object.is(descriptors.id.value, -0) ||
    descriptors.storagePath.value !== copierPublicationLaneStoragePath(artifact) ||
    descriptors.contentHash.value !== sourceRunId
  ) {
    throw publisherError('lane RAW receipt does not match the publication wrapper')
  }
}

function assertConservation(
  value: unknown,
  parsedRowCount: number
): asserts value is Readonly<{ verified: true; envelopeRowCount: number }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw publisherError('conservation verifier returned an invalid result')
  }
  const prototype = Object.getPrototypeOf(value)
  const ownKeys = Reflect.ownKeys(value)
  const names = Object.getOwnPropertyNames(value).sort()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const verified = descriptors.verified
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.some((key) => typeof key === 'symbol') ||
    !verified ||
    !verified.enumerable ||
    !('value' in verified)
  ) {
    throw publisherError('conservation verifier returned an invalid result')
  }
  if (verified.value === false && names.length === 1 && names[0] === 'verified') {
    throw publisherError('copier snapshot conservation was not verified')
  }
  const expectedKeys = ['envelopeRowCount', 'verified']
  const envelopeRowCount = descriptors.envelopeRowCount
  if (
    verified.value !== true ||
    names.length !== expectedKeys.length ||
    names.some((name, index) => name !== expectedKeys[index]) ||
    !envelopeRowCount ||
    !envelopeRowCount.enumerable ||
    !('value' in envelopeRowCount) ||
    typeof envelopeRowCount.value !== 'number' ||
    !Number.isSafeInteger(envelopeRowCount.value) ||
    envelopeRowCount.value < 0 ||
    Object.is(envelopeRowCount.value, -0) ||
    envelopeRowCount.value !== parsedRowCount
  ) {
    throw publisherError('copier snapshot envelope/parser conservation mismatch')
  }
}

/**
 * Rebuild parser input only from the immutable artifact that phase one made
 * durable. Parser output and conservation therefore share the exact stored
 * payload graph instead of an unbound capture-side copy.
 */
function rawPagesFromArtifact(artifact: HistoryAcquisitionArtifact): readonly Readonly<RawPage>[] {
  return Object.freeze(
    artifact.pages.map((page) =>
      Object.freeze({
        pageIndex: page.stored_page_index,
        payload: page.payload,
        url: page.url,
        fetchedAt: page.fetched_at,
      })
    )
  )
}

function parseCopierRows(
  adapter: SourceAdapter,
  pages: readonly Readonly<RawPage>[],
  ctx: ParseCtx
): readonly ParsedCopierRow[] {
  const rows = pages.flatMap((page) => adapter.parseHistory(page.payload, 'copiers', ctx))
  if (rows.some((row) => row.kind !== 'copiers')) {
    throw publisherError('history row kind does not match copiers')
  }
  return Object.freeze(
    (rows as ParsedCopierRow[]).map((row) =>
      Object.freeze({
        kind: 'copiers' as const,
        ts: row.ts,
        copierLabel: row.copierLabel,
        copierPnl: row.copierPnl,
        copierInvested: row.copierInvested,
        copyDurationDays: row.copyDurationDays,
        dedupeHash: row.dedupeHash,
        raw: row.raw,
      })
    )
  )
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

async function rejectAfterFallbackRaw(
  acquisition: CapturedHistoryAcquisition,
  cause: unknown,
  runtime: VerifiedCopierSnapshotPublisherRuntime
): Promise<never> {
  try {
    await runtime.persistFallbackRawArtifact(
      Object.freeze({
        artifact: acquisition.artifact,
        sourceRunId: acquisition.sourceRunId,
      })
    )
  } catch (rawCause) {
    throw new AggregateError(
      [asError(cause), asError(rawCause)],
      '[verified-copier-snapshot-publisher] rejection evidence and fallback RAW persistence failed'
    )
  }
  throw cause
}

/**
 * Publish an already captured whole copier snapshot. Invalid or interrupted
 * acquisitions retain generic RAW audit evidence. Even a terminally verified
 * capture first commits that non-publication RAW evidence; only after parsing
 * and conservation may its immutable lane wrapper acquire the copier_snapshot
 * RAW role consumed by V2.
 */
export async function publishCapturedVerifiedCopierSnapshot(
  input: PublishCapturedVerifiedCopierSnapshotInput,
  runtime: VerifiedCopierSnapshotPublisherRuntime = defaultRuntime()
): Promise<CaptureAndPublishVerifiedCopierSnapshotResult> {
  const { acquisition } = input
  if (acquisition.error !== null) {
    return rejectAfterFallbackRaw(acquisition, acquisition.error, runtime)
  }

  const artifact = acquisition.artifact
  if (
    artifact.source.id !== input.source.id ||
    artifact.source.slug !== input.source.slug ||
    artifact.trader.id !== input.trader.id ||
    artifact.trader.exchange_trader_id !== input.trader.exchange_trader_id ||
    artifact.history_kind !== 'copiers'
  ) {
    return rejectAfterFallbackRaw(
      acquisition,
      publisherError('captured copier subject does not match the publication input'),
      runtime
    )
  }
  if (artifact.pages.length === 0) {
    const qualifier = input.requireResponsePage === true ? 'scheduled ' : ''
    return rejectAfterFallbackRaw(
      acquisition,
      publisherError(
        `${input.source.slug} ${qualifier}copier snapshot returned no upstream response page`
      ),
      runtime
    )
  }

  let verifier: SelectedCopierSnapshotVerifier | null
  try {
    verifier = input.adapter.verifyCopierSnapshot?.(input.source) ?? null
  } catch (cause) {
    return rejectAfterFallbackRaw(acquisition, cause, runtime)
  }
  if (verifier === null) {
    return rejectAfterFallbackRaw(
      acquisition,
      publisherError('source/adapter pair has no reviewed copier publication contract'),
      runtime
    )
  }

  const termination = artifact.termination
  if (
    termination.evidence_state !== 'verified' ||
    termination.scan_terminal_state !== 'exhausted' ||
    termination.blocker_reasons.length !== 0 ||
    termination.verifier_contract !== verifier.contract
  ) {
    return rejectAfterFallbackRaw(
      acquisition,
      publisherError('copier snapshot has no verified exhaustive terminal proof'),
      runtime
    )
  }

  let wrapper: CopierPublicationLaneArtifact
  try {
    if (historyAcquisitionSourceRunId(artifact) !== acquisition.sourceRunId) {
      throw publisherError('captured acquisition source run does not match its artifact')
    }
    wrapper = buildCopierPublicationLaneArtifact({ lane: input.lane, acquisition: artifact })
    if (wrapper.acquisition_source_run_id !== acquisition.sourceRunId) {
      throw publisherError('lane wrapper does not bind the captured acquisition source run')
    }
  } catch (cause) {
    return rejectAfterFallbackRaw(acquisition, cause, runtime)
  }

  // Keep an audit-grade, explicitly non-publication RAW object durable before
  // executing adapter parsing. This closes the crash window without granting
  // the stronger copier_snapshot role before parser/envelope conservation.
  await runtime.persistFallbackRawArtifact(
    Object.freeze({
      artifact: acquisition.artifact,
      sourceRunId: acquisition.sourceRunId,
    })
  )

  const pages = rawPagesFromArtifact(wrapper.acquisition)
  const ctx: ParseCtx = {
    sourceSlug: input.source.slug,
    currency: input.source.currency,
    tfLabelMap: input.source.tf_label_map,
    scrapedAt: wrapper.acquisition.attempt_started_at,
    meta: input.source.meta,
  }
  // Parser or conservation rejection leaves only the copier_audit role
  // behind, which neither copier publication RPC may consume.
  const rows = parseCopierRows(input.adapter, pages, ctx)
  const conservation = verifier.verifyConservation({
    exchangeTraderId: input.trader.exchange_trader_id,
    pages,
    rows,
  })
  assertConservation(conservation, rows.length)

  const sourceRunId = copierPublicationLaneSourceRunId(wrapper)
  const observedAt = wrapper.acquisition.pages.at(-1)!.fetched_at
  const publication = Object.freeze({
    lane: input.lane,
    sourceId: input.source.id,
    traderId: input.trader.id,
    sourceRunId,
    acquisitionSourceRunId: wrapper.acquisition_source_run_id,
    observedAt,
    currency: input.source.currency,
    evidenceState: 'verified' as const,
    scanTerminalState: 'exhausted' as const,
    blockerReasons: termination.blocker_reasons,
    rows,
  }) satisfies PreflightCopierSnapshotV2PublicationInput

  // Reject every locally knowable V2 payload/value defect before granting
  // the publication-eligible copier_snapshot RAW role. The full publisher
  // repeats this exact preflight after the durable RAW receipt is available.
  preflightCopierSnapshotV2Publication(publication)

  // Grant the copier_snapshot role only after every semantic gate has passed.
  // If promotion fails, the non-publication audit RAW remains queryable.
  const rawObject = await runtime.persistLaneRawArtifact(Object.freeze({ artifact: wrapper }))
  assertLaneRawObjectReceipt(rawObject, wrapper)

  const receipt = await runtime.publishSnapshot(
    Object.freeze({
      ...publication,
      rawObject,
    })
  )
  return Object.freeze({ rawObject, receipt })
}

/**
 * Complete Tier-B copier flow. The unbounded whole-snapshot acquisition and
 * its adapter-selected terminal verifier run first. Non-publication RAW commits
 * before parsing; the lane RAW role is granted only after conservation and
 * before the receipt RPC.
 */
export async function captureAndPublishVerifiedCopierSnapshot(
  input: CaptureAndPublishVerifiedCopierSnapshotInput,
  runtime: VerifiedCopierSnapshotPublisherRuntime = defaultRuntime()
): Promise<CaptureAndPublishVerifiedCopierSnapshotResult> {
  const verifier = input.adapter.verifyCopierSnapshot?.(input.source) ?? null
  if (verifier === null) {
    throw publisherError('source/adapter pair has no reviewed copier publication contract')
  }
  const attemptStartedAt = new Date().toISOString()
  const acquisition = await captureHistoryAcquisition({
    source: input.source,
    traderId: input.trader.id,
    exchangeTraderId: input.trader.exchange_trader_id,
    kind: 'copiers',
    cursor: null,
    attemptStartedAt,
    callerPageCap: null,
    stream: input.adapter.getHistory(
      input.session,
      input.source,
      input.trader.exchange_trader_id,
      'copiers',
      null,
      input.trader.meta
    ),
    terminalVerifier: {
      contract: verifier.contract,
      verify: verifier.verifyTerminal,
    },
  })
  return publishCapturedVerifiedCopierSnapshot(
    {
      acquisition,
      adapter: input.adapter,
      lane: 'tier_b',
      ...(input.requireResponsePage === true ? { requireResponsePage: true } : {}),
      source: input.source,
      trader: input.trader,
    },
    runtime
  )
}
