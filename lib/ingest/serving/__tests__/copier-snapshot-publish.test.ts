import type { ParsedHistoryRow, SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'
import {
  buildCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
} from '../../copier-snapshot-artifact'
import { publishCopierSnapshotInTransaction } from '../copier-snapshot-publish'

const source = {
  id: 34,
  slug: 'gate_futures',
  currency: 'USDT',
  copier_table_depth: 'top10',
  fetch_region: 'local',
  status: 'active',
  serving_mode: 'serving',
} as SourceRow

const artifact = buildCopierSnapshotArtifact({
  src: source,
  traderId: 101,
  exchangeTraderId: 'trader-101',
  lane: 'tier_c',
  requestTimeframe: 0,
  pages: [
    {
      pageIndex: 1,
      payload: { rows: [{ id: 'private-1' }] },
      url: 'https://example.test/copiers?page=1',
      fetchedAt: '2026-08-04T10:00:00.000Z',
    },
  ],
  callerLimited: false,
})
const sourceRunId = copierSnapshotSourceRunId(artifact)
const rawReceipt = {
  id: 7001,
  storagePath: `gate_futures/copier_snapshot/tier_c/1785837600000_${sourceRunId}.json.gz`,
  contentHash: sourceRunId,
}
const copierRow: Extract<ParsedHistoryRow, { kind: 'copiers' }> = {
  kind: 'copiers',
  ts: artifact.observed_at,
  copierLabel: 'private-user@example.com',
  copierPnl: 12.5,
  copierInvested: 100,
  copyDurationDays: 3,
  dedupeHash: 'copier-1',
  raw: { privateId: 'private-1' },
}

function executor(response: Record<string, unknown> = {}) {
  const query = jest.fn(async () => ({
    rows: [
      {
        publication_id: 9001,
        published_at: '2026-08-04 10:00:01+00',
        parsed_row_count: 1,
        replayed: false,
        ...response,
      },
    ],
    rowCount: 1,
  }))
  return { query, transaction: { query } as IngestQueryExecutor }
}

describe('copier snapshot transaction publisher', () => {
  it('calls only the database authority function with a private exact projection', async () => {
    const { query, transaction } = executor()

    await expect(
      publishCopierSnapshotInTransaction(transaction, {
        artifact,
        rawReceipt,
        rows: [copierRow],
      })
    ).resolves.toEqual({
      publicationId: 9001,
      publishedAt: '2026-08-04 10:00:01+00',
      parsedRowCount: 1,
      replayed: false,
    })

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]
    expect(String(sql)).toContain('FROM arena.publish_copier_snapshot(')
    expect(String(sql)).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/)
    expect(values).toEqual([
      34,
      101,
      'tier_c',
      7001,
      rawReceipt.storagePath,
      sourceRunId,
      artifact.observed_at,
      false,
      1,
      null,
      JSON.stringify([
        {
          row_ordinal: 0,
          source_event_at: null,
          copier_label: copierRow.copierLabel,
          copier_pnl: copierRow.copierPnl,
          copier_invested: copierRow.copierInvested,
          copy_duration_days: copierRow.copyDurationDays,
          dedupe_hash: copierRow.dedupeHash,
        },
      ]),
    ])
    expect(String(values[10])).not.toContain('privateId')
    expect(String(values[10])).not.toContain(copierRow.ts)
  })

  it('allows an evidence-backed empty parsed snapshot', async () => {
    const { query, transaction } = executor({ parsed_row_count: 0 })
    await expect(
      publishCopierSnapshotInTransaction(transaction, { artifact, rawReceipt, rows: [] })
    ).resolves.toMatchObject({ parsedRowCount: 0 })
    expect(JSON.parse(String(query.mock.calls[0][1][10]))).toEqual([])
  })

  it('accepts an exact replay receipt', async () => {
    const { transaction } = executor({ replayed: true })
    await expect(
      publishCopierSnapshotInTransaction(transaction, {
        artifact,
        rawReceipt,
        rows: [copierRow],
      })
    ).resolves.toMatchObject({ publicationId: 9001, replayed: true })
  })

  it.each([
    [
      'mixed row kind',
      {
        ...copierRow,
        kind: 'orders',
        orderKind: 'close_long',
        symbol: 'BTCUSDT',
        side: 'long',
        price: 1,
        qty: 1,
      },
      'row kind does not match copiers',
    ],
    ['duplicate dedupe', copierRow, 'duplicate copier dedupe hash'],
    ['blank label', { ...copierRow, copierLabel: ' ' }, 'copier label is not canonical'],
    ['negative invested', { ...copierRow, copierInvested: -1 }, 'must be nonnegative'],
    ['NaN PnL', { ...copierRow, copierPnl: Number.NaN }, 'finite canonical number'],
    ['negative zero PnL', { ...copierRow, copierPnl: -0 }, 'finite canonical number'],
    ['fractional duration', { ...copierRow, copyDurationDays: 1.5 }, 'nonnegative integer'],
  ])('rejects %s before any query', async (_label, row, message) => {
    const { query, transaction } = executor()
    const rows = _label === 'duplicate dedupe' ? [copierRow, row] : [row]
    await expect(
      publishCopierSnapshotInTransaction(transaction, {
        artifact,
        rawReceipt,
        rows: rows as ParsedHistoryRow[],
      })
    ).rejects.toThrow(message)
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    ['bad id', { ...rawReceipt, id: 0 }],
    ['bad hash', { ...rawReceipt, contentHash: 'f'.repeat(64) }],
    ['bad path', { ...rawReceipt, storagePath: `${rawReceipt.storagePath}.other` }],
  ])('rejects %s RAW receipt before any query', async (_label, receipt) => {
    const { query, transaction } = executor()
    await expect(
      publishCopierSnapshotInTransaction(transaction, {
        artifact,
        rawReceipt: receipt,
        rows: [copierRow],
      })
    ).rejects.toThrow('RAW receipt')
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    ['no receipt', { rows: [] }],
    ['wrong count', { parsed_row_count: 2 }],
    ['bad publication id', { publication_id: 0 }],
    ['bad published clock', { published_at: 'not-a-date' }],
    ['bad replay flag', { replayed: 'false' }],
  ])('rejects database response with %s', async (_label, response) => {
    const { query, transaction } = executor(response)
    if (_label === 'no receipt') query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await expect(
      publishCopierSnapshotInTransaction(transaction, {
        artifact,
        rawReceipt,
        rows: [copierRow],
      })
    ).rejects.toThrow('publication')
  })
})
