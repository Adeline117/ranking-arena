/** @jest-environment node */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'

const mockAssertRuntimeReady = jest.fn()
const mockGetStripe = jest.fn()
const mockCreateStore = jest.fn()
const mockDrain = jest.fn()
const mockJoinGroup = jest.fn()
const mockSendAlert = jest.fn()
const mockReconcileAccountDeletions = jest.fn()
const mockSupabase = { rpc: jest.fn() }

jest.mock('@/lib/api/with-cron', () => ({
  withCron: jest.fn(
    (
      _jobName: string,
      handler: (
        request: NextRequest,
        context: { supabase: typeof mockSupabase }
      ) => Promise<Record<string, unknown>>
    ) =>
      async (request: NextRequest) =>
        Response.json(await handler(request, { supabase: mockSupabase }))
  ),
}))

jest.mock('@/lib/stripe', () => ({
  assertStripePaymentRuntimeReady: () => mockAssertRuntimeReady(),
  getStripe: () => mockGetStripe(),
}))

jest.mock('@/lib/stripe/entitlement-effect-worker', () => ({
  createStripeEntitlementEffectStore: (...args: unknown[]) => mockCreateStore(...args),
  drainStripeEntitlementEffects: (...args: unknown[]) => mockDrain(...args),
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  joinProOfficialGroup: (...args: unknown[]) => mockJoinGroup(...args),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendAlert(...args),
}))

jest.mock('@/lib/account/deletion-billing-reconciliation', () => ({
  reconcilePreparedAccountDeletionBilling: (...args: unknown[]) =>
    mockReconcileAccountDeletions(...args),
}))

import { GET, dynamic, maxDuration, runtime } from '../route'
import { withCron } from '@/lib/api/with-cron'

const mockWithCron = withCron as jest.Mock

describe('Stripe entitlement effect cron', () => {
  beforeEach(() => {
    for (const mock of [
      mockAssertRuntimeReady,
      mockGetStripe,
      mockCreateStore,
      mockDrain,
      mockJoinGroup,
      mockSendAlert,
      mockReconcileAccountDeletions,
    ]) {
      mock.mockReset()
    }
    process.env.STRIPE_SECRET_KEY = 'sk_live_example'
    mockGetStripe.mockReturnValue({ marker: 'stripe' })
    mockCreateStore.mockReturnValue({ marker: 'store' })
    mockDrain.mockResolvedValue({
      count: 1,
      leased: 1,
      completed: 1,
      retryScheduled: 0,
      deadLettered: 0,
      superseded: 0,
    })
    mockReconcileAccountDeletions.mockResolvedValue({ count: 1, examined: 1, settled: 1 })
  })

  afterAll(() => {
    delete process.env.STRIPE_SECRET_KEY
  })

  it('uses the bounded cron contract and drains live-mode effects', async () => {
    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/stripe-entitlement-effects')
    )

    await expect(response.json()).resolves.toMatchObject({
      count: 1,
      completed: 1,
      accountDeletionBilling: { count: 1, examined: 1, settled: 1 },
    })
    expect({ runtime, dynamic, maxDuration }).toEqual({
      runtime: 'nodejs',
      dynamic: 'force-dynamic',
      maxDuration: 60,
    })
    expect(mockWithCron).toHaveBeenCalledWith('stripe-entitlement-effects', expect.any(Function), {
      safetyTimeoutMs: 50_000,
    })
    expect(mockAssertRuntimeReady).toHaveBeenCalledTimes(1)
    expect(mockCreateStore).toHaveBeenCalledWith(mockSupabase)
    expect(mockDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        store: { marker: 'store' },
        stripe: { marker: 'stripe' },
        expectedLivemode: true,
        joinProOfficialGroup: expect.any(Function),
        sendRateLimitedAlert: expect.any(Function),
      }),
      { limit: 10, leaseSeconds: 120 }
    )
    expect(mockReconcileAccountDeletions).toHaveBeenCalledWith({
      supabase: mockSupabase,
      stripeClient: { marker: 'stripe' },
      limit: 5,
    })
  })

  it('fails before leasing when the Stripe runtime is not safe', async () => {
    mockAssertRuntimeReady.mockImplementationOnce(() => {
      throw new Error('runtime closed')
    })

    await expect(
      GET(new NextRequest('https://www.arenafi.org/api/cron/stripe-entitlement-effects'))
    ).rejects.toThrow('runtime closed')
    expect(mockCreateStore).not.toHaveBeenCalled()
    expect(mockDrain).not.toHaveBeenCalled()
    expect(mockReconcileAccountDeletions).not.toHaveBeenCalled()
  })

  it('fails before leasing when the secret key mode is ambiguous', async () => {
    process.env.STRIPE_SECRET_KEY = 'not_a_stripe_key'

    await expect(
      GET(new NextRequest('https://www.arenafi.org/api/cron/stripe-entitlement-effects'))
    ).rejects.toThrow('Stripe secret key mode is invalid')
    expect(mockCreateStore).not.toHaveBeenCalled()
    expect(mockReconcileAccountDeletions).not.toHaveBeenCalled()
  })

  it('surfaces deletion reconciliation failures while still starting the durable effect drain', async () => {
    mockReconcileAccountDeletions.mockRejectedValueOnce(new Error('prepared deletion retry failed'))

    await expect(
      GET(new NextRequest('https://www.arenafi.org/api/cron/stripe-entitlement-effects'))
    ).rejects.toThrow('prepared deletion retry failed')

    expect(mockDrain).toHaveBeenCalledTimes(1)
    expect(mockReconcileAccountDeletions).toHaveBeenCalledTimes(1)
  })

  it('is scheduled every five minutes in the deployment manifest', () => {
    const config = JSON.parse(readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>
    }
    expect(config.crons).toContainEqual({
      path: '/api/cron/stripe-entitlement-effects',
      schedule: '*/5 * * * *',
    })
  })
})
