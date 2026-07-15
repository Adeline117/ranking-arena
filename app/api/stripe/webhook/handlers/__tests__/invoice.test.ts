import type Stripe from 'stripe'
import { handleInvoiceFinalizationFailed, handlePaymentActionRequired } from '../invoice'

const mockSingle = jest.fn()
const mockSendNotification = jest.fn()
const mockSendRateLimitedAlert = jest.fn()
const mockLoggerInfo = jest.fn()
const mockLoggerWarn = jest.fn()
const mockLoggerError = jest.fn()

const query = {
  select: jest.fn(() => query),
  eq: jest.fn(() => query),
  single: (...args: unknown[]) => mockSingle(...args),
}

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: jest.fn(() => query) }),
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}))

jest.mock('@/lib/stripe', () => ({
  stripe: { subscriptions: { retrieve: jest.fn() } },
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendRateLimitedAlert(...args),
}))

function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_test',
    customer: 'cus_owner',
    ...overrides,
  } as Stripe.Invoice
}

describe('invoice webhook recovery events', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSingle.mockResolvedValue({ data: { id: 'user-1' }, error: null })
    mockSendNotification.mockResolvedValue(undefined)
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: true,
      rateLimited: false,
      channels: ['telegram'],
    })
  })

  it('notifies the owning user when bank verification is required', async () => {
    await handlePaymentActionRequired(invoice())

    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        user_id: 'user-1',
        reference_id: 'payment_action_required_in_test',
      }),
      'stripe-payment-action-required'
    )
  })

  it('does not invent an owner when the invoice has no customer', async () => {
    await handlePaymentActionRequired(invoice({ customer: null }))

    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  it('pages operators when Stripe cannot finalize an invoice', async () => {
    await handleInvoiceFinalizationFailed(
      invoice({
        last_finalization_error: {
          message: 'Tax location unavailable',
        } as Stripe.Invoice.LastFinalizationError,
      })
    )

    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Stripe invoice finalization failed',
        level: 'critical',
      }),
      'stripe:invoice-finalization:in_test',
      expect.any(Number)
    )
  })
})
