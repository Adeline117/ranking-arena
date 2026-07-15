jest.mock('next/server', () => ({
  NextResponse: class MockNextResponse {
    status: number
    private body: unknown

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }

    async json() {
      return this.body
    }
  },
}))

const mockInsert = jest.fn()
let mockUser: { id: string } | null = null

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (ctx: unknown) => unknown) => (request: unknown) =>
    handler({
      request,
      user: mockUser,
      supabase: { from: () => ({ insert: mockInsert }) },
    }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
  logger: { error: jest.fn() },
}))

import { POST } from '../route'

const basePayload = {
  event_id: '123e4567-e89b-42d3-a456-426614174000',
  event_name: 'view_trader',
  anonymous_id: '123e4567-e89b-42d3-a456-426614174001',
  session_id: '123e4567-e89b-42d3-a456-426614174002',
  path: '/trader/alice',
  properties: { source: 'ranking', rank: 3 },
}

function request(payload: Record<string, unknown>) {
  return {
    json: async () => ({ ...payload, occurred_at: new Date().toISOString() }),
  }
}

describe('POST /api/analytics/events', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser = null
    mockInsert.mockResolvedValue({ error: null })
    process.env.ANALYTICS_HASH_SALT = 'test-only-private-salt'
  })

  afterAll(() => {
    delete process.env.ANALYTICS_HASH_SALT
  })

  it('stores hashed anonymous identifiers without persisting raw IDs', async () => {
    mockUser = { id: 'user-123' }

    const response = await POST(request(basePayload) as never)

    expect(response.status).toBe(202)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: basePayload.event_id,
        event_name: 'view_trader',
        user_id: 'user-123',
        anonymous_id_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        session_id_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    )
    const stored = mockInsert.mock.calls[0][0]
    expect(stored.anonymous_id_hash).not.toContain(basePayload.anonymous_id)
    expect(stored.session_id_hash).not.toContain(basePayload.session_id)
  })

  it('rejects event names outside the canonical catalog', async () => {
    const response = await POST(request({ ...basePayload, event_name: 'made_up_event' }) as never)

    expect(response.status).toBe(400)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('treats a duplicate event ID as an idempotent accepted write', async () => {
    mockInsert.mockResolvedValue({ error: { code: '23505', message: 'duplicate' } })

    const response = await POST(request(basePayload) as never)

    expect(response.status).toBe(202)
  })

  it('rejects stale client timestamps', async () => {
    const response = await POST({
      json: async () => ({
        ...basePayload,
        occurred_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }),
    } as never)

    expect(response.status).toBe(400)
    expect(mockInsert).not.toHaveBeenCalled()
  })
})
