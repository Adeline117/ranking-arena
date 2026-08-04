import {
  fetchVerifiedSubscription,
  parseSubscriptionResponse,
  SUBSCRIPTION_REQUEST_TIMEOUT_MS,
} from './subscription-client'

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
  afterEach(() => {
    jest.useRealTimers()
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

  it('fetches with the bearer identity and validates the payload', async () => {
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ subscription: validSubscription() }),
        }) as Response
    )

    await expect(
      fetchVerifiedSubscription('access-token', USER_ID, fetchImpl)
    ).resolves.toMatchObject({ userId: USER_ID, tier: 'pro' })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/subscription',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        headers: { Authorization: 'Bearer access-token' },
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('hard-times-out a fetch implementation that ignores AbortSignal', async () => {
    jest.useFakeTimers()
    const fetchImpl = jest.fn(() => new Promise<Response>(() => undefined))

    const rejection = expect(
      fetchVerifiedSubscription('access-token', USER_ID, fetchImpl)
    ).rejects.toThrow('Subscription request timed out')
    await jest.advanceTimersByTimeAsync(SUBSCRIPTION_REQUEST_TIMEOUT_MS)
    await rejection
  })

  it('keeps the physical deadline through JSON parsing and ignores a late payload', async () => {
    jest.useFakeTimers()
    let resolveBody: ((value: unknown) => void) | undefined
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve
    })
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: () => body }) as Response)

    const rejection = expect(
      fetchVerifiedSubscription('access-token', USER_ID, fetchImpl)
    ).rejects.toThrow('Subscription request timed out')
    await jest.advanceTimersByTimeAsync(SUBSCRIPTION_REQUEST_TIMEOUT_MS)
    await rejection
    resolveBody?.({ subscription: validSubscription() })
    await Promise.resolve()
  })

  it('fails closed on non-2xx and malformed JSON', async () => {
    const unavailable = jest.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          json: async () => ({ error: 'offline' }),
        }) as Response
    )
    await expect(fetchVerifiedSubscription('token', USER_ID, unavailable)).rejects.toThrow(
      /HTTP 503/
    )

    const malformed = jest.fn(
      async () => ({ ok: true, status: 200, json: async () => Promise.reject() }) as Response
    )
    await expect(fetchVerifiedSubscription('token', USER_ID, malformed)).rejects.toThrow(
      /malformed JSON/
    )
  })
})
