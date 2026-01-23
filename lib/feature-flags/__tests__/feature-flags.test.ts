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
  getFeatureFlagConfig,
  FEATURE_FLAG_CONFIGS,
} from '../index'

describe('Feature Flags', () => {
  beforeEach(() => {
    // 清理所有覆盖
    clearAllFeatureFlagOverrides()
    // 清理环境变量
    delete process.env.NEXT_PUBLIC_FF_NEW_TRADER_UI
    delete process.env.NEXT_PUBLIC_FF_API_V2
    // 重置 NODE_ENV
    delete process.env.NODE_ENV
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
      
      // 临时修改配置以测试百分比发布
      const originalConfig = FEATURE_FLAG_CONFIGS[flag]
      FEATURE_FLAG_CONFIGS[flag] = {
        ...originalConfig,
        percentage: 50,
      }
      
      try {
        // 同一用户应该始终得到相同结果
        const result1 = isFeatureEnabled(flag, { userId })
        const result2 = isFeatureEnabled(flag, { userId })
        const result3 = isFeatureEnabled(flag, { userId })
        
        expect(result1).toBe(result2)
        expect(result2).toBe(result3)
      } finally {
        // 恢复原始配置
        FEATURE_FLAG_CONFIGS[flag] = originalConfig
      }
    })

    it('should respect user whitelist', () => {
      const flag = FeatureFlags.NEW_TRADER_UI
      const userId = 'whitelisted-user'
      
      // 临时修改配置添加白名单
      const originalConfig = FEATURE_FLAG_CONFIGS[flag]
      FEATURE_FLAG_CONFIGS[flag] = {
        ...originalConfig,
        defaultEnabled: false,
        enabledUserIds: [userId, 'another-user'],
      }
      
      try {
        // 白名单用户应该返回 true
        expect(isFeatureEnabled(flag, { userId })).toBe(true)
        expect(isFeatureEnabled(flag, { userId: 'another-user' })).toBe(true)
        // 非白名单用户应该返回 false
        expect(isFeatureEnabled(flag, { userId: 'other-user' })).toBe(false)
      } finally {
        FEATURE_FLAG_CONFIGS[flag] = originalConfig
      }
    })

    it('should respect user blacklist', () => {
      const flag = FeatureFlags.NEW_TRADER_UI
      const userId = 'blacklisted-user'
      
      // 临时修改配置添加黑名单
      const originalConfig = FEATURE_FLAG_CONFIGS[flag]
      FEATURE_FLAG_CONFIGS[flag] = {
        ...originalConfig,
        defaultEnabled: true,
        disabledUserIds: [userId, 'another-blocked-user'],
      }
      
      try {
        // 黑名单用户应该返回 false（即使默认是 true）
        expect(isFeatureEnabled(flag, { userId })).toBe(false)
        expect(isFeatureEnabled(flag, { userId: 'another-blocked-user' })).toBe(false)
        // 非黑名单用户应该返回 true
        expect(isFeatureEnabled(flag, { userId: 'other-user' })).toBe(true)
      } finally {
        FEATURE_FLAG_CONFIGS[flag] = originalConfig
      }
    })

    it('should respect environment restrictions', () => {
      const flag = FeatureFlags.API_V2
      
      // API_V2 配置了 enabledEnvironments，但不等于强制启用
      // 环境限制只检查是否允许检查，最终还是看 defaultEnabled
      // 在 development 环境下允许检查，但 defaultEnabled 是 false，所以返回 false
      expect(isFeatureEnabled(flag, { environment: 'development' })).toBe(false)
      // 在非 development 环境下不允许检查，直接返回 false
      expect(isFeatureEnabled(flag, { environment: 'production' })).toBe(false)
      expect(isFeatureEnabled(flag, { environment: 'test' })).toBe(false)
      
      // 测试一个在指定环境下启用的功能
      // 临时修改配置来测试环境限制逻辑
      const originalConfig = FEATURE_FLAG_CONFIGS[flag]
      FEATURE_FLAG_CONFIGS[flag] = {
        ...originalConfig,
        defaultEnabled: true,
        enabledEnvironments: ['test'],
      }
      
      try {
        // 在 test 环境下应该返回 true
        expect(isFeatureEnabled(flag, { environment: 'test' })).toBe(true)
        // 在非 test 环境下应该返回 false（环境限制）
        expect(isFeatureEnabled(flag, { environment: 'production' })).toBe(false)
        expect(isFeatureEnabled(flag, { environment: 'development' })).toBe(false)
      } finally {
        FEATURE_FLAG_CONFIGS[flag] = originalConfig
      }
    })

    it('should handle percentage rollout correctly', () => {
      const flag = FeatureFlags.NEW_TRADER_UI
      const userId1 = 'user-1'
      const userId2 = 'user-2'
      
      // 临时修改配置以测试百分比发布
      const originalConfig = FEATURE_FLAG_CONFIGS[flag]
      FEATURE_FLAG_CONFIGS[flag] = {
        ...originalConfig,
        defaultEnabled: false,
        percentage: 100, // 100% 应该全部启用
      }
      
      try {
        // 100% 时应该全部启用
        expect(isFeatureEnabled(flag, { userId: userId1 })).toBe(true)
        expect(isFeatureEnabled(flag, { userId: userId2 })).toBe(true)
        
        // 0% 时应该全部禁用
        FEATURE_FLAG_CONFIGS[flag].percentage = 0
        expect(isFeatureEnabled(flag, { userId: userId1 })).toBe(false)
        expect(isFeatureEnabled(flag, { userId: userId2 })).toBe(false)
      } finally {
        FEATURE_FLAG_CONFIGS[flag] = originalConfig
      }
    })

    it('should prioritize whitelist over blacklist', () => {
      const flag = FeatureFlags.NEW_TRADER_UI
      const userId = 'special-user'
      
      // 临时修改配置：同时存在白名单和黑名单
      const originalConfig = FEATURE_FLAG_CONFIGS[flag]
      FEATURE_FLAG_CONFIGS[flag] = {
        ...originalConfig,
        defaultEnabled: false,
        enabledUserIds: [userId],
        disabledUserIds: [userId], // 同一个用户在两个列表中
      }
      
      try {
        // 白名单应该优先于黑名单
        expect(isFeatureEnabled(flag, { userId })).toBe(true)
      } finally {
        FEATURE_FLAG_CONFIGS[flag] = originalConfig
      }
    })

    it('should prioritize environment variable over all other settings', () => {
      const flag = FeatureFlags.NEW_TRADER_UI
      const userId = 'test-user'
      
      // 临时修改配置
      const originalConfig = FEATURE_FLAG_CONFIGS[flag]
      FEATURE_FLAG_CONFIGS[flag] = {
        ...originalConfig,
        defaultEnabled: false,
        disabledUserIds: [userId],
        percentage: 0,
      }
      
      try {
        // 环境变量应该覆盖所有设置
        process.env.NEXT_PUBLIC_FF_NEW_TRADER_UI = 'true'
        expect(isFeatureEnabled(flag, { userId })).toBe(true)
        
        process.env.NEXT_PUBLIC_FF_NEW_TRADER_UI = 'false'
        expect(isFeatureEnabled(flag, { userId })).toBe(false)
      } finally {
        FEATURE_FLAG_CONFIGS[flag] = originalConfig
        delete process.env.NEXT_PUBLIC_FF_NEW_TRADER_UI
      }
    })
    
    it('should return false for unknown flag', () => {
      // @ts-expect-error - 测试未知 flag
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
  
  describe('getFeatureFlagConfig', () => {
    it('should return config for existing flag', () => {
      const config = getFeatureFlagConfig(FeatureFlags.NEW_TRADER_UI)
      expect(config).toBeDefined()
      expect(config).toHaveProperty('defaultEnabled')
      expect(config).toHaveProperty('percentage')
      expect(config?.description).toBe('新版交易员页面 UI')
    })

    it('should return null for unknown flag', () => {
      // @ts-expect-error - 测试未知 flag
      const config = getFeatureFlagConfig('unknown_flag')
      expect(config).toBeNull()
    })

    it('should return all expected properties', () => {
      const config = getFeatureFlagConfig(FeatureFlags.API_V2)
      expect(config).toMatchObject({
        defaultEnabled: expect.any(Boolean),
        percentage: expect.any(Number),
        envVar: expect.any(String),
        enabledEnvironments: expect.any(Array),
        description: expect.any(String),
      })
    })
  })

  describe('FeatureFlags enum', () => {
    it('should contain expected flags', () => {
      expect(FeatureFlags.NEW_TRADER_UI).toBe('new_trader_ui')
      expect(FeatureFlags.API_V2).toBe('api_v2')
      expect(FeatureFlags.PREMIUM_FEATURES).toBe('premium_features')
      expect(FeatureFlags.DARK_MODE_V2).toBe('dark_mode_v2')
      expect(FeatureFlags.NEW_POST_EDITOR).toBe('new_post_editor')
      expect(FeatureFlags.ENHANCED_SEARCH).toBe('enhanced_search')
      expect(FeatureFlags.AI_RECOMMENDATIONS).toBe('ai_recommendations')
      expect(FeatureFlags.SOCIAL_TRADING).toBe('social_trading')
      expect(FeatureFlags.NOTIFICATIONS_V2).toBe('notifications_v2')
    })
  })
})
