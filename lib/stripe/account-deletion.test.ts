/** @jest-environment node */

import type Stripe from 'stripe'
import {
  ACCOUNT_DELETION_PAUSE_METADATA_KEY,
  expireOpenSubscriptionCheckouts,
  resumeStripeSubscriptionRenewals,
  stopStripeSubscriptionRenewals,
} from './account-deletion'

const mockListCheckouts = jest.fn()
const mockExpireCheckout = jest.fn()
const mockRetrieveCheckout = jest.fn()
const mockListSubscriptions = jest.fn()
const mockRetrieveSubscription = jest.fn()
const mockUpdateSubscription = jest.fn()
const mockCancelSubscription = jest.fn()
const PAUSE_MARKER = 'user-1'

const stripeClient = {
  checkout: {
    sessions: {
      list: mockListCheckouts,
      expire: mockExpireCheckout,
      retrieve: mockRetrieveCheckout,
    },
  },
  subscriptions: {
    list: mockListSubscriptions,
    retrieve: mockRetrieveSubscription,
    update: mockUpdateSubscription,
    cancel: mockCancelSubscription,
  },
} as unknown as Stripe

function subscription(
  id: string,
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    object: 'subscription',
    id,
    customer: 'cus_owner',
    status: 'active',
    cancel_at_period_end: false,
    metadata: {},
    ...overrides,
  } as Stripe.Subscription
}

function checkout(
  id: string,
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    object: 'checkout.session',
    id,
    customer: 'cus_owner',
    mode: 'subscription',
    status: 'open',
    subscription: null,
    ...overrides,
  } as Stripe.Checkout.Session
}

function page<T>(data: T[], hasMore = false) {
  return { object: 'list', data, has_more: hasMore, url: '/v1/test' }
}

