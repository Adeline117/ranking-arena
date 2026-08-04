const mockPoolQuery = jest.fn()
const mockIngestClientConnect = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: (...args: unknown[]) => mockIngestClientConnect(...args),
}))

import type { ParsedCopierRow } from '../../core/types'
import {
  COPIER_SNAPSHOT_PUBLICATION_CONTRACT,
  publishCopierSnapshot,
  type PublishCopierSnapshotInput,
} from '../publish'

const SOURCE_RUN_ID = 'a'.repeat(64)
const OBSERVED_AT = '2026-08-04T10:00:00.000Z'
const PUBLISHED_AT = '2026-08-04T10:00:01.000Z'

const copierRow: ParsedCopierRow = {
  kind: 'copiers',
  ts: '2026-08-04T09:59:00.000Z',
  copierLabel: 'private-copier',
  copierPnl: -2.5,
  copierInvested: 100,
  copyDurationDays: 7,
  dedupeHash: 'copier-1',
  raw: { privateId: 'private-copier', nested: { exact: true } },
}

function input(rows: readonly ParsedCopierRow[] = [copierRow]): PublishCopierSnapshotInput {
  return {
    sourceId: 34,
    traderId: 42,
    rawObjectId: 2_081_897,
    sourceRunId: SOURCE_RUN_ID,
    observedAt: OBSERVED_AT,
    currency: 'USDC',
    evidenceState: 'verified',
    scanTerminalState: 'exhausted',
    blockerReasons: [],
    rows,
  }
}

function receipt(rowCount = 1): Record<string, unknown> {
  return {
    receiptId: 501,
    sourceRunId: SOURCE_RUN_ID,
    observedAt: OBSERVED_AT,
    publishedAt: PUBLISHED_AT,
    rowCount,
  }
}

function rpcResult(value: unknown = receipt()): Record<string, unknown> {
  return {
    command: 'SELECT',
    rowCount: 1,
    rows: [{ receipt: value }],
  }
}

