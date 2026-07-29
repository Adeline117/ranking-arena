/** @jest-environment node */

jest.mock('@/lib/env', () => ({
  env: new Proxy({}, { get: (_target, key) => process.env[String(key)] }),
}))

const mockRpc = jest.fn()

jest.mock('@/app/api/stripe/webhook/handlers/shared', () => ({
  getSupabase: () => ({ rpc: mockRpc }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

const mockHandleCheckoutComplete = jest.fn()
const mockHandleCheckoutExpired = jest.fn()
const mockHandleTipPaymentCompleted = jest.fn()
const mockHandleSubscriptionUpdate = jest.fn()
const mockHandleSubscriptionCanceled = jest.fn()
const mockHandleTrialWillEnd = jest.fn()
const mockHandlePaymentSucceeded = jest.fn()
const mockHandlePaymentFailed = jest.fn()
const mockHandlePaymentActionRequired = jest.fn()
const mockHandleInvoiceFinalizationFailed = jest.fn()
const mockHandleChargeRefunded = jest.fn()
const mockHandleRefundLifecycle = jest.fn()
const mockHandleChargeDisputeCreated = jest.fn()
const mockHandleChargeDisputeFundsWithdrawn = jest.fn()
const mockHandleChargeDisputeFundsReinstated = jest.fn()

jest.mock('@/app/api/stripe/webhook/handlers/checkout', () => ({
  carriesTipCheckoutIdentity: (metadata: Record<string, string> | null | undefined) => {
    const candidate = metadata || {}
    return (
      candidate.type === 'tip' ||
      Object.prototype.hasOwnProperty.call(candidate, 'tip_id') ||
      (Object.prototype.hasOwnProperty.call(candidate, 'from_user_id') &&
        Object.prototype.hasOwnProperty.call(candidate, 'post_id') &&
        Object.prototype.hasOwnProperty.call(candidate, 'to_user_id'))
    )
  },
  handleCheckoutComplete: (...args: unknown[]) => mockHandleCheckoutComplete(...args),
  handleCheckoutExpired: (...args: unknown[]) => mockHandleCheckoutExpired(...args),
  handleTipPaymentCompleted: (...args: unknown[]) => mockHandleTipPaymentCompleted(...args),
}))
jest.mock('@/app/api/stripe/webhook/handlers/subscription', () => ({
  handleSubscriptionUpdate: (...args: unknown[]) => mockHandleSubscriptionUpdate(...args),
  handleSubscriptionCanceled: (...args: unknown[]) => mockHandleSubscriptionCanceled(...args),
  handleTrialWillEnd: (...args: unknown[]) => mockHandleTrialWillEnd(...args),
}))
jest.mock('@/app/api/stripe/webhook/handlers/invoice', () => ({
  handlePaymentSucceeded: (...args: unknown[]) => mockHandlePaymentSucceeded(...args),
  handlePaymentFailed: (...args: unknown[]) => mockHandlePaymentFailed(...args),
  handlePaymentActionRequired: (...args: unknown[]) => mockHandlePaymentActionRequired(...args),
  handleInvoiceFinalizationFailed: (...args: unknown[]) =>
    mockHandleInvoiceFinalizationFailed(...args),
}))
jest.mock('@/app/api/stripe/webhook/handlers/refund', () => ({
  handleChargeRefunded: (...args: unknown[]) => mockHandleChargeRefunded(...args),
  handleRefundLifecycle: (...args: unknown[]) => mockHandleRefundLifecycle(...args),
  handleChargeDisputeCreated: (...args: unknown[]) => mockHandleChargeDisputeCreated(...args),
  handleChargeDisputeFundsWithdrawn: (...args: unknown[]) =>
    mockHandleChargeDisputeFundsWithdrawn(...args),
  handleChargeDisputeFundsReinstated: (...args: unknown[]) =>
    mockHandleChargeDisputeFundsReinstated(...args),
}))

jest.mock('@/lib/stripe', () => ({
  constructWebhookEvent: jest.fn(),
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: () => 'test-correlation-id',
  runWithCorrelationId: (_id: string, operation: () => unknown) => operation(),
}))

import { NextRequest } from 'next/server'
import { constructWebhookEvent } from '@/lib/stripe'
import { POST } from '../route'

const constructEventMock = constructWebhookEvent as jest.Mock
const leaseToken = '11111111-1111-4111-8111-111111111111'

function createRequest(signature: string | null = 'valid-signature'): NextRequest {
  const headers = new Headers()
  if (signature) headers.set('stripe-signature', signature)
  return {
    text: jest.fn().mockResolvedValue('{}'),
    headers: { get: (name: string) => headers.get(name) },
  } as unknown as NextRequest
}

function event(type = 'checkout.session.completed') {
  return {
    id: 'evt_test_retryable',
    created: 1_800_000_000,
    livemode: true,
    type,
    data: {
      object: {
        id: 'obj_123',
        customer: 'cus_123',
        metadata: {},
      },
    },
  }
}

describe('POST /api/stripe/webhook', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      STRIPE_SECRET_KEY: 'sk_test_xxx',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_xxx',
    }
    constructEventMock.mockReturnValue(event())
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_stripe_event_v2') {
        return Promise.resolve({
          data: { status: 'claimed', leaseToken },
          error: null,
        })
      }
      if (name === 'finish_stripe_event_v2') {
        return Promise.resolve({ data: { status: 'processed' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('rejects a missing Stripe signature', async () => {
    const response = await POST(createRequest(null))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Missing stripe-signature header' })
  })

  it('verifies the raw request body before claiming an event', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('Invalid signature')
    })

    const response = await POST(createRequest())

    expect(response.status).toBe(400)
    expect(constructEventMock).toHaveBeenCalledWith('{}', 'valid-signature')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('marks an event processed only after its handler succeeds', async () => {
    const response = await POST(createRequest())

    expect(response.status).toBe(200)
    expect(mockHandleCheckoutComplete).toHaveBeenCalledTimes(1)
    expect(mockHandleCheckoutComplete).toHaveBeenCalledWith(expect.anything(), {
      id: 'evt_test_retryable',
      created: 1_800_000_000,
      livemode: true,
    })
    expect(mockRpc.mock.calls).toEqual([
      [
        'claim_stripe_event_v2',
        {
          p_event_id: 'evt_test_retryable',
          p_event_type: 'checkout.session.completed',
          p_livemode: true,
        },
      ],
      [
        'finish_stripe_event_v2',
        {
          p_event_id: 'evt_test_retryable',
          p_event_type: 'checkout.session.completed',
          p_livemode: true,
          p_lease_token: leaseToken,
          p_succeeded: true,
          p_error: null,
        },
      ],
    ])
  })

  it('skips only events that reached the processed state', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'processed' }, error: null })

    const response = await POST(createRequest())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, skipped: true })
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
  })

  it('returns non-2xx for a concurrent processing claim so Stripe retries', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'busy' }, error: null })

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
  })

  it('fails closed when the same event identity arrives with a different type', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'identity_conflict' }, error: null })

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('rejects a claimed response without a valid lease token', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { status: 'claimed', leaseToken: 'not-a-lease' },
      error: null,
    })

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
  })

  it('passes test mode through the exact claim and fenced completion identity', async () => {
    constructEventMock.mockReturnValue({ ...event(), livemode: false })

    const response = await POST(createRequest())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'claim_stripe_event_v2', {
      p_event_id: 'evt_test_retryable',
      p_event_type: 'checkout.session.completed',
      p_livemode: false,
    })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'finish_stripe_event_v2', {
      p_event_id: 'evt_test_retryable',
      p_event_type: 'checkout.session.completed',
      p_livemode: false,
      p_lease_token: leaseToken,
      p_succeeded: true,
      p_error: null,
    })
  })

  it('does not acknowledge work when its completion lease was lost', async () => {
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'claim_stripe_event_v2') {
        return Promise.resolve({
          data: { status: 'claimed', leaseToken },
          error: null,
        })
      }
      if (name === 'finish_stripe_event_v2' && args.p_succeeded === true) {
        return Promise.resolve({ data: { status: 'lease_lost' }, error: null })
      }
      if (name === 'finish_stripe_event_v2') {
        return Promise.resolve({ data: { status: 'lease_lost' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
    expect(mockHandleCheckoutComplete).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenLastCalledWith('finish_stripe_event_v2', {
      p_event_id: 'evt_test_retryable',
      p_event_type: 'checkout.session.completed',
      p_livemode: true,
      p_lease_token: leaseToken,
      p_succeeded: false,
      p_error: 'Stripe event success state was not persisted',
    })
  })

  it('marks a failed handler retryable and succeeds on the next delivery', async () => {
    mockHandleCheckoutComplete
      .mockRejectedValueOnce(new Error('temporary database outage'))
      .mockResolvedValueOnce(undefined)

    const first = await POST(createRequest())
    const second = await POST(createRequest())

    expect(first.status).toBe(500)
    expect(second.status).toBe(200)
    expect(mockHandleCheckoutComplete).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenCalledWith('finish_stripe_event_v2', {
      p_event_id: 'evt_test_retryable',
      p_event_type: 'checkout.session.completed',
      p_livemode: true,
      p_lease_token: leaseToken,
      p_succeeded: false,
      p_error: 'temporary database outage',
    })
    expect(mockRpc).toHaveBeenLastCalledWith('finish_stripe_event_v2', {
      p_event_id: 'evt_test_retryable',
      p_event_type: 'checkout.session.completed',
      p_livemode: true,
      p_lease_token: leaseToken,
      p_succeeded: true,
      p_error: null,
    })
  })

  it('does not acknowledge a paid tip whose local persistence failed', async () => {
    constructEventMock.mockReturnValue({
      ...event(),
      data: {
        object: {
          id: 'cs_tip',
          customer: 'cus_123',
          metadata: { type: 'tip', tip_id: 'tip-123' },
        },
      },
    })
    mockHandleTipPaymentCompleted.mockRejectedValueOnce(new Error('Failed to mark tip completed'))

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
    expect(mockHandleTipPaymentCompleted).toHaveBeenCalledTimes(1)
    expect(mockHandleTipPaymentCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cs_tip' }),
      { id: 'evt_test_retryable', created: 1_800_000_000, livemode: true }
    )
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith('finish_stripe_event_v2', {
      p_event_id: 'evt_test_retryable',
      p_event_type: 'checkout.session.completed',
      p_livemode: true,
      p_lease_token: leaseToken,
      p_succeeded: false,
      p_error: 'Failed to mark tip completed',
    })
  })

  it.each([
    ['tip_id marker', { type: 'group', tip_id: 'tip-123' }],
    [
      'snapshot tuple markers',
      {
        type: 'group',
        from_user_id: 'from-123',
        post_id: 'post-123',
        to_user_id: 'to-123',
      },
    ],
  ])(
    'routes a completed Tip with drifted type via %s to durable Tip review',
    async (_, metadata) => {
      constructEventMock.mockReturnValue({
        ...event(),
        data: {
          object: {
            id: 'cs_tip_drift',
            customer: 'cus_123',
            metadata,
          },
        },
      })
      mockHandleTipPaymentCompleted.mockResolvedValueOnce({
        status: 'manual_review',
        reviewCode: 'invalid_session_state',
      })

      const response = await POST(createRequest())

      expect(response.status).toBe(200)
      expect(mockHandleTipPaymentCompleted).toHaveBeenCalledTimes(1)
      expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['customer.subscription.created', mockHandleSubscriptionUpdate],
    ['customer.subscription.updated', mockHandleSubscriptionUpdate],
    ['customer.subscription.deleted', mockHandleSubscriptionCanceled],
    ['invoice.payment_succeeded', mockHandlePaymentSucceeded],
    ['invoice.paid', mockHandlePaymentSucceeded],
    ['invoice.payment_failed', mockHandlePaymentFailed],
    ['invoice.payment_action_required', mockHandlePaymentActionRequired],
    ['invoice.finalization_failed', mockHandleInvoiceFinalizationFailed],
    ['charge.dispute.created', mockHandleChargeDisputeCreated],
    ['charge.dispute.funds_withdrawn', mockHandleChargeDisputeFundsWithdrawn],
    ['charge.dispute.funds_reinstated', mockHandleChargeDisputeFundsReinstated],
    ['checkout.session.expired', mockHandleCheckoutExpired],
    ['customer.subscription.trial_will_end', mockHandleTrialWillEnd],
  ])('dispatches %s', async (type, handler) => {
    constructEventMock.mockReturnValue(event(type))

    const response = await POST(createRequest())

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    if (
      type === 'checkout.session.expired' ||
      type === 'customer.subscription.created' ||
      type === 'customer.subscription.updated' ||
      type === 'customer.subscription.deleted'
    ) {
      expect(handler).toHaveBeenCalledWith(expect.anything(), {
        id: 'evt_test_retryable',
        created: 1_800_000_000,
        livemode: true,
      })
    }
    if (type === 'invoice.payment_succeeded' || type === 'invoice.paid') {
      expect(handler).toHaveBeenCalledWith(expect.anything(), {
        id: 'evt_test_retryable',
        created: 1_800_000_000,
        livemode: true,
        type,
      })
    }
    if (type === 'invoice.payment_failed') {
      expect(handler).toHaveBeenCalledWith(expect.anything(), {
        id: 'evt_test_retryable',
        created: 1_800_000_000,
        livemode: true,
        type: 'invoice.payment_failed',
      })
    }
    if (
      type === 'charge.dispute.created' ||
      type === 'charge.dispute.funds_withdrawn' ||
      type === 'charge.dispute.funds_reinstated'
    ) {
      expect(handler).toHaveBeenCalledWith(expect.anything(), {
        eventId: 'evt_test_retryable',
        eventCreatedAt: 1_800_000_000,
        livemode: true,
      })
    }
  })

  it.each(['refund.created', 'refund.updated', 'refund.failed'])(
    'dispatches canonical %s through the unified refund lifecycle handler',
    async (type) => {
      const stripeEvent = event(type)
      constructEventMock.mockReturnValue(stripeEvent)

      const response = await POST(createRequest())

      expect(response.status).toBe(200)
      expect(mockHandleRefundLifecycle).toHaveBeenCalledTimes(1)
      expect(mockHandleRefundLifecycle).toHaveBeenCalledWith(stripeEvent.data.object, {
        eventId: 'evt_test_retryable',
        eventCreatedAt: 1_800_000_000,
        livemode: true,
      })
      expect(mockHandleChargeRefunded).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['charge.refunded', mockHandleChargeRefunded, mockHandleRefundLifecycle],
    ['charge.refund.updated', mockHandleRefundLifecycle, mockHandleChargeRefunded],
  ])(
    'dispatches legacy %s through its refund authority adapter',
    async (type, handler, otherRefundHandler) => {
      const stripeEvent = event(type)
      constructEventMock.mockReturnValue(stripeEvent)

      const response = await POST(createRequest())

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(stripeEvent.data.object, {
        eventId: 'evt_test_retryable',
        eventCreatedAt: 1_800_000_000,
        livemode: true,
      })
      expect(otherRefundHandler).not.toHaveBeenCalled()
    }
  )
})
