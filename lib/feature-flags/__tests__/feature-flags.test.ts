/**
 * 功能开关测试
 */

import {
  FeatureFlags,
  isFeatureEnabled,
  getAllFeatureFlags,
  setFeatureFlagOverride,
  clearFeatureFlagOverride,
  clearAllFeatureFlagOverrides,
  isFeatureEnabledWithOverrides,
  FEATURE_FLAG_CONFIGS,
} from '../index'

describe('Feature Flags', () => {
  beforeEach(() => {
    // 清理所有覆盖
    clearAllFeatureFlagOverrides()
    // 清理环境变量
    delete process.env.NEXT_PUBLIC_FF_NEW_TRADER_UI
  })
  
  describe('isFeatureEnabled', () => {
    it('should return default value when flag is not configured', () => {
      const result = isFeatureEnabled(FeatureFlags.NEW_TRADER_UI)
      expect(result).toBe(FEATURE_FLAG_CONFIGS[FeatureFlags.NEW_TRADER_UI].defaultEnabled)
    })
    
    it('should respect environment variable', () => {
      process.env.NEXT_PUBLIC_FF_NEW_TRADER_UI = 'true'
      const result = isFeatureEnabled(FeatureFlags.NEW_TRADER_UI)
      expect(result).toBe(true)
      
      process.env.NEXT_PUBLIC_FF_NEW_TRADER_UI = 'false'
      const result2 = isFeatureEnabled(FeatureFlags.NEW_TRADER_UI)
      expect(result2).toBe(false)
    })
    
    it('should handle percentage rollout consistently for same user', () => {
      const userId = 'test-user-123'
      const flag = FeatureFlags.NEW_TRADER_UI
      
      // 同一用户应该始终得到相同结果
      const result1 = isFeatureEnabled(flag, { userId })
      const result2 = isFeatureEnabled(flag, { userId })
      const result3 = isFeatureEnabled(flag, { userId })
      
      expect(result1).toBe(result2)
      expect(result2).toBe(result3)
    })
    
    it('should return false for unknown flag', () => {
      // @ts-ignore - 测试未知 flag
      const result = isFeatureEnabled('unknown_flag')
      expect(result).toBe(false)
    })
  })
  
  describe('getAllFeatureFlags', () => {
    it('should return all feature flags', () => {
      const flags = getAllFeatureFlags()
      
      // 检查所有定义的 flag 都存在
      for (const flag of Object.values(FeatureFlags)) {
        expect(flags).toHaveProperty(flag)
        expect(typeof flags[flag]).toBe('boolean')
      }
    })
    
    it('should include user context', () => {
      const flagsWithoutUser = getAllFeatureFlags()
      const flagsWithUser = getAllFeatureFlags({ userId: 'test-user' })
      
      // 两个调用都应该返回有效的 flags 对象
      expect(Object.keys(flagsWithoutUser).length).toBeGreaterThan(0)
      expect(Object.keys(flagsWithUser).length).toBeGreaterThan(0)
    })
  })
  
  describe('Runtime overrides', () => {
    it('should allow setting override', () => {
      const flag = FeatureFlags.NEW_TRADER_UI
      
      // 默认值
      const defaultValue = isFeatureEnabled(flag)
      
      // 设置覆盖
      setFeatureFlagOverride(flag, !defaultValue)
      const overriddenValue = isFeatureEnabledWithOverrides(flag)
      
      expect(overriddenValue).toBe(!defaultValue)
    })
    
    it('should allow clearing override', () => {
      const flag = FeatureFlags.NEW_TRADER_UI
      const defaultValue = isFeatureEnabled(flag)
      
      // 设置覆盖
      setFeatureFlagOverride(flag, !defaultValue)
      
      // 清除覆盖
      clearFeatureFlagOverride(flag)
      const result = isFeatureEnabledWithOverrides(flag)
      
      expect(result).toBe(defaultValue)
    })
    
    it('should allow clearing all overrides', () => {
      setFeatureFlagOverride(FeatureFlags.NEW_TRADER_UI, true)
      setFeatureFlagOverride(FeatureFlags.API_V2, true)
      
      clearAllFeatureFlagOverrides()
      
      const ui = isFeatureEnabledWithOverrides(FeatureFlags.NEW_TRADER_UI)
      const api = isFeatureEnabledWithOverrides(FeatureFlags.API_V2)
      
      expect(ui).toBe(isFeatureEnabled(FeatureFlags.NEW_TRADER_UI))
      expect(api).toBe(isFeatureEnabled(FeatureFlags.API_V2))
    })
  })
  
  describe('FeatureFlags enum', () => {
    it('should contain expected flags', () => {
      expect(FeatureFlags.NEW_TRADER_UI).toBe('new_trader_ui')
      expect(FeatureFlags.API_V2).toBe('api_v2')
      expect(FeatureFlags.PREMIUM_FEATURES).toBe('premium_features')
    })
  })
})
