/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  badRequest: (message: string) =>
    new MockTestResponse({ success: false, error: { message } }, 400),
  handleError: () =>
    new MockTestResponse({ success: false, error: { message: 'Internal server error' } }, 500),
}))

import { DELETE, GET, PATCH } from '../route'

type QueryResult = { data?: unknown; error: unknown; count?: number | null }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'order', 'update', 'delete', 'in']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.single = jest.fn().mockResolvedValue(result)
  builder.range = jest.fn().mockResolvedValue(result)
  builder.then = jest.fn((resolveResult: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolveResult)
  )
  return builder
}

function request(method: 'GET' | 'PATCH' | 'DELETE' = 'GET'): Request {
  return {
    url: `https://www.arenafi.org/api/bookmark-folders/${FOLDER_ID}`,
    method,
    json: async () => ({ name: 'Renamed' }),
  } as Request
}

const context = { params: Promise.resolve({ id: FOLDER_ID }) }

function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: FOLDER_ID,
    user_id: OWNER_ID,
    name: 'Public list',
    description: null,
    avatar_url: null,
    is_public: true,
    is_default: false,
    post_count: 0,
    created_at: '2026-07-29T00:00:00Z',
    ...overrides,
  }
}

describe('/api/bookmark-folders/[id] consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('distinguishes a database failure from a missing folder', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('keeps a genuine no-row result as not found', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )

    const response = await GET(request(), context)

    expect(response.status).toBe(404)
  })

  it('does not turn an unavailable subscriber count into zero', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: folder(), error: null }))
      .mockReturnValueOnce(
        query({ count: null, error: { code: 'XX000', message: 'count failed' } })
      )

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('does not turn a subscription lookup failure into not subscribed', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: folder(), error: null }))
      .mockReturnValueOnce(query({ count: 3, error: null }))
      .mockReturnValueOnce(
        query({ data: null, error: { code: 'XX000', message: 'subscription failed' } })
      )

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('does not turn a bookmark page failure into an empty folder', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: folder({ user_id: USER_ID }), error: null }))
      .mockReturnValueOnce(query({ count: 0, error: null }))
      .mockReturnValueOnce(
        query({ data: null, error: { code: 'XX000', message: 'bookmarks failed' } })
      )

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('keeps GET read-only when an embedded post is absent', async () => {
    const bookmarkPage = query({
      data: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          post_id: '55555555-5555-4555-8555-555555555555',
          created_at: '2026-07-29T00:00:00Z',
          posts: null,
        },
      ],
      error: null,
    })
    mockFrom
      .mockReturnValueOnce(query({ data: folder({ user_id: USER_ID }), error: null }))
      .mockReturnValueOnce(query({ count: 0, error: null }))
      .mockReturnValueOnce(bookmarkPage)
      .mockReturnValueOnce(query({ data: { handle: 'owner', avatar_url: null }, error: null }))

    const response = await GET(request(), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.posts).toEqual([])
    expect(bookmarkPage.delete).not.toHaveBeenCalled()
    expect(bookmarkPage.update).not.toHaveBeenCalled()

    const source = readFileSync(
      resolve(process.cwd(), 'app/api/bookmark-folders/[id]/route.ts'),
      'utf8'
    )
    const getHandler = source.slice(
      source.indexOf('export async function GET'),
      source.indexOf('// 更新收藏夹信息')
    )
    expect(getHandler).not.toContain(".from('post_bookmarks')\n                .delete()")
    expect(getHandler).not.toContain('update({ post_count:')
  })

  it.each([
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ] as const)(
    'does not report a %s database failure as folder-not-found',
    async (method, handler) => {
      mockFrom.mockReturnValueOnce(
        query({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
      )

      const response = await handler(request(method), context)

      expect(response.status).toBe(500)
    }
  )
})
