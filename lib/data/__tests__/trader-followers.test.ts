jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn() },
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { getTraderArenaFollowersCount } from '../trader-followers'

describe('single trader account follower count', () => {
  it('filters by both trader id and source', async () => {
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
    }
    query.select.mockReturnValue(query)
    query.eq.mockReturnValueOnce(query).mockResolvedValueOnce({ count: 3 })
    const client = {
      from: jest.fn().mockReturnValue(query),
    } as unknown as SupabaseClient

    await expect(getTraderArenaFollowersCount(client, 'shared-id', 'bybit')).resolves.toBe(3)
    expect(query.eq).toHaveBeenNthCalledWith(1, 'trader_id', 'shared-id')
    expect(query.eq).toHaveBeenNthCalledWith(2, 'source', 'bybit')
  })

  it('does not query an incomplete identity', async () => {
    const from = jest.fn()
    const client = { from } as unknown as SupabaseClient

    await expect(getTraderArenaFollowersCount(client, 'shared-id', '')).resolves.toBe(0)
    expect(from).not.toHaveBeenCalled()
  })
})
