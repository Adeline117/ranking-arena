/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { atomicPlatformCleanup, cleanupStaleRows, rerankAllRows } from '../rerank-cleanup'

const missingFunction = { code: '42883', message: 'function does not exist' }

describe('current leaderboard cohort finalization', () => {
  it('propagates a non-missing-function rerank RPC error', async () => {
    const from = jest.fn()
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    })

    await expect(rerankAllRows({ rpc, from } as never, '30D')).rejects.toThrow(
      '[30D] required eligibility-aware rerank RPC failed (42501): permission denied'
    )
    expect(rpc).toHaveBeenCalledWith('rerank_public_eligible_leaderboard', {
      p_season_id: '30D',
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('propagates a thrown rerank RPC call', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('network unavailable'))

    await expect(rerankAllRows({ rpc } as never, '7D')).rejects.toThrow(
      '[7D] rerank RPC threw: network unavailable'
    )
  })

  it.each([null, -1, 1.5, '3'])('rejects an unverifiable rerank RPC result: %p', async (data) => {
    const rpc = jest.fn().mockResolvedValue({ data, error: null })

    await expect(rerankAllRows({ rpc } as never, '7D')).rejects.toThrow(
      '[7D] eligibility-aware rerank RPC returned an invalid result'
    )
  })

  it.each([0, 3])('accepts a non-negative integer rerank RPC result: %p', async (data) => {
    const rpc = jest.fn().mockResolvedValue({ data, error: null })

    await expect(rerankAllRows({ rpc } as never, '90D')).resolves.toBeUndefined()
  })

  it('fails closed without any client-side writes when the required RPC is missing', async () => {
    const from = jest.fn()
    const rpc = jest.fn().mockResolvedValue({ data: null, error: missingFunction })

    await expect(rerankAllRows({ rpc, from } as never, '30D')).rejects.toThrow(
      '[30D] required eligibility-aware rerank RPC failed (42883): function does not exist'
    )
    expect(from).not.toHaveBeenCalled()
  })

  it('fails before cleanup when a fresh platform has no publication-cohort entry', async () => {
    const rpc = jest.fn()

    await expect(
      atomicPlatformCleanup({ rpc } as never, '30D', ['binance_futures'], new Map())
    ).rejects.toThrow(
      '[30D] atomic cleanup missing publication cohort for fresh platform binance_futures'
    )
    expect(rpc).not.toHaveBeenCalled()
  })

  it('passes an explicit empty keep-set to the cleanup RPC', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: 3, error: null })

    await expect(
      atomicPlatformCleanup(
        { rpc } as never,
        '30D',
        ['binance_futures'],
        new Map([['binance_futures', []]])
      )
    ).resolves.toBe(3)
    expect(rpc).toHaveBeenCalledWith('cleanup_stale_platform_rows', {
      p_season_id: '30D',
      p_source: 'binance_futures',
      p_keep_trader_ids: [],
    })
  })

  it('propagates a non-missing-function atomic cleanup RPC error', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    })

    await expect(
      atomicPlatformCleanup(
        { rpc } as never,
        '30D',
        ['binance_futures'],
        new Map([['binance_futures', ['keep']]])
      )
    ).rejects.toThrow('[30D] atomic cleanup RPC failed for binance_futures: permission denied')
  })

  it('propagates a thrown atomic cleanup RPC call', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('connection reset'))

    await expect(
      atomicPlatformCleanup(
        { rpc } as never,
        '7D',
        ['hyperliquid'],
        new Map([['hyperliquid', ['keep']]])
      )
    ).rejects.toThrow('[7D] atomic cleanup RPC threw for hyperliquid: connection reset')
  })

  it('fails closed without client-side deletion when the required cleanup RPC is missing', async () => {
    const from = jest.fn()
    const rpc = jest.fn().mockResolvedValue({ data: null, error: missingFunction })

    await expect(
      atomicPlatformCleanup(
        { rpc, from } as never,
        '30D',
        ['binance_futures'],
        new Map([['binance_futures', ['keep']]])
      )
    ).rejects.toThrow(
      '[30D] atomic cleanup RPC failed for binance_futures: function does not exist'
    )
    expect(from).not.toHaveBeenCalled()
  })

  it('keeps legacy stale-row maintenance best-effort when a query throws', async () => {
    const from = jest.fn(() => {
      throw new Error('maintenance unavailable')
    })

    await expect(cleanupStaleRows({ from } as never, '90D')).resolves.toBe(0)
  })
})
