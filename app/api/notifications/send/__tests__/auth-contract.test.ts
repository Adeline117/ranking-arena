/** @jest-environment node */

// Exercise the route with the real verifyServiceAuth implementation. The V1
// hold must retain both established service credential forms.
jest.mock('@/lib/env', () => ({
  env: {
    CRON_SECRET: 'notification-delivery-cron-secret',
  },
}))

import {
  V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS,
  V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY,
} from '@/lib/notifications/v1-internal-delivery-publication'
import { POST } from '../route'

const originalInternalApiKey = process.env.INTERNAL_API_KEY

function request(headers: Record<string, string>): Request {
  return new Request('https://www.arenafi.org/api/notifications/send?type=ignored', {
    method: 'POST',
    headers,
  })
}

function expectNoStore(response: Response): void {
  for (const [header, value] of Object.entries(
    V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS
  )) {
    expect(response.headers.get(header)).toBe(value)
  }
}

describe('POST /api/notifications/send service credential contract', () => {
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = 'notification-delivery-internal-api-key'
  })

  afterAll(() => {
    if (originalInternalApiKey === undefined) delete process.env.INTERNAL_API_KEY
    else process.env.INTERNAL_API_KEY = originalInternalApiKey
  })

  it('accepts the established CRON_SECRET Bearer credential before the V1 hold', async () => {
    const response = POST(
      request({ authorization: 'Bearer notification-delivery-cron-secret' }) as never
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual(
      V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY
    )
    expectNoStore(response)
  })

  it('accepts the established INTERNAL_API_KEY x-internal-key credential before the V1 hold', async () => {
    const response = POST(
      request({ 'x-internal-key': 'notification-delivery-internal-api-key' }) as never
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual(
      V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY
    )
    expectNoStore(response)
  })

  it.each([{}, { authorization: 'Bearer invalid' }, { 'x-internal-key': 'invalid' }])(
    'rejects invalid service credentials with the same no-store 401',
    async (headers) => {
      const response = POST(request(headers) as never)

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
      expectNoStore(response)
    }
  )
})
