/** @jest-environment node */

import type { NextRequest } from 'next/server'

const mockSupabase = { marker: 'request-scoped-capabilities-client' }
const mockGetSourceCapabilities = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => (request: unknown) =>
    handler({ supabase: mockSupabase, request }),
}))

jest.mock('@/lib/api/response', () => ({
  success: (data: unknown, status = 200, headers?: Record<string, string>) => ({
    status,
    headers: new Headers(headers),
    json: async () => ({ success: true, data }),
  }),
}))

jest.mock('@/lib/data/serving/capabilities', () => ({
  getSourceCapabilities: (...args: unknown[]) => mockGetSourceCapabilities(...args),
}))

import { GET } from '../route'

describe('GET /api/sources/capabilities authority boundary', () => {
  it('reads the request-scoped client and returns triple no-store headers', async () => {
    const capabilities = { bitunix_futures: { surfaces: { copiers: false } } }
    mockGetSourceCapabilities.mockResolvedValueOnce(capabilities)

    const response = await GET({} as NextRequest)
    const body = await response.json()

    expect(mockGetSourceCapabilities).toHaveBeenCalledWith(mockSupabase)
    expect(body).toEqual({ success: true, data: capabilities })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })
})
