import { readReferralApplyAcknowledgement, readTerminalReferralApplyError } from './client-contract'

const VIEWER_ID = '11111111-1111-4111-8111-111111111111'
const REFERRER_ID = '22222222-2222-4222-8222-222222222222'
const ATTRIBUTION_ID = '33333333-3333-4333-8333-333333333333'

function acknowledgement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    status: 'applied',
    referred_id: VIEWER_ID,
    referrer_id: REFERRER_ID,
    attribution_id: ATTRIBUTION_ID,
    created: true,
    code: 'alice-code',
    referrer_handle: 'alice',
    ...overrides,
  }
}

describe('referral apply client contract', () => {
  it('accepts an exact identity-bound applied acknowledgement', () => {
    expect(
      readReferralApplyAcknowledgement(acknowledgement(), {
        viewerId: VIEWER_ID,
        code: 'alice-code',
      })
    ).toEqual({
      status: 'applied',
      referredId: VIEWER_ID,
      referrerId: REFERRER_ID,
      attributionId: ATTRIBUTION_ID,
      created: true,
      code: 'alice-code',
      referrerHandle: 'alice',
    })
  })

  it('accepts an exact idempotent acknowledgement', () => {
    expect(
      readReferralApplyAcknowledgement(
        acknowledgement({ status: 'already_applied', created: false }),
        { viewerId: VIEWER_ID, code: 'alice-code' }
      )
    ).toMatchObject({ status: 'already_applied', created: false })
  })

  it.each([
    ['expanded body', acknowledgement({ unexpected: true })],
    ['wrong viewer', acknowledgement({ referred_id: REFERRER_ID })],
    ['wrong code', acknowledgement({ code: 'other-code' })],
    ['self referrer', acknowledgement({ referrer_id: VIEWER_ID })],
    ['invalid attribution id', acknowledgement({ attribution_id: 'attribution' })],
    ['contradictory created', acknowledgement({ created: false })],
    ['non-normalized handle', acknowledgement({ referrer_handle: 'e\u0301' })],
  ])('rejects a %s', (_label, value) => {
    expect(
      readReferralApplyAcknowledgement(value, { viewerId: VIEWER_ID, code: 'alice-code' })
    ).toBeNull()
  })

  it.each([
    [400, 'REFERRAL_INVALID_CODE'],
    [400, 'REFERRAL_SELF_REFERRAL'],
    [404, 'REFERRAL_CODE_NOT_FOUND'],
    [409, 'REFERRAL_CODE_AMBIGUOUS'],
    [409, 'REFERRAL_ALREADY_ATTRIBUTED'],
  ])('accepts the terminal %i/%s pair', (status, code) => {
    expect(
      readTerminalReferralApplyError(
        { success: false, code, error: 'Referral cannot be applied' },
        status
      )
    ).toBe(code)
  })

  it.each([
    [
      429,
      'REFERRAL_CODE_NOT_FOUND',
      { success: false, code: 'REFERRAL_CODE_NOT_FOUND', error: 'x' },
    ],
    [
      500,
      'REFERRAL_ALREADY_ATTRIBUTED',
      { success: false, code: 'REFERRAL_ALREADY_ATTRIBUTED', error: 'x' },
    ],
    [
      404,
      'expanded error',
      { success: false, code: 'REFERRAL_CODE_NOT_FOUND', error: 'x', extra: true },
    ],
    [404, 'generic error', { error: 'Referral code not found' }],
  ])('rejects non-terminal or malformed %i %s', (status, _label, value) => {
    expect(readTerminalReferralApplyError(value, status)).toBeNull()
  })
})
