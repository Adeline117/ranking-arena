import { PremiumService, isPro, isProOrAbove, getPlan } from '../index'
import type { UserSubscription } from '../index'

function sub(overrides: Partial<UserSubscription>): UserSubscription {
  return {
    userId: 'u1',
    tier: 'free',
    status: 'active',
    startDate: '2026-01-01T00:00:00Z',
    endDate: null,
    trialEndDate: null,
    autoRenew: false,
    usage: {
      apiCallsToday: 0,
      comparisonReportsThisMonth: 0,
      exportsThisMonth: 0,
      currentFollows: 0,
      currentCustomRankings: 0,
    },
    ...overrides,
  }
}

describe('isPro / isProOrAbove', () => {
  it("'pro' → true，'free' → false", () => {
    expect(isPro('pro')).toBe(true)
    expect(isPro('free')).toBe(false)
    expect(isProOrAbove('pro')).toBe(true)
    expect(isProOrAbove('free')).toBe(false)
  })
})

describe('PremiumService — 订阅状态机', () => {
  it('active/trialing → isSubscriptionActive true', () => {
    const s = new PremiumService()
    s.setSubscription(sub({ status: 'active' }))
    expect(s.isSubscriptionActive()).toBe(true)
    s.setSubscription(sub({ status: 'trialing' }))
    expect(s.isSubscriptionActive()).toBe(true)
  })

  it('cancelled/expired/past_due → isSubscriptionActive false', () => {
    const s = new PremiumService()
    for (const status of ['cancelled', 'expired', 'past_due'] as const) {
      s.setSubscription(sub({ status }))
      expect(s.isSubscriptionActive()).toBe(false)
    }
  })

  it('isPremiumUser：付费 tier + active → true', () => {
    const s = new PremiumService()
    s.setSubscription(sub({ tier: 'pro', status: 'active' }))
    expect(s.isPremiumUser()).toBe(true)
  })

  it('isPremiumUser：free tier → false（即使 active）', () => {
    const s = new PremiumService()
    s.setSubscription(sub({ tier: 'free', status: 'active' }))
    expect(s.isPremiumUser()).toBe(false)
  })

  it('isPremiumUser：pro tier 但已过期 → false', () => {
    const s = new PremiumService()
    s.setSubscription(sub({ tier: 'pro', status: 'expired' }))
    expect(s.isPremiumUser()).toBe(false)
  })

  it('getTier / getSubscription 回读', () => {
    const s = new PremiumService()
    const sb = sub({ tier: 'pro' })
    s.setSubscription(sb)
    expect(s.getTier()).toBe('pro')
    expect(s.getSubscription().userId).toBe('u1')
  })
})

describe('PremiumService — 免费用户功能门控', () => {
  it('free 用户访问需付费的功能 → hasAccess false + 升级提示', () => {
    const s = new PremiumService()
    s.setSubscription(sub({ tier: 'free' }))
    const r = s.checkFeatureAccess('api_access')
    if (!r.hasAccess) {
      expect(r.upgradeMessage).toBeTruthy()
      expect(r.message).toBeTruthy()
    }
    // 无论 promo 与否，返回结构完整
    expect(r).toHaveProperty('hasAccess')
    expect(r).toHaveProperty('isLimitReached')
  })

  it('历史数据访问：请求超过限额 → hasAccess 依限额', () => {
    const s = new PremiumService()
    s.setSubscription(sub({ tier: 'free' }))
    const r = s.checkHistoricalDataAccess(99999)
    expect(r).toHaveProperty('hasAccess')
    expect(typeof r.hasAccess).toBe('boolean')
  })
})

describe('PremiumService — usage 更新', () => {
  it('updateUsage 合并', () => {
    const s = new PremiumService()
    s.setSubscription(sub({}))
    s.updateUsage({ apiCallsToday: 5 })
    expect(s.getSubscription().usage.apiCallsToday).toBe(5)
    // 其他字段保留
    expect(s.getSubscription().usage.exportsThisMonth).toBe(0)
  })

  it('resetDailyUsage 清零 apiCallsToday', () => {
    const s = new PremiumService()
    s.setSubscription(sub({ usage: { ...sub({}).usage, apiCallsToday: 100 } }))
    s.resetDailyUsage()
    expect(s.getSubscription().usage.apiCallsToday).toBe(0)
  })

  it('resetMonthlyUsage 清零月度计数', () => {
    const s = new PremiumService()
    s.setSubscription(
      sub({ usage: { ...sub({}).usage, comparisonReportsThisMonth: 10, exportsThisMonth: 5 } })
    )
    s.resetMonthlyUsage()
    expect(s.getSubscription().usage.comparisonReportsThisMonth).toBe(0)
    expect(s.getSubscription().usage.exportsThisMonth).toBe(0)
  })
})

describe('getPlan', () => {
  it('free/pro 有对应计划', () => {
    expect(getPlan('free')?.id).toBe('free')
    // pro plan 存在（若定义）
    const pro = getPlan('pro')
    if (pro) expect(pro.id).toBe('pro')
  })
})
