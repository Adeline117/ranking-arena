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

  it('sanitizeRecordRow strips identifier-ish keys (defense in depth)', () => {
    const row = JSON.parse(
      '{"symbol":"BTCUSDT","realized_pnl":12,"copier_label":"ku****j@***.com",' +
        '"copierLabel":"x","email":"a@b.c","user_id":"123",' +
        '"raw":{"email":"nested@secret.invalid"},"__proto__":{"polluted":true},' +
        '"prototype":{"polluted":true},"constructor":{"polluted":true}}'
    ) as Record<string, unknown>
    const sanitized = sanitizeRecordRow(row)

    expect(sanitized).toEqual({ symbol: 'BTCUSDT', realized_pnl: 12 })
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

    expect(sanitizeRecordRow(row)).toEqual({ symbol: 'BTCUSDT', realized_pnl: 12 })
  })

  it('filters malformed copier distribution entries and non-finite aggregate values', async () => {
    const aggregate = await getCopierAggregate(
      rpcClient({
        copierCount: Number.NaN,
        copierCountMax: -1,
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
      copierCountMax: null,
      totalCopierPnl: null,
      pnlDistribution: [{ bucket: 'valid', count: 2 }],
    })
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
          { bucket: '0~1000', count: 20 },
          { bucket: '>10000', count: 1 },
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
        { bucket: '>10000', count: 1 },
      ],
      depth: 'full',
      provenance: {
        source: 'bitget_futures',
        sourceAsOf: null,
        observedAt: null,
        publishedAt: null,
      },
    })
    // The serialized aggregate must contain no copier identifiers anywhere.
    expect(JSON.stringify(aggregate)).not.toMatch(/copier_label|copierLabel|email/)
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

  it('preserves rows and pagination without attaching history completeness to non-history kinds', async () => {
    const page = await getRecordsPage(
      rpcClient({
        rows: [{ order_id: 'order-1' }],
        nextCursor: 'orders-next',
        asOf: '2026-06-10T12:00:00Z',
      }),
      'bitget_futures',
      'abc',
      'orders',
      null
    )
    expect(page!.rows).toEqual([{ order_id: 'order-1' }])
    expect(page!.nextCursor).toBe('orders-next')
    expect(page!.completeness).toBeUndefined()
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
          { symbol: 'BTCUSDT', raw: { email: 'secret@example.com' } },
          nullPrototype,
        ],
      }),
      'bitget_futures',
      'abc',
      'orders',
      null
    )

    expect(page?.rows).toEqual([{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }])
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
    expect(page!.rows).toEqual([{ symbol: 'BTCUSDT' }])
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

  it('keeps old or contradictory Tier-C position-history payloads partial', () => {
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

    expect(oldPage!.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
    })
    expect(forgedComplete!.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
    })
  })

  it('leaves non-history Tier-C pagination and completeness unchanged', () => {
    const page = recordsPageFromTierC('bitget_futures', 'orders', {
      rows: [],
      nextCursor: 'orders-next',
      completeness: {
        state: 'partial',
        reason: 'interactive_preview',
      },
    })

    expect(page!.nextCursor).toBe('orders-next')
    expect(page!.completeness).toBeUndefined()
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
        { symbol: 'BTCUSDT', raw: { user_id: 'private' }, constructor: 'blocked' },
      ],
    })

    expect(page?.rows).toEqual([{ symbol: 'BTCUSDT' }])
  })
})
