const mockGetSupabaseAdmin = jest.fn()
const mockSendWebPush = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))
jest.mock('@/lib/utils/web-push', () => ({
  sendPushNotification: (...args: unknown[]) => mockSendWebPush(...args),
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { PushNotificationService, type PushSubscription } from '../push-notification'

function queryReturning(result: { data: unknown; error: unknown }) {
  const filters: Array<[string, unknown]> = []
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  }
  query.select.mockReturnValue(query)
  query.eq.mockImplementation((column: string, value: unknown) => {
    filters.push([column, value])
    return query
  })
  query.limit.mockReturnValue(query)
  return { query, filters }
}

describe('PushNotificationService ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('checks active status with both user and token predicates', async () => {
    const { query, filters } = queryReturning({ data: { id: 'subscription-a' }, error: null })
    const from = jest.fn().mockReturnValue(query)
    mockGetSupabaseAdmin.mockReturnValue({ from })
    const service = new PushNotificationService()

    await expect(service.hasActiveSubscription('user-a', 'shared-token')).resolves.toBe(true)

    expect(from).toHaveBeenCalledWith('push_subscriptions')
    expect(filters).toEqual([
      ['user_id', 'user-a'],
      ['token', 'shared-token'],
      ['enabled', true],
    ])
  })

  it('loads Web Push keys for the expected owner even when a token is shared', async () => {
    const { query, filters } = queryReturning({
      data: { endpoint: 'https://push.test/shared', p256dh: 'key-a', auth: 'auth-a' },
      error: null,
    })
    mockGetSupabaseAdmin.mockReturnValue({ from: jest.fn().mockReturnValue(query) })
    mockSendWebPush.mockResolvedValue(true)
    const service = new PushNotificationService()

    await expect(
      service.sendToToken(
        'shared-token',
        'web',
        { title: 'Private A alert', body: 'body', data: { type: 'rank_change' } },
        'user-a'
      )
    ).resolves.toEqual({ success: true })

    expect(filters).toEqual([
      ['user_id', 'user-a'],
      ['token', 'shared-token'],
      ['enabled', true],
    ])
    expect(mockSendWebPush).toHaveBeenCalledWith(
      {
        endpoint: 'https://push.test/shared',
        keys: { p256dh: 'key-a', auth: 'auth-a' },
      },
      expect.objectContaining({ recipientUserId: 'user-a', title: 'Private A alert' })
    )
  })

  it('fails closed when a Web Push send has no owner scope', async () => {
    const from = jest.fn()
    mockGetSupabaseAdmin.mockReturnValue({ from })
    const service = new PushNotificationService()

    await expect(
      service.sendToToken('shared-token', 'web', { title: 'title', body: 'body' })
    ).resolves.toEqual({ success: false, error: 'Web Push requires an owner scope' })
    expect(from).not.toHaveBeenCalled()
  })

  it('disables only the current owner row after an expired Web Push endpoint', async () => {
    mockGetSupabaseAdmin.mockReturnValue({ from: jest.fn() })
    const service = new PushNotificationService()
    const subscription: PushSubscription = {
      id: 'subscription-a',
      userId: 'user-a',
      token: 'shared-token',
      provider: 'web',
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }
    jest.spyOn(service, 'getUserSubscriptions').mockResolvedValue([subscription])
    jest
      .spyOn(service, 'sendToToken')
      .mockResolvedValue({ success: false, error: 'Subscription expired' })
    const disable = jest.spyOn(service, 'disableSubscription').mockResolvedValue()

    await service.sendToUser('user-a', { title: 'title', body: 'body' })

    expect(disable).toHaveBeenCalledWith('user-a', 'shared-token')
  })
})
