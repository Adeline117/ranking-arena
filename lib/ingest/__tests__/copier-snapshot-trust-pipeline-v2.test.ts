import '../adapters/register'

const mockWriteCopierSnapshotTrustRawArtifactV2 = jest.fn()
const mockPublishCopierSnapshotTrustV2 = jest.fn()

jest.mock('../raw', () => ({
  writeCopierSnapshotTrustRawArtifactV2: (...args: unknown[]) =>
    mockWriteCopierSnapshotTrustRawArtifactV2(...args),
}))

jest.mock('../serving/copier-snapshot-publish-v2', () => ({
  publishCopierSnapshotTrustV2: (...args: unknown[]) => mockPublishCopierSnapshotTrustV2(...args),
}))

import type { BuildCopierSnapshotArtifactInput } from '../copier-snapshot-artifact'
import type { CopierSnapshotArtifactV2 } from '../copier-snapshot-artifact-v2'
import type { IngestQueryExecutor } from '../db'
import { captureWritePublishCopierSnapshotTrustV2 } from '../copier-snapshot-trust-pipeline-v2'
import type {
  CopierSnapshotTrustRawArtifactV2Receipt,
  IngestTransactionRunner,
  ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
} from '../raw'
import type { CopierSnapshotTrustPublicationV2Receipt } from '../serving/copier-snapshot-publish-v2'
import type { RawPage, SourceRow } from '../core/types'

function source(): SourceRow {
  return {
    id: 34,
    slug: 'bingx_futures',
    exchange_id: 3,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'bingx',
    leaderboard_url: 'https://example.test/leaderboard',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: null,
    deep_profile_topn: 20,
    positions_topn: 20,
    profile_cache_ttl: '15 minutes',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '15 minutes',
    cadence_tier_b: '1 hour',
    cadence_tier_d: '5 minutes',
    fetch_region: 'local',
    rate_budget_ms: 250,
    phase: 1,
    serving_mode: 'serving',
    status: 'active',
    meta: {},
  }
}

function page(): RawPage {
  return {
    pageIndex: 1,
    payload: {
      code: 0,
      data: {
        followerDetailsVoList: [
          {
            uid: 'private-candidate-a',
            nickName: 'private-name-a',
            followingProfitLoss: '1.25',
            copyAmount: '10',
            followingDays: 2,
          },
        ],
      },
    },
    url: 'https://example.test/copiers?page=1',
    fetchedAt: '2026-08-08T12:00:01.000Z',
  }
}

function captureInput(): BuildCopierSnapshotArtifactInput {
  return {
    src: source(),
    traderId: 101,
    exchangeTraderId: 'private-exchange-trader-101',
    lane: 'tier_c',
    requestTimeframe: 0,
    pages: [page()],
    callerLimited: false,
  }
}

function expectedStoragePath(artifact: CopierSnapshotArtifactV2, sourceRunId: string): string {
  const snapshot = artifact.snapshot
  return (
    `${snapshot.source.slug}/copier_snapshot_trust/${snapshot.lane}/${sourceRunId}/` +
    `copier_snapshot_trust_${sourceRunId}.json.gz`
  )
}

function rawReceipt(
  writeInput: { readonly artifact: CopierSnapshotArtifactV2; readonly sourceRunId: string },
  overrides: Partial<CopierSnapshotTrustRawArtifactV2Receipt> = {}
): CopierSnapshotTrustRawArtifactV2Receipt {
  const { artifact, sourceRunId } = writeInput
  return Object.freeze({
    id: 8001,
    storagePath: expectedStoragePath(artifact, sourceRunId),
    contentHash: sourceRunId,
    sourceRunId,
    snapshotSourceRunId: artifact.snapshot_source_run_id,
    candidateLedgerSha256: artifact.candidate_ledger_sha256,
    parserConservationSha256: artifact.parser_conservation_sha256,
    projectionLedgerSha256: artifact.projection_ledger_sha256,
    ...overrides,
  })
}

