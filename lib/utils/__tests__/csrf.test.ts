/**
 * CSRF 工具测试
 */

import {
  generateCsrfToken,
  generateTimedCsrfToken,
  validateTimedCsrfToken,
  safeCompare,
  validateCsrfToken,
  getCsrfCookieOptions,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from '../csrf'

describe('CSRF utilities', () => {
  describe('generateCsrfToken', () => {
    it('应该生成 64 字符的 hex 字符串', () => {
      const token = generateCsrfToken()
      expect(token).toMatch(/^[a-f0-9]{64}$/)
    })

    it('应该每次生成不同的 token', () => {
      const token1 = generateCsrfToken()
      const token2 = generateCsrfToken()
      expect(token1).not.toBe(token2)
    })
  })

  describe('generateTimedCsrfToken', () => {
    it('应该生成带时间戳的 token', () => {
      const token = generateTimedCsrfToken()
      expect(token).toMatch(/^[a-z0-9]+\.[a-f0-9]{64}$/)
    })

    it('应该包含时间戳部分', () => {
      const token = generateTimedCsrfToken()
      const [timestamp] = token.split('.')
      const parsed = parseInt(timestamp, 36)
      expect(parsed).toBeGreaterThan(0)
      expect(parsed).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('validateTimedCsrfToken', () => {
    it('应该验证有效的 token', () => {
      const token = generateTimedCsrfToken()
      expect(validateTimedCsrfToken(token)).toBe(true)
    })

    it('应该拒绝空 token', () => {
      expect(validateTimedCsrfToken('')).toBe(false)
      expect(validateTimedCsrfToken(null as unknown as string)).toBe(false)
    })

    it('应该拒绝格式错误的 token', () => {
      expect(validateTimedCsrfToken('no-dot-separator')).toBe(false)
      expect(validateTimedCsrfToken('too.many.dots')).toBe(false)
    })

    it('应该拒绝 token 部分长度不正确的 token', () => {
      const timestamp = Date.now().toString(36)
      expect(validateTimedCsrfToken(`${timestamp}.short`)).toBe(false)
    })

    it('应该拒绝过期的 token', () => {
      // 创建一个 25 小时前的时间戳
      const oldTimestamp = (Date.now() - 25 * 60 * 60 * 1000).toString(36)
      const token = `${oldTimestamp}.${'a'.repeat(64)}`
      expect(validateTimedCsrfToken(token)).toBe(false)
    })
  })

  describe('safeCompare', () => {
    it('应该返回 true 当字符串相等', () => {
      expect(safeCompare('hello', 'hello')).toBe(true)
    })

    it('应该返回 false 当字符串不相等', () => {
      expect(safeCompare('hello', 'world')).toBe(false)
    })

    it('应该返回 false 当长度不同', () => {
      expect(safeCompare('short', 'much longer')).toBe(false)
    })

    it('应该返回 false 当输入为空', () => {
      expect(safeCompare('', 'hello')).toBe(false)
      expect(safeCompare('hello', '')).toBe(false)
      expect(safeCompare('', '')).toBe(false)
      expect(safeCompare(null as unknown as string, 'hello')).toBe(false)
    })
  })

  describe('validateCsrfToken', () => {
    it('应该验证匹配的 cookie 和 header token', () => {
      const token = generateTimedCsrfToken()
      expect(validateCsrfToken(token, token)).toBe(true)
    })

    it('应该拒绝不匹配的 token', () => {
      const token1 = generateTimedCsrfToken()
      const token2 = generateTimedCsrfToken()
      expect(validateCsrfToken(token1, token2)).toBe(false)
    })

    it('应该拒绝缺少 cookie token', () => {
      const token = generateTimedCsrfToken()
      expect(validateCsrfToken(undefined, token)).toBe(false)
    })

    it('应该拒绝缺少 header token', () => {
      const token = generateTimedCsrfToken()
      expect(validateCsrfToken(token, undefined)).toBe(false)
    })
  })

  describe('getCsrfCookieOptions', () => {
    it('应该返回正确的 cookie 名称', () => {
      const options = getCsrfCookieOptions()
      expect(options.name).toBe(CSRF_COOKIE_NAME)
    })

    it('应该设置 httpOnly 为 false', () => {
      const options = getCsrfCookieOptions()
      expect(options.httpOnly).toBe(false)
    })

    it('应该设置 sameSite 为 strict', () => {
      const options = getCsrfCookieOptions()
      expect(options.sameSite).toBe('strict')
    })

    it('应该设置正确的 maxAge', () => {
      const options = getCsrfCookieOptions()
      expect(options.maxAge).toBe(24 * 60 * 60) // 24 小时（秒）
    })
  })

  describe('constants', () => {
    it('应该导出正确的 cookie 名称', () => {
      expect(CSRF_COOKIE_NAME).toBe('csrf-token')
    })

    it('应该导出正确的 header 名称', () => {
      expect(CSRF_HEADER_NAME).toBe('x-csrf-token')
    })
  })
})