describe('account deletion Stripe shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListCheckouts.mockResolvedValue(page([]))
    mockListSubscriptions.mockResolvedValue(page([]))
    mockUpdateSubscription.mockImplementation(
      async (id: string, update: { cancel_at_period_end?: boolean; metadata?: Stripe.Metadata }) =>
        subscription(id, {
          cancel_at_period_end: update.cancel_at_period_end ?? false,
          metadata: update.metadata ?? {},
        })
    )
    mockCancelSubscription.mockImplementation(async (id: string) =>
      subscription(id, { status: 'canceled' })
    )
  })

  it('discovers and immediately cancels API and consumer subscriptions for the customer', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([subscription('sub_consumer'), subscription('sub_api')])
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: ['sub_consumer', 'sub_api'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_consumer', 'sub_api'],
    })

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockUpdateSubscription).toHaveBeenNthCalledWith(1, 'sub_consumer', {
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER,
      },
    })
    expect(mockUpdateSubscription).toHaveBeenNthCalledWith(2, 'sub_api', {
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER,
      },
    })
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
  })

  it('immediately cancels subscriptions that were already set to end after the period', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([
        subscription('sub_terminal', { status: 'canceled' }),
        subscription('sub_paused', { cancel_at_period_end: true }),
        subscription('sub_deletion_paused', {
          cancel_at_period_end: true,
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        }),
      ])
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: ['sub_terminal', 'sub_paused', 'sub_deletion_paused'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_paused', 'sub_deletion_paused'],
    })
    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1)
    expect(mockUpdateSubscription).toHaveBeenCalledWith('sub_paused', {
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER,
      },
    })
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
  })

  it('validates every discovered subscription owner before changing billing', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([subscription('sub_wrong', { customer: 'cus_other' })])
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: [],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'permanent',
      })
    ).rejects.toThrow('belongs to a different customer')
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it.each(['past_due', 'incomplete'] as Stripe.Subscription.Status[])(
    'immediately cancels %s subscriptions so invoice retries cannot charge a deleted account',
    async (status) => {
      mockListSubscriptions.mockResolvedValue(page([subscription('sub_unpaid', { status })]))

      await expect(
        stopStripeSubscriptionRenewals({
          stripeClient,
          subscriptionIds: ['sub_unpaid'],
          expectedCustomerId: 'cus_owner',
          deletionMode: 'recoverable',
          pauseMarker: PAUSE_MARKER,
        })
      ).resolves.toEqual({
        customerId: 'cus_owner',
        changedSubscriptionIds: ['sub_unpaid'],
      })

      expect(mockCancelSubscription).toHaveBeenCalledWith('sub_unpaid', {
        invoice_now: false,
        prorate: false,
      })
    }
  )

  it('immediately cancels when the latest finalized invoice is still open and retryable', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([
        subscription('sub_open_invoice', {
          status: 'past_due',
          latest_invoice: {
            object: 'invoice',
            id: 'in_retryable',
            status: 'open',
            auto_advance: true,
          } as Stripe.Invoice,
        }),
      ])
    )

    await stopStripeSubscriptionRenewals({
      stripeClient,
      subscriptionIds: ['sub_open_invoice'],
      expectedCustomerId: 'cus_owner',
      deletionMode: 'recoverable',
      pauseMarker: PAUSE_MARKER,
    })

    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_open_invoice', {
      invoice_now: false,
      prorate: false,
    })
  })

  it('re-reads an ambiguously canceled subscription and accepts only a terminal result', async () => {
    mockListSubscriptions.mockResolvedValue(page([subscription('sub_past_due')]))
    mockCancelSubscription.mockRejectedValue(new Error('connection reset after write'))
    mockRetrieveSubscription.mockResolvedValue(
      subscription('sub_past_due', {
        status: 'canceled',
        metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
      })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: ['sub_past_due'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_past_due'],
    })
  })

  it('immediately cancels every live remote subscription before hard deletion', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([subscription('sub_consumer'), subscription('sub_api')])
    )
    mockCancelSubscription.mockImplementation(async (id: string) =>
      subscription(id, { status: 'canceled' })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: ['sub_consumer', 'sub_api'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'permanent',
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_consumer', 'sub_api'],
    })
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
  })

  it('paginates and expires every open Checkout including one-time payments', async () => {
    mockListCheckouts
      .mockResolvedValueOnce(
        page(
          [
            checkout('cs_api_1'),
            checkout('cs_tip', {
              mode: 'payment',
            }),
          ],
          true
        )
      )
      .mockResolvedValueOnce(page([checkout('cs_api_2')]))
    mockExpireCheckout.mockImplementation(async (id: string) => checkout(id, { status: 'expired' }))

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
      })
    ).resolves.toEqual({
      expiredSessionIds: ['cs_api_1', 'cs_tip', 'cs_api_2'],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
    })

    expect(mockListCheckouts).toHaveBeenNthCalledWith(2, {
      customer: 'cus_owner',
      status: 'open',
      limit: 100,
      starting_after: 'cs_tip',
    })
    expect(mockExpireCheckout).toHaveBeenCalledTimes(3)
    expect(mockExpireCheckout).toHaveBeenCalledWith('cs_tip')
  })

  it('returns the exact subscription when open Checkout completes during expiration', async () => {
    mockListCheckouts.mockResolvedValue(page([checkout('cs_raced')]))
    mockExpireCheckout.mockRejectedValue(new Error('session is no longer open'))
    mockRetrieveCheckout.mockResolvedValue(
      checkout('cs_raced', {
        status: 'complete',
        subscription: 'sub_raced',
      })
    )

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
      })
    ).resolves.toEqual({
      expiredSessionIds: [],
      racedSubscriptionIds: ['sub_raced'],
      racedOneTimeSessionIds: [],
    })
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('surfaces a one-time payment that completes during expiration', async () => {
    mockListCheckouts.mockResolvedValue(page([checkout('cs_tip_raced', { mode: 'payment' })]))
    mockExpireCheckout.mockRejectedValue(new Error('session is no longer open'))
    mockRetrieveCheckout.mockResolvedValue(
      checkout('cs_tip_raced', {
        mode: 'payment',
        status: 'complete',
      })
    )

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
      })
    ).resolves.toEqual({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: ['cs_tip_raced'],
    })
  })

  it('fails closed when an open Checkout cannot be made non-payable', async () => {
    mockListCheckouts.mockResolvedValue(page([checkout('cs_open')]))
    mockExpireCheckout.mockRejectedValue(new Error('Stripe unavailable'))
    mockRetrieveCheckout.mockResolvedValue(checkout('cs_open'))

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
      })
    ).rejects.toThrow('remains payable')
  })

  it('resumes only nonterminal subscriptions still scheduled to cancel', async () => {
    mockRetrieveSubscription
      .mockResolvedValueOnce(
        subscription('sub_resume', {
          cancel_at_period_end: true,
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        })
      )
      .mockResolvedValueOnce(
        subscription('sub_terminal', {
          status: 'canceled',
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        })
      )
    mockUpdateSubscription.mockResolvedValue(
      subscription('sub_resume', { cancel_at_period_end: false, metadata: {} })
    )

    await expect(
      resumeStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: ['sub_resume', 'sub_terminal'],
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_resume'],
      terminalMarkedSubscriptionIds: ['sub_terminal'],
    })

    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1)
    expect(mockUpdateSubscription).toHaveBeenCalledWith('sub_resume', {
      cancel_at_period_end: false,
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: '',
      },
    })
  })

  it('enumerates a customer but resumes only subscriptions marked by this deletion', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([
        subscription('sub_api', {
          cancel_at_period_end: true,
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        }),
        subscription('sub_user_cancelled', {
          cancel_at_period_end: true,
          metadata: {},
        }),
      ])
    )
    mockUpdateSubscription.mockResolvedValue(
      subscription('sub_api', { cancel_at_period_end: false, metadata: {} })
    )

    await expect(
      resumeStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: [],
        expectedCustomerId: 'cus_owner',
        includeCustomerSubscriptions: true,
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_api'],
      terminalMarkedSubscriptionIds: [],
    })

    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1)
    expect(mockUpdateSubscription).not.toHaveBeenCalledWith('sub_user_cancelled', expect.anything())
  })

  it('re-enumerates and stops the entire customer after an ambiguous recovery write', async () => {
    mockListSubscriptions
      .mockResolvedValueOnce(
        page([
          subscription('sub_ambiguous', {
            cancel_at_period_end: true,
            metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
          }),
        ])
      )
      .mockResolvedValueOnce(
        page([
          // The first update committed in Stripe but its response was lost.
          subscription('sub_ambiguous', {
            cancel_at_period_end: false,
            metadata: {},
          }),
          // A concurrent/unlinked subscription must also be stopped while the
          // account remains tombstoned.
          subscription('sub_concurrent', {
            cancel_at_period_end: false,
            metadata: {},
          }),
        ])
      )
    mockUpdateSubscription
      .mockRejectedValueOnce(new Error('connection reset after write'))
      .mockImplementation(
        async (
          id: string,
          update: { cancel_at_period_end?: boolean; metadata?: Stripe.Metadata }
        ) =>
          subscription(id, {
            cancel_at_period_end: update.cancel_at_period_end ?? false,
            metadata: update.metadata ?? {},
          })
      )

    await expect(
      resumeStripeSubscriptionRenewals({
        stripeClient,
        subscriptionIds: ['sub_ambiguous'],
        expectedCustomerId: 'cus_owner',
        includeCustomerSubscriptions: true,
        pauseMarker: PAUSE_MARKER,
      })
    ).rejects.toThrow('connection reset after write')

    expect(mockListSubscriptions).toHaveBeenCalledTimes(2)
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_ambiguous', {
      invoice_now: false,
      prorate: false,
    })
    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_concurrent', {
      invoice_now: false,
      prorate: false,
    })
  })
})
