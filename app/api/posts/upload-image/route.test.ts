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
const mockSupabase = {
  rpc: mockRpc,
  storage: {
    from: mockFrom,
  },
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: (context: Record<string, unknown>) => unknown) => (request: unknown) =>
    handler({
      user: { id: '11111111-1111-4111-8111-111111111111' },
      supabase: mockSupabase,
      request,
    }),
}))

const mockSniffImageFile = jest.fn()
jest.mock('@/lib/utils/image-magic-bytes', () => ({
  sniffImageFile: (...args: unknown[]) => mockSniffImageFile(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { POST } from './route'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function file(size = 12): File {
  return { size } as File
}

function request(fileEntry: FormDataEntryValue | null, purpose: FormDataEntryValue | null = null) {
  return {
    formData: jest.fn().mockResolvedValue({
      get: (key: string) => {
        if (key === 'file') return fileEntry
        if (key === 'purpose') return purpose
        return null
      },
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

describe('post image upload authority', () => {
  let uploadedPath = ''

  beforeEach(() => {
    jest.clearAllMocks()
    uploadedPath = ''
    mockSniffImageFile.mockResolvedValue({
      kind: 'jpeg',
      mime: 'image/jpeg',
      extension: 'jpg',
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

  it.each([
    ['missing file', null],
    ['string form field', 'not-a-file'],
    ['empty file', file(0)],
  ])('rejects %s before sniffing or storage access', async (_label, fileEntry) => {
    const response = await POST(request(fileEntry) as never)

    expect(response.status).toBe(400)
    expect(mockSniffImageFile).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('reports the migrated bucket as unavailable without pointing to a dead setup script', async () => {
    mockUpload.mockResolvedValue({
      data: null,
      error: { message: 'Bucket not found' },
    })

    const response = await POST(request(file()) as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({
      error: 'Post media storage is temporarily unavailable.',
      code: 'BUCKET_NOT_FOUND',
    })
    expect(JSON.stringify(body)).not.toContain('setup_posts_storage.sql')
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('reserves, uploads, lists, and finalizes a legacy image in authority order', async () => {
    const response = await POST(request(file()) as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(uploadedPath).toMatch(new RegExp(`^${USER_ID}/[0-9a-f-]{36}\\.jpg$`))
    const reserveArgs = mockRpc.mock.calls[0][1]
    expect(mockRpc.mock.calls[0][0]).toBe('reserve_post_media_upload_atomic')
    expect(reserveArgs).toEqual({
      p_upload_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      p_owner_id: USER_ID,
      p_object_name: uploadedPath,
      p_purpose: 'legacy_image',
      p_mime_type: 'image/jpeg',
      p_size_bytes: 12,
    })
    expect(mockUpload).toHaveBeenCalledWith(uploadedPath, expect.anything(), {
      contentType: 'image/jpeg',
      upsert: false,
    })
    expect(mockList).toHaveBeenCalledWith(USER_ID, {
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
      verified: true,
    })
  })

  it.each(['post_image', 'group_avatar'] as const)(
    'binds the explicit %s purpose into both registry mutations',
    async (purpose) => {
      const response = await POST(request(file(), purpose) as never)

      expect(response.status).toBe(200)
      expect(mockRpc).toHaveBeenNthCalledWith(
        1,
        'reserve_post_media_upload_atomic',
        expect.objectContaining({ p_purpose: purpose })
      )
      expect(mockRpc).toHaveBeenNthCalledWith(
        2,
        'finalize_post_media_upload_atomic',
        expect.objectContaining({ p_purpose: purpose })
      )
    }
  )

  it.each(['legacy_image', 'post_video', '', ' post_image '])(
    'rejects the explicit purpose %j before sniffing, RPC, or Storage',
    async (purpose) => {
      const response = await POST(request(file(), purpose) as never)

      expect(response.status).toBe(400)
      expect(mockSniffImageFile).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('fails closed before Storage when reservation RPC returns an error', async () => {
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

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Upload failed' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed before Storage when reservation RPC throws', async () => {
    mockRpc.mockRejectedValueOnce(new Error('network failure'))
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'still unavailable' } })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('treats a status-zero transport wrapper as ambiguous and never touches Storage', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'EPIPE', details: null, hint: null, message: 'transport failure' },
      status: 0,
      statusText: '',
    })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not trust an exact receipt carried by a non-success transport status', async () => {
    mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => ({
      ...registryResult(name, args),
      status: 0,
      statusText: '',
    }))

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['uploaded status', { status: 'uploaded' }],
    ['mismatched upload', { upload_id: '22222222-2222-4222-8222-222222222222' }],
    ['mismatched object', { object_name: `${USER_ID}/attacker.jpg` }],
    ['malformed expiry', { expires_at: 'not-a-timestamp' }],
  ])('fails closed before Storage for a stale or mismatched %s', async (_label, override) => {
    mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args, override)
    )

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('rejects a first-attempt reservation replay without retrying or touching Storage', async () => {
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args, { replayed: true })
    )

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('accepts an exact replay only on the controlled reservation retry', async () => {
    mockRpc.mockRejectedValueOnce(new Error('response lost after commit'))
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
      registryResult(name, args, { replayed: true })
    )

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(3)
    expect(mockRpc.mock.calls[0][0]).toBe('reserve_post_media_upload_atomic')
    expect(mockRpc.mock.calls[1][0]).toBe('reserve_post_media_upload_atomic')
    expect(mockUpload.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockRpc.mock.invocationCallOrder[1]
    )
  })

  it('fails closed and cleans only the requested path on a mismatched upload acknowledgement', async () => {
    mockUpload.mockImplementation(async (path: string) => {
      uploadedPath = path
      return { data: { path: `${USER_ID}/attacker.jpg` }, error: null }
    })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockList).not.toHaveBeenCalled()
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('removes the requested object when exact listing verification fails', async () => {
    mockList.mockResolvedValue({ data: [{ name: 'different.jpg' }], error: null })

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
    expect(await response.json()).toEqual({ error: 'Upload failed' })
    expect(mockRemove).toHaveBeenCalledTimes(1)
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
    expect(mockGetPublicUrl).not.toHaveBeenCalled()
  })

  it.each(['throw', 'mismatch', 'malformed', 'transport', 'error_with_data'] as const)(
    'preserves the tracked object when finalization remains ambiguous after %s',
    async (failure) => {
      mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) =>
        registryResult(name, args)
      )
      if (failure === 'throw') {
        mockRpc.mockRejectedValueOnce(new Error('response lost after commit'))
        mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'network unavailable' } })
      } else if (failure === 'transport' || failure === 'error_with_data') {
        const result = {
          data: failure === 'error_with_data' ? { unexpected: true } : null,
          error: { code: 'EPIPE', details: null, hint: null, message: 'transport failure' },
          status: failure === 'error_with_data' ? 500 : 0,
          statusText: failure === 'error_with_data' ? 'Internal Server Error' : '',
        }
        mockRpc.mockResolvedValueOnce(result)
        mockRpc.mockResolvedValueOnce(result)
      } else {
        const override =
          failure === 'mismatch'
            ? { object_name: `${USER_ID}/attacker.jpg` }
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
      expect(await response.json()).toEqual({ error: 'Upload failed' })
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
