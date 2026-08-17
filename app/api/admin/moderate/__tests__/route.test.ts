import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'

let mockAuthorized = true

function mockNextResponseJson(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return {
    status: init.status ?? 200,
    headers: new Map(Object.entries(init.headers ?? {})),
    json: async () => body,
  }
}

type MockAdminHandler = (context: {
  admin: { id: string; email: string }
  supabase: { from: () => never }
  request: NextRequest
}) => Promise<unknown> | unknown

jest.mock('next/server', () => ({
  NextResponse: {
    json: mockNextResponseJson,
  },
}))

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth:
    (handler: MockAdminHandler) =>
    async (request: NextRequest): Promise<unknown> => {
      if (!mockAuthorized) {
        return mockNextResponseJson(
          { success: false, error: 'Admin access required' },
          { status: 403 }
        )
      }
      return handler({
        admin: { id: 'admin-1', email: 'admin@example.com' },
        supabase: {
          from: () => {
            throw new Error('retired endpoint must not access the database')
          },
        },
        request,
      })
    },
}))

import { POST } from '../route'

const request = { json: jest.fn() } as NextRequest

describe('/api/admin/moderate retirement boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthorized = true
  })

  it('returns an authenticated, non-cacheable 410 with atomic replacements', async () => {
    const response = await POST(request)

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Deprecation')).toBe('true')
    expect(response.headers.get('Link')).toContain('/api/admin/moderation-queue')
    expect(request.json).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'The legacy administrator moderation endpoint has been retired.',
      code: 'ADMIN_MODERATE_ENDPOINT_RETIRED',
      replacements: {
        content: '/api/admin/moderation-queue',
        ban: '/api/admin/users/{id}/ban',
      },
    })
  })

  it('keeps the tombstone behind administrator authentication', async () => {
    mockAuthorized = false

    const response = await POST(request)

    expect(response.status).toBe(403)
    expect(request.json).not.toHaveBeenCalled()
  })

  it('contains no request-body or database mutation path', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/admin/moderate/route.ts'), 'utf8')

    expect(source).not.toContain('request.json')
    expect(source).not.toContain('req.json')
    expect(source).not.toContain('.from(')
    expect(source).not.toContain('setAdminUserSanctionAtomic')
    expect(source).not.toContain('moderateCommentWithRollout')
    expect(source).toContain("'Cache-Control': 'private, no-store'")
    expect(source).toContain("Deprecation: 'true'")
  })
})
