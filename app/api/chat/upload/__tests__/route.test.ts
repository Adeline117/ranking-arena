/** @jest-environment node */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PEER_ID = '22222222-2222-4222-8222-222222222222'
const SCOPE_ID = '33333333-3333-4333-8333-333333333333'

const mockFrom = jest.fn()
const mockStorageFrom = jest.fn()
const mockListBuckets = jest.fn()
const mockUpload = jest.fn()
const mockCreateSignedUrl = jest.fn()
const mockRemove = jest.fn()
const mockLoggerError = jest.fn()
const builders = new Map<string, ReturnType<typeof queryBuilder>>()
const tableResults = new Map<string, { data: unknown; error: unknown }>()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: USER_ID, email: 'member@example.com' },
        supabase: {
          from: mockFrom,
          storage: { from: mockStorageFrom, listBuckets: mockListBuckets },
        },
        request,
      }),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

import { POST } from '../route'

function queryBuilder() {
  const builder = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(),
  }
  builder.select.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  return builder
}

function uploadRequest(scopeType: 'conversation' | 'channel' | null = 'conversation') {
  const file = {
    name: 'proof.txt',
    type: 'text/plain',
    size: 5,
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(5)),
  }
  const entries: Record<string, unknown> = {
    file,
    conversationId: SCOPE_ID,
    ...(scopeType === null ? {} : { scopeType }),
  }

  return {
    formData: jest.fn().mockResolvedValue({
      get: jest.fn((key: string) => entries[key] ?? null),
    }),
  } as never
}

describe('POST /api/chat/upload private media boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    builders.clear()
    tableResults.clear()
    tableResults.set('conversations', {
      data: { user1_id: USER_ID, user2_id: PEER_ID },
      error: null,
    })
    tableResults.set('chat_channels', {
      data: { id: SCOPE_ID, type: 'group' },
      error: null,
    })
    tableResults.set('channel_members', {
      data: { channel_id: SCOPE_ID },
      error: null,
    })
    mockFrom.mockImplementation((table: string) => {
      const builder = queryBuilder()
      builder.maybeSingle.mockImplementation(async () => tableResults.get(table))
      builders.set(table, builder)
      return builder
    })
    mockListBuckets.mockResolvedValue({
      data: [{ id: 'chat', name: 'chat', public: false }],
      error: null,
    })
    mockUpload.mockImplementation(async (path: string) => ({ data: { path }, error: null }))
    mockCreateSignedUrl.mockImplementation(async (path: string) => ({
      data: {
        signedUrl: `https://project.supabase.co/storage/v1/object/sign/chat/${path}?token=fresh`,
      },
      error: null,
    }))
    mockRemove.mockResolvedValue({ data: [], error: null })
    mockStorageFrom.mockReturnValue({
      upload: mockUpload,
      createSignedUrl: mockCreateSignedUrl,
      remove: mockRemove,
    })
  })

  it('uploads a direct-message attachment privately and returns only a short signed URL', async () => {
    const response = await POST(uploadRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({
        url: expect.stringMatching('/storage/v1/object/sign/chat/'),
        fileName: expect.stringMatching(new RegExp(`^${SCOPE_ID}/file/`)),
        originalName: 'proof.txt',
        category: 'file',
      })
    )
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(body.fileName, 15 * 60)
    expect(mockRemove).not.toHaveBeenCalled()
    expect(builders.get('conversations')?.eq).toHaveBeenCalledWith('id', SCOPE_ID)
  })

  it('supports group uploads only after exact channel membership authorization', async () => {
    const response = await POST(uploadRequest('channel'))

    expect(response.status).toBe(200)
    expect(builders.get('chat_channels')?.eq).toHaveBeenCalledWith('id', SCOPE_ID)
    expect(builders.get('channel_members')?.eq).toHaveBeenCalledWith('channel_id', SCOPE_ID)
    expect(builders.get('channel_members')?.eq).toHaveBeenCalledWith('user_id', USER_ID)
    expect(builders.has('conversations')).toBe(false)
  })

  it('rejects a removed group member before touching storage', async () => {
    tableResults.set('channel_members', { data: null, error: null })

    const response = await POST(uploadRequest('channel'))

    expect(response.status).toBe(403)
    expect(mockListBuckets).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it.each([
    [null, 'missing'],
    [{ id: 'chat', name: 'chat', public: true }, 'public'],
  ])('fails closed when the chat bucket is %s', async (bucket) => {
    mockListBuckets.mockResolvedValue({ data: bucket ? [bucket] : [], error: null })

    const response = await POST(uploadRequest())

    expect(response.status).toBe(503)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('deletes the uploaded object when the returned signature is not exact', async () => {
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://attacker.example/not-chat' },
      error: null,
    })

    const response = await POST(uploadRequest())
    const uploadedPath = mockUpload.mock.calls[0]?.[0]

    expect(response.status).toBe(500)
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
  })

  it('keeps missing scopeType compatible only with direct conversations', async () => {
    const response = await POST(uploadRequest(null))

    expect(response.status).toBe(200)
    expect(builders.has('conversations')).toBe(true)
    expect(builders.has('channel_members')).toBe(false)
  })
})
