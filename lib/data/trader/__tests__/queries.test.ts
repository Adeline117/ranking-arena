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

import { safeQuery, withTimeout } from '../queries'

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
    const result = await withTimeout(
      Promise.resolve('hello'),
      5000
    )
    expect(result).toBe('hello')
  })

  it('exceeds timeout → rejects with timeout error', async () => {
    const slowPromise = new Promise<string>(resolve =>
      setTimeout(() => resolve('too late'), 5000)
    )
    await expect(
      withTimeout(slowPromise, 10)
    ).rejects.toThrow('Query timeout after 10ms')
  })
})
