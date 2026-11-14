/** @jest-environment node */

type Result = Record<string, unknown>
const calls: Array<{ op: string; args: unknown[] }> = []
let results: Result[] = []

/** Chainable + awaitable query stub; each from() consumes the next result. */
function query(result: Result) {
  const builder: Record<string, unknown> = {}
  for (const op of ['select', 'eq', 'order', 'insert', 'update']) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ op, args })
      return builder
    }
  }
  builder.single = async () => result
  builder.maybeSingle = async () => result
  builder.then = (resolve: (value: unknown) => void) => resolve(result)
  return builder
}
const mockSupabase = { from: jest.fn(() => query(results.shift() ?? { data: null, error: null })) }

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
    handler({ user: { id: 'user-1' }, supabase: mockSupabase, request }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { GET, PATCH, POST } from '../route'

const request = (body?: unknown) =>
  new Request('http://localhost/api/user/api-keys', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never
const dbError = { message: 'db down', code: 'XX000' }
const eqFilters = () => calls.filter((c) => c.op === 'eq').map((c) => c.args)

describe('/api/user/api-keys', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    calls.length = 0
    results = []
  })

  it('lists only the caller’s keys and masks the secret', async () => {
    results = [
      {
        data: [{ id: 'k1', name: 'Bot', key: 'arena_sk_0123456789abcdef0123456789abcdef' }],
        error: null,
      },
    ]

    const response = await GET(request())
    const body = await response.json()

    expect(eqFilters()).toEqual([['user_id', 'user-1']])
    expect(body.data[0].key).toBe('arena_s...cdef')
    expect(JSON.stringify(body)).not.toContain('0123456789abcdef0123456789abcdef')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('creates a key for the caller and returns the full secret once', async () => {
    results = [
      { count: 2, error: null },
      { data: { id: 'k2', name: 'My bot', key: 'arena_sk_new' }, error: null },
    ]

    const response = await POST(request({ name: '  My bot  ' }))

    expect(response.status).toBe(201)
    const insert = calls.find((c) => c.op === 'insert')?.args[0] as Record<string, unknown>
    expect(insert).toMatchObject({
      user_id: 'user-1',
      name: 'My bot',
      tier: 'free',
      daily_limit: 100,
    })
    expect(insert.key).toMatch(/^arena_sk_[0-9a-f]{32}$/)
  })

  it('enforces the active-key limit', async () => {
    results = [{ count: 5, error: null }]

    const response = await POST(request({}))

    expect(response.status).toBe(400)
    expect(calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('does not skip the limit when the count query fails', async () => {
    results = [{ count: null, error: dbError }]

    const response = await POST(request({}))

    expect(response.status).toBe(500)
    expect(calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it.each([['null'], ['[]'], ['"text"']])(
    'treats a %s body as empty instead of crashing',
    async (raw) => {
      results = [
        { count: 0, error: null },
        { data: { id: 'k3', name: 'Default', key: 'arena_sk_new' }, error: null },
      ]

      const response = await POST(
        new Request('http://localhost/api/user/api-keys', { method: 'POST', body: raw }) as never
      )

      expect(response.status).toBe(201)
      expect((calls.find((c) => c.op === 'insert')?.args[0] as { name: string }).name).toBe(
        'Default'
      )
    }
  )

  it('revokes only a key the caller owns', async () => {
    results = [{ data: { id: 'k1' }, error: null }]

    const response = await PATCH(request({ id: 'k1' }))

    expect(response.status).toBe(200)
    expect(eqFilters()).toEqual([
      ['id', 'k1'],
      ['user_id', 'user-1'],
    ])
  })

  it('distinguishes a missing key from a database failure when revoking', async () => {
    results = [{ data: null, error: null }]
    expect((await PATCH(request({ id: 'someone-elses' }))).status).toBe(404)

    results = [{ data: null, error: dbError }]
    expect((await PATCH(request({ id: 'k1' }))).status).toBe(500)

    expect((await PATCH(request({}))).status).toBe(400)
  })
})
