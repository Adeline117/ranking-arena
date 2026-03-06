/**
 * Send Alert Tests
 * 测试统一 Telegram 告警系统
 */

import { sendAlert, sendScraperAlert } from './send-alert'

// Mock fetch
global.fetch = jest.fn()

// Mock logger
jest.mock('@/lib/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}))

const originalEnv = process.env

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...originalEnv,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_ALERT_CHAT_ID: 'test-chat-id',
  }
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })
})

afterAll(() => {
  process.env = originalEnv
})

describe('sendAlert', () => {
  test('should return not sent when Telegram env missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
  })

  test('should send via Telegram when configured', async () => {
    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'warning',
    })

    expect(result.sent).toBe(true)
    expect(result.channels).toContain('telegram')
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  test('should handle fetch errors gracefully', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'))

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
  })

  test('should handle non-ok response', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 })

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
  })

  test('should include details in Telegram payload', async () => {
    await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'warning',
      details: {
        'Platform': 'binance',
        'Error Code': 'TIMEOUT',
      },
    })

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.text).toContain('Platform')
    expect(body.text).toContain('binance')
    expect(body.text).toContain('TIMEOUT')
    expect(body.parse_mode).toBe('HTML')
  })

  test('should send correct chat_id', async () => {
    await sendAlert({ title: 'Test', message: 'msg', level: 'critical' })

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.chat_id).toBe('test-chat-id')
  })
})

describe('sendScraperAlert', () => {
  test('should not send when no platforms have issues', async () => {
    const result = await sendScraperAlert([], [], {})
    expect(result.sent).toBe(false)
  })

  test('should send critical alert for critical platforms', async () => {
    await sendScraperAlert(
      ['binance'],
      [],
      { binance: 'Binance' }
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.text).toContain('严重过期')
    expect(body.text).toContain('Binance')
  })

  test('should send warning alert for stale platforms', async () => {
    await sendScraperAlert(
      [],
      ['bybit'],
      { bybit: 'Bybit' }
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.text).toContain('陈旧')
    expect(body.text).toContain('Bybit')
  })

  test('should include both critical and stale platforms', async () => {
    await sendScraperAlert(
      ['binance'],
      ['bybit', 'bitget'],
      { binance: 'Binance', bybit: 'Bybit', bitget: 'Bitget' }
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.text).toContain('Binance')
    expect(body.text).toContain('Bybit')
    expect(body.text).toContain('Bitget')
  })
})
