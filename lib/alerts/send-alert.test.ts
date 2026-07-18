/**
 * Send Alert Tests
 * 测试统一 Telegram 告警系统
 */

// Mock the telegram module BEFORE imports
jest.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlertDetailed: jest.fn().mockResolvedValue({ outcome: 'delivered', httpStatus: 200 }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn().mockResolvedValue(null),
}))

import { sendAlert, sendRateLimitedAlert, sendScraperAlert } from './send-alert'
import { sendTelegramAlertDetailed } from '@/lib/notifications/telegram'
import { getSharedRedis } from '@/lib/cache/redis-client'

const mockSendTelegram = sendTelegramAlertDetailed as jest.MockedFunction<
  typeof sendTelegramAlertDetailed
>
const mockGetSharedRedis = getSharedRedis as jest.MockedFunction<typeof getSharedRedis>
const originalFetch = global.fetch

function httpResponse(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSendTelegram.mockResolvedValue({ outcome: 'delivered', httpStatus: 200 })
  mockGetSharedRedis.mockResolvedValue(null)
  delete process.env.ALERT_GITHUB_TOKEN
  delete process.env.ALERT_GITHUB_REPO
  delete process.env.ALERT_WEBHOOK_URL
  global.fetch = jest.fn()
})

afterAll(() => {
  global.fetch = originalFetch
})

describe('sendAlert', () => {
  test('should call the detailed Telegram sender with correct params', async () => {
    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'warning',
    })

    expect(result.sent).toBe(true)
    expect(result.channels).toContain('telegram')
    expect(mockSendTelegram).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        source: '系统告警',
        title: 'Test Alert',
        message: 'Test message',
      })
    )
  })

  test('should return not sent when Telegram fails', async () => {
    mockSendTelegram.mockResolvedValue({
      outcome: 'failed',
      reason: 'network_error',
    })

    const result = await sendAlert({
      title: 'Fail Alert',
      message: 'msg',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
  })

  test('should pass details as string values', async () => {
    await sendAlert({
      title: 'Details Alert',
      message: 'msg',
      level: 'critical',
      details: { count: 42, name: 'test' },
    })

    const call = mockSendTelegram.mock.calls[0][0]
    expect(call.details).toEqual({ count: '42', name: 'test' })
  })

  test('preserves a caller-provided source for Telegram dedup identity', async () => {
    await sendAlert({
      source: 'stripe',
      title: 'Payment integrity',
      message: 'manual review required',
      level: 'critical',
    })

    expect(mockSendTelegram.mock.calls[0][0].source).toBe('stripe')
  })

  test('does not open a GitHub fallback issue for expected Telegram dedup', async () => {
    process.env.ALERT_GITHUB_TOKEN = 'github-token'
    process.env.ALERT_GITHUB_REPO = 'owner/repo'
    mockSendTelegram.mockResolvedValue({
      outcome: 'suppressed',
      reason: 'deduplicated',
    })

    const result = await sendAlert({
      title: 'Already handled',
      message: 'duplicate critical alert',
      level: 'critical',
    })

    expect(result).toEqual({ sent: false, channels: [] })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('opens the independent GitHub channel for a real critical Telegram failure', async () => {
    process.env.ALERT_GITHUB_TOKEN = 'github-token'
    process.env.ALERT_GITHUB_REPO = 'owner/repo'
    mockSendTelegram.mockResolvedValue({
      outcome: 'failed',
      reason: 'http_error',
      httpStatus: 401,
    })
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce(httpResponse(200, { items: [] }))
      .mockResolvedValueOnce(httpResponse(201))

    const result = await sendAlert({
      title: 'Primary channel failed',
      message: 'Telegram returned 401',
      level: 'critical',
    })

    expect(result).toEqual({ sent: true, channels: ['github'] })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  test('does not add an unsolicited GitHub fallback when Telegram was not requested', async () => {
    process.env.ALERT_GITHUB_TOKEN = 'github-token'
    process.env.ALERT_GITHUB_REPO = 'owner/repo'
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook'
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(httpResponse(200))

    const result = await sendAlert({
      title: 'Webhook only',
      message: 'explicit routing',
      level: 'critical',
      channels: ['webhook'],
    })

    expect(result).toEqual({ sent: true, channels: ['webhook'] })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    delete process.env.ALERT_WEBHOOK_URL
  })
})

describe('sendRateLimitedAlert', () => {
  test('does not write a cooldown when only the GitHub fallback delivered', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }
    mockGetSharedRedis.mockResolvedValue(redis as never)
    process.env.ALERT_GITHUB_TOKEN = 'github-token'
    process.env.ALERT_GITHUB_REPO = 'owner/repo'
    mockSendTelegram.mockResolvedValue({
      outcome: 'failed',
      reason: 'http_error',
      httpStatus: 401,
    })
    ;(global.fetch as jest.Mock).mockImplementation(async (input: string | URL | Request) => {
      if (String(input).includes('/search/issues')) {
        return httpResponse(200, { items: [] })
      }
      return httpResponse(201)
    })

    const first = await sendRateLimitedAlert(
      { title: 'Fallback only', message: 'primary failed', level: 'critical' },
      'github-only-cooldown'
    )
    const second = await sendRateLimitedAlert(
      { title: 'Fallback only', message: 'primary failed', level: 'critical' },
      'github-only-cooldown'
    )

    expect(first.sent).toBe(true)
    expect(second.rateLimited).toBe(false)
    expect(mockSendTelegram).toHaveBeenCalledTimes(2)
    expect(redis.set).not.toHaveBeenCalled()
  })

  test('does not resend when the Redis cooldown write fails', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockRejectedValue(new Error('Redis write unavailable')),
    }
    mockGetSharedRedis.mockResolvedValue(redis as never)

    const first = await sendRateLimitedAlert(
      { title: 'Write failure', message: 'send once', level: 'critical' },
      'write-failure-cooldown'
    )
    const second = await sendRateLimitedAlert(
      { title: 'Write failure', message: 'send once', level: 'critical' },
      'write-failure-cooldown'
    )

    expect(first.sent).toBe(true)
    expect(second).toEqual({ sent: false, rateLimited: true, channels: [] })
    expect(mockSendTelegram).toHaveBeenCalledTimes(1)
    expect(redis.set).toHaveBeenCalledTimes(1)
  })
})

describe('sendScraperAlert', () => {
  test('should not send when no platforms have issues', async () => {
    const result = await sendScraperAlert([], [], {})
    expect(result.sent).toBe(false)
    expect(mockSendTelegram).not.toHaveBeenCalled()
  })

  test('should send critical alert for critical platforms', async () => {
    const result = await sendScraperAlert(['binance'], [], { binance: 'Binance' })

    expect(result.sent).toBe(true)
    const call = mockSendTelegram.mock.calls[0][0]
    expect(call.title).toContain('严重过期')
    expect(call.message).toContain('Binance')
  })

  test('should send warning alert for stale platforms', async () => {
    await sendScraperAlert([], ['bybit'], { bybit: 'Bybit' })

    const call = mockSendTelegram.mock.calls[0][0]
    expect(call.title).toContain('陈旧')
    expect(call.message).toContain('Bybit')
  })

  test('should include both critical and stale platforms', async () => {
    await sendScraperAlert(['binance'], ['bybit', 'bitget'], {
      binance: 'Binance',
      bybit: 'Bybit',
      bitget: 'Bitget',
    })

    const call = mockSendTelegram.mock.calls[0][0]
    expect(call.message).toContain('Binance')
    expect(call.message).toContain('Bybit')
    expect(call.message).toContain('Bitget')
  })
})
