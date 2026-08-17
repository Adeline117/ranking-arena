import {
  isAdminSubscriptionSyncProxyBypassPath,
  isAvatarProxyBypassPath,
  isHealthEvaluateReportProxyBypassPath,
  isHealthHeartbeatProxyBypassPath,
  isInternalNotificationDeliveryProxyBypassPath,
  isPublicEgressProxyBypassPath,
  isReferralProgramProxyBypassPath,
  shouldSkip,
} from '@/proxy'

describe('cron proxy bypass paths', () => {
  it.each(['/api/cron/backfill-avatars', '/api/v1/cron/backfill-avatars'])(
    'bypasses proxy work for %s',
    (pathname) => {
      expect(shouldSkip(pathname)).toBe(true)
    }
  )

  it.each([
    '/api/cronical/backfill-avatars',
    '/api/v1/cronical/backfill-avatars',
    '/api/v1/cron-backfill-avatars',
  ])('does not bypass proxy work for adjacent non-cron path %s', (pathname) => {
    expect(shouldSkip(pathname)).toBe(false)
  })
})

describe('avatar proxy compatibility bypass paths', () => {
  it.each(['/api/avatar', '/api/v1/avatar'])('hands %s directly to its route', (pathname) => {
    expect(isAvatarProxyBypassPath(pathname)).toBe(true)
    expect(shouldSkip(pathname)).toBe(true)
  })

  it.each(['/api/avatar-metadata', '/api/avatar/metadata', '/api/v1/avatar-metadata'])(
    'does not bypass proxy work for adjacent non-avatar route %s',
    (pathname) => {
      expect(isAvatarProxyBypassPath(pathname)).toBe(false)
      expect(shouldSkip(pathname)).toBe(false)
    }
  )
})

describe('admin subscription-sync hold bypass paths', () => {
  it.each(['/api/admin/sync-subscription', '/api/v1/admin/sync-subscription'])(
    'hands %s directly to its authentication-first hold',
    (pathname) => {
      expect(isAdminSubscriptionSyncProxyBypassPath(pathname)).toBe(true)
      expect(shouldSkip(pathname)).toBe(true)
    }
  )

  it.each([
    '/api/admin',
    '/api/admin/sync-subscriptions',
    '/api/admin/sync-subscription/child',
    '/api/admin/users',
    '/api/v1/admin',
    '/api/v1/admin/sync-subscriptions',
    '/api/v1/admin/sync-subscription/child',
    '/api/v1/admin/users',
  ])('does not bypass proxy work for adjacent admin path %s', (pathname) => {
    expect(isAdminSubscriptionSyncProxyBypassPath(pathname)).toBe(false)
    expect(shouldSkip(pathname)).toBe(false)
  })
})

describe('public egress hold bypass paths', () => {
  it.each([
    '/api/cdn-proxy',
    '/api/v1/cdn-proxy',
    '/api/market/alpha',
    '/api/v1/market/alpha',
    '/api/market/arbitrage',
    '/api/v1/market/arbitrage',
    '/api/market/candles',
    '/api/v1/market/candles',
    '/api/market/defi',
    '/api/v1/market/defi',
    '/api/market/exchanges',
    '/api/v1/market/exchanges',
    '/api/market/overview',
    '/api/v1/market/overview',
    '/api/market/coin/bitcoin',
    '/api/v1/market/coin/bitcoin',
    '/api/market/futures',
    '/api/v1/market/futures',
    '/api/market/fear-greed',
    '/api/v1/market/fear-greed',
    '/api/market/sparklines',
    '/api/v1/market/sparklines',
    '/api/market/sectors',
    '/api/v1/market/sectors',
    '/api/posts/link-preview',
    '/api/v1/posts/link-preview',
  ])('hands %s directly to its fixed no-store hold', (pathname) => {
    expect(isPublicEgressProxyBypassPath(pathname)).toBe(true)
    expect(shouldSkip(pathname)).toBe(true)
  })

  it.each([
    '/api/cdn-proxy/child',
    '/api/cdn-proxies',
    '/api/v1/cdn-proxy/child',
    '/api/v1/cdn-proxies',
    '/api/market/alpha/child',
    '/api/market/alphas',
    '/api/v1/market/alpha/child',
    '/api/v1/market/alphas',
    '/api/market/arbitrage/child',
    '/api/market/arbitrages',
    '/api/market/arbitrage-history',
    '/api/v1/market/arbitrage/child',
    '/api/v1/market/arbitrages',
    '/api/v1/market/arbitrage-history',
    '/api/market/candles/child',
    '/api/market/candle',
    '/api/market/candles-history',
    '/api/v1/market/candles/child',
    '/api/v1/market/candle',
    '/api/v1/market/candles-history',
    '/api/market/defi/child',
    '/api/market/defis',
    '/api/market/defi-history',
    '/api/v1/market/defi/child',
    '/api/v1/market/defis',
    '/api/v1/market/defi-history',
    '/api/market/exchanges/child',
    '/api/market/exchange',
    '/api/market/exchanges-history',
    '/api/v1/market/exchanges/child',
    '/api/v1/market/exchange',
    '/api/v1/market/exchanges-history',
    '/api/market/overview/child',
    '/api/market/overviews',
    '/api/market/overview-history',
    '/api/v1/market/overview/child',
    '/api/v1/market/overviews',
    '/api/v1/market/overview-history',
    '/api/market/coin',
    '/api/market/coin/',
    '/api/market/coin/bitcoin/child',
    '/api/market/coins/bitcoin',
    '/api/market/coin-history/bitcoin',
    '/api/v1/market/coin',
    '/api/v1/market/coin/',
    '/api/v1/market/coin/bitcoin/child',
    '/api/v1/market/coins/bitcoin',
    '/api/v1/market/coin-history/bitcoin',
    '/api/market/futures/child',
    '/api/market/future',
    '/api/market/futures-history',
    '/api/v1/market/futures/child',
    '/api/v1/market/future',
    '/api/v1/market/futures-history',
    '/api/market/fear-greed/child',
    '/api/market/fear-greeds',
    '/api/market/fear-greed-history',
    '/api/v1/market/fear-greed/child',
    '/api/v1/market/fear-greeds',
    '/api/v1/market/fear-greed-history',
    '/api/market/sparklines/child',
    '/api/market/sparkline',
    '/api/market/sparklines-history',
    '/api/v1/market/sparklines/child',
    '/api/v1/market/sparkline',
    '/api/v1/market/sparklines-history',
    '/api/market/sectors/child',
    '/api/market/sector',
    '/api/market/sectors-history',
    '/api/v1/market/sectors/child',
    '/api/v1/market/sector',
    '/api/v1/market/sectors-history',
    '/api/posts/link-previews',
    '/api/posts/link-preview/child',
    '/api/v1/posts/link-previews',
    '/api/v1/posts/link-preview/child',
  ])('does not bypass proxy work for adjacent public egress path %s', (pathname) => {
    expect(isPublicEgressProxyBypassPath(pathname)).toBe(false)
    expect(shouldSkip(pathname)).toBe(false)
  })
})

