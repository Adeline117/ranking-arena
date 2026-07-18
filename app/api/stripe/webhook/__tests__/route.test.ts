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
const mockHandleRefundUpdated = jest.fn()
const mockHandleChargeDisputeCreated = jest.fn()

jest.mock('@/app/api/stripe/webhook/handlers/checkout', () => ({
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
  handleRefundUpdated: (...args: unknown[]) => mockHandleRefundUpdated(...args),
  handleChargeDisputeCreated: (...args: unknown[]) => mockHandleChargeDisputeCreated(...args),
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
      if (name === 'claim_stripe_event') return Promise.resolve({ data: 'claimed', error: null })
      if (name === 'finish_stripe_event') return Promise.resolve({ data: true, error: null })
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
    expect(mockRpc.mock.calls).toEqual([
      [
        'claim_stripe_event',
        {
          p_event_id: 'evt_test_retryable',
          p_event_type: 'checkout.session.completed',
        },
      ],
      [
        'finish_stripe_event',
        {
          p_event_id: 'evt_test_retryable',
          p_succeeded: true,
          p_error: null,
        },
      ],
    ])
  })

  it('skips only events that reached the processed state', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'processed', error: null })

    const response = await POST(createRequest())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, skipped: true })
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
  })

  it('returns non-2xx for a concurrent processing claim so Stripe retries', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'busy', error: null })

    const response = await POST(createRequest())

    expect(response.status).toBe(500)
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
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
    expect(mockRpc).toHaveBeenCalledWith('finish_stripe_event', {
      p_event_id: 'evt_test_retryable',
      p_succeeded: false,
      p_error: 'temporary database outage',
    })
    expect(mockRpc).toHaveBeenLastCalledWith('finish_stripe_event', {
      p_event_id: 'evt_test_retryable',
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
    expect(mockHandleCheckoutComplete).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith('finish_stripe_event', {
      p_event_id: 'evt_test_retryable',
      p_succeeded: false,
      p_error: 'Failed to mark tip completed',
    })
  })

  it.each([
    ['customer.subscription.updated', mockHandleSubscriptionUpdate],
    ['customer.subscription.deleted', mockHandleSubscriptionCanceled],
    ['invoice.payment_succeeded', mockHandlePaymentSucceeded],
    ['invoice.paid', mockHandlePaymentSucceeded],
    ['invoice.payment_failed', mockHandlePaymentFailed],
    ['invoice.payment_action_required', mockHandlePaymentActionRequired],
    ['invoice.finalization_failed', mockHandleInvoiceFinalizationFailed],
    ['charge.refunded', mockHandleChargeRefunded],
    ['charge.refund.updated', mockHandleRefundUpdated],
    ['refund.updated', mockHandleRefundUpdated],
    ['charge.dispute.created', mockHandleChargeDisputeCreated],
    ['checkout.session.expired', mockHandleCheckoutExpired],
    ['customer.subscription.trial_will_end', mockHandleTrialWillEnd],
  ])('dispatches %s', async (type, handler) => {
    constructEventMock.mockReturnValue(event(type))

    const response = await POST(createRequest())

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
