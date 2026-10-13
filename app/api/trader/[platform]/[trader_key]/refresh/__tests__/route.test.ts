/**
 * @jest-environment node
 */

const mockGetAuthUser = jest.fn()

jest.mock('@/lib/api', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
      status: init.status ?? 200,
      headers: init.headers ?? {},
      json: async () => body,
    }),
  },
}))

import type { NextRequest } from 'next/server'
import {
  V1_LEGACY_REFRESH_JOBS_NO_STORE_HEADERS,
  V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE,
} from '@/lib/ingest/v1-legacy-refresh-jobs-publication'
import { POST } from '../route'

describe('POST /api/trader/:platform/:trader_key/refresh V1 containment', () => {
  const request = { json: jest.fn() } as unknown as NextRequest

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns no-store 401 without reading a body for an unauthenticated request', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(request)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(response.headers).toEqual(V1_LEGACY_REFRESH_JOBS_NO_STORE_HEADERS)
    expect(request.json).not.toHaveBeenCalled()
  })

  it('returns no-store 410 without reading a body or admitting a legacy job', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })

    const response = await POST(request)

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({
      error: V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE,
    })
    expect(response.headers).toEqual(V1_LEGACY_REFRESH_JOBS_NO_STORE_HEADERS)
    expect(request.json).not.toHaveBeenCalled()
  })
})
