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
const mockFrom = jest.fn(() => ({
  upload: mockUpload,
  list: mockList,
  remove: mockRemove,
  getPublicUrl: mockGetPublicUrl,
}))
const mockSupabase = {
  storage: {
    from: mockFrom,
  },
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
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

function request(fileEntry: FormDataEntryValue | null) {
  return {
    formData: jest.fn().mockResolvedValue({
      get: (key: string) => (key === 'file' ? fileEntry : null),
    }),
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
  })

  it('accepts only an exact upload and listing acknowledgement', async () => {
    const response = await POST(request(file()) as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(uploadedPath).toMatch(new RegExp(`^${USER_ID}/[0-9a-f-]{36}\\.jpg$`))
    expect(mockUpload).toHaveBeenCalledWith(uploadedPath, expect.anything(), {
      contentType: 'image/jpeg',
      upsert: false,
    })
    expect(mockList).toHaveBeenCalledWith(USER_ID, {
      search: uploadedPath.slice(uploadedPath.lastIndexOf('/') + 1),
      limit: 1,
    })
    expect(body).toEqual({
      url: `https://storage.test/${uploadedPath}`,
      fileName: uploadedPath,
      verified: true,
    })
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
  })

  it('removes the requested object when exact listing verification fails', async () => {
    mockList.mockResolvedValue({ data: [{ name: 'different.jpg' }], error: null })

    const response = await POST(request(file()) as never)

    expect(response.status).toBe(500)
    expect(mockRemove).toHaveBeenCalledWith([uploadedPath])
  })
})
