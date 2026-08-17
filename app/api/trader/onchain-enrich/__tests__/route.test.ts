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
import { POST } from '../route'

describe('/api/trader/onchain-enrich V1 source hold', () => {
  it('returns no-store 410 without parsing a request or starting enrichment', async () => {
    const request = { json: jest.fn() } as unknown as NextRequest

    const response = POST(request)

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({ error: 'INGEST_EXECUTION_NOT_PUBLISHED' })
    expect(response.headers).toEqual({
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
    })
    expect(request.json).not.toHaveBeenCalled()
  })
})
