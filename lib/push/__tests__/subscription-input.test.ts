import {
  MAX_PUSH_TOKEN_LENGTH,
  PushSubscriptionRegistrationSchema,
  PushSubscriptionTokenBodySchema,
} from '../subscription-input'

describe('push subscription input validation', () => {
  const endpoint = 'https://push.example.test/subscription/one'

  it('accepts a complete Web Push subscription', () => {
    expect(
      PushSubscriptionRegistrationSchema.safeParse({
        token: endpoint,
        provider: 'web',
        platform: 'web',
        endpoint,
        p256dh: 'public-key',
        auth: 'auth-secret',
      }).success
    ).toBe(true)
  })

  it.each([
    ['a mismatched endpoint', { token: endpoint, endpoint: `${endpoint}-other` }],
    ['an insecure endpoint', { token: 'http://push.test/one', endpoint: 'http://push.test/one' }],
    ['missing browser keys', { token: endpoint, endpoint, p256dh: undefined }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      PushSubscriptionRegistrationSchema.safeParse({
        token: endpoint,
        provider: 'web',
        platform: 'web',
        endpoint,
        p256dh: 'public-key',
        auth: 'auth-secret',
        ...overrides,
      }).success
    ).toBe(false)
  })

  it('rejects unknown registration fields and oversized tokens', () => {
    expect(
      PushSubscriptionRegistrationSchema.safeParse({
        token: 'native-token',
        provider: 'fcm',
        unexpected: true,
      }).success
    ).toBe(false)
    expect(
      PushSubscriptionTokenBodySchema.safeParse({ token: 'x'.repeat(MAX_PUSH_TOKEN_LENGTH + 1) })
        .success
    ).toBe(false)
  })
})
