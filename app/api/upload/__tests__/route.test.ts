jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    method: string
    private readonly body: unknown

    constructor(
      url: string,
      opts?: { headers?: Record<string, string>; method?: string; body?: unknown }
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries(opts?.headers ?? {}))
      this.method = opts?.method ?? 'POST'
      this.body = opts?.body
    }

    async json() {
      return this.body
    }

    async formData() {
      return this.body
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockGetAuthUser = jest.fn()
const mockRpc = jest.fn()
const mockUpload = jest.fn()
const mockGetPublicUrl = jest.fn()
const mockCreateSignedUrl = jest.fn()
const mockRemove = jest.fn()
const mockStorageFrom = jest.fn(() => ({
  upload: mockUpload,
  getPublicUrl: mockGetPublicUrl,
  createSignedUrl: mockCreateSignedUrl,
  remove: mockRemove,
}))
const mockSupabase = {
  rpc: mockRpc,
  storage: { from: mockStorageFrom },
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => async (request: unknown) => {
    const user = await mockGetAuthUser(request)
    if (!user) {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    return handler({ user, supabase: mockSupabase, request })
  },
}))

const mockSniffImageFile = jest.fn()
jest.mock('@/lib/utils/image-magic-bytes', () => ({
  sniffImageFile: (...args: unknown[]) => mockSniffImageFile(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { DELETE, POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OBJECT_NAME = `${USER_ID}/0123456789abcdef.jpg`
const EVIDENCE_REF = `reports/${OBJECT_NAME}`
const LEASE_TOKEN = '33333333-3333-4333-8333-333333333333'
const EXPIRES_AT = '2026-07-16T13:00:00.000Z'
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])

function createMockFile(size = jpegBytes.byteLength) {
  return {
    name: 'screenshot.png',
    type: 'image/png',
    size,
    arrayBuffer: jest.fn().mockResolvedValue(jpegBytes.buffer),
  }
}

function formData(file: ReturnType<typeof createMockFile> | null, bucket?: string) {
  const values = new Map<string, unknown>()
  if (file) values.set('file', file)
  if (bucket) values.set('bucket', bucket)
  return { get: (key: string) => values.get(key) ?? null }
}

function postRequest(file: ReturnType<typeof createMockFile> | null, bucket?: string) {
  return new NextRequest('http://localhost/api/upload', {
    method: 'POST',
    body: formData(file, bucket) as unknown,
  })
}

function deleteRequest(evidenceRef: unknown = EVIDENCE_REF) {
  return new NextRequest('http://localhost/api/upload', {
    method: 'DELETE',
    body: { evidence_ref: evidenceRef },
  })
}

function rpcResult(name: string) {
  switch (name) {
    case 'reserve_report_evidence_upload':
      return {
        data: {
          reserved: true,
          evidence_ref: EVIDENCE_REF,
          object_name: OBJECT_NAME,
          expires_at: EXPIRES_AT,
        },
        error: null,
      }
    case 'finalize_report_evidence_upload':
      return {
        data: {
          finalized: true,
          evidence_ref: EVIDENCE_REF,
          status: 'uploaded',
          expires_at: EXPIRES_AT,
        },
        error: null,
      }
    case 'lease_report_evidence_cleanup':
      return {
        data: {
          acquired: true,
          evidence_ref: EVIDENCE_REF,
          object_name: OBJECT_NAME,
          lease_token: LEASE_TOKEN,
          lease_expires_at: EXPIRES_AT,
        },
        error: null,
      }
    case 'ack_report_evidence_cleanup':
    case 'release_report_evidence_cleanup':
      return { data: true, error: null }
    default:
      throw new Error(`Unexpected RPC ${name}`)
  }
}

describe('/api/upload report evidence lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockSniffImageFile.mockResolvedValue({
      kind: 'jpeg',
      mime: 'image/jpeg',
      extension: 'jpg',
    })
    mockRpc.mockImplementation(async (name: string) => rpcResult(name))
    mockUpload.mockResolvedValue({ error: null })
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.test/signed/report-evidence' },
      error: null,
    })
    mockRemove.mockResolvedValue({ error: null })
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: 'https://storage.test/public.jpg' } })
  })

  it('requires authentication', async () => {
    mockGetAuthUser.mockResolvedValue(null)
    const response = await POST(postRequest(createMockFile()))
    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['missing file', null, undefined, /No file/i],
    ['oversized file', createMockFile(3 * 1024 * 1024), undefined, /too large|2MB/i],
    ['invalid bucket', createMockFile(), 'malicious', /Invalid bucket/i],
  ])('rejects %s before reserving', async (_label, file, bucket, message) => {
    const response = await POST(postRequest(file, bucket))
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(message)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects invalid magic bytes before reserving', async () => {
    mockSniffImageFile.mockResolvedValue(null)
    const response = await POST(postRequest(createMockFile()))
    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('reserves before upload, disables storage caching, signs, then finalizes', async () => {
    const response = await POST(postRequest(createMockFile()))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toEqual({
      url: 'https://storage.test/signed/report-evidence',
      preview_url: 'https://storage.test/signed/report-evidence',
      evidence_ref: EVIDENCE_REF,
    })
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'reserve_report_evidence_upload', {
      p_reporter_id: USER_ID,
      p_mime_type: 'image/jpeg',
      p_extension: 'jpg',
    })
    expect(mockUpload).toHaveBeenCalledWith(OBJECT_NAME, expect.any(Buffer), {
      contentType: 'image/jpeg',
      upsert: false,
      cacheControl: '0',
    })
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(OBJECT_NAME, 300)
    expect(mockRpc).toHaveBeenCalledWith('finalize_report_evidence_upload', {
      p_reporter_id: USER_ID,
      p_evidence_ref: EVIDENCE_REF,
    })
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockUpload.mock.invocationCallOrder[0])
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateSignedUrl.mock.invocationCallOrder[0]
    )
  })

  it('keeps avatars on the public non-registry path', async () => {
    const response = await POST(postRequest(createMockFile(), 'avatars'))
    expect(response.status).toBe(200)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${USER_ID}/[0-9a-f]{16}\\.jpg$`)),
      expect.any(Buffer),
      { contentType: 'image/jpeg', upsert: false }
    )
    expect(mockGetPublicUrl).toHaveBeenCalled()
  })

  it.each(['upload', 'sign', 'finalize'])(
    'removes storage and acknowledges the reservation when %s fails',
    async (stage) => {
      if (stage === 'upload') mockUpload.mockResolvedValue({ error: { message: 'upload failed' } })
      if (stage === 'sign') {
        mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: 'sign failed' } })
      }
      if (stage === 'finalize') {
        mockRpc.mockImplementation(async (name: string) =>
          name === 'finalize_report_evidence_upload'
            ? { data: null, error: { code: 'XX000' } }
            : rpcResult(name)
        )
      }

      const response = await POST(postRequest(createMockFile()))
      expect(response.status).toBe(500)
      expect(mockRpc).toHaveBeenCalledWith('lease_report_evidence_cleanup', {
        p_reporter_id: USER_ID,
        p_evidence_ref: EVIDENCE_REF,
      })
      expect(mockRemove).toHaveBeenCalledWith([OBJECT_NAME])
      expect(mockRpc).toHaveBeenCalledWith('ack_report_evidence_cleanup', {
        p_reporter_id: USER_ID,
        p_evidence_ref: EVIDENCE_REF,
        p_lease_token: LEASE_TOKEN,
      })
    }
  )

  it('compensates a reservation when reading the upload body fails', async () => {
    const file = createMockFile()
    file.arrayBuffer.mockRejectedValue(new Error('body read failed'))
    const response = await POST(postRequest(file))
    expect(response.status).toBe(500)
    expect(mockRemove).toHaveBeenCalledWith([OBJECT_NAME])
    expect(mockRpc).toHaveBeenCalledWith('ack_report_evidence_cleanup', {
      p_reporter_id: USER_ID,
      p_evidence_ref: EVIDENCE_REF,
      p_lease_token: LEASE_TOKEN,
    })
  })

  it('compensates a syntactically owned reservation with an invalid RPC shape', async () => {
    mockRpc.mockImplementation(async (name: string) =>
      name === 'reserve_report_evidence_upload'
        ? {
            data: {
              ...rpcResult(name).data,
              unexpected: true,
            },
            error: null,
          }
        : rpcResult(name)
    )
    const response = await POST(postRequest(createMockFile()))
    expect(response.status).toBe(500)
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockRemove).toHaveBeenCalledWith([OBJECT_NAME])
  })

  it('deletes only an owned unclaimed reference through a cleanup lease', async () => {
    const response = await DELETE(deleteRequest())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRemove).toHaveBeenCalledWith([OBJECT_NAME])
    expect(mockRpc).toHaveBeenCalledWith('ack_report_evidence_cleanup', {
      p_reporter_id: USER_ID,
      p_evidence_ref: EVIDENCE_REF,
      p_lease_token: LEASE_TOKEN,
    })
  })

  it('rejects another reporter reference before cleanup RPC', async () => {
    const foreignRef = 'reports/22222222-2222-4222-8222-222222222222/0123456789abcdef.jpg'
    const response = await DELETE(deleteRequest(foreignRef))
    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects cleanup of claimed evidence', async () => {
    mockRpc.mockImplementation(async (name: string) =>
      name === 'lease_report_evidence_cleanup'
        ? { data: { acquired: false, reason: 'CLAIMED' }, error: null }
        : rpcResult(name)
    )
    const response = await DELETE(deleteRequest())
    expect(response.status).toBe(409)
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('releases the lease when Storage removal fails so the worker can retry', async () => {
    mockRemove.mockResolvedValue({ error: { message: 'temporary failure' } })
    const response = await DELETE(deleteRequest())
    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledWith('release_report_evidence_cleanup', {
      p_reporter_id: USER_ID,
      p_evidence_ref: EVIDENCE_REF,
      p_lease_token: LEASE_TOKEN,
    })
    expect(mockRpc).not.toHaveBeenCalledWith('ack_report_evidence_cleanup', expect.anything())
  })
})
