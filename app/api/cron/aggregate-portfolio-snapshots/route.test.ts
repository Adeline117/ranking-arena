jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: jest.fn(),
}))
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn(
      (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
        status: init.status ?? 200,
        headers: new Map(Object.entries(init.headers ?? {})),
        json: async () => body,
      })
    ),
  },
}))

import type { NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { GET } from './route'

const verify = verifyCronSecret as jest.MockedFunction<typeof verifyCronSecret>

describe('legacy portfolio snapshot cron', () => {
  it('keeps authentication but performs a fixed V1 no-op', async () => {
    verify.mockReturnValue(true)
    const response = await GET({} as NextRequest)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'retired',
      snapshots: 0,
      reason: 'Legacy portfolio snapshot aggregation is disabled in Arena V1',
    })
  })

  it('still rejects unauthenticated callers', async () => {
    verify.mockReturnValue(false)
    const response = await GET({} as NextRequest)
    expect(response.status).toBe(401)
  })
})
