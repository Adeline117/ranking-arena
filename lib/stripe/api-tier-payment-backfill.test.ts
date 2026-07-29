import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const mockResolveApiTierInvoicePaymentAuthority = jest.fn()
const mockRecordApiTierInvoicePayment = jest.fn()

jest.mock('@/lib/stripe/api-tier-payment', () => ({
  resolveApiTierInvoicePaymentAuthority: (...args: unknown[]) =>
    mockResolveApiTierInvoicePaymentAuthority(...args),
  recordApiTierInvoicePayment: (...args: unknown[]) => mockRecordApiTierInvoicePayment(...args),
}))

jest.mock('@/lib/stripe/api-tier-reversal-actions', () => ({
  currentStripeLivemode: () => true,
}))

import { drainApiTierPaymentBackfill } from './api-tier-payment-backfill'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_ID = 'cus_api_backfill'
const SUBSCRIPTION_ID = 'sub_api_backfill'

function invoice(index: number): Stripe.Invoice {
  return {
    id: `in_${String(index).padStart(3, '0')}`,
    amount_paid: 4_900,
  } as Stripe.Invoice
}

function harness(options: {
  pages?: Array<{ data: Stripe.Invoice[]; has_more: boolean }>
  listError?: Error
  recordStatus?: 'recorded' | 'already_recorded' | 'identity_conflict' | 'manual_review'
}) {
  const pages = options.pages ?? [
    { data: Array.from({ length: 100 }, (_, index) => invoice(index)), has_more: true },
    { data: [invoice(100)], has_more: false },
  ]
  const list = options.listError
    ? jest.fn().mockRejectedValue(options.listError)
    : jest.fn().mockImplementation(async () => pages.shift())

  const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'claim_api_tier_payment_backfill_targets_atomic') {
      return {
        data: [
          {
            livemode: true,
            stripe_subscription_id: SUBSCRIPTION_ID,
            user_id: USER_ID,
            stripe_customer_id: CUSTOMER_ID,
            last_invoice_id: null,
            lease_token: args.p_worker_token,
          },
        ],
        error: null,
      }
    }
    if (name === 'checkpoint_api_tier_payment_backfill_target_atomic') {
      return { data: 'checkpointed', error: null }
    }
    if (name === 'finish_api_tier_payment_backfill_target_atomic') {
      return {
        data: args.p_succeeded
          ? 'completed'
          : args.p_requires_attention
            ? 'attention'
            : 'retry_scheduled',
        error: null,
      }
    }
    throw new Error(`Unexpected RPC ${name}`)
  })

  mockResolveApiTierInvoicePaymentAuthority.mockImplementation(
    async ({ invoice: value }: { invoice: Stripe.Invoice }) => ({
      userId: USER_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      invoiceId: value.id,
      livemode: true,
    })
  )
  mockRecordApiTierInvoicePayment.mockImplementation(async ({ authority }) => ({
    status: options.recordStatus ?? 'recorded',
    projectionStatus: null,
    shouldCancel: false,
    authority,
  }))

  return {
    stripe: { invoices: { list } } as unknown as Stripe,
    supabase: { rpc } as unknown as SupabaseClient<Database>,
    list,
    rpc,
  }
}

describe('API tier historical paid-Invoice backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('walks beyond 100 invoices and checkpoints only after each durable page', async () => {
    const test = harness({})

    await expect(
      drainApiTierPaymentBackfill({
        stripe: test.stripe,
        supabase: test.supabase,
        limit: 1,
      })
    ).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retryScheduled: 0,
      attention: 0,
      scannedInvoices: 101,
    })

    expect(test.list).toHaveBeenNthCalledWith(1, {
      subscription: SUBSCRIPTION_ID,
      status: 'paid',
      limit: 100,
    })
    expect(test.list).toHaveBeenNthCalledWith(2, {
      subscription: SUBSCRIPTION_ID,
      status: 'paid',
      limit: 100,
      starting_after: 'in_099',
    })
    expect(mockResolveApiTierInvoicePaymentAuthority).toHaveBeenCalledTimes(101)
    expect(mockRecordApiTierInvoicePayment).toHaveBeenCalledTimes(101)
    expect(
      test.rpc.mock.calls
        .filter(([name]) => name === 'checkpoint_api_tier_payment_backfill_target_atomic')
        .map(([, args]) => args)
    ).toEqual([
      expect.objectContaining({ p_last_invoice_id: 'in_099', p_scanned_delta: 100 }),
      expect.objectContaining({ p_last_invoice_id: 'in_100', p_scanned_delta: 1 }),
    ])
  })

  it('marks an exact durable payment conflict for launch-blocking attention', async () => {
    const test = harness({
      pages: [{ data: [invoice(0)], has_more: false }],
      recordStatus: 'identity_conflict',
    })

    await expect(
      drainApiTierPaymentBackfill({
        stripe: test.stripe,
        supabase: test.supabase,
      })
    ).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retryScheduled: 0,
      attention: 1,
      scannedInvoices: 0,
    })

    expect(test.rpc).toHaveBeenLastCalledWith(
      'finish_api_tier_payment_backfill_target_atomic',
      expect.objectContaining({
        p_succeeded: false,
        p_requires_attention: true,
        p_error: expect.stringContaining('persisted identity_conflict'),
      })
    )
  })

  it('keeps transient Stripe pagination failures retryable', async () => {
    const test = harness({ listError: new Error('Stripe invoices unavailable') })

    await expect(
      drainApiTierPaymentBackfill({
        stripe: test.stripe,
        supabase: test.supabase,
      })
    ).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retryScheduled: 1,
      attention: 0,
      scannedInvoices: 0,
    })

    expect(test.rpc).toHaveBeenLastCalledWith(
      'finish_api_tier_payment_backfill_target_atomic',
      expect.objectContaining({
        p_succeeded: false,
        p_requires_attention: false,
        p_error: 'Stripe invoices unavailable',
      })
    )
  })
})