function publicationReceipt(
  anchors: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  artifact: CopierSnapshotArtifactV2,
  overrides: Partial<CopierSnapshotTrustPublicationV2Receipt> = {}
): CopierSnapshotTrustPublicationV2Receipt {
  return Object.freeze({
    publicationId: 9001,
    publishedAt: '2026-08-08T12:00:02.000000Z',
    sourceId: anchors.expectedSourceId,
    traderId: anchors.expectedTraderId,
    lane: anchors.expectedLane,
    rawObjectIdAtPublication: anchors.rawObjectId,
    outerSourceRunId: anchors.expectedSourceRunId,
    observedAt: '2026-08-08T12:00:01.000000Z',
    snapshotSourceRunId: anchors.expectedSnapshotSourceRunId,
    candidateLedgerSha256: anchors.expectedCandidateLedgerSha256,
    parserConservationSha256: anchors.expectedParserConservationSha256,
    projectionLedgerSha256: anchors.expectedProjectionLedgerSha256,
    parsedRowCount: artifact.projection_ledger.row_count,
    coverageState: 'unknown',
    rankEligible: false,
    replayed: false,
    isCurrentHead: true,
    ...overrides,
  })
}

function runner(): IngestTransactionRunner {
  return async <T>(_operation: (transaction: IngestQueryExecutor) => Promise<T>): Promise<T> => {
    throw new Error('the pipeline test runner is only an identity witness')
  }
}

