/** @jest-environment node */

const mockGetSupabaseAdmin = jest.fn()
const mockSearchTraders = jest.fn()
const mockFetch = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: jest.fn(),
  searchTraders: (...args: unknown[]) => mockSearchTraders(...args),
}))

jest.mock('@/lib/constants/exchanges', () => ({ EXCHANGE_CONFIG: {} }))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

jest.mock('@/lib/i18n/bot', () => ({
  botMessages: (_lang: string, key: string) => key,
}))

jest.mock('@/lib/constants/urls', () => ({ BASE_URL: 'https://example.test' }))

import { handleTelegramUpdate } from './telegram-bot'

describe('Telegram trader-alert publication containment', () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token'
    mockFetch.mockResolvedValue({ ok: true })
    global.fetch = mockFetch as typeof fetch
  })

  afterAll(() => {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = originalToken
    global.fetch = originalFetch
  })

  it('does not create a subscription or read trader data for /follow during V1', async () => {
    await handleTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 42, first_name: 'V1 User', language_code: 'en' },
        chat: { id: 100, type: 'private' },
        text: '/follow CryptoKing',
        date: 0,
      },
    })

    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockSearchTraders).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({
      chat_id: 100,
      text: 'followUnavailable',
    })
  })
})
