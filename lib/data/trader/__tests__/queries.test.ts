/**
 * trader/queries.ts — safeQuery wrapper tests
 *
 * Validates the safeQuery helper that converts Supabase query results
 * into DataResult, handling known non-fatal errors gracefully.
 */

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

import { getLeaderboard, safeQuery, withTimeout } from '../queries'

function chainableQuery() {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'not', 'or', 'gt', 'gte', 'order', 'range']) {
    query[method] = jest.fn(() => query)
  }
  query.abortSignal = jest.fn().mockResolvedValue({ data: [], error: null })
  query.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
  return query
}

describe('safeQuery', () => {
  it('successful query → { ok: true, data: result }', async () => {
    const result = await safeQuery(async () => ({
      data: { id: 1, name: 'test' },
      error: null,
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ id: 1, name: 'test' })
    }
  })

  it('successful query returning null data → { ok: true, data: null }', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: null,
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error 42P01 (table not exist) → { ok: true, data: null } (graceful)', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { code: '42P01', message: 'relation "foo" does not exist' },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error "does not exist" message → { ok: true, data: null } (graceful)', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { message: 'table does not exist' },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error "relation" in message → { ok: true, data: null } (graceful)', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { message: 'relation "trader_snapshots_v3" not found' },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error (other) → { ok: false, error: message }', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('duplicate key value violates unique constraint')
    }
  })

  it('query error with no message → { ok: false, error: "Unknown query error" }', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { code: '99999' },
    }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Unknown query error')
    }
  })

  it('unexpected exception (Error) → { ok: false, error: message }', async () => {
    const result = await safeQuery(async () => {
      throw new Error('connection timeout')
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('connection timeout')
    }
  })

  it('unexpected exception (string) → { ok: false, error: message }', async () => {
    const result = await safeQuery(async () => {
      throw 'some string error'
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Unexpected query error')
    }
  })
})

describe('withTimeout', () => {
  it('resolves before timeout → returns result', async () => {
    const result = await withTimeout(Promise.resolve('hello'), 5000)
    expect(result).toBe('hello')
  })

  it('exceeds timeout → rejects with timeout error', async () => {
    const slowPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve('too late'), 5000)
    )
    await expect(withTimeout(slowPromise, 10)).rejects.toThrow('Query timeout after 10ms')
  })
})

describe('getLeaderboard source exclusion', () => {
  it('applies an exclusion before the finite DB page even with a platform filter', async () => {
    const leaderboardQuery = chainableQuery()
    const countQuery = chainableQuery()
    const signal = new AbortController().signal
    const supabase = {
      from: jest.fn((table: string) =>
        table === 'leaderboard_ranks' ? leaderboardQuery : countQuery
      ),
    }

    await getLeaderboard(supabase as never, {
      period: '90D',
      platform: 'binance_futures',
      excludeSources: ['okx_web3_solana'],
      limit: 20,
      signal,
    })

    expect(leaderboardQuery.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
    expect(leaderboardQuery.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(leaderboardQuery.range).toHaveBeenCalledWith(0, 19)
    expect(leaderboardQuery.abortSignal).toHaveBeenCalledWith(signal)
    expect(countQuery.abortSignal).toHaveBeenCalledWith(signal)
    expect(leaderboardQuery.not.mock.invocationCallOrder[0]).toBeLessThan(
      leaderboardQuery.range.mock.invocationCallOrder[0]
    )
  })

  it.each(['okx_web3_solana', 'bitget_bots_futures', 'bitget_bots_spot'])(
    'does not query quarantined platform %s',
    async (platform) => {
      const from = jest.fn()
      const result = await getLeaderboard({ from } as never, { platform })
      expect(result).toEqual({ traders: [], total: 0 })
      expect(from).not.toHaveBeenCalled()
    }
  )
})
