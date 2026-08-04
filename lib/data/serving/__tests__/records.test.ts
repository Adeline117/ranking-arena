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

function rpcClient(data: unknown, error: unknown = null): SupabaseClient {
  return { rpc: jest.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient
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

  it('fails the whole copier histogram closed and rejects non-finite aggregate values', async () => {
    const aggregate = await getCopierAggregate(
      rpcClient({
        copierCount: Number.NaN,
        copierCountMax: 20,
        totalCopierPnl: Number.POSITIVE_INFINITY,
        currency: 'USDT',
        depth: 'full',
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
      copierCount: null,
      copierCountMax: 20,
      totalCopierPnl: null,
      pnlDistribution: [],
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
  })

  it.each([
    ['a non-record entry', [null, { bucket: '0~1000', count: 10 }]],
    ['an unknown bucket', [{ bucket: 'private@example.invalid', count: 10 }]],
    [
      'a bucket below the privacy floor',
      [
        { bucket: '0~1000', count: 4 },
        { bucket: '>10000', count: 10 },
      ],
    ],
    [
      'a duplicate bucket',
      [
        { bucket: '0~1000', count: 5 },
        { bucket: '0~1000', count: 5 },
      ],
    ],
    ['a cohort below the privacy floor', [{ bucket: '0~1000', count: 5 }]],
    ['an unsafe count', [{ bucket: '0~1000', count: Number.MAX_SAFE_INTEGER + 1 }]],
    [
      'a fractional count',
      [
        { bucket: '0~1000', count: 5.5 },
        { bucket: '>10000', count: 5 },
      ],
    ],
    ['an unknown field', [{ bucket: '0~1000', count: 10, copierLabel: 'private@example.invalid' }]],
  ])('fails the entire histogram closed for %s', async (_reason, pnlDistribution) => {
    const aggregate = await getCopierAggregate(
      rpcClient({
        copierCount: 20,
        totalCopierPnl: 12,
        currency: 'USDT',
        depth: 'full',
        pnlDistribution,
      }),
      'bitget_futures',
      'abc'
    )

    expect(aggregate).not.toBeNull()
    expect(aggregate?.pnlDistribution).toEqual([])
  })

  it('getCopierAggregate returns aggregate-only fields', async () => {
    const aggregate = await getCopierAggregate(
      rpcClient({
        copierCount: 28,
        copierCountMax: null,
        totalCopierPnl: 900.5,
        currency: 'USDT',
        depth: 'full',
        asOf: '2026-06-10T12:00:00Z',
        pnlDistribution: [
          { bucket: '>10000', count: 5 },
          { bucket: '0~1000', count: 18 },
          { bucket: '<-1000', count: 5 },
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
        { bucket: '<-1000', count: 5 },
        { bucket: '0~1000', count: 18 },
        { bucket: '>10000', count: 5 },
      ],
      depth: 'full',
      provenance: {
        source: 'bitget_futures',
        sourceAsOf: null,
        observedAt: null,
        publishedAt: null,
      },
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
    // The serialized aggregate must contain no copier identifiers anywhere.
    expect(JSON.stringify(aggregate)).not.toMatch(/copier_label|copierLabel|email/)
  })

  it.each([undefined, 'BTC', 'usdt'])(
    'does not invent a copier PnL unit for %s currency',
    async (currency) => {
      const aggregate = await getCopierAggregate(
        rpcClient({
          copierCount: 10,
          totalCopierPnl: 12,
          currency,
          depth: 'full',
          pnlDistribution: [
            { bucket: '>10000', count: 5 },
            { bucket: '<-1000', count: 5 },
          ],
        }),
        'bitget_futures',
        'abc'
      )

      expect(aggregate?.totalCopierPnl).toBeNull()
      expect(aggregate?.pnlDistribution).toEqual([])
    }
  )

  it.each(['full', 'top10', 'top3_preview'] as const)(
    'rejects a syntactically valid but evidence-free %s aggregate shell',
    async (depth) => {
      const aggregate = await getCopierAggregate(
        rpcClient({
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
  it('fails closed over legacy warm position history until a receipt-bound projection exists', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [
          { symbol: 'BTCUSDT', realized_pnl: 10, copier_label: 'leak-me' },
          { symbol: 'ETHUSDT', realized_pnl: -3 },
        ],
        nextCursor: '2026-06-01 00:00:00+00|abc',
        asOf: '2026-06-10T12:00:00Z',
        currency: 'USDT',
        completeness: {
          state: 'complete',
          reason: 'verified_terminal_history',
          evidenceState: 'verified',
          scanTerminalState: 'exhausted',
          blockerReasons: [],
        },
      }),
      'bitget_futures',
      'abc',
      'position_history',
      null
    )
    expect(page).not.toBeNull()
    expect(page!.rows).toEqual([])
    expect(page!.nextCursor).toBeNull()
    expect(page!.cacheState).toBe('warm')
    // Legacy `asOf` was often the RPC's now(); it is intentionally ignored.
    expect(page!.provenance).toEqual({
      source: 'bitget_futures',
      sourceAsOf: null,
      observedAt: null,
      publishedAt: null,
    })
    // The current RPC does not join the served rows to RAW terminal evidence;
    // a self-asserted completeness field must therefore fail closed.
    expect(page!.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
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

    expect(page!.provenance).toEqual({
      source: 'bitget_futures',
      sourceAsOf: '2026-06-10T11:00:00Z',
      observedAt: '2026-06-10T12:00:00Z',
      publishedAt: '2026-06-10T12:01:00Z',
    })
    expect(page!.completeness).toBeUndefined()
  })

  it('does not synthesize current time for missing or invalid provenance', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [],
        sourceAsOf: 'not-a-time',
        observedAt: ' 2026-06-10T12:00:00Z',
        publishedAt: 123,
      }),
      'bitget_futures',
      'abc',
      'orders',
      null
    )

    expect(page!.provenance).toEqual({
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
  it('maps Tier-C position history as a non-pageable partial preview', () => {
    const page = recordsPageFromTierC('bitget_futures', 'position_history', {
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
    expect(page!.cacheState).toBe('cold-fetched')
    expect(page!.rows).toEqual([
      {
        ...EMPTY_POSITION_HISTORY_ROW,
        symbol: 'BTCUSDT',
      },
    ])
    expect(page!.nextCursor).toBeNull()
    expect(page!.provenance).toEqual({
      source: 'bitget_futures',
      sourceAsOf: null,
      observedAt: '2026-06-10T12:00:00Z',
      publishedAt: null,
    })
    expect(page!.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
      evidenceState: 'caller_limited',
      scanTerminalState: 'partial',
      blockerReasons: ['caller_limit'],
    })
  })

  it('keeps legacy, contradictory, or inapplicable complete Tier-C history partial', () => {
    const oldPage = recordsPageFromTierC('bitget_futures', 'position_history', { rows: [] })
    const forgedComplete = recordsPageFromTierC('bitget_futures', 'position_history', {
      rows: [],
      completeness: {
        state: 'complete',
        reason: 'interactive_preview',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
      },
    })
    const validButInapplicableComplete = recordsPageFromTierC('bitget_futures', 'orders', {
      rows: [],
      completeness: {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    })

    expect(oldPage!.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
    })
    expect(forgedComplete!.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
    })
    expect(validButInapplicableComplete!.completeness).toEqual({
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
})
