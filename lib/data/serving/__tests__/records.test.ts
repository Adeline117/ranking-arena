/**
 * Records serving tests — keyset page mapping + the spec §6 copier-PII
 * rule, asserted at every layer: SQL text, serializer, aggregate shape.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getRecordsPage,
  getCopierAggregate,
  recordsPageFromTierC,
  sanitizeRecordRow,
} from '../records'
import { COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT } from '../cache-policy'

function rpcClient(data: unknown, error: unknown = null): SupabaseClient {
  return { rpc: jest.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient
}

function verifiedCopierPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    copierCount: 10,
    copierCountMax: null,
    totalCopierPnl: 900.5,
    currency: 'USDT',
    depth: 'full',
    sourceAsOf: null,
    observedAt: '2026-06-10T12:00:00.000Z',
    publishedAt: '2026-06-10T12:01:00.000Z',
    receiptBound: true,
    receiptReaderContract: COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
    receiptId: 77,
    sourceRunId: 'a'.repeat(64),
    evidenceState: 'verified',
    scanTerminalState: 'exhausted',
    blockerReasons: [],
    pnlDistribution: [{ bucket: '0~1000', count: 10 }],
    ...overrides,
  }
}

const EMPTY_ORDER_ROW = {
  ts: null,
  kind: null,
  symbol: null,
  side: null,
  price: null,
  qty: null,
  notional: null,
  realized_pnl: null,
  currency: null,
}

const EMPTY_POSITION_ROW = {
  symbol: null,
  side: null,
  margin_mode: null,
  leverage: null,
  size: null,
  entry_price: null,
  mark_price: null,
  notional: null,
  margin: null,
  unrealized_pnl: null,
  roe: null,
  currency: null,
  as_of: null,
}

const EMPTY_POSITION_HISTORY_ROW = {
  symbol: null,
  side: null,
  margin_mode: null,
  leverage: null,
  size: null,
  entry_price: null,
  exit_price: null,
  max_open_interest: null,
  realized_pnl: null,
  roi: null,
  source_return: null,
  closing_value: null,
  opened_at: null,
  closed_at: null,
  currency: null,
}

const EMPTY_TRANSFER_ROW = {
  ts: null,
  direction: null,
  asset: null,
  amount: null,
}

describe('copier PII rule (spec §6)', () => {
  it('the records RPC SQL hard-blocks the copiers kind and never selects copier_label', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../supabase/migrations/20260611000309_arena_records_rpcs.sql'),
      'utf8'
    )
    expect(sql).toContain("RAISE EXCEPTION 'copier records are aggregate-only")
    // copier_label appears only in prose comments, never as a selected column
    const codeLines = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.includes('copier_label'))
    expect(codeLines).toEqual([])
  })

  it('sanitizeRecordRow allowlists order fields and strips identifier-ish keys', () => {
    const row = JSON.parse(
      '{"ts":"2026-08-03T12:00:00.000Z","symbol":"BTCUSDT","realized_pnl":12,"copier_label":"ku****j@***.com",' +
        '"copierLabel":"x","email":"a@b.c","user_id":"123",' +
        '"sourceFactId":"internal-id","source_fact_id":"internal-id",' +
        '"sourceLifecycleMarker":"closed","source_lifecycle_marker":"closed",' +
        '"fieldSources":{"symbol":"data[].symbol"},"field_sources":{},' +
        '"limitations":[],"sourceReturn":0.12,"source_return":0.12,' +
        '"raw":{"email":"nested@secret.invalid"},"__proto__":{"polluted":true},' +
        '"prototype":{"polluted":true},"constructor":{"polluted":true}}'
    ) as Record<string, unknown>
    const sanitized = sanitizeRecordRow('orders', row)

    expect(sanitized).toEqual({
      ...EMPTY_ORDER_ROW,
      ts: '2026-08-03T12:00:00.000Z',
      symbol: 'BTCUSDT',
      realized_pnl: 12,
    })
    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('sanitizeRecordRow strips claim-substrate provenance the DB path never projects', () => {
    // okx/bitget/binance position-history parsers attach these to every row.
    // arena_records_page builds an explicit column list and omits them, so the
    // Tier-C preview must not advertise a wider row contract than Tier-B.
    const row = JSON.parse(
      '{"symbol":"BTCUSDT","realized_pnl":12,' +
        '"sourceFactId":"[\\"trader\\",\\"row\\"]","source_fact_id":"x",' +
        '"sourceLifecycleMarker":"1730000000000","source_lifecycle_marker":"x",' +
        '"sourceReturn":0.42,"source_return":0.42,' +
        '"fieldSources":{"symbol":"data[].instId"},"field_sources":{},' +
        '"limitations":["source_return_missing"]}'
    ) as Record<string, unknown>

    expect(sanitizeRecordRow('position_history', row)).toEqual({
      ...EMPTY_POSITION_HISTORY_ROW,
      symbol: 'BTCUSDT',
      realized_pnl: 12,
      source_return: 0.42,
    })
  })

  it('rejects missing record identity and never mistakes the parser discriminator for order type', () => {
    expect(sanitizeRecordRow('positions', { side: 'long' })).toBeNull()
    expect(sanitizeRecordRow('orders', { ts: '2026-08', kind: 'limit' })).toBeNull()
    expect(
      sanitizeRecordRow('orders', {
        ts: '2026-08-03T12:00:00Z',
        kind: 'orders',
      })
    ).toEqual({
      ...EMPTY_ORDER_ROW,
      ts: '2026-08-03T12:00:00.000Z',
    })
  })
  it('drops an unbound histogram and non-finite aggregate values', async () => {
    const aggregate = await getCopierAggregate(
      rpcClient({
        receiptReaderContract: COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
        copierCount: 20,
        copierCountMax: -1,
        totalCopierPnl: Number.POSITIVE_INFINITY,
        currency: 'USDT',
        depth: 'full',
        receiptBound: false,
        pnlDistribution: [
          null,
          [],
          'bad',
          { bucket: 'negative', count: -1 },
          { bucket: 'fractional', count: 1.5 },
          { bucket: 'valid', count: 2 },
        ],
      }),
      'bitget_futures',
      'abc'
    )

    expect(aggregate).toMatchObject({
      copierCount: 20,
      copierCountMax: null,
      totalCopierPnl: null,
      pnlDistribution: [],
      receiptBound: false,
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
  })

  it('getCopierAggregate returns aggregate-only fields', async () => {
    const aggregate = await getCopierAggregate(
      rpcClient({
        receiptReaderContract: COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
        copierCount: 28,
        copierCountMax: null,
        totalCopierPnl: 900.5,
        currency: 'USDT',
        depth: 'full',
        sourceAsOf: '2026-06-10T11:00:00Z',
        observedAt: '2026-06-10T12:00:00.000Z',
        publishedAt: '2026-06-10T12:01:00.000Z',
        receiptBound: true,
        receiptId: 77,
        sourceRunId: 'a'.repeat(64),
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
        pnlDistribution: [
          { bucket: '0~1000', count: 20 },
          { bucket: '>10000', count: 8 },
        ],
      }),
      'bitget_futures',
      'abc'
    )
    expect(aggregate).toEqual({
      copierCount: 28,
      copierCountMax: null,
      totalCopierPnl: { value: 900.5, currency: 'USDT' },
      pnlDistribution: [
        { bucket: '0~1000', count: 20 },
        { bucket: '>10000', count: 8 },
      ],
      depth: 'full',
      receiptBound: true,
      provenance: {
        source: 'bitget_futures',
        sourceAsOf: '2026-06-10T11:00:00Z',
        observedAt: '2026-06-10T12:00:00.000Z',
        publishedAt: '2026-06-10T12:01:00.000Z',
      },
      completeness: {
        state: 'complete',
        reason: 'verified_copier_snapshot',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    })
    // The serialized aggregate must contain no copier identifiers anywhere.
    expect(JSON.stringify(aggregate)).not.toMatch(/copier_label|copierLabel|email/)
  })

  it.each([
    ['missing', undefined],
    ['legacy @3', 'arena.copier-snapshot-receipt-reader@3'],
    ['malformed', 'arena.copier-snapshot-receipt-reader@4 '],
  ])('rejects a %s reader marker before accepting receipt-bound values', async (_label, marker) => {
    const aggregate = await getCopierAggregate(
      rpcClient(verifiedCopierPayload({ receiptReaderContract: marker })),
      'bitget_futures',
      'abc'
    )

    expect(aggregate).toBeNull()
  })

  it.each([0, -0])(
    'rejects malformed claimed copier receipt id %p instead of downgrading it',
    async (receiptId) => {
      const aggregate = await getCopierAggregate(
        rpcClient({
          receiptReaderContract: COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
          copierCount: 10,
          currency: 'USDT',
          depth: 'full',
          receiptBound: true,
          receiptId,
          sourceRunId: 'a'.repeat(64),
          evidenceState: 'verified',
          scanTerminalState: 'exhausted',
          blockerReasons: [],
          observedAt: '2026-06-10T12:00:00.000Z',
          publishedAt: '2026-06-10T12:01:00.000Z',
          pnlDistribution: [{ bucket: '0~1000', count: 10 }],
        }),
        'bitget_futures',
        'abc'
      )

      expect(aggregate).toBeNull()
    }
  )

  it.each([undefined, 'BTC', 'usdt'])(
    'fails closed for a receipt-bound aggregate with %s currency',
    async (currency) => {
      const aggregate = await getCopierAggregate(
        rpcClient(
          verifiedCopierPayload({
            copierCount: 10,
            totalCopierPnl: 12,
            currency,
            pnlDistribution: [{ bucket: '0~1000', count: 10 }],
          })
        ),
        'bitget_futures',
        'abc'
      )

      expect(aggregate).toBeNull()
    }
  )

  it.each([
    ['a missing copier count', { copierCount: null }],
    ['a non-full depth', { depth: 'top10' }],
    ['a non-null upper-bound field', { copierCountMax: 10 }],
    [
      'a source freshness clock that @4 never discloses',
      { sourceAsOf: '2026-06-10T11:00:00.000Z' },
    ],
    ['a non-finite PnL', { totalCopierPnl: Number.POSITIVE_INFINITY }],
    ['negative zero PnL', { totalCopierPnl: -0 }],
    ['a nonzero PnL for a measured zero-count snapshot', { copierCount: 0, totalCopierPnl: 1 }],
  ] as const)('fails closed for a receipt-bound aggregate with %s', async (_label, overrides) => {
    const aggregate = await getCopierAggregate(
      rpcClient(verifiedCopierPayload(overrides)),
      'bitget_futures',
      'abc'
    )

    expect(aggregate).toBeNull()
  })

  it('accepts only exact, ordered, k-anonymous bucket projections', async () => {
    const aggregate = await getCopierAggregate(
      rpcClient(
        verifiedCopierPayload({
          copierCount: 15,
          pnlDistribution: [
            { bucket: '<-1000', count: 5 },
            { bucket: '1000~10000', count: 10 },
          ],
        })
      ),
      'bitget_futures',
      'abc'
    )

    expect(aggregate?.pnlDistribution).toEqual([
      { bucket: '<-1000', count: 5 },
      { bucket: '1000~10000', count: 10 },
    ])
  })

  it.each([
    [
      'PII or any third key',
      10,
      [
        { bucket: '<-1000', count: 5 },
        { bucket: '0~1000', count: 5, copierLabel: 'private@example.invalid' },
      ],
    ],
    [
      'an unknown bucket',
      10,
      [
        { bucket: '<-1000', count: 5 },
        { bucket: 'negative', count: 5 },
      ],
    ],
    [
      'a duplicate bucket',
      10,
      [
        { bucket: '0~1000', count: 5 },
        { bucket: '0~1000', count: 5 },
      ],
    ],
    [
      'a bucket below k=5',
      10,
      [
        { bucket: '-1000~0', count: 4 },
        { bucket: '0~1000', count: 6 },
      ],
    ],
    ['a non-empty cohort below 10', 10, [{ bucket: '0~1000', count: 5 }]],
    ['a count above the verified copier count', 9, [{ bucket: '0~1000', count: 10 }]],
    [
      'non-canonical bucket order',
      10,
      [
        { bucket: '0~1000', count: 5 },
        { bucket: '-1000~0', count: 5 },
      ],
    ],
    ['an unsafe integer count', 10, [{ bucket: '0~1000', count: Number.MAX_SAFE_INTEGER + 1 }]],
    ['a fractional count', 10, [{ bucket: '0~1000', count: 10.5 }]],
    ['a negative-zero count', 10, [{ bucket: '0~1000', count: -0 }]],
  ] as const)(
    'drops the entire histogram when it contains %s',
    async (_label, count, histogram) => {
      const aggregate = await getCopierAggregate(
        rpcClient(verifiedCopierPayload({ copierCount: count, pnlDistribution: histogram })),
        'bitget_futures',
        'abc'
      )

      expect(aggregate).not.toBeNull()
      expect(aggregate?.pnlDistribution).toEqual([])
      expect(JSON.stringify(aggregate)).not.toContain('private@example.invalid')
    }
  )

  it('keeps an empty verified histogram valid when every copier PnL is null', async () => {
    const aggregate = await getCopierAggregate(
      rpcClient(
        verifiedCopierPayload({
          copierCount: 12,
          totalCopierPnl: null,
          pnlDistribution: [],
        })
      ),
      'bitget_futures',
      'abc'
    )

    expect(aggregate).toMatchObject({
      copierCount: 12,
      totalCopierPnl: null,
      pnlDistribution: [],
      receiptBound: true,
      completeness: { state: 'complete', reason: 'verified_copier_snapshot' },
    })
  })

  it.each([
    ['full', 'full'],
    ['top10', 'top10'],
    ['top3 preview', 'top3_preview'],
    ['missing-depth', undefined],
    ['invalid-depth', 'unexpected'],
  ] as const)(
    'rejects a syntactically valid but evidence-free %s aggregate shell',
    async (_label, depth) => {
      const aggregate = await getCopierAggregate(
        rpcClient({
          receiptReaderContract: COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
          copierCount: null,
          copierCountMax: null,
          totalCopierPnl: null,
          currency: 'USDT',
          depth,
          pnlDistribution: [],
          copierLabel: 'must-not-turn-the-shell-into-evidence',
          raw: { email: 'private@example.invalid' },
        }),
        'bitget_futures',
        'abc'
      )

      expect(aggregate).toBeNull()
    }
  )

  it('treats measured zero as aggregate evidence and preserves explicit source N/A', async () => {
    const measuredZero = await getCopierAggregate(
      rpcClient({
        receiptReaderContract: COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
        copierCount: 0,
        copierCountMax: 0,
        totalCopierPnl: 0,
        currency: 'USDT',
        depth: 'full',
        pnlDistribution: [],
      }),
      'bitget_futures',
      'zero'
    )
    const notApplicable = await getCopierAggregate(
      rpcClient({
        receiptReaderContract: COPIER_SNAPSHOT_RECEIPT_READER_CONTRACT,
        copierCount: null,
        copierCountMax: null,
        totalCopierPnl: null,
        depth: 'none',
        pnlDistribution: [],
      }),
      'source_without_copiers',
      'n/a'
    )

    expect(measuredZero).toMatchObject({
      copierCount: 0,
      copierCountMax: 0,
      totalCopierPnl: { value: 0, currency: 'USDT' },
      depth: 'full',
    })
    expect(notApplicable).toMatchObject({
      copierCount: null,
      totalCopierPnl: null,
      depth: 'none',
    })
  })
})

describe('getRecordsPage', () => {
  it('maps RPC jsonb to RecordsPage and sanitizes rows', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [
          {
            symbol: 'BTCUSDT',
            realized_pnl: 10,
            source_return: 0.1,
            source_fact_id: 'internal',
            field_sources: { symbol: 'data[].symbol' },
          },
          { symbol: 'ETHUSDT', realized_pnl: -3 },
        ],
        nextCursor: '2026-06-01 00:00:00+00|abc',
        sourceAsOf: null,
        observedAt: '2026-08-03T12:00:00.000Z',
        publishedAt: '2026-08-03T12:00:01.000Z',
        publicationId: 42,
        stateId: 42,
        sourceRunId: 'a'.repeat(64),
        currency: 'USDT',
        completeness: {
          state: 'complete',
          reason: 'verified_terminal_history',
          evidenceState: 'verified',
          scanTerminalState: 'exhausted',
          blockerReasons: [],
          contract: 'arena.position-history-completeness@2',
          publicationId: 42,
        },
      }),
      'bitget_futures',
      'abc',
      'position_history',
      null
    )
    expect(page).not.toBeNull()
    expect(page!.rows).toEqual([
      {
        ...EMPTY_POSITION_HISTORY_ROW,
        symbol: 'BTCUSDT',
        realized_pnl: 10,
        source_return: 0.1,
      },
      { ...EMPTY_POSITION_HISTORY_ROW, symbol: 'ETHUSDT', realized_pnl: -3 },
    ])
    expect(page!.nextCursor).toBe('2026-06-01 00:00:00+00|abc')
    expect(page!.cacheState).toBe('warm')
    expect(page!.provenance).toEqual({
      source: 'bitget_futures',
      sourceAsOf: null,
      observedAt: '2026-08-03T12:00:00.000Z',
      publishedAt: '2026-08-03T12:00:01.000Z',
    })
    expect(page!.completeness).toEqual({
      state: 'complete',
      reason: 'verified_terminal_history',
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
    })
  })

  it('quarantines warm position-history rows and cursors without exact @2 evidence', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [{ symbol: 'must-not-serve', realized_pnl: 99 }],
        nextCursor: 'legacy-cursor',

        asOf: '2026-06-10T12:00:00Z',
      }),
      'bitget_futures',
      'abc',
      'position_history',
      null
    )

    expect(page).toMatchObject({
      rows: [],
      nextCursor: null,
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
  })

  it('preserves warm order rows but marks their unbound history unknown', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [
          {
            ts: '2026-06-10T11:00:00Z',
            kind: 'limit',
            symbol: 'BTCUSDT',
            side: 'buy',
            price: 100,
            qty: 2,
            currency: 'USDT',
            order_id: 'must-not-escape',
          },
        ],
        nextCursor: 'orders-next',
        asOf: '2026-06-10T12:00:00Z',
      }),
      'bitget_futures',
      'abc',
      'orders',
      null
    )

    expect(page!.rows).toEqual([
      {
        ...EMPTY_ORDER_ROW,
        ts: '2026-06-10T11:00:00.000Z',
        kind: 'limit',
        symbol: 'BTCUSDT',
        side: 'buy',
        price: 100,
        qty: 2,
        currency: 'USDT',
      },
    ])
    expect(page!.nextCursor).toBe('orders-next')
    expect(page!.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })
  })

  it('preserves warm transfer rows in asset units and marks their completeness unknown', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [
          {
            ts: '2026-06-10T11:00:00Z',
            direction: 'in',
            asset: 'BTC',
            amount: 0.5,
            currency: 'USDC',
            transfer_id: 'must-not-escape',
          },
        ],
        nextCursor: 'transfers-next',
      }),
      'bitget_futures',
      'abc',
      'transfers',
      null
    )

    expect(page!.rows).toEqual([
      {
        ...EMPTY_TRANSFER_ROW,
        ts: '2026-06-10T11:00:00.000Z',
        direction: 'in',
        asset: 'BTC',
        amount: 0.5,
      },
    ])
    expect(page!.rows[0]).not.toHaveProperty('currency')
    expect(page!.nextCursor).toBe('transfers-next')
    expect(page!.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })
  })

  it('accepts a complete empty position-history page only with an exact publication identity', async () => {
    const sourceRunId = 'a'.repeat(64)
    const page = await getRecordsPage(
      rpcClient({
        rows: [],
        nextCursor: null,
        sourceAsOf: null,
        observedAt: '2026-08-03T12:00:00.000Z',
        publishedAt: '2026-08-03T12:00:01.000Z',
        publicationId: 42,
        stateId: 42,
        sourceRunId,
        completeness: {
          blockerReasons: [],
          contract: 'arena.position-history-completeness@2',
          evidenceState: 'verified',
          publicationId: 42,
          reason: 'verified_terminal_history',
          scanTerminalState: 'exhausted',
          state: 'complete',
        },
      }),
      'bitget_futures',
      'abc',
      'position_history',
      null
    )

    expect(page).toMatchObject({
      rows: [],
      nextCursor: null,
      cacheState: 'warm',
      completeness: {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    })
  })

  it.each([
    ['mismatched state', { stateId: 41 }],
    ['missing source run', { sourceRunId: null }],
    ['malformed source-run SHA', { sourceRunId: 'A'.repeat(64) }],
    ['sentinel zero source-run SHA', { sourceRunId: '0'.repeat(64) }],
    ['missing publication clock', { publishedAt: null }],
    [
      'mismatched verdict publication',
      {
        completeness: {
          blockerReasons: [],
          contract: 'arena.position-history-completeness@2',
          evidenceState: 'verified',
          publicationId: 41,
          reason: 'verified_terminal_history',
          scanTerminalState: 'exhausted',
          state: 'complete',
        },
      },
    ],
  ])('keeps a forged complete verdict unknown when it has %s', async (_label, drift) => {
    const response = {
      rows: [{ symbol: 'forged-row' }],
      nextCursor: 'forged-cursor',
      observedAt: '2026-08-03T12:00:00.000Z',
      publishedAt: '2026-08-03T12:00:01.000Z',
      publicationId: 42,
      stateId: 42,
      sourceRunId: 'a'.repeat(64),
      completeness: {
        blockerReasons: [],
        contract: 'arena.position-history-completeness@2',
        evidenceState: 'verified',
        publicationId: 42,
        reason: 'verified_terminal_history',
        scanTerminalState: 'exhausted',
        state: 'complete',
      },
      ...drift,
    }

    const page = await getRecordsPage(
      rpcClient(response),
      'bitget_futures',
      'abc',
      'position_history',
      null
    )
    expect(page?.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })
    expect(page?.rows).toEqual([])
    expect(page?.nextCursor).toBeNull()
  })

  it('does not attach history completeness to current positions', async () => {
    const page = await getRecordsPage(
      rpcClient({ rows: [], nextCursor: null, asOf: '2026-06-10T12:00:00Z' }),
      'bitget_futures',
      'abc',
      'positions',
      null
    )

    expect(page?.completeness).toBeUndefined()
  })

  it('keeps source, observation, and publication clocks distinct', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [],
        sourceAsOf: '2026-06-10T11:00:00Z',
        observedAt: '2026-06-10T12:00:00Z',
        publishedAt: '2026-06-10T12:01:00Z',
      }),
      'bitget_futures',
      'abc',
      'positions',
      null
    )

    expect(page?.provenance).toEqual({
      source: 'bitget_futures',
      sourceAsOf: '2026-06-10T11:00:00Z',
      observedAt: '2026-06-10T12:00:00Z',
      publishedAt: '2026-06-10T12:01:00Z',
    })
    expect(page!.completeness).toBeUndefined()
  })

  it('does not synthesize request time for missing, legacy, or invalid clocks', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [],
        asOf: '2026-06-10T13:00:00Z',
        sourceAsOf: 'not-a-time',
        observedAt: ' 2026-06-10T12:00:00Z',
        publishedAt: 123,
      }),
      'bitget_futures',
      'abc',
      'orders',
      null
    )

    expect(page?.provenance).toEqual({
      source: 'bitget_futures',
      sourceAsOf: null,
      observedAt: null,
      publishedAt: null,
    })
  })

  it('returns null for unknown traders (RPC NULL) and on error', async () => {
    expect(await getRecordsPage(rpcClient(null), 's', 't', 'orders', null)).toBeNull()
    expect(
      await getRecordsPage(rpcClient(null, { message: 'x' }), 's', 't', 'orders', null)
    ).toBeNull()
    expect(await getRecordsPage(rpcClient([]), 's', 't', 'orders', null)).toBeNull()
  })

  it('drops malformed and internal RAW rows without crashing the warm mapper', async () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      symbol: 'ETHUSDT',
    })
    const page = await getRecordsPage(
      rpcClient({
        rows: [
          null,
          [],
          'not-a-row',
          42,
          new Date('2026-06-10T12:00:00Z'),
          { ts: 'not-a-time', symbol: 'INVALID' },
          {
            ts: '2026-06-10T12:00:00Z',
            symbol: 'BTCUSDT',
            raw: { email: 'secret@example.com' },
          },
          Object.assign(nullPrototype, { ts: '2026-06-10T11:00:00Z' }),
        ],
      }),
      'bitget_futures',
      'abc',
      'orders',
      null
    )

    expect(page?.rows).toEqual([
      {
        ...EMPTY_ORDER_ROW,
        ts: '2026-06-10T12:00:00.000Z',
        symbol: 'BTCUSDT',
      },
      {
        ...EMPTY_ORDER_ROW,
        ts: '2026-06-10T11:00:00.000Z',
        symbol: 'ETHUSDT',
      },
    ])
  })
})

describe('recordsPageFromTierC', () => {
  it.each(['position_history'] as const)(
    'maps Tier-C %s as a non-pageable partial preview',
    (kind) => {
      const page = recordsPageFromTierC('bitget_futures', kind, {
        rows: [{ symbol: 'BTCUSDT', copier_label: 'leak' }],
        nextCursor: 'must-not-escape',
        sourceAsOf: null,
        observedAt: '2026-06-10T12:00:00Z',
        publishedAt: null,
        completeness: {
          state: 'partial',
          reason: 'interactive_preview',
          evidenceState: 'caller_limited',
          scanTerminalState: 'partial',
          blockerReasons: ['caller_limit'],
        },
      })

      expect(page).not.toBeNull()
      expect(page!.rows).toEqual([
        {
          ...EMPTY_POSITION_HISTORY_ROW,
          symbol: 'BTCUSDT',
        },
      ])
      expect(page).toMatchObject({
        cacheState: 'cold-fetched',
        nextCursor: null,
        provenance: {
          source: 'bitget_futures',
          sourceAsOf: null,
          observedAt: '2026-06-10T12:00:00Z',
          publishedAt: null,
        },
        completeness: {
          state: 'partial',
          reason: 'interactive_preview',
          evidenceState: 'caller_limited',
          scanTerminalState: 'partial',
          blockerReasons: ['caller_limit'],
        },
      })
    }
  )

  it.each([
    ['missing metadata', undefined],
    [
      'forged complete metadata',
      {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    ],
    [
      'an invalid evidence enum',
      {
        state: 'partial',
        reason: 'interactive_preview',
        evidenceState: 'trusted_by_worker',
        scanTerminalState: 'partial',
        blockerReasons: ['caller_limit'],
      },
    ],
    [
      'contradictory diagnostics',
      {
        state: 'partial',
        reason: 'interactive_preview',
        evidenceState: 'caller_limited',
        scanTerminalState: 'exhausted',
        blockerReasons: ['caller_limit'],
      },
    ],
    [
      'an incomplete diagnostic group',
      {
        state: 'partial',
        reason: 'interactive_preview',
        evidenceState: 'caller_limited',
      },
    ],
  ])('canonicalizes %s to partial without copying diagnostics', (_label, completeness) => {
    const page = recordsPageFromTierC('bitget_futures', 'position_history', {
      rows: [],
      completeness,
    })

    expect(page?.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
    })
  })

  it('does not accept a complete verdict on a Tier-C append-only preview', () => {
    const page = recordsPageFromTierC('bitget_futures', 'orders', {
      rows: [],
      completeness: {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    })

    expect(page?.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
    })
  })

  it.each(['orders', 'transfers'] as const)(
    'maps Tier-C %s as a non-pageable partial preview',
    (kind) => {
      const page = recordsPageFromTierC('bitget_futures', kind, {
        rows: [],
        nextCursor: 'orders-next',
        completeness: {
          state: 'partial',
          reason: 'interactive_preview',
        },
      })

      expect(page!.nextCursor).toBeNull()
      expect(page!.completeness).toEqual({
        state: 'partial',
        reason: 'interactive_preview',
      })
    }
  )

  it('keeps current positions pageable without attaching history completeness', () => {
    const page = recordsPageFromTierC('bitget_futures', 'positions', {
      rows: [
        {
          symbol: 'BTCUSDT',
          side: 'long',
          entryPrice: 100,
          markPrice: 110,
          unrealizedPnl: 10,
          currency: 'USDT',
          raw: { account: 'private' },
          debug: true,
        },
      ],
      nextCursor: 'positions-next',
      completeness: { state: 'partial', reason: 'interactive_preview' },
    })

    expect(page!.rows).toEqual([
      {
        ...EMPTY_POSITION_ROW,
        symbol: 'BTCUSDT',
        side: 'long',
        entry_price: 100,
        mark_price: 110,
        unrealized_pnl: 10,
        currency: 'USDT',
      },
    ])
    expect(page!.nextCursor).toBe('positions-next')
    expect(page!.completeness).toBeUndefined()
  })

  it('serves transfer amounts only in their asset unit', () => {
    const page = recordsPageFromTierC('gtrade', 'transfers', {
      rows: [
        {
          ts: '2026-08-03T12:00:00Z',
          direction: 'in',
          asset: 'BTC',
          amount: 0.5,
          currency: 'USDC',
        },
      ],
    })

    expect(page!.rows).toEqual([
      {
        ...EMPTY_TRANSFER_ROW,
        ts: '2026-08-03T12:00:00.000Z',
        direction: 'in',
        asset: 'BTC',
        amount: 0.5,
      },
    ])
    expect(page!.rows[0]).not.toHaveProperty('currency')
  })

  it('returns null when the payload has no rows array', () => {
    expect(recordsPageFromTierC('s', 'position_history', { stats: [] })).toBeNull()
    expect(recordsPageFromTierC('s', 'position_history', [])).toBeNull()
  })

  it('drops malformed and internal RAW rows without crashing the Tier-C mapper', () => {
    const page = recordsPageFromTierC('bitget_futures', 'orders', {
      rows: [
        null,
        ['not', 'a', 'row'],
        true,
        {
          ts: '2026-08-03T12:00:00Z',
          kind: 'orders',
          orderKind: 'limit',
          symbol: 'BTCUSDT',
          raw: { user_id: 'private' },
          constructor: 'blocked',
          debug: 'must-not-escape',
        },
      ],
    })

    expect(page?.rows).toEqual([
      {
        ...EMPTY_ORDER_ROW,
        ts: '2026-08-03T12:00:00.000Z',
        kind: 'limit',
        symbol: 'BTCUSDT',
      },
    ])
  })

  it('strips position claim metadata but retains canonical source_return', () => {
    const page = recordsPageFromTierC('bitget_futures', 'position_history', {
      rows: [
        {
          symbol: 'BTCUSDT',
          sourceFactId: 'internal',
          sourceLifecycleMarker: 'closed',
          fieldSources: { symbol: 'data[].symbol' },
          limitations: [],
          sourceReturn: 0.4,
          source_return: 0.4,
        },
      ],
    })
    expect(page?.rows).toEqual([
      {
        ...EMPTY_POSITION_HISTORY_ROW,
        symbol: 'BTCUSDT',
        source_return: 0.4,
      },
    ])
  })
})
