/**
 * Send Alert Tests
 * 测试警告通知系统
 */

import { sendAlert, sendScraperAlert } from './send-alert'

// Mock fetch
global.fetch = jest.fn()

// Mock Supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
  })),
}))

import { createClient } from '@supabase/supabase-js'

// Mock environment variables
const originalEnv = process.env

beforeEach(() => {
  jest.clearAllMocks()
  process.env = {
    ...originalEnv,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  }
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })
})

afterAll(() => {
  process.env = originalEnv
})

describe('sendAlert', () => {
  test('should return not sent when no config', async () => {
    // Mock Supabase to return no config
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({ data: null, error: null }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
  })

  test('should return not sent when Supabase env missing', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
  })

  test('should send to Slack when configured', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'warning',
    })

    expect(result.sent).toBe(true)
    expect(result.channels).toContain('slack')
    expect(global.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })

  test('should send to Feishu when configured', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'feishu_webhook_url', value: 'https://open.feishu.cn/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'critical',
    })

    expect(result.sent).toBe(true)
    expect(result.channels).toContain('feishu')
  })

  test('should send to both Slack and Feishu when both configured', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
          { key: 'feishu_webhook_url', value: 'https://open.feishu.cn/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(true)
    expect(result.channels).toContain('slack')
    expect(result.channels).toContain('feishu')
  })

  test('should not send to disabled channels', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: false },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('should handle fetch errors gracefully', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
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
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 })

    const result = await sendAlert({
      title: 'Test Alert',
      message: 'Test message',
      level: 'info',
    })

    expect(result.sent).toBe(false)
    expect(result.channels).toEqual([])
  })

  test('should include details in Slack payload', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

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
    expect(body.attachments[0].fields).toHaveLength(2)
  })

  test('should use correct color for each level', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

    // Info level
    await sendAlert({ title: 'Info', message: 'Test', level: 'info' })
    let body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.attachments[0].color).toBe('#22c55e')

    // Warning level
    ;(global.fetch as jest.Mock).mockClear()
    await sendAlert({ title: 'Warning', message: 'Test', level: 'warning' })
    body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.attachments[0].color).toBe('#f59e0b')

    // Critical level
    ;(global.fetch as jest.Mock).mockClear()
    await sendAlert({ title: 'Critical', message: 'Test', level: 'critical' })
    body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.attachments[0].color).toBe('#ef4444')
  })
})

describe('sendScraperAlert', () => {
  test('should not send when no platforms have issues', async () => {
    const result = await sendScraperAlert([], [], {})
    expect(result.sent).toBe(false)
  })

  test('should send critical alert for critical platforms', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

    await sendScraperAlert(
      ['binance'],
      [],
      { binance: 'Binance' }
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.attachments[0].title).toContain('严重过期')
    expect(body.attachments[0].color).toBe('#ef4444')
  })

  test('should send warning alert for stale platforms', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

    await sendScraperAlert(
      [],
      ['bybit'],
      { bybit: 'Bybit' }
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.attachments[0].title).toContain('陈旧')
    expect(body.attachments[0].color).toBe('#f59e0b')
  })

  test('should include both critical and stale platforms', async () => {
    const mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue({
        data: [
          { key: 'slack_webhook_url', value: 'https://hooks.slack.com/test', enabled: true },
        ],
        error: null,
      }),
    }
    ;(createClient as jest.Mock).mockReturnValue(mockSupabase)
    ;(global.fetch as jest.Mock).mockResolvedValue({ ok: true })

    await sendScraperAlert(
      ['binance'],
      ['bybit', 'bitget'],
      { binance: 'Binance', bybit: 'Bybit', bitget: 'Bitget' }
    )

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.attachments[0].text).toContain('Binance')
    expect(body.attachments[0].text).toContain('Bybit')
    expect(body.attachments[0].text).toContain('Bitget')
  })
})