describe('copier snapshot receipt publication', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPoolQuery.mockResolvedValue(rpcResult())
  })

  it('sends one exact private snapshot contract through the atomic owner RPC', async () => {
    await expect(publishCopierSnapshot(input())).resolves.toEqual(receipt())

    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    expect(String(mockPoolQuery.mock.calls[0][0])).toBe(
      'SELECT public.publish_copier_snapshot_v1($1::jsonb) AS receipt'
    )
    expect(mockPoolQuery.mock.calls[0][1]).toHaveLength(1)
    const payload = JSON.parse(String(mockPoolQuery.mock.calls[0][1][0]))
    expect(Object.keys(payload).sort()).toEqual(
      [
        'contract',
        'sourceId',
        'traderId',
        'rawObjectId',
        'sourceRunId',
        'observedAt',
        'currency',
        'evidenceState',
        'scanTerminalState',
        'blockerReasons',
        'rows',
      ].sort()
    )
    expect(payload).toMatchObject({
      contract: COPIER_SNAPSHOT_PUBLICATION_CONTRACT,
      sourceId: 34,
      traderId: 42,
      rawObjectId: 2_081_897,
      sourceRunId: SOURCE_RUN_ID,
      observedAt: OBSERVED_AT,
      currency: 'USDC',
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
    })
    expect(payload.rows).toEqual([
      {
        ts: copierRow.ts,
        copierLabel: copierRow.copierLabel,
        copierPnl: copierRow.copierPnl,
        copierInvested: copierRow.copierInvested,
        copyDurationDays: copierRow.copyDurationDays,
        dedupeHash: copierRow.dedupeHash,
        raw: copierRow.raw,
      },
    ])
    expect(Object.keys(payload.rows[0]).sort()).toEqual(
      [
        'ts',
        'copierLabel',
        'copierPnl',
        'copierInvested',
        'copyDurationDays',
        'dedupeHash',
        'raw',
      ].sort()
    )
    expect(mockIngestClientConnect).not.toHaveBeenCalled()
    expect(String(mockPoolQuery.mock.calls[0][0])).not.toMatch(
      /copier_snapshot_publications|copier_snapshot_rows|copier_records/i
    )
  })

  it('supports a verified zero-row receipt without manufacturing a row', async () => {
    mockPoolQuery.mockResolvedValue(rpcResult(receipt(0)))

    await expect(publishCopierSnapshot(input([]))).resolves.toEqual(receipt(0))

    const payload = JSON.parse(String(mockPoolQuery.mock.calls[0][1][0]))
    expect(payload.rows).toEqual([])
  })

  it.each([
    ['extra top-level key', { ...input(), extra: true }],
    ['unverified evidence', { ...input(), evidenceState: 'rejected' }],
    ['nonterminal scan', { ...input(), scanTerminalState: 'partial' }],
    ['blocker', { ...input(), blockerReasons: ['caller_limit'] }],
    ['source id outside smallint', { ...input(), sourceId: 32_768 }],
    ['zero source run', { ...input(), sourceRunId: '0'.repeat(64) }],
    ['noncanonical observation', { ...input(), observedAt: '2026-08-04 10:00:00Z' }],
    ['extra row key', { ...input(), rows: [{ ...copierRow, sourceIdentity: 'private' }] }],
    [
      'noncanonical row timestamp',
      { ...input(), rows: [{ ...copierRow, ts: '2026-08-04T09:59:00Z' }] },
    ],
    [
      'row timestamp beyond observation tolerance',
      { ...input(), rows: [{ ...copierRow, ts: '2026-08-04T10:05:00.001Z' }] },
    ],
    ['duplicate row identity', { ...input(), rows: [copierRow, { ...copierRow }] }],
    ['nonfinite numeric', { ...input(), rows: [{ ...copierRow, copierPnl: Number.NaN }] }],
    ['negative investment', { ...input(), rows: [{ ...copierRow, copierInvested: -1 }] }],
    ['fractional duration', { ...input(), rows: [{ ...copierRow, copyDurationDays: 1.5 }] }],
    [
      'duration outside integer range',
      { ...input(), rows: [{ ...copierRow, copyDurationDays: 2_147_483_648 }] },
    ],
  ])('rejects invalid input before database I/O: %s', async (_label, invalid) => {
    await expect(publishCopierSnapshot(invalid as PublishCopierSnapshotInput)).rejects.toThrow(
      '[copier-snapshot]'
    )
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['extra key', { ...receipt(), extra: true }],
    ['missing key', { ...receipt(), rowCount: undefined }],
    ['wrong run', { ...receipt(), sourceRunId: 'b'.repeat(64) }],
    ['wrong observation', { ...receipt(), observedAt: '2026-08-04T09:00:00.000Z' }],
    ['wrong count', { ...receipt(), rowCount: 2 }],
    ['bad receipt id', { ...receipt(), receiptId: 0 }],
    ['bad publish clock', { ...receipt(), publishedAt: '2026-08-04 10:00:01Z' }],
  ])('rejects a malformed or drifted receipt: %s', async (_label, invalidReceipt) => {
    mockPoolQuery.mockResolvedValue(rpcResult(invalidReceipt))

    await expect(publishCopierSnapshot(input())).rejects.toThrow('[copier-snapshot]')
  })

  it.each([
    ['wrong command', { ...rpcResult(), command: 'UPDATE' }],
    ['zero rows', { ...rpcResult(), rowCount: 0, rows: [] }],
    [
      'extra outer field',
      {
        ...rpcResult(),
        rows: [{ receipt: receipt(), extra: true }],
      },
    ],
  ])('rejects an invalid RPC result envelope: %s', async (_label, invalidResult) => {
    mockPoolQuery.mockResolvedValue(invalidResult)

    await expect(publishCopierSnapshot(input())).rejects.toThrow('[copier-snapshot]')
  })
})
