/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    warn: jest.fn(),
  }),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { applyArenaFollowers } from '../scoring-helpers'

function scored(source: string, traderId = 'shared-id') {
  return {
    source,
    source_trader_id: traderId,
    followers: 999,
  }
}

describe('applyArenaFollowers account identity', () => {
  it('keeps the same raw trader id separate across exchanges', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { trader_id: 'shared-id', source: 'bybit', cnt: 2 },
        { trader_id: 'shared-id', source: 'binance', cnt: 1 },
      ],
      error: null,
    })
    const supabase = { rpc } as unknown as SupabaseClient
    const rows = [scored('bybit'), scored('binance')]

    const result = await applyArenaFollowers(supabase, rows, '90D')

    expect(rpc).toHaveBeenCalledWith('count_trader_account_followers', {
      p_trader_ids: ['shared-id', 'shared-id'],
      p_sources: ['bybit', 'binance'],
    })
    expect(rows.map((row) => row.followers)).toEqual([2, 1])
    expect(result).toEqual({ applied: 2, uniqueAccounts: 2 })
  })

  it('falls back on a returned RPC error and filters the query cross-product', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'schema cache stale' },
    })
    const query = {
      select: jest.fn(),
      in: jest.fn(),
      range: jest.fn(),
    }
    query.select.mockReturnValue(query)
    query.in.mockReturnValue(query)
    query.range.mockResolvedValue({
      data: [
        { trader_id: 'shared-id', source: 'bybit' },
        { trader_id: 'shared-id', source: 'bybit' },
        { trader_id: 'shared-id', source: 'binance' },
      ],
      error: null,
    })
    const supabase = {
      rpc,
      from: jest.fn().mockReturnValue(query),
    } as unknown as SupabaseClient
    const rows = [scored('bybit')]

    const result = await applyArenaFollowers(supabase, rows, '30D')

    expect(rows[0].followers).toBe(2)
    expect(result).toEqual({ applied: 1, uniqueAccounts: 1 })
  })

  it('paginates fallback counts without merging a reused id across sources', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'RPC unavailable' },
    })
    const firstPage = Array.from({ length: 1000 }, () => ({
      trader_id: 'shared-id',
      source: 'bybit',
    }))
    const query = {
      select: jest.fn(),
      in: jest.fn(),
      range: jest.fn(),
    }
    query.select.mockReturnValue(query)
    query.in.mockReturnValue(query)
    query.range.mockResolvedValueOnce({ data: firstPage, error: null }).mockResolvedValueOnce({
      data: [{ trader_id: 'shared-id', source: 'binance' }],
      error: null,
    })
    const supabase = {
      rpc,
      from: jest.fn().mockReturnValue(query),
    } as unknown as SupabaseClient
    const rows = [scored('bybit'), scored('binance')]

    await applyArenaFollowers(supabase, rows, '90D')

    expect(query.range).toHaveBeenNthCalledWith(1, 0, 999)
    expect(query.range).toHaveBeenNthCalledWith(2, 1000, 1999)
    expect(rows.map((row) => row.followers)).toEqual([1000, 1])
  })

  it('deduplicates repeated account rows and zeroes invalid identities', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: [], error: null })
    const supabase = { rpc } as unknown as SupabaseClient
    const rows = [scored('bybit'), scored('bybit'), scored('', 'missing-source')]

    const result = await applyArenaFollowers(supabase, rows, '7D')

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ applied: 0, uniqueAccounts: 1 })
    expect(rows.map((row) => row.followers)).toEqual([0, 0, 0])
  })
})
