import {
  isAvatarProxyBypassPath,
  isHealthEvaluateReportProxyBypassPath,
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
