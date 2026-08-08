import type { SelectedCopierSnapshotVerifier, SourceAdapter } from '@/lib/ingest/core/adapter'
import type { ParsedCopierRow, SourceRow } from '@/lib/ingest/core/types'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import {
  historyAcquisitionSourceRunId,
  type CapturedHistoryAcquisition,
  type HistoryAcquisitionArtifact,
} from '@/lib/ingest/history-acquisition'
import {
  copierPublicationLaneSourceRunId,
  copierPublicationLaneStoragePath,
  type CopierPublicationLaneArtifact,
} from '@/lib/ingest/copier-publication-lane-artifact'
import type {
  CopierPublicationLaneRawReceipt,
  WriteCopierPublicationLaneRawInput,
} from '@/lib/ingest/copier-publication-lane-raw'
import type {
  CopierSnapshotPublicationV2Receipt,
  PublishCopierSnapshotV2Input,
} from '@/lib/ingest/serving/publish'
import { strictCanonicalSha256 } from '@/lib/ingest/strict-canonical-json'
const mockCaptureHistoryAcquisition = jest.fn()

jest.mock('@/lib/ingest/history-acquisition', () => {
  const actual = jest.requireActual('@/lib/ingest/history-acquisition')
  return {
    ...actual,
    captureHistoryAcquisition: (...args: unknown[]) => mockCaptureHistoryAcquisition(...args),
  }
})

import {
  captureAndPublishVerifiedCopierSnapshot,
  type VerifiedCopierSnapshotPublisherRuntime,
} from '../verified-copier-snapshot-publisher'

const parserClock = '2026-08-04T10:00:00.000Z'
const fetchedAt = '2026-08-04T10:00:01.000Z'
const source = {
  id: 7,
  slug: 'binance_futures',
  adapter_slug: 'binance',
  currency: 'USDT',
  tf_label_map: {},
  meta: {},
} as SourceRow
const trader = Object.freeze({
  id: 41,
  exchange_trader_id: 'lead-1',
  meta: null,
})
const rawPayload = Object.freeze({ data: Object.freeze([{ alias: 'copier-1', pnl: '12.5' }]) })
function artifact(
  termination: Partial<HistoryAcquisitionArtifact['termination']> = {},
  pages: HistoryAcquisitionArtifact['pages'] | null = null
): HistoryAcquisitionArtifact {
  return {
    contract: 'arena.ingest.history-acquisition-artifact@1',
    serialization_contract: 'arena.strict-canonical-json@1',
    source: { id: source.id, slug: source.slug },
    trader: { id: trader.id, exchange_trader_id: trader.exchange_trader_id },
    history_kind: 'copiers',
    attempt_started_at: parserClock,
    starting_cursor: null,
    capture_config: { caller_page_cap: null },
    pages:
      pages ??
      ([
        {
          ordinal: 1,
          stored_page_index: 1,
          url: 'https://example.test/copiers?page=1',
          fetched_at: fetchedAt,
          payload_sha256: strictCanonicalSha256(rawPayload),
          payload: rawPayload,
        },
      ] as HistoryAcquisitionArtifact['pages']),
    termination: {
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }],
      verifier_contract: 'arena.ingest.history-terminal-verifier.test.copiers@1',
      scan_terminal_state: 'exhausted',
      terminal_cursor_value: null,
      overlap_event_at: null,
      blocker_reasons: [],
      ...termination,
    },
  }
}

function capture(overrides: Partial<CapturedHistoryAcquisition> = {}): CapturedHistoryAcquisition {
  const capturedArtifact = overrides.artifact ?? artifact()
  return {
    artifact: capturedArtifact,
    sourceRunId: strictCanonicalSha256(capturedArtifact),
    pages: [],
    error: null,
    ...overrides,
  }
}

function laneRawObject(wrapper: CopierPublicationLaneArtifact): CopierPublicationLaneRawReceipt {
  return Object.freeze({
    id: 501,
    storagePath: copierPublicationLaneStoragePath(wrapper),
    contentHash: copierPublicationLaneSourceRunId(wrapper),
  })
}

function publicationReceipt(
  input: PublishCopierSnapshotV2Input
): CopierSnapshotPublicationV2Receipt {
  return Object.freeze({
    receiptId: 701,
    lane: input.lane,
    sourceRunId: input.sourceRunId,
    acquisitionSourceRunId: input.acquisitionSourceRunId,
    observedAt: input.observedAt,
    publishedAt: '2026-08-04T10:00:02.000Z',
    rowCount: input.rows.length,
  })
}

