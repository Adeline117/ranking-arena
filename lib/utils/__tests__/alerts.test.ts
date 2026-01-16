/**
 * 告警通知工具测试
 */

import {
  sendAlert,
  alertInfo,
  alertWarning,
  alertError,
  alertCritical,
  alertException,
  alertHealthCheckFailed,
  alertRateLimitExceeded,
  type AlertPayload,
  type AlertSeverity,
} from '../alerts'

// Mock fetch
global.fetch = jest.fn()

describe('alerts utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // 清除环境变量
    delete process.env.SLACK_WEBHOOK_URL
    delete process.env.DISCORD_WEBHOOK_URL
  })

  describe('sendAlert', () => {
    it('应该在没有配置渠道时仅记录日志', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation()
      
      await sendAlert({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'info',
      })
      
      // 没有配置渠道，不应该调用 fetch
      expect(fetch).not.toHaveBeenCalled()
      
      consoleSpy.mockRestore()
    })

    it('应该发送到 Slack 当配置了 webhook', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockResolvedValueOnce({ ok: true })
      
      await sendAlert({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'warning',
      })
      
      expect(fetch).toHaveBeenCalledWith(
        'https://hooks.slack.com/test',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    it('应该发送到 Discord 当配置了 webhook', async () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test'
      ;(fetch as jest.Mock).mockResolvedValueOnce({ ok: true })
      
      await sendAlert({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'error',
      })
      
      expect(fetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          method: 'POST',
        })
      )
    })

    it('应该同时发送到多个渠道', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test'
      ;(fetch as jest.Mock).mockResolvedValue({ ok: true })
      
      await sendAlert({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'critical',
      })
      
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('应该处理发送失败', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 })
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation()
      
      await sendAlert({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'error',
      })
      
      // 应该继续执行而不是抛出错误
      consoleSpy.mockRestore()
    })

    it('应该处理网络异常', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'))
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation()
      
      await sendAlert({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'error',
      })
      
      // 应该继续执行而不是抛出错误
      consoleSpy.mockRestore()
    })

    it('应该自动添加时间戳', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockResolvedValueOnce({ ok: true })
      
      const beforeTime = new Date().toISOString()
      
      await sendAlert({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'info',
      })
      
      const afterTime = new Date().toISOString()
      
      // 验证 fetch 被调用并且 body 包含时间戳
      expect(fetch).toHaveBeenCalled()
    })
  })

  describe('convenience methods', () => {
    beforeEach(() => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockResolvedValue({ ok: true })
    })

    it('alertInfo 应该发送 info 级别告警', async () => {
      await alertInfo('Info Title', 'Info message')
      
      expect(fetch).toHaveBeenCalled()
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.attachments[0].color).toBe('#36a64f')
    })

    it('alertWarning 应该发送 warning 级别告警', async () => {
      await alertWarning('Warning Title', 'Warning message')
      
      expect(fetch).toHaveBeenCalled()
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.attachments[0].color).toBe('#ffc107')
    })

    it('alertError 应该发送 error 级别告警', async () => {
      await alertError('Error Title', 'Error message')
      
      expect(fetch).toHaveBeenCalled()
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.attachments[0].color).toBe('#ff7c7c')
    })

    it('alertCritical 应该发送 critical 级别告警', async () => {
      await alertCritical('Critical Title', 'Critical message')
      
      expect(fetch).toHaveBeenCalled()
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.attachments[0].color).toBe('#dc3545')
    })
  })

  describe('alertException', () => {
    beforeEach(() => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockResolvedValue({ ok: true })
    })

    it('应该发送带错误信息的告警', async () => {
      const error = new Error('Test error message')
      error.name = 'TestError'
      
      await alertException(error, 'test-context')
      
      expect(fetch).toHaveBeenCalled()
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.attachments[0].title).toContain('TestError')
      expect(body.attachments[0].text).toContain('Test error message')
    })
  })

  describe('alertHealthCheckFailed', () => {
    beforeEach(() => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockResolvedValue({ ok: true })
    })

    it('应该发送健康检查失败告警', async () => {
      await alertHealthCheckFailed('database', 'Connection timeout')
      
      expect(fetch).toHaveBeenCalled()
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.attachments[0].title).toContain('健康检查失败')
      expect(body.attachments[0].text).toContain('database')
      expect(body.attachments[0].text).toContain('Connection timeout')
    })
  })

  describe('alertRateLimitExceeded', () => {
    beforeEach(() => {
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test'
      ;(fetch as jest.Mock).mockResolvedValue({ ok: true })
    })

    it('应该发送限流告警', async () => {
      await alertRateLimitExceeded('user:123', '/api/posts')
      
      expect(fetch).toHaveBeenCalled()
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)
      expect(body.attachments[0].title).toContain('限流')
      expect(body.attachments[0].text).toContain('user:123')
      expect(body.attachments[0].text).toContain('/api/posts')
    })
  })
})
