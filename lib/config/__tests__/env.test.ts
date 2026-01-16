/**
 * 环境配置模块测试
 */

import {
  isProduction,
  isDevelopment,
  isTest,
  getAppUrl,
  isRedisAvailable,
  isSentryConfigured,
} from '../env'

describe('环境配置模块', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('环境检测函数', () => {
    it('isProduction 应该正确检测生产环境', () => {
      // 在测试环境中，NODE_ENV 是 'test'
      expect(isProduction()).toBe(false)
    })

    it('isDevelopment 应该正确检测开发环境', () => {
      // 在测试环境中不是开发环境
      expect(isDevelopment()).toBe(false)
    })

    it('isTest 应该正确检测测试环境', () => {
      expect(isTest()).toBe(true)
    })
  })

  describe('getAppUrl', () => {
    it('应该返回有效的 URL', () => {
      const url = getAppUrl()
      expect(url).toMatch(/^https?:\/\//)
    })
  })

  describe('isRedisAvailable', () => {
    it('应该返回布尔值', () => {
      const result = isRedisAvailable()
      expect(typeof result).toBe('boolean')
    })
  })

  describe('isSentryConfigured', () => {
    it('应该返回布尔值', () => {
      const result = isSentryConfigured()
      expect(typeof result).toBe('boolean')
    })
  })
})
