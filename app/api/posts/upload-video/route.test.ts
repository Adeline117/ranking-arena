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
const mockFrom = jest.fn(() => ({
  upload: mockUpload,
  list: mockList,
  remove: mockRemove,
  getPublicUrl: mockGetPublicUrl,
}))
const mockSupabase = { storage: { from: mockFrom } }

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

  it('accepts only an exact upload and listing acknowledgement', async () => {
    const response = await POST(request(file()) as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(uploadedPath).toMatch(new RegExp(`^${USER_ID}/videos/[0-9a-f-]{36}\\.mp4$`))
    expect(mockUpload).toHaveBeenCalledWith(uploadedPath, expect.anything(), {
      contentType: 'video/mp4',
      upsert: false,
    })
    expect(mockList).toHaveBeenCalledWith(`${USER_ID}/videos`, {
      search: uploadedPath.slice(uploadedPath.lastIndexOf('/') + 1),
      limit: 1,
    })
    expect(body).toEqual({
      url: `https://storage.test/${uploadedPath}`,
      fileName: uploadedPath,
      fileSize: 24,
      fileType: 'video/mp4',
    })
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
  })

  it('removes the requested object when exact listing verification fails', async () => {
    mockList.mockResolvedValue({ data: [{ name: 'different.mp4' }], error: null })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
  })
})
