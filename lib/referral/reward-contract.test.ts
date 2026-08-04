import { BASE_URL } from '@/lib/constants/urls'
import { readReferralCodeCreation, readReferralSnapshot } from './reward-contract'

const OWNER = '11111111-1111-4111-8111-111111111111'
const REWARD = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-08-03T12:00:00.000Z'
const CODE = `ra_${'a'.repeat(32)}`

function envelope(data: Record<string, unknown>) {
  return { success: true, data, meta: { timestamp: NOW } }
}

function reward(status: 'not_granted' | 'pending' | 'active' | 'expired' | 'revoked') {
  if (status === 'not_granted') {
    return {
      reward_id: null,
      status,
      granted_days: null,
      entitlement_granted_at: null,
      entitlement_starts_at: null,
      entitlement_expires_at: null,
      entitlement_revoked_at: null,
    }
  }
  return {
    reward_id: REWARD,
    status,
    granted_days: 30,
    entitlement_granted_at: status === 'pending' ? null : NOW,
    entitlement_starts_at: status === 'pending' ? null : '2026-01-01T12:00:00.000Z',
    entitlement_expires_at:
      status === 'pending'
        ? null
        : status === 'expired'
          ? '2026-02-02T12:00:00.000Z'
          : '2099-09-02T12:00:00.000Z',
    entitlement_revoked_at: status === 'revoked' ? '2026-08-04T12:00:00.000Z' : null,
  }
}

describe('referral reward client contract', () => {
  it('accepts an exact owner-bound qualified snapshot with durable grant evidence', () => {
    expect(
      readReferralSnapshot(
        envelope({
          referral: {
            owner_id: OWNER,
            referral_code: CODE,
            referral_link: `${BASE_URL}/?ref=${CODE}`,
            code_source: 'custom',
            qualified_referral_count: 3,
            advocate_reward: reward('active'),
          },
        }),
        { ownerId: OWNER }
      )
    ).toEqual(
      expect.objectContaining({
        ownerId: OWNER,
        qualifiedReferralCount: 3,
        advocateReward: expect.objectContaining({ status: 'active', rewardId: REWARD }),
      })
    )
  })

  it('accepts a missing usable code and a pending durable marker without claiming a grant', () => {
    const parsed = readReferralSnapshot(
      envelope({
        referral: {
          owner_id: OWNER,
          referral_code: null,
          referral_link: null,
          code_source: 'none',
          qualified_referral_count: 8,
          advocate_reward: reward('pending'),
        },
      }),
      { ownerId: OWNER }
    )

    expect(parsed?.referralCode).toBeNull()
    expect(parsed?.advocateReward.status).toBe('pending')
  })

  it.each([
    ['expanded root', { extra: true }],
    ['wrong owner', { owner_id: '33333333-3333-4333-8333-333333333333' }],
    ['untrusted link', { referral_link: 'https://evil.example/?ref=x' }],
    ['fractional count', { qualified_referral_count: 2.5 }],
  ])('rejects %s', (_label, change) => {
    const value = envelope({
      referral: {
        owner_id: OWNER,
        referral_code: CODE,
        referral_link: `${BASE_URL}/?ref=${CODE}`,
        code_source: 'custom',
        qualified_referral_count: 3,
        advocate_reward: reward('active'),
        ...(change.extra ? {} : change),
      },
    }) as Record<string, unknown>
    if (change.extra) value.extra = true
    expect(readReferralSnapshot(value, { ownerId: OWNER })).toBeNull()
  })

  it('rejects count-only reward claims without durable reward/grant identity', () => {
    const claimed = reward('not_granted')
    claimed.status = 'active'
    expect(
      readReferralSnapshot(
        envelope({
          referral: {
            owner_id: OWNER,
            referral_code: CODE,
            referral_link: `${BASE_URL}/?ref=${CODE}`,
            code_source: 'custom',
            qualified_referral_count: 99,
            advocate_reward: claimed,
          },
        }),
        { ownerId: OWNER }
      )
    ).toBeNull()
  })

  it.each(['expired', 'revoked'] as const)(
    'accepts a truthful %s historical entitlement without calling it active',
    (status) => {
      const parsed = readReferralSnapshot(
        envelope({
          referral: {
            owner_id: OWNER,
            referral_code: CODE,
            referral_link: `${BASE_URL}/?ref=${CODE}`,
            code_source: 'custom',
            qualified_referral_count: 3,
            advocate_reward: reward(status),
          },
        }),
        { ownerId: OWNER }
      )
      expect(parsed?.advocateReward.status).toBe(status)
    }
  )

  it('accepts only an exact owner-bound one-time code creation receipt', () => {
    const value = envelope({
      mutation: {
        action: 'create',
        owner_id: OWNER,
        referral_code: CODE,
        referral_link: `${BASE_URL}/?ref=${CODE}`,
        code_source: 'custom',
      },
    })
    expect(readReferralCodeCreation(value, { ownerId: OWNER })).toEqual({
      ownerId: OWNER,
      referralCode: CODE,
      referralLink: `${BASE_URL}/?ref=${CODE}`,
      codeSource: 'custom',
    })
    expect(
      readReferralCodeCreation(
        { ...value, data: { mutation: { ...value.data.mutation, regenerated: true } } },
        { ownerId: OWNER }
      )
    ).toBeNull()
  })
})
