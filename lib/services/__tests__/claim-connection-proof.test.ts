import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { claimConnectionExchange, hasVerifiedClaimConnection } from '../claim-connection-proof'

function clientResult(data: unknown, error: unknown = null) {
  const builder: Record<string, jest.Mock> = {}
  builder.select = jest.fn(() => builder)
  builder.eq = jest.fn(() => builder)
  builder.maybeSingle = jest.fn().mockResolvedValue({ data, error })
  const from = jest.fn(() => builder)
  return { client: { from } as unknown as SupabaseClient<Database>, from, builder }
}

describe('claim connection proof', () => {
  it.each([
    ['binance_futures', 'binance'],
    ['BYBIT_SPOT', 'bybit'],
    [' okx ', 'okx'],
    ['gate', 'gate'],
  ])('maps leaderboard source %s to connection exchange %s', (source, expected) => {
    expect(claimConnectionExchange(source)).toBe(expected)
  })

  it('accepts only an active exact-UID proof with recorded read-only scope', async () => {
    const { client, from, builder } = clientResult({
      verified_uid: 'trader-1',
      last_verified_at: '2026-07-16T10:00:00.000Z',
      scope_permissions: ['read_only'],
    })

    await expect(
      hasVerifiedClaimConnection(client, 'user-1', 'binance_futures', 'trader-1')
    ).resolves.toBe(true)

    expect(from).toHaveBeenCalledWith('user_exchange_connections')
    expect(builder.select).toHaveBeenCalledWith('verified_uid, last_verified_at, scope_permissions')
    expect(builder.eq).toHaveBeenNthCalledWith(1, 'user_id', 'user-1')
    expect(builder.eq).toHaveBeenNthCalledWith(2, 'exchange', 'binance')
    expect(builder.eq).toHaveBeenNthCalledWith(3, 'is_active', true)
  })

  it.each([
    [
      {
        verified_uid: 'somebody-else',
        last_verified_at: '2026-07-16T10:00:00.000Z',
        scope_permissions: ['read'],
      },
      'UID mismatch',
    ],
    [
      { verified_uid: 'trader-1', last_verified_at: null, scope_permissions: ['read'] },
      'missing verification time',
    ],
    [
      {
        verified_uid: 'trader-1',
        last_verified_at: '2026-07-16T10:00:00.000Z',
        scope_permissions: [],
      },
      'empty scope proof',
    ],
    [
      {
        verified_uid: 'trader-1',
        last_verified_at: '2026-07-16T10:00:00.000Z',
        scope_permissions: { read: true },
      },
      'non-array scope proof',
    ],
    [null, 'missing connection'],
  ])('rejects an invalid connection proof: %s (%s)', async (connection) => {
    const { client } = clientResult(connection)

    await expect(
      hasVerifiedClaimConnection(client, 'user-1', 'binance_futures', 'trader-1')
    ).resolves.toBe(false)
  })

  it('propagates connection lookup failures instead of treating them as proof', async () => {
    const queryError = { code: 'XX000', message: 'database unavailable' }
    const { client } = clientResult(null, queryError)

    await expect(
      hasVerifiedClaimConnection(client, 'user-1', 'binance_futures', 'trader-1')
    ).rejects.toBe(queryError)
  })
})
