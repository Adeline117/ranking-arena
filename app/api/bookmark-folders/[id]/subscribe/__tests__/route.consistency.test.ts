/** @jest-environment node */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

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
  badRequest: (message: string) =>
    new MockTestResponse({ success: false, error: { message } }, 400),
  error: (message: string, status: number, code: string) =>
    new MockTestResponse({ success: false, error: { code, message } }, status),
  handleError: () =>
    new MockTestResponse({ success: false, error: { message: 'Internal server error' } }, 500),
}))

import { DELETE, GET, POST } from '../route'

type QueryResult = { data?: unknown; error: unknown }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.single = jest.fn().mockResolvedValue(result)
  return builder
}

function request(method: 'GET' | 'POST' | 'DELETE'): Request {
  return {
    url: `https://www.arenafi.org/api/bookmark-folders/${FOLDER_ID}/subscribe`,
    method,
  } as Request
}

function context(id = FOLDER_ID) {
  return { params: Promise.resolve({ id }) }
}

function ack(
  status: 'added' | 'already_subscribed' | 'removed' | 'not_subscribed',
  subscriberCount: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    user_id: USER_ID,
    folder_id: FOLDER_ID,
    is_subscribed: status === 'added' || status === 'already_subscribed',
    subscriber_count: subscriberCount,
    ...overrides,
  }
}

describe('/api/bookmark-folders/[id]/subscribe consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not report a failed subscription read as false', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: '42P01', message: 'table missing' } })
    )

    const response = await GET(request('GET'), context())

    expect(response.status).toBe(500)
  })

  it('keeps a genuine no-row subscription as false', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )

    const response = await GET(request('GET'), context())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ is_subscribed: false })
  })

  it.each(['GET', 'POST', 'DELETE'] as const)(
    'rejects a malformed folder id for %s',
    async (method) => {
      const handler = method === 'GET' ? GET : method === 'POST' ? POST : DELETE
      const response = await handler(request(method), context('not-a-uuid'))

      expect(response.status).toBe(400)
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['missing RPC', { code: 'PGRST202', message: 'Could not find the function' }],
    ['missing table', { code: '42P01', message: 'relation does not exist' }],
  ])('returns 503 when the atomic authority has a %s', async (_label, error) => {
    mockRpc.mockResolvedValueOnce({ data: null, error })

    const response = await POST(request('POST'), context())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Folder subscriptions are temporarily unavailable',
      },
    })
  })

  it('does not convert an atomic database failure into a policy outcome', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'database unavailable' },
    })

    const response = await DELETE(request('DELETE'), context())

    expect(response.status).toBe(500)
  })

  it.each([
    ['null', null],
    ['extra field', { ...ack('added', 1), extra: true }],
    ['wrong actor', ack('added', 1, { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })],
    ['wrong folder', ack('added', 1, { folder_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })],
    ['false add', ack('added', 1, { is_subscribed: false })],
    ['zero add count', ack('added', 0)],
    ['unsafe count', ack('added', Number.MAX_SAFE_INTEGER + 1)],
    ['remove status for add', ack('removed', 0)],
  ])('rejects a malformed or mismatched %s acknowledgement', async (_label, data) => {
    mockRpc.mockResolvedValueOnce({ data, error: null })

    const response = await POST(request('POST'), context())

    expect(response.status).toBe(500)
  })

  it.each([
    ['account_inactive', 403],
    ['folder_not_found', 404],
    ['owner_forbidden', 400],
    ['folder_private', 403],
    ['already_subscribed', 409],
  ] as const)('maps POST %s without another database read', async (status, expectedStatus) => {
    const data = status === 'already_subscribed' ? ack('already_subscribed', 3) : { status }
    mockRpc.mockResolvedValueOnce({ data, error: null })

    const response = await POST(request('POST'), context())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledWith('mutate_bookmark_folder_subscription_atomic', {
      p_folder_id: FOLDER_ID,
      p_action: 'add',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns the exact atomic add count', async () => {
    mockRpc.mockResolvedValueOnce({ data: ack('added', 7), error: null })

    const response = await POST(request('POST'), context())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.data).toEqual({
      message: 'Subscribed successfully',
      is_subscribed: true,
      subscriber_count: 7,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['account_inactive', 403],
    ['folder_not_found', 404],
    ['not_subscribed', 404],
  ] as const)('maps DELETE %s without another database read', async (status, expectedStatus) => {
    const data = status === 'not_subscribed' ? ack('not_subscribed', 4) : { status }
    mockRpc.mockResolvedValueOnce({ data, error: null })

    const response = await DELETE(request('DELETE'), context())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledWith('mutate_bookmark_folder_subscription_atomic', {
      p_folder_id: FOLDER_ID,
      p_action: 'remove',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns the exact atomic remove count', async () => {
    mockRpc.mockResolvedValueOnce({ data: ack('removed', 6), error: null })

    const response = await DELETE(request('DELETE'), context())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      message: 'Unsubscribed successfully',
      is_subscribed: false,
      subscriber_count: 6,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
