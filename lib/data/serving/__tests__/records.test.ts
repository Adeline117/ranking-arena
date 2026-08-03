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
    expect(
      sanitizeRecordRow({
        symbol: 'BTCUSDT',
        realized_pnl: 12,
        copier_label: 'ku****j@***.com',
        copierLabel: 'x',
        email: 'a@b.c',
        user_id: '123',
      })
    ).toEqual({ symbol: 'BTCUSDT', realized_pnl: 12 })
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
      provenance: { source: 'bitget_futures', asOf: '2026-06-10T12:00:00Z' },
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
    expect(page!.rows).toEqual([
      { symbol: 'BTCUSDT', realized_pnl: 10 },
      { symbol: 'ETHUSDT', realized_pnl: -3 },
    ])
    expect(page!.nextCursor).toBe('2026-06-01 00:00:00+00|abc')
    expect(page!.cacheState).toBe('warm')
    expect(page!.provenance).toEqual({ source: 'bitget_futures', asOf: '2026-06-10T12:00:00Z' })
    // The current RPC does not join the served rows to RAW terminal evidence;
    // a self-asserted completeness field must therefore fail closed.
    expect(page!.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })
  })

  it('does not attach history completeness to non-history record kinds', async () => {
    const page = await getRecordsPage(
      rpcClient({ rows: [], nextCursor: null, asOf: '2026-06-10T12:00:00Z' }),
      'bitget_futures',
      'abc',
      'orders',
      null
    )
    expect(page!.completeness).toBeUndefined()
  })

  it('returns null for unknown traders (RPC NULL) and on error', async () => {
    expect(await getRecordsPage(rpcClient(null), 's', 't', 'orders', null)).toBeNull()
    expect(
      await getRecordsPage(rpcClient(null, { message: 'x' }), 's', 't', 'orders', null)
    ).toBeNull()
  })
})

describe('recordsPageFromTierC', () => {
  it('maps Tier-C position history as a non-pageable partial preview', () => {
    const page = recordsPageFromTierC('bitget_futures', 'position_history', {
      rows: [{ symbol: 'BTCUSDT', copier_label: 'leak' }],
      nextCursor: 'must-not-escape',
      asOf: '2026-06-10T12:00:00Z',
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
  })
})
