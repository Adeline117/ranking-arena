jest.mock('@/lib/api/csrf', () => ({
  getCsrfHeaders: jest.fn(() => ({ 'x-csrf-token': 'csrf-test' })),
}))
jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: { getValidToken: jest.fn() },
}))
jest.mock('@/lib/auth/viewer-scope', () => ({
  isViewerScopeCurrent: jest.fn(),
}))

import { getCsrfHeaders } from '@/lib/api/csrf'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import {
  bindPostCreateOperation,
  publishPostAtomic,
  type PostCreateRequestWithOperation,
} from './post-create-client'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_OPERATION_ID = '22222222-2222-4222-8222-222222222222'
const POST_ID = '33333333-3333-4333-8333-333333333333'
const AUTHOR_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_AUTHOR_ID = '55555555-5555-4555-8555-555555555555'
const GROUP_ID = '66666666-6666-4666-8666-666666666666'
const POLL_ID = '77777777-7777-4777-8777-777777777777'
const CREATED_AT = '2026-08-03T12:34:56.123456+00:00'

const viewerScope: ViewerScope = {
  viewerKey: `user:${AUTHOR_ID}`,
  sessionGeneration: 7,
  userId: AUTHOR_ID,
}

const mockGetValidToken = tokenRefreshCoordinator.getValidToken as jest.Mock
const mockIsViewerScopeCurrent = isViewerScopeCurrent as jest.Mock
const mockGetCsrfHeaders = getCsrfHeaders as jest.Mock

function jwtFor(subject: string): string {
  return `${btoa('{}')}.${btoa(JSON.stringify({ sub: subject }))}.signature`
}

function boundRequest(overrides: Record<string, unknown> = {}): PostCreateRequestWithOperation {
  return bindPostCreateOperation(
    {
      title: 'Market outlook',
      content: 'First line\nSecond line',
      images: ['https://cdn.example.com/chart.png'],
      ...overrides,
    },
    null,
    () => OPERATION_ID
  ).request as PostCreateRequestWithOperation
}

function successPayload(
  request: PostCreateRequestWithOperation,
  options: {
    operationStatus?: 'created' | 'replayed'
    operationId?: string
    authorId?: string
    groupId?: string | null
    visibility?: 'public' | 'followers' | 'group'
    images?: string[]
    poll?: unknown
    pollId?: string | null
  } = {}
) {
  const operationStatus = options.operationStatus ?? 'created'
  const hasCustomPoll = request.poll_enabled && request.poll_options !== undefined
  const poll =
    options.poll !== undefined
      ? options.poll
      : hasCustomPoll
        ? {
            id: POLL_ID,
            post_id: POST_ID,
            question: request.title,
            options: request.poll_options!.map((text, index) => ({ text, votes: 0, index })),
            type: request.poll_type,
            end_at: request.poll_duration_hours === 0 ? null : '2026-08-04T12:34:56.123456+00:00',
          }
        : null

  return {
    success: true,
    data: {
      post: {
        id: POST_ID,
        author_id: options.authorId ?? AUTHOR_ID,
        author_handle: 'alice',
        group_id: options.groupId === undefined ? (request.group_id ?? null) : options.groupId,
        title: request.title,
        content: request.content,
        images: options.images ?? request.images,
        poll_enabled: request.poll_enabled,
        poll_id: options.pollId === undefined ? (hasCustomPoll ? POLL_ID : null) : options.pollId,
        visibility: options.visibility ?? request.visibility,
        is_sensitive: request.is_sensitive,
        content_warning: request.content_warning ?? null,
        language: 'en',
        mentions: [],
        hashtags: [],
        author_arena_score: 42.5,
        author_is_verified: true,
        content_version: 0,
        status: 'active',
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
      },
      poll,
      operation: {
        status: operationStatus,
        applied: operationStatus === 'created',
        operation_id: options.operationId ?? request.operation_id,
      },
    },
  }
}

function response(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  }
}

