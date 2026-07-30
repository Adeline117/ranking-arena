/** @jest-environment node */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'

const mockFrom = jest.fn()
const mockSupabase = { from: (...args: unknown[]) => mockFrom(...args) }

jest.mock('@/lib/api/middleware', () => ({
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

import { GET } from '../route'

type QueryResult = { data?: unknown; error: unknown; count?: number | null }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'order', 'range', 'in']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = jest.fn((resolveResult: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolveResult)
  )
  return builder
}

function request(limit = 20): Request {
  return {
    url: `https://www.arenafi.org/api/bookmark-folders/subscribed?limit=${limit}`,
  } as Request
}

function subscription(folderId: string, createdAt: string) {
  return {
    id: `subscription-${folderId}`,
    created_at: createdAt,
    bookmark_folders: {
      id: folderId,
      name: 'Public list',
      description: null,
      avatar_url: null,
      is_public: true,
      post_count: 4,
      created_at: '2026-07-28T00:00:00Z',
      user_id: OWNER_ID,
    },
  }
}

describe('/api/bookmark-folders/subscribed consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not report a missing subscription table as an empty list', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: '42P01', message: 'table missing' } })
    )

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('does not publish owner-less folders when the owner lookup fails', async () => {
    mockFrom
      .mockReturnValueOnce(
        query({ data: [subscription(FOLDER_ID, '2026-07-29T00:00:00Z')], error: null })
      )
      .mockReturnValueOnce(
        query({ data: null, error: { code: 'XX000', message: 'owners failed' } })
      )

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('does not fabricate a zero subscriber count on count failure', async () => {
    mockFrom
      .mockReturnValueOnce(
        query({ data: [subscription(FOLDER_ID, '2026-07-29T00:00:00Z')], error: null })
      )
      .mockReturnValueOnce(
        query({ data: [{ id: OWNER_ID, handle: 'owner', avatar_url: null }], error: null })
      )
      .mockReturnValueOnce(
        query({ count: null, error: { code: 'XX000', message: 'count failed' } })
      )

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('returns exact subscriber counts and uses a lookahead row for pagination', async () => {
    const secondFolderId = '44444444-4444-4444-8444-444444444444'
    mockFrom
      .mockReturnValueOnce(
        query({
          data: [
            subscription(FOLDER_ID, '2026-07-29T00:00:00Z'),
            subscription(secondFolderId, '2026-07-28T00:00:00Z'),
          ],
          error: null,
        })
      )
      .mockReturnValueOnce(
        query({ data: [{ id: OWNER_ID, handle: 'owner', avatar_url: null }], error: null })
      )
      .mockReturnValueOnce(query({ count: 7, error: null }))

    const response = await GET(request(1))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.folders).toHaveLength(1)
    expect(body.data.folders[0]).toMatchObject({
      id: FOLDER_ID,
      subscriber_count: 7,
      owner_handle: 'owner',
    })
    expect(body.data.pagination).toEqual({ limit: 1, offset: 0, has_more: true })
  })
})
