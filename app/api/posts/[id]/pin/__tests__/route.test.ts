/** @jest-environment node */

const mockFrom = jest.fn()
const mockCanServiceActorReadPost = jest.fn()
const mockUser = { id: '11111111-1111-4111-8111-111111111111' }
const mockSupabase = { from: (...args: unknown[]) => mockFrom(...args) }

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: mockSupabase, request }),
}))
jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPost: (...args: unknown[]) => mockCanServiceActorReadPost(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { POST } from '../route'

const POST_ID = '22222222-2222-4222-8222-222222222222'
const context = { params: Promise.resolve({ id: POST_ID }) }

type QueryResult = { data: unknown; error: unknown }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'neq', 'update']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.single = jest.fn().mockResolvedValue(result)
  builder.maybeSingle = jest.fn().mockResolvedValue(result)
  builder.then = jest.fn((resolve: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolve)
  )
  return builder
}

const request = { method: 'POST', url: `https://www.arenafi.org/api/posts/${POST_ID}/pin` }

describe('POST /api/posts/[id]/pin service audience boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCanServiceActorReadPost.mockResolvedValue(true)
  })

  it('denies pin state reads and writes before touching posts when audience is unavailable', async () => {
    mockCanServiceActorReadPost.mockResolvedValue(false)

    const response = await POST(request as unknown as Parameters<typeof POST>[0], context)

    expect(response.status).toBe(404)
    expect(mockCanServiceActorReadPost).toHaveBeenCalledWith(mockSupabase, POST_ID, mockUser.id)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('allows the current author and keeps every update bound to the URL post', async () => {
    const target = query({
      data: { id: POST_ID, author_id: mockUser.id, is_pinned: false, group_id: null },
      error: null,
    })
    const unpin = query({ data: null, error: null })
    const pin = query({ data: null, error: null })
    mockFrom.mockReturnValueOnce(target).mockReturnValueOnce(unpin).mockReturnValueOnce(pin)

    const response = await POST(request as unknown as Parameters<typeof POST>[0], context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ is_pinned: true, message: 'Pinned' })
    expect(pin.eq).toHaveBeenCalledWith('id', POST_ID)
  })
})
