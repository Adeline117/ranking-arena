/** @jest-environment node */

const mockGetAuthUser = jest.fn()
const mockRequireAuth = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockCanServiceActorReadPost = jest.fn()
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => mockSupabase,
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  success: (data: unknown) => Response.json({ success: true, data }),
  handleError: () => Response.json({ error: 'Internal server error' }, { status: 500 }),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPost: (...args: unknown[]) => mockCanServiceActorReadPost(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: () => null,
  RateLimitPresets: { read: {}, write: {} },
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { GET, POST } from '../route'

const POST_ID = '11111111-1111-4111-8111-111111111111'
const POLL_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const context = { params: Promise.resolve({ id: POST_ID }) }

type QueryResult = { data: unknown; error: unknown }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq']) builder[method] = jest.fn(() => builder)
  builder.maybeSingle = jest.fn().mockResolvedValue(result)
  builder.then = jest.fn((resolve: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolve)
  )
  return builder
}

function request(method: 'GET' | 'POST', body?: unknown): Parameters<typeof GET>[0] {
  return {
    method,
    url: `https://www.arenafi.org/api/posts/${POST_ID}/poll-vote`,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof GET>[0]
}

describe('/api/posts/[id]/poll-vote service audience boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
    mockCanServiceActorReadPost.mockResolvedValue(true)
    mockRpc.mockResolvedValue({
      data: {
        status: 'voted',
        poll_id: POLL_ID,
        options: [
          { text: 'Up', votes: 1 },
          { text: 'Down', votes: 0 },
        ],
        total_votes: 1,
        user_votes: [0],
      },
      error: null,
    })
  })

  it('denies poll child reads before querying them', async () => {
    mockCanServiceActorReadPost.mockResolvedValue(false)

    const response = await GET(request('GET'), context)

    expect(response.status).toBe(404)
    expect(mockCanServiceActorReadPost).toHaveBeenCalledWith(mockSupabase, POST_ID, USER_ID)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns poll children only after canonical audience approval', async () => {
    mockFrom
      .mockReturnValueOnce(
        query({
          data: {
            id: POLL_ID,
            question: 'Direction?',
            options: [
              { text: 'Up', votes: 1 },
              { text: 'Down', votes: 0 },
            ],
            type: 'single',
            end_at: null,
          },
          error: null,
        })
      )
      .mockReturnValueOnce(query({ data: [{ option_index: 0 }], error: null }))

    const response = await GET(request('GET'), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.userVotes).toEqual([0])
    expect(body.data.poll.showResults).toBe(true)
  })

  it('casts votes only through the canonical atomic RPC', async () => {
    const response = await POST(request('POST', { optionIndexes: [0] }), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('cast_post_poll_vote_atomic', {
      p_actor_id: USER_ID,
      p_post_id: POST_ID,
      p_option_indexes: [0],
    })
    expect(body.data.poll).toEqual({
      id: POLL_ID,
      options: [
        { text: 'Up', votes: 1 },
        { text: 'Down', votes: 0 },
      ],
      totalVotes: 1,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when the atomic RPC returns a malformed acknowledgement', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'voted', poll_id: POLL_ID, options: [], total_votes: -1 },
      error: null,
    })

    const response = await POST(request('POST', { optionIndexes: [0] }), context)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