describe('bindPostCreateOperation', () => {
  it('reuses one operation for the same normalized frozen intent', () => {
    const firstUuid = jest.fn(() => OPERATION_ID)
    const retryUuid = jest.fn(() => SECOND_OPERATION_ID)
    const first = bindPostCreateOperation(
      {
        title: '  Market outlook  ',
        content: '  First line\nSecond line  ',
        images: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
      },
      null,
      firstUuid
    )
    const retry = bindPostCreateOperation(
      {
        content: 'First line\nSecond line',
        title: 'Market outlook',
        group_id: null,
        images: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
        poll_enabled: false,
        visibility: 'public',
        is_sensitive: false,
        content_warning: null,
      },
      first,
      retryUuid
    )

    expect(retry).toBe(first)
    expect(retry.request.operation_id).toBe(OPERATION_ID)
    expect(firstUuid).toHaveBeenCalledTimes(1)
    expect(retryUuid).not.toHaveBeenCalled()
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.request)).toBe(true)
    expect(Object.isFrozen(first.request.images)).toBe(true)
  })

  it('creates a new operation when content or ordered arrays change', () => {
    const first = bindPostCreateOperation(
      {
        title: 'Market outlook',
        content: 'Body',
        images: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
      },
      null,
      () => OPERATION_ID
    )
    const reordered = bindPostCreateOperation(
      {
        title: 'Market outlook',
        content: 'Body',
        images: ['https://cdn.example.com/b.png', 'https://cdn.example.com/a.png'],
      },
      first,
      () => SECOND_OPERATION_ID
    )

    expect(reordered).not.toBe(first)
    expect(reordered.fingerprint).not.toBe(first.fingerprint)
    expect(reordered.request.operation_id).toBe(SECOND_OPERATION_ID)
  })
})

