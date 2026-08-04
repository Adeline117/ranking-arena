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
        '"sourceFactId":"internal-id","source_fact_id":"internal-id",' +
        '"sourceLifecycleMarker":"closed","source_lifecycle_marker":"closed",' +
        '"fieldSources":{"symbol":"data[].symbol"},"field_sources":{},' +
        '"limitations":[],"sourceReturn":0.12,"source_return":0.12,' +
        '"raw":{"email":"nested@secret.invalid"},"__proto__":{"polluted":true},' +
        '"prototype":{"polluted":true},"constructor":{"polluted":true}}'
    ) as Record<string, unknown>

    expect(sanitizeRecordRow(row)).toEqual({
      symbol: 'BTCUSDT',
      realized_pnl: 12,
      sourceReturn: 0.12,
      source_return: 0.12,
    })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
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
        sourceAsOf: '2026-06-10T11:00:00Z',
        observedAt: '2026-06-10T12:00:00Z',
        publishedAt: '2026-06-10T12:01:00Z',
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
        sourceAsOf: '2026-06-10T11:00:00Z',
        observedAt: '2026-06-10T12:00:00Z',
        publishedAt: '2026-06-10T12:01:00Z',
      },
    })
    // The serialized aggregate must contain no copier identifiers anywhere.
    expect(JSON.stringify(aggregate)).not.toMatch(/copier_label|copierLabel|email/)
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
      { symbol: 'BTCUSDT', realized_pnl: 10, source_return: 0.1 },
      { symbol: 'ETHUSDT', realized_pnl: -3 },
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

  it.each(['orders', 'transfers'] as const)(
    'does not attach position-history completeness to %s',
    async (kind) => {
      const page = await getRecordsPage(
        rpcClient({ rows: [{ id: 1 }], nextCursor: 'next' }),
        'bitget_futures',
        'abc',
        kind,
        null
      )
      expect(page?.rows).toEqual([{ id: 1 }])
      expect(page?.nextCursor).toBe('next')
      expect(page?.completeness).toBeUndefined()
    }
  )

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
    ['missing publication clock', { publishedAt: null }],
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

      expect(page).toMatchObject({
        cacheState: 'cold-fetched',
        rows: [{ symbol: 'BTCUSDT' }],
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

  it('keeps current-position pagination and ignores history metadata', () => {
    const page = recordsPageFromTierC('bitget_futures', 'positions', {
      rows: [],
      nextCursor: 'positions-next',
      completeness: {
        state: 'partial',
        reason: 'interactive_preview',
      },
    })

    expect(page?.nextCursor).toBe('positions-next')
    expect(page?.completeness).toBeUndefined()
  })

  it.each(['orders', 'transfers'] as const)(
    'keeps %s pagination and ignores position-history metadata',
    (kind) => {
      const page = recordsPageFromTierC('bitget_futures', kind, {
        rows: [{ id: 1 }],
        nextCursor: `${kind}-next`,
        completeness: { state: 'partial', reason: 'interactive_preview' },
      })
      expect(page?.nextCursor).toBe(`${kind}-next`)
      expect(page?.completeness).toBeUndefined()
    }
  )

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

  it('strips position claim metadata but retains verified economic return fields', () => {
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
    expect(page?.rows).toEqual([{ symbol: 'BTCUSDT', sourceReturn: 0.4, source_return: 0.4 }])
  })
})