function copierRow(raw: Record<string, unknown>): ParsedCopierRow {
  return {
    kind: 'copiers',
    ts: parserClock,
    copierLabel: 'copier-1',
    copierPnl: 12.5,
    copierInvested: null,
    copyDurationDays: null,
    dedupeHash: 'copier-1',
    raw,
  }
}

describe('verified Tier-B copier snapshot publisher', () => {
  const getHistory = jest.fn(() => ({ [Symbol.asyncIterator]: jest.fn() }))
  const parseHistory = jest.fn((payload: typeof rawPayload) => [copierRow(payload.data[0])])
  const verifyTerminal = jest.fn(() => ({
    verified: true as const,
    scanTerminalState: 'exhausted' as const,
  }))
  const verifyConservation = jest.fn(() => ({ verified: true as const, envelopeRowCount: 1 }))
  const verifier: SelectedCopierSnapshotVerifier = {
    contract: 'arena.ingest.history-terminal-verifier.test.copiers@1',
    verifyTerminal,
    verifyConservation,
  }
  const selectCopierVerifier = jest.fn(() => verifier)
  const adapter = {
    getHistory,
    parseHistory,
    verifyCopierSnapshot: selectCopierVerifier,
  } as SourceAdapter
  const persistFallbackRawArtifact = jest.fn()
  const persistLaneRawArtifact = jest.fn()
  const publishSnapshot = jest.fn()
  const runtime: VerifiedCopierSnapshotPublisherRuntime = {
    persistFallbackRawArtifact,
    persistLaneRawArtifact,
    publishSnapshot,
  }
  const input = {
    adapter,
    session: {} as FetchSession,
    source,
    trader,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCaptureHistoryAcquisition.mockResolvedValue(capture())
    persistFallbackRawArtifact.mockResolvedValue({
      id: 500,
      storagePath: 'binance_futures/history_trust/copiers/fallback.json.gz',
      contentHash: 'f'.repeat(64),
    })
    persistLaneRawArtifact.mockImplementation(
      async ({ artifact: wrapper }: WriteCopierPublicationLaneRawInput) => laneRawObject(wrapper)
    )
    publishSnapshot.mockImplementation(async (request: PublishCopierSnapshotV2Input) =>
      publicationReceipt(request)
    )
    parseHistory.mockImplementation((payload: typeof rawPayload) => [copierRow(payload.data[0])])
    verifyConservation.mockReturnValue({ verified: true, envelopeRowCount: 1 })
    selectCopierVerifier.mockReturnValue(verifier)
  })

  it('publishes only after unbounded capture, durable RAW, exact proof, and conservation', async () => {
    const acquisition = capture()
    mockCaptureHistoryAcquisition.mockResolvedValue(acquisition)
    const result = await captureAndPublishVerifiedCopierSnapshot(input, runtime)
    const wrapper = persistLaneRawArtifact.mock.calls[0][0]
      .artifact as CopierPublicationLaneArtifact
    const expectedRawObject = laneRawObject(wrapper)
    const publicationInput = publishSnapshot.mock.calls[0][0] as PublishCopierSnapshotV2Input

    expect(result).toEqual({
      rawObject: expectedRawObject,
      receipt: publicationReceipt(publicationInput),
    })

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      source,
      trader.exchange_trader_id,
      'copiers',
      null,
      null
    )
    expect(mockCaptureHistoryAcquisition).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        traderId: trader.id,
        exchangeTraderId: trader.exchange_trader_id,
        kind: 'copiers',
        cursor: null,
        callerPageCap: null,
        terminalVerifier: {
          contract: verifier.contract,
          verify: verifier.verifyTerminal,
        },
      })
    )
    expect(selectCopierVerifier).toHaveBeenCalledTimes(2)
    expect(selectCopierVerifier).toHaveBeenNthCalledWith(1, source)
    expect(selectCopierVerifier).toHaveBeenNthCalledWith(2, source)
    expect(persistFallbackRawArtifact).toHaveBeenCalledWith({
      artifact: acquisition.artifact,
      sourceRunId: acquisition.sourceRunId,
    })
    expect(parseHistory).toHaveBeenCalledWith(rawPayload, 'copiers', {
      sourceSlug: source.slug,
      currency: source.currency,
      tfLabelMap: source.tf_label_map,
      scrapedAt: parserClock,
      meta: source.meta,
    })
    expect(persistLaneRawArtifact).toHaveBeenCalledWith({
      artifact: expect.objectContaining({
        publication_lane: 'tier_b',
        acquisition_source_run_id: historyAcquisitionSourceRunId(artifact()),
        acquisition: expect.objectContaining({ history_kind: 'copiers' }),
      }),
    })
    expect(verifyConservation).toHaveBeenCalledWith({
      exchangeTraderId: trader.exchange_trader_id,
      parserClock,
      pages: [
        {
          pageIndex: 1,
          payload: rawPayload,
          url: 'https://example.test/copiers?page=1',
          fetchedAt,
        },
      ],
      rows: [expect.objectContaining({ kind: 'copiers', raw: rawPayload.data[0] })],
    })
    expect(publishSnapshot).toHaveBeenCalledWith({
      lane: 'tier_b',
      sourceId: source.id,
      traderId: trader.id,
      rawObject: expectedRawObject,
      sourceRunId: copierPublicationLaneSourceRunId(wrapper),
      acquisitionSourceRunId: wrapper.acquisition_source_run_id,
      observedAt: fetchedAt,
      currency: source.currency,
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
      rows: [expect.objectContaining({ kind: 'copiers' })],
    })
    expect(persistFallbackRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      parseHistory.mock.invocationCallOrder[0]
    )
    expect(parseHistory.mock.invocationCallOrder[0]).toBeLessThan(
      verifyConservation.mock.invocationCallOrder[0]
    )
    expect(verifyConservation.mock.invocationCallOrder[0]).toBeLessThan(
      persistLaneRawArtifact.mock.invocationCallOrder[0]
    )
    expect(persistLaneRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      publishSnapshot.mock.invocationCallOrder[0]
    )
  })

  it('persists RAW before rejecting a non-exhausted terminal state', async () => {
    mockCaptureHistoryAcquisition.mockResolvedValue(
      capture({
        artifact: artifact({ scan_terminal_state: 'partial' }),
      })
    )

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(
      'copier snapshot has no verified exhaustive terminal proof'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('persists RAW before rejecting a terminal blocker', async () => {
    mockCaptureHistoryAcquisition.mockResolvedValue(
      capture({
        artifact: artifact({ blocker_reasons: ['terminal_claim_rejected'] }),
      })
    )

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(
      'copier snapshot has no verified exhaustive terminal proof'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('persists fallback RAW when the artifact names a different verifier', async () => {
    mockCaptureHistoryAcquisition.mockResolvedValue(
      capture({
        artifact: artifact({
          verifier_contract: 'arena.ingest.history-terminal-verifier.forged.copiers@1',
        }),
      })
    )

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(
      'copier snapshot has no verified exhaustive terminal proof'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('never promotes a capture whose source-run digest is not its artifact hash', async () => {
    mockCaptureHistoryAcquisition.mockResolvedValue(capture({ sourceRunId: 'f'.repeat(64) }))

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(
      'captured acquisition source run does not match its artifact'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('never parses or grants the lane role when audit RAW durability fails', async () => {
    const failure = new Error('object storage unavailable')
    persistFallbackRawArtifact.mockRejectedValue(failure)

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toBe(failure)
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(verifyConservation).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('retains audit RAW when post-conservation lane promotion fails', async () => {
    const failure = new Error('lane RAW pointer unavailable')
    persistLaneRawArtifact.mockRejectedValue(failure)

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toBe(failure)
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(parseHistory).toHaveBeenCalledTimes(1)
    expect(verifyConservation).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).toHaveBeenCalledTimes(1)
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('reselects the adapter authority after capture and fails closed if it disappears', async () => {
    selectCopierVerifier.mockReturnValueOnce(verifier).mockReturnValueOnce(null)

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(
      'source/adapter pair has no reviewed copier publication contract'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('persists copier audit RAW when the post-capture selector throws', async () => {
    const failure = new Error('selector configuration drifted')
    selectCopierVerifier.mockReturnValueOnce(verifier).mockImplementationOnce(() => {
      throw failure
    })

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toBe(failure)
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('persists upstream failure evidence before propagating the capture error', async () => {
    const failure = new Error('upstream disconnected')
    mockCaptureHistoryAcquisition.mockResolvedValue(capture({ error: failure }))

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toBe(failure)
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('reports both the capture and fallback RAW failures without parsing', async () => {
    mockCaptureHistoryAcquisition.mockResolvedValue(
      capture({ error: new Error('upstream disconnected') })
    )
    persistFallbackRawArtifact.mockRejectedValue(new Error('fallback RAW unavailable'))

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining('fallback RAW persistence failed'),
      errors: [
        expect.objectContaining({ message: 'upstream disconnected' }),
        expect.objectContaining({ message: 'fallback RAW unavailable' }),
      ],
    })
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('persists an empty capture before enforcing the scheduled response-page gate', async () => {
    mockCaptureHistoryAcquisition.mockResolvedValue(capture({ artifact: artifact({}, []) }))

    await expect(
      captureAndPublishVerifiedCopierSnapshot({ ...input, requireResponsePage: true }, runtime)
    ).rejects.toThrow(
      'binance_futures scheduled copier snapshot returned no upstream response page'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('retains audit RAW and never grants the lane role when parsing fails', async () => {
    const failure = new Error('copier parser rejected the response')
    parseHistory.mockImplementationOnce(() => {
      throw failure
    })

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toBe(failure)
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(parseHistory).toHaveBeenCalledTimes(1)
    expect(verifyConservation).not.toHaveBeenCalled()
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('rejects failed conservation without reaching the receipt authority', async () => {
    verifyConservation.mockReturnValue({ verified: false })

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(
      'copier snapshot conservation was not verified'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(parseHistory).toHaveBeenCalledTimes(1)
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it('rejects an envelope/parser count mismatch without publishing', async () => {
    verifyConservation.mockReturnValue({ verified: true, envelopeRowCount: 2 })

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(
      'copier snapshot envelope/parser conservation mismatch'
    )
    expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
    expect(persistLaneRawArtifact).not.toHaveBeenCalled()
    expect(publishSnapshot).not.toHaveBeenCalled()
  })

  it.each([
    [
      'label beyond the database limit',
      { copierLabel: 'x'.repeat(513) },
      'rows[0].copierLabel is invalid',
    ],
    [
      'duration beyond the database int32 range',
      { copyDurationDays: 2_147_483_648 },
      'rows[0].copyDurationDays is invalid',
    ],
  ] as const)(
    'keeps only copier audit RAW when local V2 preflight rejects %s',
    async (_label, rowOverride, message) => {
      parseHistory.mockImplementationOnce((payload: typeof rawPayload) => [
        { ...copierRow(payload.data[0]), ...rowOverride },
      ])

      await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toThrow(message)

      expect(persistFallbackRawArtifact).toHaveBeenCalledTimes(1)
      expect(parseHistory).toHaveBeenCalledTimes(1)
      expect(verifyConservation).toHaveBeenCalledTimes(1)
      expect(persistLaneRawArtifact).not.toHaveBeenCalled()
      expect(publishSnapshot).not.toHaveBeenCalled()
    }
  )

  it('propagates a lane-aware receipt publication failure after all prior gates', async () => {
    const failure = new Error('receipt RPC rejected tier_b lane')
    publishSnapshot.mockRejectedValue(failure)

    await expect(captureAndPublishVerifiedCopierSnapshot(input, runtime)).rejects.toBe(failure)
    expect(persistLaneRawArtifact).toHaveBeenCalledTimes(1)
    expect(verifyConservation).toHaveBeenCalledTimes(1)
    expect(publishSnapshot).toHaveBeenCalledWith(expect.objectContaining({ lane: 'tier_b' }))
  })

  it('freezes the conserved row snapshot across asynchronous lane promotion', async () => {
    persistLaneRawArtifact.mockImplementationOnce(
      async ({ artifact: wrapper }: WriteCopierPublicationLaneRawInput) => {
        const conservedRows = verifyConservation.mock.calls[0][0].rows as ParsedCopierRow[]
        expect(Object.isFrozen(conservedRows)).toBe(true)
        expect(Object.isFrozen(conservedRows[0])).toBe(true)
        expect(Reflect.set(conservedRows[0], 'copierPnl', 999)).toBe(false)
        await Promise.resolve()
        return laneRawObject(wrapper)
      }
    )

    await captureAndPublishVerifiedCopierSnapshot(input, runtime)

    const published = (publishSnapshot.mock.calls[0][0] as PublishCopierSnapshotV2Input).rows
    expect(published[0].copierPnl).toBe(12.5)
    expect(published).toBe(verifyConservation.mock.calls[0][0].rows)
  })
})
