/** @jest-environment node */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'

const mockFrom = jest.fn()
const mockSupabase = { from: (...args: unknown[]) => mockFrom(...args) }

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: { id: USER_ID }, supabase: mockSupabase, request }),
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: { id: USER_ID }, supabase: mockSupabase, request }),
}))

class MockTestResponse {
  constructor(
    private readonly body: unknown,
    readonly status: number
  ) {}

  async json() {
    return this.body
  }
}

jest.mock('@/lib/api/response', () => ({
  success: (data: unknown, status = 200) => new MockTestResponse({ success: true, data }, status),
  handleError: () =>
    new MockTestResponse({ success: false, error: { message: 'Internal server error' } }, 500),
}))

import { DELETE, GET, POST } from '../route'

type QueryResult = { data?: unknown; error: unknown; count?: number | null }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'insert', 'delete']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.single = jest.fn().mockResolvedValue(result)
  builder.then = jest.fn((resolveResult: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolveResult)
  )
  return builder
}

function request(method: 'GET' | 'POST' | 'DELETE'): Request {
  return {
    url: `https://www.arenafi.org/api/bookmark-folders/${FOLDER_ID}/subscribe`,
    method,
  } as Request
}

const context = { params: Promise.resolve({ id: FOLDER_ID }) }
const publicFolder = {
  id: FOLDER_ID,
  user_id: OWNER_ID,
  is_public: true,
  name: 'Public list',
}

describe('/api/bookmark-folders/[id]/subscribe consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not report a failed subscription read as false', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: '42P01', message: 'table missing' } })
    )

    const response = await GET(request('GET'), context)

    expect(response.status).toBe(500)
  })

  it('keeps a genuine no-row subscription as false', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )

    const response = await GET(request('GET'), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ is_subscribed: false })
  })

  it('does not report a POST folder-read outage as not found', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await POST(request('POST'), context)

    expect(response.status).toBe(500)
  })

  it('does not ignore an existing-subscription lookup failure', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: publicFolder, error: null }))
      .mockReturnValueOnce(
        query({ data: null, error: { code: 'XX000', message: 'lookup failed' } })
      )

    const response = await POST(request('POST'), context)

    expect(response.status).toBe(500)
  })

  it('maps a concurrent duplicate insert to already-subscribed', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: publicFolder, error: null }))
      .mockReturnValueOnce(query({ data: null, error: { code: 'PGRST116', message: 'no rows' } }))
      .mockReturnValueOnce(
        query({ data: null, error: { code: '23505', message: 'duplicate key' } })
      )

    const response = await POST(request('POST'), context)

    expect(response.status).toBe(409)
  })

  it('does not fabricate zero after a successful subscribe count failure', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: publicFolder, error: null }))
      .mockReturnValueOnce(query({ data: null, error: { code: 'PGRST116', message: 'no rows' } }))
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(
        query({ count: null, error: { code: 'XX000', message: 'count failed' } })
      )

    const response = await POST(request('POST'), context)

    expect(response.status).toBe(500)
  })

  it('does not report a DELETE lookup outage as not subscribed', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await DELETE(request('DELETE'), context)

    expect(response.status).toBe(500)
  })

  it('does not fabricate zero after a successful unsubscribe count failure', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: { id: 'subscription-1' }, error: null }))
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(
        query({ count: null, error: { code: 'XX000', message: 'count failed' } })
      )

    const response = await DELETE(request('DELETE'), context)

    expect(response.status).toBe(500)
  })
})
