/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const POST_ID = '33333333-3333-4333-8333-333333333333'

const mockLoggerError = jest.fn()
const mockDeleteCache = jest.fn()
const mockFrom = jest.fn()
const mockStorageFrom = jest.fn()
const mockRequestJson = jest.fn()

let fetchResult: { data: unknown; error: unknown }
let deleteResult: { data: unknown; error: unknown }
let postFromCall: number
let fetchBuilder: ReturnType<typeof makeFetchBuilder>
let deleteBuilder: ReturnType<typeof makeDeleteBuilder>

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
        user: { id: OWNER },
        supabase: {
          from: mockFrom,
          storage: { from: mockStorageFrom },
        },
        request,
      }),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLoggerError(...args) }),
}))
jest.mock('@/lib/utils/server-cache', () => ({
  deleteServerCacheByPrefix: (...args: unknown[]) => mockDeleteCache(...args),
}))

import { DELETE } from '../route'

function makeFetchBuilder() {
  const builder = {
    select: jest.fn(),
    eq: jest.fn(),
    single: jest.fn(),
  }
  builder.select.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  builder.single.mockImplementation(async () => fetchResult)
  return builder
}

function makeDeleteBuilder() {
  const builder = {
    delete: jest.fn(),
    eq: jest.fn(),
    select: jest.fn(),
  }
  builder.delete.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  builder.select.mockImplementation(async () => deleteResult)
  return builder
}

function request() {
  return { json: mockRequestJson } as never
}

function context() {
  return { params: Promise.resolve({ id: POST_ID }) }
}

describe('DELETE /api/posts/[id]/delete safety boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    fetchResult = { data: { author_id: OWNER }, error: null }
    deleteResult = { data: [{ id: POST_ID }], error: null }
    postFromCall = 0
    fetchBuilder = makeFetchBuilder()
    deleteBuilder = makeDeleteBuilder()
    mockFrom.mockImplementation((table: string) => {
      expect(table).toBe('posts')
      postFromCall += 1
      if (postFromCall === 1) return fetchBuilder
      if (postFromCall === 2) return deleteBuilder
      throw new Error('delete route performed an unexpected table query')
    })
  })

  it('hard-deletes with an owner predicate and one exact affected-row acknowledgement', async () => {
    mockRequestJson.mockResolvedValue({
      url: 'https://evil.example/storage/v1/object/public/posts/foreign/video.mp4',
      fileName: `${OTHER}/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4`,
    })

    const response = await DELETE(request(), context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })
    expect(fetchBuilder.select).toHaveBeenCalledWith('author_id')
    expect(deleteBuilder.eq).toHaveBeenNthCalledWith(1, 'id', POST_ID)
    expect(deleteBuilder.eq).toHaveBeenNthCalledWith(2, 'author_id', OWNER)
    expect(deleteBuilder.select).toHaveBeenCalledWith('id')
    expect(mockRequestJson).not.toHaveBeenCalled()
    expect(mockStorageFrom).not.toHaveBeenCalled()
    expect(mockDeleteCache).toHaveBeenCalledWith('posts:')
  })

  it('does not issue a delete when the authenticated user is not the fetched author', async () => {
    fetchResult = { data: { author_id: OTHER }, error: null }

    const response = await DELETE(request(), context())

    expect(response.status).toBe(403)
    expect(deleteBuilder.delete).not.toHaveBeenCalled()
    expect(mockDeleteCache).not.toHaveBeenCalled()
  })

  it.each([
    ['no affected row', { data: [], error: null }, 404],
    ['null acknowledgement', { data: null, error: null }, 404],
    ['object acknowledgement', { data: { id: POST_ID }, error: null }, 404],
    ['multiple affected rows', { data: [{ id: POST_ID }, { id: OTHER }], error: null }, 404],
    ['database failure', { data: null, error: { message: 'delete failed' } }, 500],
  ])('fails closed on %s', async (_label, result, expectedStatus) => {
    deleteResult = result

    const response = await DELETE(request(), context())

    expect(response.status).toBe(expectedStatus)
    expect(mockStorageFrom).not.toHaveBeenCalled()
    expect(mockDeleteCache).not.toHaveBeenCalled()
  })

  it('has a static no-Storage/no-client-media cleanup guard until claims and leases exist', () => {
    const route = readFileSync(resolve(process.cwd(), 'app/api/posts/[id]/delete/route.ts'), 'utf8')

    expect(route).not.toContain('.storage')
    expect(route).not.toContain('.remove(')
    expect(route).not.toMatch(/request\.(?:json|formData|text|arrayBuffer)\s*\(/)
    expect(route).not.toMatch(/searchParams\.(?:get|getAll)\s*\(/)
    expect(route).toContain(".eq('author_id', user.id)")
    expect(route).toContain(".select('id')")
  })
})