describe('publishPostAtomic', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetValidToken.mockResolvedValue(jwtFor(AUTHOR_ID))
    mockIsViewerScopeCurrent.mockReturnValue(true)
    mockGetCsrfHeaders.mockReturnValue({ 'x-csrf-token': 'csrf-test' })
  })

  it('rejects a scope that was already superseded without requesting a token', async () => {
    mockIsViewerScopeCurrent.mockReturnValue(false)
    const fetcher = jest.fn()

    await expect(publishPostAtomic(boundRequest(), viewerScope, fetcher)).resolves.toEqual({
      status: 'superseded',
      error: 'Authentication scope changed',
    })
    expect(mockGetValidToken).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires an authenticated user in the captured scope', async () => {
    const fetcher = jest.fn()

    await expect(
      publishPostAtomic(
        boundRequest(),
        { viewerKey: 'anon', sessionGeneration: 8, userId: null },
        fetcher
      )
    ).resolves.toEqual({
      status: 'superseded',
      error: 'Authentication scope changed',
    })
    expect(mockGetValidToken).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a token whose exact JWT subject does not own the captured scope', async () => {
    mockGetValidToken.mockResolvedValue(jwtFor(OTHER_AUTHOR_ID))
    const fetcher = jest.fn()

    await expect(publishPostAtomic(boundRequest(), viewerScope, fetcher)).resolves.toEqual({
      status: 'superseded',
      error: 'Authentication scope changed',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not publish success after the viewer scope changes in flight', async () => {
    mockIsViewerScopeCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const request = boundRequest()
    const fetcher = jest.fn().mockResolvedValue(response(201, successPayload(request)))

    await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toEqual({
      status: 'superseded',
      error: 'Authentication scope changed',
    })
  })

  it('returns a typed failure with only a safe non-2xx API error', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(response(403, { success: false, error: '  No permission to publish  ' }))

    await expect(publishPostAtomic(boundRequest(), viewerScope, fetcher)).resolves.toEqual({
      status: 'failed',
      httpStatus: 403,
      error: 'No permission to publish',
    })
  })

  it('fails closed on a non-JSON 2xx response', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockRejectedValue(new SyntaxError('not json')),
    })

    await expect(publishPostAtomic(boundRequest(), viewerScope, fetcher)).resolves.toMatchObject({
      status: 'invalid_ack',
      httpStatus: 201,
    })
  })

  it.each([
    [
      'an extra envelope field',
      (payload: ReturnType<typeof successPayload>) => ({ ...payload, extra: true }),
    ],
    [
      'the wrong operation echo',
      (_payload: ReturnType<typeof successPayload>, request: PostCreateRequestWithOperation) =>
        successPayload(request, { operationId: SECOND_OPERATION_ID }),
    ],
    [
      'the wrong author echo',
      (_payload: ReturnType<typeof successPayload>, request: PostCreateRequestWithOperation) =>
        successPayload(request, { authorId: OTHER_AUTHOR_ID }),
    ],
    [
      'the wrong image echo',
      (_payload: ReturnType<typeof successPayload>, request: PostCreateRequestWithOperation) =>
        successPayload(request, { images: ['https://cdn.example.com/other.png'] }),
    ],
  ])('rejects %s', async (_label, mutate) => {
    const request = boundRequest()
    const payload = mutate(successPayload(request), request)
    const fetcher = jest.fn().mockResolvedValue(response(201, payload))

    await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toMatchObject({
      status: 'invalid_ack',
      httpStatus: 201,
    })
  })

  it('accepts an exact 201 created acknowledgement and sends auth, JSON, and CSRF proof', async () => {
    const request = boundRequest()
    const payload = successPayload(request)
    const fetcher = jest.fn().mockResolvedValue(response(201, payload))

    await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toEqual({
      status: 'created',
      data: payload.data,
    })
    expect(mockGetValidToken).toHaveBeenCalledWith({
      expectedUserId: AUTHOR_ID,
      sessionGeneration: 7,
    })
    expect(fetcher).toHaveBeenCalledWith('/api/posts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'x-csrf-token': 'csrf-test',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtFor(AUTHOR_ID)}`,
      },
      body: JSON.stringify(request),
    })
  })

  it('accepts an exact 200 idempotent replay', async () => {
    const request = boundRequest()
    const payload = successPayload(request, { operationStatus: 'replayed' })
    const fetcher = jest.fn().mockResolvedValue(response(200, payload))

    await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toEqual({
      status: 'replayed',
      data: payload.data,
    })
  })

  it.each([
    ['created', 200],
    ['replayed', 201],
  ] as const)('rejects %s evidence returned with HTTP %i', async (operationStatus, httpStatus) => {
    const request = boundRequest()
    const payload = successPayload(request, { operationStatus })
    const fetcher = jest.fn().mockResolvedValue(response(httpStatus, payload))

    await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toMatchObject({
      status: 'invalid_ack',
      httpStatus,
    })
  })

  it('accepts legacy tri-state poll evidence only without a custom poll row', async () => {
    const request = boundRequest({ poll_enabled: true })
    const payload = successPayload(request)
    const fetcher = jest.fn().mockResolvedValue(response(201, payload))

    await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toMatchObject({
      status: 'created',
      data: { poll: null },
    })
  })

  it.each([
    [0, null],
    [24, '2026-08-04T12:34:56.123456+00:00'],
  ] as const)(
    'validates custom poll option order, type, and duration semantics',
    async (hours, endAt) => {
      const request = boundRequest({
        poll_enabled: true,
        poll_options: ['Bullish', 'Bearish'],
        poll_type: 'single',
        poll_duration_hours: hours,
      })
      const payload = successPayload(request, {
        poll: {
          id: POLL_ID,
          post_id: POST_ID,
          question: request.title,
          options: [
            { text: 'Bullish', votes: 0, index: 0 },
            { text: 'Bearish', votes: 0, index: 1 },
          ],
          type: 'single',
          end_at: endAt,
        },
      })
      const fetcher = jest.fn().mockResolvedValue(response(201, payload))

      await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toMatchObject({
        status: 'created',
      })
    }
  )

  it.each([
    {
      label: 'option order',
      poll: {
        id: POLL_ID,
        post_id: POST_ID,
        question: 'Market outlook',
        options: [
          { text: 'Bearish', votes: 0, index: 0 },
          { text: 'Bullish', votes: 0, index: 1 },
        ],
        type: 'single',
        end_at: null,
      },
    },
    {
      label: 'poll type',
      poll: {
        id: POLL_ID,
        post_id: POST_ID,
        question: 'Market outlook',
        options: [
          { text: 'Bullish', votes: 0, index: 0 },
          { text: 'Bearish', votes: 0, index: 1 },
        ],
        type: 'multiple',
        end_at: null,
      },
    },
    {
      label: 'zero-duration end time',
      poll: {
        id: POLL_ID,
        post_id: POST_ID,
        question: 'Market outlook',
        options: [
          { text: 'Bullish', votes: 0, index: 0 },
          { text: 'Bearish', votes: 0, index: 1 },
        ],
        type: 'single',
        end_at: '2026-08-04T12:34:56.123456+00:00',
      },
    },
  ])('rejects a custom poll with the wrong $label echo', async ({ poll }) => {
    const request = boundRequest({
      poll_enabled: true,
      poll_options: ['Bullish', 'Bearish'],
      poll_type: 'single',
      poll_duration_hours: 0,
    })
    const fetcher = jest.fn().mockResolvedValue(response(201, successPayload(request, { poll })))

    await expect(publishPostAtomic(request, viewerScope, fetcher)).resolves.toMatchObject({
      status: 'invalid_ack',
      httpStatus: 201,
    })
  })
})
