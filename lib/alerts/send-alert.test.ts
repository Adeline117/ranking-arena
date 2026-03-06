/**
 * Send Alert Tests
 * 测试统一 Telegram 告警系统
 */

// Mock the telegram module BEFORE imports
jest.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: jest.fn().mockResolvedValue(true),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import { sendAlert, sendScraperAlert } from './send-alert'
import { sendTelegramAlert } from '@/lib/notifications/telegram'

const mockSendTelegram = sendTelegramAlert as jest.MockedFunction<typeof sendTelegramAlert>

beforeEach(() => {
  jest.clearAllMocks()
  mockSendTelegram.mockResolvedValue(true)
})

describe('sendAlert', () => {
  test('should call sendTelegramAlert with correct params', async () => {
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
    mockSendTelegram.mockResolvedValue(false)

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
})

describe('sendScraperAlert', () => {
  test('should not send when no platforms have issues', async () => {
    const result = await sendScraperAlert([], [], {})
    expect(result.sent).toBe(false)
    expect(mockSendTelegram).not.toHaveBeenCalled()
  })

  test('should send critical alert for critical platforms', async () => {
    const result = await sendScraperAlert(
      ['binance'],
      [],
      { binance: 'Binance' }
    )

    expect(result.sent).toBe(true)
    const call = mockSendTelegram.mock.calls[0][0]
    expect(call.title).toContain('严重过期')
    expect(call.message).toContain('Binance')
  })

  test('should send warning alert for stale platforms', async () => {
    await sendScraperAlert(
      [],
      ['bybit'],
      { bybit: 'Bybit' }
    )

    const call = mockSendTelegram.mock.calls[0][0]
    expect(call.title).toContain('陈旧')
    expect(call.message).toContain('Bybit')
  })

  test('should include both critical and stale platforms', async () => {
    await sendScraperAlert(
      ['binance'],
      ['bybit', 'bitget'],
      { binance: 'Binance', bybit: 'Bybit', bitget: 'Bitget' }
    )

    const call = mockSendTelegram.mock.calls[0][0]
    expect(call.message).toContain('Binance')
    expect(call.message).toContain('Bybit')
    expect(call.message).toContain('Bitget')
  })
})
