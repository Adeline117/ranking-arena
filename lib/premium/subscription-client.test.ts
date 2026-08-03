const mockAuthedFetch = jest.fn()

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

import { fetchVerifiedSubscription, parseSubscriptionResponse } from './subscription-client'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function validSubscription(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    tier: 'pro',
    status: 'active',
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-08-01T00:00:00.000Z',
    trialEndDate: null,
    autoRenew: true,
    paymentMethod: 'stripe',
    usage: {
      apiCallsToday: 1,
      comparisonReportsThisMonth: 2,
      exportsThisMonth: 3,
      currentFollows: 4,
      currentCustomRankings: 0,
    },
    plan: 'monthly',
    currentPeriodEnd: '2026-08-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    ...overrides,
  }
}

describe('subscription client authority', () => {
  beforeEach(() => {
    mockAuthedFetch.mockReset()
  })

  it('accepts the exact current-viewer response', () => {
    expect(parseSubscriptionResponse({ subscription: validSubscription() }, USER_ID)).toMatchObject(
      { userId: USER_ID, tier: 'pro', status: 'active' }
    )
  })

  it.each([
    ['wrong owner', { userId: '22222222-2222-4222-8222-222222222222' }],
    ['unknown tier', { tier: 'elite' }],
    ['inactive status', { status: 'past_due' }],
    ['invalid start date', { startDate: 'not-a-date' }],
    ['invalid renewal state', { autoRenew: 'true' }],
    ['invalid payment method', { paymentMethod: 'cash' }],
    ['unexpected field', { unexpected: true }],
  ])('rejects a response with %s', (_label, overrides) => {
    expect(() =>
      parseSubscriptionResponse({ subscription: validSubscription(overrides) }, USER_ID)
    ).toThrow(/subscription/i)
  })

  it.each([null, -1, 1.5, Number.NaN])('rejects the invalid usage count %p', (count) => {
    expect(() =>
      parseSubscriptionResponse(
        {
          subscription: validSubscription({
            usage: { ...validSubscription().usage, currentFollows: count },
          }),
        },
        USER_ID
      )
    ).toThrow(/subscription/i)
  })

  it('rejects missing and extra response envelope fields', () => {
    expect(() => parseSubscriptionResponse({}, USER_ID)).toThrow(/envelope/i)
    expect(() =>
      parseSubscriptionResponse({ subscription: validSubscription(), stale: true }, USER_ID)
    ).toThrow(/envelope/i)
  })

  it('uses the scoped iOS-safe transport and validates the payload', async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { subscription: validSubscription() },
    })

    try {
      await expect(fetchVerifiedSubscription('access-token', USER_ID, 7)).resolves.toMatchObject({
        userId: USER_ID,
        tier: 'pro',
      })
    } finally {
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor)
    }
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/subscription',
      'GET',
      'access-token',
      undefined,
      10_000,
      { expectedUserId: USER_ID, expectedSessionGeneration: 7 }
    )
  })

  it('fails closed on non-2xx and malformed JSON', async () => {
    mockAuthedFetch.mockResolvedValueOnce({ ok: false, status: 503, data: { error: 'offline' } })
    await expect(fetchVerifiedSubscription('token', USER_ID, 1)).rejects.toThrow(/HTTP 503/)

    mockAuthedFetch.mockResolvedValueOnce({ ok: true, status: 200, data: null })
    await expect(fetchVerifiedSubscription('token', USER_ID, 1)).rejects.toThrow(/malformed JSON/)
  })

  it('rejects stale identity results and invalid request scope', async () => {
    mockAuthedFetch.mockResolvedValueOnce({
      ok: false,
      status: 0,
      data: null,
      stale: true,
    })
    await expect(fetchVerifiedSubscription('token', USER_ID, 1)).rejects.toThrow(/identity changed/)
    await expect(fetchVerifiedSubscription('', USER_ID, 1)).rejects.toThrow(/identity is missing/)
    await expect(fetchVerifiedSubscription('token', USER_ID, -1)).rejects.toThrow(
      /identity is missing/
    )
  })
})