describe('referral-program hold bypass paths', () => {
  it.each(['/api/referral', '/api/referral/apply', '/api/v1/referral', '/api/v1/referral/apply'])(
    'hands %s directly to its authentication-first hold',
    (pathname) => {
      expect(isReferralProgramProxyBypassPath(pathname)).toBe(true)
      expect(shouldSkip(pathname)).toBe(true)
    }
  )

  it.each([
    '/api/referrals',
    '/api/referral-code',
    '/api/referral/apply-history',
    '/api/referral/apply/child',
    '/api/v1/referrals',
    '/api/v1/referral-code',
    '/api/v1/referral/apply-history',
    '/api/v1/referral/apply/child',
  ])('does not bypass proxy work for adjacent referral path %s', (pathname) => {
    expect(isReferralProgramProxyBypassPath(pathname)).toBe(false)
    expect(shouldSkip(pathname)).toBe(false)
  })
})

describe('internal notification-delivery hold bypass paths', () => {
  it.each(['/api/notifications/send', '/api/v1/notifications/send'])(
    'hands %s directly to its service-authentication-first hold',
    (pathname) => {
      expect(isInternalNotificationDeliveryProxyBypassPath(pathname)).toBe(true)
      expect(shouldSkip(pathname)).toBe(true)
    }
  )

  it.each([
    '/api/notifications',
    '/api/notifications/mark-read',
    '/api/notifications/ranking-changes',
    '/api/notifications/send/child',
    '/api/notifications/sends',
    '/api/v1/notifications',
    '/api/v1/notifications/mark-read',
    '/api/v1/notifications/ranking-changes',
    '/api/v1/notifications/send/child',
    '/api/v1/notifications/sends',
  ])('does not bypass proxy work for adjacent notification path %s', (pathname) => {
    expect(isInternalNotificationDeliveryProxyBypassPath(pathname)).toBe(false)
    expect(shouldSkip(pathname)).toBe(false)
  })
})

describe('health evaluator hold bypass paths', () => {
  it.each(['/api/health/evaluate-report', '/api/v1/health/evaluate-report'])(
    'hands %s directly to its authentication-first hold',
    (pathname) => {
      expect(isHealthEvaluateReportProxyBypassPath(pathname)).toBe(true)
      expect(shouldSkip(pathname)).toBe(true)
    }
  )

  it.each([
    '/api/health/evaluate-reports',
    '/api/health/evaluate-report/child',
    '/api/v1/health/evaluate-reports',
    '/api/v1/health/evaluate-report/child',
    '/api/v1/health/detailed',
  ])('does not add an exact bypass for adjacent health path %s', (pathname) => {
    expect(isHealthEvaluateReportProxyBypassPath(pathname)).toBe(false)
  })

  it.each([
    '/api/v1/health/evaluate-reports',
    '/api/v1/health/evaluate-report/child',
    '/api/v1/health/detailed',
  ])('does not bypass proxy work for adjacent versioned health path %s', (pathname) => {
    expect(shouldSkip(pathname)).toBe(false)
  })
})

describe('health heartbeat handoff paths', () => {
  it.each(['/api/health/heartbeat', '/api/v1/health/heartbeat'])(
    'hands %s directly to its route-owned authentication contract',
    (pathname) => {
      expect(isHealthHeartbeatProxyBypassPath(pathname)).toBe(true)
      expect(shouldSkip(pathname)).toBe(true)
    }
  )

  it.each([
    '/api/health/heartbeats',
    '/api/health/heartbeat/child',
    '/api/v1/health/heartbeats',
    '/api/v1/health/heartbeat/child',
    '/api/v1/health/detailed',
  ])('does not add an exact heartbeat handoff for adjacent health path %s', (pathname) => {
    expect(isHealthHeartbeatProxyBypassPath(pathname)).toBe(false)
  })

  it.each([
    '/api/v1/health/heartbeats',
    '/api/v1/health/heartbeat/child',
    '/api/v1/health/detailed',
  ])('does not bypass proxy work for adjacent versioned health path %s', (pathname) => {
    expect(shouldSkip(pathname)).toBe(false)
  })
})
