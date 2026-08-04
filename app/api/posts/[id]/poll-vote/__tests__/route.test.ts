/** @jest-environment node */

const mockGetAuthUser = jest.fn()
const mockRequireAuth = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockCanServiceActorReadPostStrict = jest.fn()
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => mockSupabase,
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  handleError: () => Response.json({ error: 'Internal server error' }, { status: 500 }),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPostStrict: (...args: unknown[]) => mockCanServiceActorReadPostStrict(...args),
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
const REQUEST_ID = 'a'.repeat(32)
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

function request(
  method: 'GET' | 'POST',
  body?: unknown,
  urlSuffix = ''
): Parameters<typeof GET>[0] {
  const readQuery = `?operation=read&request_id=${REQUEST_ID}`
  return {
    method,
    url: `https://www.arenafi.org/api/posts/${POST_ID}/poll-vote${
      method === 'GET' ? urlSuffix || readQuery : urlSuffix
    }`,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof GET>[0]
}

function postBody(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'set_vote',
    request_id: REQUEST_ID,
    poll_id: POLL_ID,
    option_indexes: [0],
    ...overrides,
  }
}

describe('/api/posts/[id]/poll-vote exact viewer contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
    mockCanServiceActorReadPostStrict.mockResolvedValue(true)
    mockRpc.mockResolvedValue({
      data: {
        status: 'voted',
        poll_id: POLL_ID,
        options: [
          { text: 'Up', votes: 1, index: 0 },
          { text: 'Down', votes: 0, index: 1 },
        ],
        total_votes: 1,
        user_votes: [0],
      },
      error: null,
    })
  })

  it('denies poll child reads before querying them', async () => {
    mockCanServiceActorReadPostStrict.mockResolvedValue(false)

    const response = await GET(request('GET'), context)

    expect(response.status).toBe(404)
    expect(mockCanServiceActorReadPostStrict).toHaveBeenCalledWith(mockSupabase, POST_ID, USER_ID)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('keeps audience-authority failures distinct from a filtered post', async () => {
    mockCanServiceActorReadPostStrict.mockRejectedValue(new Error('authority unavailable'))

    const response = await GET(request('GET'), context)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns an exact viewer/post/request-bound snapshot after audience approval', async () => {
    mockFrom
      .mockReturnValueOnce(
        query({
          data: {
            id: POLL_ID,
            question: 'Direction?',
            options: [
              { text: 'Up', votes: 1, index: 0 },
              { text: 'Down', votes: 0, index: 1 },
            ],
            type: 'single',
            end_at: null,
          },
          error: null,
        })
      )
      .mockReturnValueOnce(query({ data: [{ option_index: 0 }], error: null }))

    const response = await GET(request('GET'), context)

    await expect(response.json()).resolves.toEqual({
      actor_id: USER_ID,
      post_id: POST_ID,
      request_id: REQUEST_ID,
      operation: 'read',
      action: 'found',
      poll: {
        id: POLL_ID,
        question: 'Direction?',
        options: [
          { text: 'Up', votes: 1 },
          { text: 'Down', votes: 0 },
        ],
        type: 'single',
        end_at: null,
        is_expired: false,
        show_results: true,
        total_votes: 1,
      },
      user_votes: [0],
    })
    expect(response.status).toBe(200)
  })

  it('distinguishes an authoritative empty poll from a load failure', async () => {
    mockFrom.mockReturnValueOnce(query({ data: null, error: null }))

    const response = await GET(request('GET'), context)

    await expect(response.json()).resolves.toMatchObject({
      actor_id: USER_ID,
      post_id: POST_ID,
      request_id: REQUEST_ID,
      operation: 'read',
      action: 'absent',
      poll: null,
      user_votes: [],
    })
  })

  it('fails closed when persisted option indexes disagree with JSON order', async () => {
    mockFrom.mockReturnValueOnce(
      query({
        data: {
          id: POLL_ID,
          question: 'Direction?',
          options: [
            { text: 'Up', votes: 1, index: 1 },
            { text: 'Down', votes: 0, index: 0 },
          ],
          type: 'single',
          end_at: null,
        },
        error: null,
      })
    )

    const response = await GET(request('GET'), context)

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate or invented snapshot query fields', async () => {
    const response = await GET(
      request('GET', undefined, `?operation=read&request_id=${REQUEST_ID}&extra=true`),
      context
    )

    expect(response.status).toBe(400)
    expect(mockCanServiceActorReadPostStrict).not.toHaveBeenCalled()
  })

  it('casts votes only through the canonical atomic RPC and returns exact absolute counts', async () => {
    const response = await POST(request('POST', postBody()), context)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('cast_post_poll_vote_expected_atomic', {
      p_actor_id: USER_ID,
      p_expected_poll_id: POLL_ID,
      p_post_id: POST_ID,
      p_option_indexes: [0],
    })
    await expect(response.json()).resolves.toEqual({
      actor_id: USER_ID,
      post_id: POST_ID,
      poll_id: POLL_ID,
      request_id: REQUEST_ID,
      operation: 'set_vote',
      action: 'voted',
      poll: {
        options: [
          { text: 'Up', votes: 1 },
          { text: 'Down', votes: 0 },
        ],
        total_votes: 1,
      },
      option_indexes: [0],
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['an extra field', { invented: true }],
    ['out-of-order indexes', { option_indexes: [1, 0] }],
    ['a duplicate index', { option_indexes: [0, 0] }],
    ['another operation', { operation: 'toggle' }],
  ])('rejects %s before invoking the write RPC', async (_name, overrides) => {
    const response = await POST(request('POST', postBody(overrides)), context)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a receipt for a different poll as stale', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'voted',
        poll_id: '44444444-4444-4444-8444-444444444444',
        options: [
          { text: 'Up', votes: 1, index: 0 },
          { text: 'Down', votes: 0, index: 1 },
        ],
        total_votes: 1,
        user_votes: [0],
      },
      error: null,
    })

    const response = await POST(request('POST', postBody()), context)

    expect(response.status).toBe(409)
  })

  it('maps a pre-mutation expected-poll mismatch to 409', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'poll_changed' }, error: null })

    const response = await POST(request('POST', postBody()), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'Poll changed; reload before voting',
    })
    expect(mockRpc).toHaveBeenCalledWith('cast_post_poll_vote_expected_atomic', {
      p_actor_id: USER_ID,
      p_expected_poll_id: POLL_ID,
      p_post_id: POST_ID,
      p_option_indexes: [0],
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when the atomic RPC returns malformed counts or extra fields', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'voted',
        poll_id: POLL_ID,
        options: [
          { text: 'Up', votes: 1, index: 0 },
          { text: 'Down', votes: 0, index: 1 },
        ],
        total_votes: 2,
        user_votes: [0],
        invented: true,
      },
      error: null,
    })

    const response = await POST(request('POST', postBody()), context)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