describe('copier snapshot trust v2 capture/write/publish pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('captures, writes, verifies, and publishes in order through the exact same runner', async () => {
    const runTransaction = runner()
    const order: string[] = []
    let capturedWriteInput:
      | { readonly artifact: CopierSnapshotArtifactV2; readonly sourceRunId: string }
      | undefined

    mockWriteCopierSnapshotTrustRawArtifactV2.mockImplementationOnce(
      async (
        value: { readonly artifact: CopierSnapshotArtifactV2; readonly sourceRunId: string },
        suppliedRunner: IngestTransactionRunner
      ) => {
        order.push('write')
        capturedWriteInput = value
        expect(suppliedRunner).toBe(runTransaction)
        return rawReceipt(value)
      }
    )
    mockPublishCopierSnapshotTrustV2.mockImplementationOnce(
      async (
        anchors: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
        suppliedRunner: IngestTransactionRunner
      ) => {
        order.push('publish')
        expect(suppliedRunner).toBe(runTransaction)
        expect(capturedWriteInput).toBeDefined()
        return publicationReceipt(anchors, capturedWriteInput!.artifact)
      }
    )

    const result = await captureWritePublishCopierSnapshotTrustV2(captureInput(), runTransaction)

    expect(order).toEqual(['write', 'publish'])
    expect(mockWriteCopierSnapshotTrustRawArtifactV2).toHaveBeenCalledTimes(1)
    expect(mockPublishCopierSnapshotTrustV2).toHaveBeenCalledTimes(1)
    expect(capturedWriteInput).toBeDefined()
    const writeInput = capturedWriteInput!
    expect(Object.keys(writeInput).sort()).toEqual(['artifact', 'sourceRunId'])
    expect(writeInput.sourceRunId).toMatch(/^[0-9a-f]{64}$/)
    expect(writeInput.artifact.projection_ledger.rows).toHaveLength(1)

    const anchors = mockPublishCopierSnapshotTrustV2.mock.calls[0][0] as Readonly<
      ReadVerifiedCopierSnapshotTrustRawArtifactV2Input & Record<string, unknown>
    >
    expect(Object.keys(anchors).sort()).toEqual([
      'expectedCandidateLedgerSha256',
      'expectedExchangeTraderId',
      'expectedLane',
      'expectedParserConservationSha256',
      'expectedProjectionLedgerSha256',
      'expectedSnapshotSourceRunId',
      'expectedSourceId',
      'expectedSourceRunId',
      'expectedSourceSlug',
      'expectedTraderId',
      'rawObjectId',
    ])
    expect(anchors).toEqual({
      rawObjectId: 8001,
      expectedSourceId: writeInput.artifact.snapshot.source.id,
      expectedSourceSlug: writeInput.artifact.snapshot.source.slug,
      expectedTraderId: writeInput.artifact.snapshot.trader.id,
      expectedExchangeTraderId: writeInput.artifact.snapshot.trader.exchange_trader_id,
      expectedLane: writeInput.artifact.snapshot.lane,
      expectedSourceRunId: writeInput.sourceRunId,
      expectedSnapshotSourceRunId: writeInput.artifact.snapshot_source_run_id,
      expectedCandidateLedgerSha256: writeInput.artifact.candidate_ledger_sha256,
      expectedParserConservationSha256: writeInput.artifact.parser_conservation_sha256,
      expectedProjectionLedgerSha256: writeInput.artifact.projection_ledger_sha256,
    })
    expect(anchors).not.toHaveProperty('rows')
    expect(anchors).not.toHaveProperty('artifact')
    expect(anchors).not.toHaveProperty('storagePath')
    expect(anchors).not.toHaveProperty('coverageState')
    expect(anchors).not.toHaveProperty('rankEligible')
    expect(Object.isFrozen(anchors)).toBe(true)

    expect(Object.keys(result).sort()).toEqual(
      [
        'candidateLedgerSha256',
        'coverageState',
        'isCurrentHead',
        'lane',
        'observedAt',
        'outerSourceRunId',
        'parsedRowCount',
        'parserConservationSha256',
        'publicationId',
        'publishedAt',
        'rankEligible',
        'rawObjectIdAtPublication',
        'replayed',
        'snapshotSourceRunId',
        'sourceId',
        'traderId',
        'projectionLedgerSha256',
      ].sort()
    )
    expect(result).toMatchObject({
      rawObjectIdAtPublication: 8001,
      outerSourceRunId: writeInput.sourceRunId,
      parsedRowCount: 1,
      rankEligible: false,
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each([
    [
      'rank eligibility claim',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => ({
        ...value,
        rankEligible: true,
      }),
      'must remain non-ranking',
    ],
    [
      'RAW anchor mismatch',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => ({
        ...value,
        rawObjectIdAtPublication: 8002,
      }),
      'RAW identity does not match',
    ],
    [
      'observation clock mismatch',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => ({
        ...value,
        observedAt: '2026-08-08T12:00:00.000000Z',
      }),
      'observation clock does not match',
    ],
    [
      'parsed count mismatch',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => ({
        ...value,
        parsedRowCount: 0,
      }),
      'parsed row count does not match',
    ],
    [
      'coverage mismatch',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => ({
        ...value,
        coverageState: 'partial',
      }),
      'coverage state does not match',
    ],
    [
      'new non-head state',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => ({
        ...value,
        replayed: false,
        isCurrentHead: false,
      }),
      'new publisher receipt must be the current lane head',
    ],
    [
      'extra field',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => ({ ...value, rows: [] }),
      'fields outside the v2 contract',
    ],
    [
      'accessor',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => {
        const hostile = { ...value }
        Object.defineProperty(hostile, 'publishedAt', {
          enumerable: true,
          get: () => value.publishedAt,
        })
        return hostile
      },
      'accessors or missing fields',
    ],
    [
      'proxy',
      (value: CopierSnapshotTrustPublicationV2Receipt): unknown => new Proxy({ ...value }, {}),
      'non-plain receipt',
    ],
  ])('rejects a hostile publisher %s receipt', async (_label, alter, error) => {
    const runTransaction = runner()
    let writeInput:
      | { readonly artifact: CopierSnapshotArtifactV2; readonly sourceRunId: string }
      | undefined
    mockWriteCopierSnapshotTrustRawArtifactV2.mockImplementationOnce(
      async (value: {
        readonly artifact: CopierSnapshotArtifactV2
        readonly sourceRunId: string
      }) => {
        writeInput = value
        return rawReceipt(value)
      }
    )
    mockPublishCopierSnapshotTrustV2.mockImplementationOnce(
      async (anchors: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input) => {
        expect(writeInput).toBeDefined()
        return alter(publicationReceipt(anchors, writeInput!.artifact))
      }
    )

    await expect(
      captureWritePublishCopierSnapshotTrustV2(captureInput(), runTransaction)
    ).rejects.toThrow(error)
  })

  it.each([
    [
      'outer source-run anchor',
      (value: CopierSnapshotTrustRawArtifactV2Receipt): CopierSnapshotTrustRawArtifactV2Receipt =>
        Object.freeze({ ...value, contentHash: 'f'.repeat(64) }),
      'outer source-run anchor',
    ],
    [
      'child evidence anchor',
      (value: CopierSnapshotTrustRawArtifactV2Receipt): CopierSnapshotTrustRawArtifactV2Receipt =>
        Object.freeze({ ...value, candidateLedgerSha256: 'f'.repeat(64) }),
      'child evidence anchors',
    ],
  ])('rejects a mismatched RAW %s before publishing', async (_label, alter, error) => {
    const runTransaction = runner()
    mockWriteCopierSnapshotTrustRawArtifactV2.mockImplementationOnce(
      async (value: {
        readonly artifact: CopierSnapshotArtifactV2
        readonly sourceRunId: string
      }) => alter(rawReceipt(value))
    )

    await expect(
      captureWritePublishCopierSnapshotTrustV2(captureInput(), runTransaction)
    ).rejects.toThrow(error)
    expect(mockPublishCopierSnapshotTrustV2).not.toHaveBeenCalled()
  })

  it.each([
    [
      'extra field',
      (value: CopierSnapshotTrustRawArtifactV2Receipt): unknown => ({
        ...value,
        receiptLeak: true,
      }),
      'fields outside the v2 contract',
    ],
    [
      'accessor',
      (value: CopierSnapshotTrustRawArtifactV2Receipt): unknown => {
        const hostile = { ...value }
        Object.defineProperty(hostile, 'id', { enumerable: true, get: () => value.id })
        return hostile
      },
      'accessors or missing fields',
    ],
    [
      'proxy',
      (value: CopierSnapshotTrustRawArtifactV2Receipt): unknown => new Proxy({ ...value }, {}),
      'non-plain receipt',
    ],
  ])('rejects a hostile RAW %s receipt before publishing', async (_label, alter, error) => {
    const runTransaction = runner()
    mockWriteCopierSnapshotTrustRawArtifactV2.mockImplementationOnce(
      async (value: {
        readonly artifact: CopierSnapshotArtifactV2
        readonly sourceRunId: string
      }) => alter(rawReceipt(value))
    )

    await expect(
      captureWritePublishCopierSnapshotTrustV2(captureInput(), runTransaction)
    ).rejects.toThrow(error)
    expect(mockPublishCopierSnapshotTrustV2).not.toHaveBeenCalled()
  })

  it('propagates RAW and publisher failures without attempting a later stage', async () => {
    const runTransaction = runner()
    const rawFailure = new Error('RAW pointer rejected')
    mockWriteCopierSnapshotTrustRawArtifactV2.mockRejectedValueOnce(rawFailure)

    await expect(
      captureWritePublishCopierSnapshotTrustV2(captureInput(), runTransaction)
    ).rejects.toBe(rawFailure)
    expect(mockPublishCopierSnapshotTrustV2).not.toHaveBeenCalled()

    let writeInput:
      | { readonly artifact: CopierSnapshotArtifactV2; readonly sourceRunId: string }
      | undefined
    mockWriteCopierSnapshotTrustRawArtifactV2.mockImplementationOnce(
      async (value: {
        readonly artifact: CopierSnapshotArtifactV2
        readonly sourceRunId: string
      }) => {
        writeInput = value
        return rawReceipt(value)
      }
    )
    const publishFailure = new Error('publication authority rejected')
    mockPublishCopierSnapshotTrustV2.mockRejectedValueOnce(publishFailure)

    await expect(
      captureWritePublishCopierSnapshotTrustV2(captureInput(), runTransaction)
    ).rejects.toBe(publishFailure)
    expect(writeInput).toBeDefined()
    expect(mockPublishCopierSnapshotTrustV2).toHaveBeenCalledTimes(1)
  })

  it('has no caller-owned rows boundary', async () => {
    const runTransaction = runner()
    const hostile = Object.assign(captureInput(), { rows: [] })

    await expect(captureWritePublishCopierSnapshotTrustV2(hostile, runTransaction)).rejects.toThrow(
      'exact capture fields'
    )
    expect(mockWriteCopierSnapshotTrustRawArtifactV2).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshotTrustV2).not.toHaveBeenCalled()
  })

  it('leaves a hostile proxy input for capture to reject before RAW or publication', async () => {
    const runTransaction = runner()
    const hostile = new Proxy(captureInput(), {
      get() {
        throw new Error('pipeline must not read caller input')
      },
      ownKeys() {
        throw new Error('pipeline must not enumerate caller input')
      },
    })

    await expect(captureWritePublishCopierSnapshotTrustV2(hostile, runTransaction)).rejects.toThrow(
      'non-proxy plain object'
    )
    expect(mockWriteCopierSnapshotTrustRawArtifactV2).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshotTrustV2).not.toHaveBeenCalled()
  })
})
