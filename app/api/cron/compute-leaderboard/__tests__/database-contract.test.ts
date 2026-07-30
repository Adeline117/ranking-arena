/**
 * @jest-environment node
 */

import { assertRankPublicationDatabaseContract } from '../database-contract'

describe('rank publication database contract preflight', () => {
  it('accepts only the expected no-side-effect invalid-argument responses', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'invalid argument' },
    })

    await expect(assertRankPublicationDatabaseContract({ rpc } as never)).resolves.toBeUndefined()
    expect(rpc.mock.calls).toEqual([
      ['rerank_public_eligible_leaderboard', { p_season_id: '__contract_probe__' }],
      ['refresh_public_rank_count_cache_for_seasons', { p_season_ids: [] }],
    ])
  })

  it.each([
    ['missing function', { code: '42883', message: 'function does not exist' }],
    ['stale PostgREST schema', { code: 'PGRST202', message: 'not in schema cache' }],
    ['permission failure', { code: '42501', message: 'permission denied' }],
    ['unexpected success', null],
  ])('fails closed on %s', async (_label, error) => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error })

    await expect(assertRankPublicationDatabaseContract({ rpc } as never)).rejects.toThrow(
      'eligibility-aware rerank RPC contract unavailable'
    )
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the second contract is unavailable', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid season' } })
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'not in schema cache' },
      })

    await expect(assertRankPublicationDatabaseContract({ rpc } as never)).rejects.toThrow(
      'rank-authoritative count RPC contract unavailable (PGRST202: not in schema cache)'
    )
  })

  it('wraps a transport exception before any mutation can start', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('network unavailable'))

    await expect(assertRankPublicationDatabaseContract({ rpc } as never)).rejects.toThrow(
      'eligibility-aware rerank RPC contract probe threw: network unavailable'
    )
  })
})
