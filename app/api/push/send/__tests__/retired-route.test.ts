/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockGetAuthUser = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

function request(body?: string): NextRequest {
  return new NextRequest('https://example.test/api/push/send', {
    method: 'POST',
    body,
  })
}

function expectNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe(
    'private, no-store, max-age=0, must-revalidate'
  )
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('retired arbitrary push sender', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('authenticates before reading a push body', async () => {
    mockGetAuthUser.mockResolvedValue(null)
    const unreadableBody = jest.fn(() => {
      throw new Error('an unauthenticated body must remain unread')
    })

    const response = await POST({ json: unreadableBody } as never)

    expect(response.status).toBe(401)
    expect(unreadableBody).not.toHaveBeenCalled()
    expectNoStore(response)
  })

  it('returns a fixed no-store tombstone for an authenticated caller', async () => {
    mockGetAuthUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
    const response = await POST(request('{"data":{"type":"ranking_change"}}'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: 'Retired push sender',
      code: 'TRADER_NOTIFICATIONS_NOT_PUBLISHED',
      message:
        'Trader alerts, ranking-change notifications, and personalized digests are temporarily unavailable during V1 verification.',
    })
    expectNoStore(response)
  })

  it('has no push-provider, role, or request-body capability', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/push/send/route.ts'), 'utf8')

    expect(source).not.toContain('getPushNotificationService')
    expect(source).not.toContain("from('user_profiles')")
    expect(source).not.toContain('request.json')
  })
})
