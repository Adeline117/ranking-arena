jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Map<string, string>

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockUpload = jest.fn()
const mockList = jest.fn()
const mockRemove = jest.fn()
const mockGetPublicUrl = jest.fn()
const mockRpc = jest.fn()
const mockFrom = jest.fn(() => ({
  upload: mockUpload,
  list: mockList,
  remove: mockRemove,
  getPublicUrl: mockGetPublicUrl,
}))
const mockSupabase = { rpc: mockRpc, storage: { from: mockFrom } }

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockSupabase,
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))

const mockSniffVideoFile = jest.fn()
jest.mock('@/lib/utils/video-magic-bytes', () => ({
  sniffVideoFile: (...args: unknown[]) => mockSniffVideoFile(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { POST } from './route'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function file(size = 24): File {
  return { size } as File
}

function request(fileEntry: FormDataEntryValue | null) {
  return {
    formData: jest.fn().mockResolvedValue({
      get: (key: string) => (key === 'file' ? fileEntry : null),
    }),
  }
}

function registryResult(
  name: string,
  args: Record<string, unknown>,
  override: Record<string, unknown> = {}
) {
  return {
    data: {
      status: name === 'reserve_post_media_upload_atomic' ? 'reserved' : 'uploaded',
      upload_id: args.p_upload_id,
      object_name: args.p_object_name,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      replayed: false,
      ...override,
    },
    error: null,
    status: 200,
    statusText: 'OK',
  }
}

describe('post video upload authority', () => {
  let uploadedPath = ''

  beforeEach(() => {
    jest.clearAllMocks()
    uploadedPath = ''
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockSniffVideoFile.mockResolvedValue({
      kind: 'mp4',
      mime: 'video/mp4',
      extension: 'mp4',
    })
    mockUpload.mockImplementation(async (path: string) => {
      uploadedPath = path
      return { data: { path }, error: null }
    })
    mockList.mockImplementation(async () => ({
      data: [{ name: uploadedPath.slice(uploadedPath.lastIndexOf('/') + 1) }],
      error: null,
    }))
    mockRemove.mockResolvedValue({ data: [], error: null })
    mockGetPublicUrl.mockImplementation((path: string) => ({
      data: { publicUrl: `https://storage.test/${path}` },
    }))
    mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args)
    )
  })

  it('requires an active authenticated user before reading the form body', async () => {
    mockGetAuthUser.mockResolvedValue(null)
    const uploadRequest = request(file())

    const response = await POST(uploadRequest as never)

    expect(response.status).toBe(401)
    expect(uploadRequest.formData).not.toHaveBeenCalled()
    expect(mockSniffVideoFile).not.toHaveBeenCalled()
  })

  it.each([
    ['missing file', null],
    ['string form field', 'not-a-file'],
    ['empty file', file(0)],
    ['oversized file', file(100 * 1024 * 1024 + 1)],
  ])('rejects %s before sniffing or storage access', async (_label, fileEntry) => {
    const response = await POST(request(fileEntry) as never)

    expect(response.status).toBe(400)
    expect(mockSniffVideoFile).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('rejects content that fails bounded video sniffing', async () => {
    mockSniffVideoFile.mockResolvedValue(null)

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(400)
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('reserves, uploads, lists, and finalizes a video in authority order', async () => {
    const response = await POST(request(file()) as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(uploadedPath).toMatch(new RegExp(`^${USER_ID}/videos/[0-9a-f-]{36}\\.mp4$`))
    const reserveArgs = mockRpc.mock.calls[0][1]
    expect(mockRpc.mock.calls[0][0]).toBe('reserve_post_media_upload_atomic')
    expect(reserveArgs).toEqual({
      p_upload_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      p_owner_id: USER_ID,
      p_object_name: uploadedPath,
      p_purpose: 'post_video',
      p_mime_type: 'video/mp4',
      p_size_bytes: 24,
    })
    expect(mockUpload).toHaveBeenCalledWith(uploadedPath, expect.anything(), {
      contentType: 'video/mp4',
      upsert: false,
    })
    expect(mockList).toHaveBeenCalledWith(`${USER_ID}/videos`, {
      search: uploadedPath.slice(uploadedPath.lastIndexOf('/') + 1),
      limit: 1,
    })
    expect(mockRpc.mock.calls[1]).toEqual(['finalize_post_media_upload_atomic', reserveArgs])
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockUpload.mock.invocationCallOrder[0])
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(
      mockList.mock.invocationCallOrder[0]
    )
    expect(mockList.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[1])
    expect(mockRpc.mock.invocationCallOrder[1]).toBeLessThan(
      mockGetPublicUrl.mock.invocationCallOrder[0]
    )
    expect(body).toEqual({
      url: `https://storage.test/${uploadedPath}`,
      fileName: uploadedPath,
      fileSize: 24,
      fileType: 'video/mp4',
    })
  })

  it.each(['error', 'throw', 'uploaded', 'mismatch', 'malformed'] as const)(
    'fails closed before Storage when reservation returns %s evidence',
    async (failure) => {
      if (failure === 'error') {
        mockRpc.mockResolvedValueOnce({
          data: null,
          error: {
            code: '22023',
            details: null,
            hint: null,
            message: 'registry unavailable',
          },
          status: 400,
          statusText: 'Bad Request',
        })
      } else if (failure === 'throw') {
        mockRpc.mockRejectedValueOnce(new Error('network failure'))
        mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'still unavailable' } })
      } else {
        mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
          registryResult(
            name,
            args,
            failure === 'uploaded'
              ? { status: 'uploaded' }
              : failure === 'mismatch'
                ? { upload_id: '22222222-2222-4222-8222-222222222222' }
                : { expires_at: 'not-a-timestamp' }
          )
        )
      }

      const response = await POST(request(file()) as never)

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'Internal server error' })
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockRpc).toHaveBeenCalledTimes(failure === 'error' ? 1 : 2)
    }
  )

  it('rejects a first-attempt reservation replay without retrying or touching Storage', async () => {
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args, { replayed: true })
    )

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed and cleans only the requested path on a mismatched upload acknowledgement', async () => {
    mockUpload.mockImplementation(async (path: string) => {
      uploadedPath = path
      return { data: { path: `${USER_ID}/videos/attacker.mp4` }, error: null }
    })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockList).not.toHaveBeenCalled()
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('removes the requested object when exact listing verification fails', async () => {
    mockList.mockResolvedValue({ data: [{ name: 'different.mp4' }], error: null })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('cleans only the generated path after a conclusive database finalization rejection', async () => {
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args)
    )
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', details: null, hint: null, message: 'finalize rejected' },
      status: 400,
      statusText: 'Bad Request',
    })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
    expect(mockRemove).toHaveBeenCalledTimes(1)
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
    expect(mockGetPublicUrl).not.toHaveBeenCalled()
  })

  it.each(['throw', 'mismatch', 'malformed'] as const)(
    'preserves the tracked object when finalization remains ambiguous after %s',
    async (failure) => {
      mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
        registryResult(name, args)
      )
      if (failure === 'throw') {
        mockRpc.mockRejectedValueOnce(new Error('response lost after commit'))
        mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'network unavailable' } })
      } else {
        const override =
          failure === 'mismatch'
            ? { object_name: `${USER_ID}/videos/attacker.mp4` }
            : { expires_at: 'not-a-timestamp' }
        mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
          registryResult(name, args, override)
        )
        mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
          registryResult(name, args, override)
        )
      }

      const response = await POST(request(file()) as never)

      expect(response.status).toBe(500)
      expect(mockRpc).toHaveBeenCalledTimes(3)
      expect(mockRemove).not.toHaveBeenCalled()
      expect(mockGetPublicUrl).not.toHaveBeenCalled()
    }
  )

  it('confirms a commit-ambiguous finalization with one exact replay', async () => {
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args)
    )
    mockRpc.mockRejectedValueOnce(new Error('response lost after commit'))
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args, { replayed: true })
    )

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(3)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('rejects a first-attempt finalization replay without retrying or deleting', async () => {
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args)
    )
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args, { replayed: true })
    )

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockGetPublicUrl).not.toHaveBeenCalled()
  })
})
