import {
  isValidTipSessionId,
  readTipCheckoutAcknowledgement,
  readTipVerificationFailure,
  readVerifiedTipPayment,
} from './tip-client-contract'

const VIEWER_ID = '10000000-0000-4000-8000-000000000001'
const POST_ID = '20000000-0000-4000-8000-000000000002'
const RECIPIENT_ID = '30000000-0000-4000-8000-000000000003'
const TIP_ID = '40000000-0000-4000-8000-000000000004'
const SESSION_ID = 'cs_tip_atomic'

function checkoutReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      checkout: {
        tip_id: TIP_ID,
        session_id: SESSION_ID,
        from_user_id: VIEWER_ID,
        post_id: POST_ID,
        to_user_id: RECIPIENT_ID,
        amount_cents: 500,
        currency: 'usd',
        status: 'open',
        url: `https://checkout.stripe.com/c/pay/${SESSION_ID}#opaque-stripe-state`,
        expires_at: '2030-01-01T00:00:00.000Z',
        ...overrides,
      },
    },
    meta: { timestamp: '2026-08-03T12:00:00.000Z' },
  }
}

function verifiedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      tip: {
        tip_id: TIP_ID,
        session_id: SESSION_ID,
        from_user_id: VIEWER_ID,
        post_id: POST_ID,
        to_user_id: RECIPIENT_ID,
        amount_cents: 500,
        currency: 'usd',
        status: 'completed',
        completed_at: '2026-08-03T12:00:00+00:00',
        ...overrides,
      },
    },
    meta: { timestamp: '2026-08-03T12:00:01.000Z' },
  }
}

describe('Tip client payment contracts', () => {
  it('accepts only an exact identity-bound open Checkout receipt', () => {
    expect(
      readTipCheckoutAcknowledgement(checkoutReceipt(), {
        viewerId: VIEWER_ID,
        postId: POST_ID,
        recipientId: RECIPIENT_ID,
        amountCents: 500,
      })
    ).toEqual({
      tipId: TIP_ID,
      sessionId: SESSION_ID,
      expiresAt: '2030-01-01T00:00:00.000Z',
      url: `https://checkout.stripe.com/c/pay/${SESSION_ID}#opaque-stripe-state`,
    })
  })

  it.each([
    ['viewer drift', { from_user_id: RECIPIENT_ID }],
    ['post drift', { post_id: RECIPIENT_ID }],
    ['recipient drift', { to_user_id: POST_ID }],
    ['amount drift', { amount_cents: 300 }],
    ['currency drift', { currency: 'eur' }],
    ['status drift', { status: 'complete' }],
    ['untrusted origin', { url: `https://example.com/c/pay/${SESSION_ID}` }],
    [
      'embedded credentials',
      { url: `https://user:password@checkout.stripe.com/c/pay/${SESSION_ID}` },
    ],
    ['session not in URL path', { url: 'https://checkout.stripe.com/c/pay/cs_other' }],
    ['expired receipt', { expires_at: '2020-01-01T00:00:00.000Z' }],
  ])('rejects checkout %s', (_, override) => {
    expect(
      readTipCheckoutAcknowledgement(checkoutReceipt(override), {
        viewerId: VIEWER_ID,
        postId: POST_ID,
        recipientId: RECIPIENT_ID,
        amountCents: 500,
      })
    ).toBeNull()
  })

  it('rejects an expanded Checkout response', () => {
    expect(
      readTipCheckoutAcknowledgement(
        { ...checkoutReceipt(), message: 'looks successful' },
        {
          viewerId: VIEWER_ID,
          postId: POST_ID,
          recipientId: RECIPIENT_ID,
          amountCents: 500,
        }
      )
    ).toBeNull()
  })

  it('accepts only an exact completed durable Tip receipt', () => {
    expect(
      readVerifiedTipPayment(verifiedReceipt(), {
        viewerId: VIEWER_ID,
        sessionId: SESSION_ID,
      })
    ).toEqual({
      tipId: TIP_ID,
      sessionId: SESSION_ID,
      fromUserId: VIEWER_ID,
      postId: POST_ID,
      toUserId: RECIPIENT_ID,
      amountCents: 500,
      currency: 'usd',
      completedAt: '2026-08-03T12:00:00+00:00',
    })
  })

  it.each([
    ['viewer drift', { from_user_id: RECIPIENT_ID }],
    ['session drift', { session_id: 'cs_other' }],
    ['pending projection', { status: 'pending' }],
    ['refunded projection', { status: 'refunded' }],
    ['invalid amount', { amount_cents: '500' }],
    ['missing completion time', { completed_at: null }],
  ])('rejects verified Tip %s', (_, override) => {
    expect(
      readVerifiedTipPayment(verifiedReceipt(override), {
        viewerId: VIEWER_ID,
        sessionId: SESSION_ID,
      })
    ).toBeNull()
  })

  it('classifies only exact non-success verification acknowledgements', () => {
    expect(
      readTipVerificationFailure(
        {
          success: false,
          code: 'TIP_PAYMENT_PENDING',
          error: 'Tip payment confirmation is still processing.',
        },
        409
      )
    ).toBe('pending')
    expect(
      readTipVerificationFailure(
        {
          success: false,
          code: 'TIP_PAYMENT_REFUNDED',
          error: 'Tip payment has been refunded.',
        },
        410
      )
    ).toBe('refunded')
    expect(
      readTipVerificationFailure(
        {
          success: false,
          code: 'TIP_PAYMENT_PENDING',
          error: 'pending',
          status: 'completed',
        },
        409
      )
    ).toBeNull()
  })

  it('validates the only URL credential accepted by the success page', () => {
    expect(isValidTipSessionId(SESSION_ID)).toBe(true)
    expect(isValidTipSessionId('pi_not_a_session')).toBe(false)
    expect(isValidTipSessionId(null)).toBe(false)
  })
})
