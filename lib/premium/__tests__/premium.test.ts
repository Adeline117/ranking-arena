/**
 * 会员系统单元测试
 */

import {
  SUBSCRIPTION_PLANS,
  PREMIUM_FEATURES,
  hasFeatureAccess,
  getFeatureLimits,
  getPlan,
} from '../index'
import { formatPrice } from '@/lib/types/premium'
import type { SubscriptionTier, PremiumFeatureId } from '../index'

describe('SUBSCRIPTION_PLANS', () => {
  test('包含所有订阅等级', () => {
    const tiers = SUBSCRIPTION_PLANS.map(plan => plan.id)
    expect(tiers).toContain('free')
    expect(tiers).toContain('pro')
    expect(tiers.length).toBe(2)
  })

  test('每个计划都有名称和描述', () => {
    SUBSCRIPTION_PLANS.forEach(plan => {
      expect(plan.name).toBeTruthy()
      expect(plan.description).toBeTruthy()
    })
  })

  test('价格配置正确', () => {
    SUBSCRIPTION_PLANS.forEach(plan => {
      expect(plan.price).toHaveProperty('monthly')
      expect(plan.price).toHaveProperty('yearly')
    })
  })

  test('免费计划价格为 0', () => {
    const freePlan = SUBSCRIPTION_PLANS.find(p => p.id === 'free')
    expect(freePlan?.price.monthly).toBe(0)
    expect(freePlan?.price.yearly).toBe(0)
  })
})

describe('PREMIUM_FEATURES', () => {
  test('包含核心功能', () => {
    const featureIds = PREMIUM_FEATURES.map(f => f.id)
    expect(featureIds).toContain('trader_comparison')
    expect(featureIds).toContain('api_access')
    expect(featureIds).toContain('trader_alerts')
    expect(featureIds).toContain('advanced_filter')
  })

  test('每个功能都有名称和描述', () => {
    PREMIUM_FEATURES.forEach(feature => {
      expect(feature.name).toBeTruthy()
      expect(feature.description).toBeTruthy()
    })
  })

  test('每个功能都指定了可用等级', () => {
    PREMIUM_FEATURES.forEach(feature => {
      expect(Array.isArray(feature.tier)).toBe(true)
      expect(feature.tier.length).toBeGreaterThan(0)
    })
  })
})

describe('hasFeatureAccess', () => {
  test('免费用户无法访问高级功能', () => {
    expect(hasFeatureAccess('free', 'api_access')).toBe(false)
    expect(hasFeatureAccess('free', 'advanced_analytics')).toBe(false)
  })

  test('Pro 用户可以访问 Pro 级功能', () => {
    // 根据实际配置测试
    const proFeatures = PREMIUM_FEATURES.filter(f => f.tier.includes('pro'))
    proFeatures.forEach(feature => {
      expect(hasFeatureAccess('pro', feature.id)).toBe(true)
    })
  })

  test('Pro 用户可以访问所有 Pro 功能', () => {
    PREMIUM_FEATURES.forEach(feature => {
      if (feature.tier.includes('pro')) {
        expect(hasFeatureAccess('pro', feature.id)).toBe(true)
      }
    })
  })

  test('不存在的功能返回 false', () => {
    expect(hasFeatureAccess('pro', 'nonexistent_feature' as PremiumFeatureId)).toBe(false)
  })
})

describe('getFeatureLimits', () => {
  test('返回正确的限制配置', () => {
    const freeLimits = getFeatureLimits('free')
    expect(freeLimits).toHaveProperty('apiCallsPerDay')
    expect(freeLimits).toHaveProperty('followLimit')
    expect(freeLimits).toHaveProperty('exportsPerMonth')
  })

  test('Pro 等级有更高的限制', () => {
    const freeLimits = getFeatureLimits('free')
    const proLimits = getFeatureLimits('pro')

    expect(proLimits.apiCallsPerDay).toBeGreaterThan(freeLimits.apiCallsPerDay)
    expect(proLimits.followLimit).toBeGreaterThan(freeLimits.followLimit)
    expect(proLimits.historicalDataDays).toBeGreaterThan(freeLimits.historicalDataDays)
  })
})

describe('getPlan', () => {
  test('返回正确的计划', () => {
    const freePlan = getPlan('free')
    expect(freePlan?.id).toBe('free')

    const proPlan = getPlan('pro')
    expect(proPlan?.id).toBe('pro')
  })

  test('无效等级返回 undefined', () => {
    const plan = getPlan('invalid' as SubscriptionTier)
    expect(plan).toBeUndefined()
  })
})

describe('formatPrice', () => {
  test('格式化价格', () => {
    expect(formatPrice(9.99)).toMatch(/\$9\.99/)
  })

  test('免费显示为 "免费"', () => {
    expect(formatPrice(0)).toBe('免费')
  })

  test('联系销售显示正确', () => {
    expect(formatPrice(-1)).toBe('联系销售')
  })
})
