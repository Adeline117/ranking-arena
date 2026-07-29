/** @jest-environment node */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import type { AccountDeletionOneTimeSettlementObservation } from './account-deletion'
import {
  checkAccountDeletionOneTimeSettlementsReady,
  persistAccountDeletionOneTimeSettlementScan,
} from './account-deletion-settlement'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SCAN_TOKEN = '22222222-2222-4222-8222-222222222222'
const mockRpc = jest.fn()
const supabase = { rpc: mockRpc } as unknown as SupabaseClient<Database>

function observation(
  checkoutSessionId: string,
  overrides: Partial<AccountDeletionOneTimeSettlementObservation> = {}
): AccountDeletionOneTimeSettlementObservation {
  return {
    checkoutSessionId,
    livemode: true,
    stripeCustomerId: 'cus_owner',
    productKind: 'tip',
    stripeStatus: 'complete',
    paymentStatus: 'paid',
    ownershipStatus: 'exact',
    ...overrides,
  }
}

describe('durable account deletion one-time settlement RPCs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sorts the complete Session inventory and accepts only an exact sync ACK', async () => {
    mockRpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({
      data: {
        status: 'synced',
        user_id: args.p_user_id,
        stripe_customer_id: args.p_stripe_customer_id,
        scan_token: args.p_scan_token,
        observed_session_ids: ['cs_a', 'cs_b'],
        pending_session_ids: ['cs_b'],
        terminal_session_ids: ['cs_a'],
      },
      error: null,
    }))

    await expect(
      persistAccountDeletionOneTimeSettlementScan({
        supabase,
        userId: USER_ID,
        stripeCustomerId: 'cus_owner',
        observations: [
          observation('cs_b'),
          observation('cs_a', { stripeStatus: 'expired', paymentStatus: 'unpaid' }),
        ],
        scanToken: SCAN_TOKEN,
      })
    ).resolves.toEqual({
      scanToken: SCAN_TOKEN,
      observedSessionIds: ['cs_a', 'cs_b'],
      pendingSessionIds: ['cs_b'],
      terminalSessionIds: ['cs_a'],
    })

    expect(mockRpc).toHaveBeenCalledWith('sync_account_deletion_one_time_settlements', {
      p_user_id: USER_ID,
      p_stripe_customer_id: 'cus_owner',
      p_scan_token: SCAN_TOKEN,
      p_observations: [
        {
          checkout_session_id: 'cs_a',
          livemode: true,
          stripe_customer_id: 'cus_owner',
          product_kind: 'tip',
          stripe_status: 'expired',
          payment_status: 'unpaid',
          ownership_status: 'exact',
        },
        {
          checkout_session_id: 'cs_b',
          livemode: true,
          stripe_customer_id: 'cus_owner',
          product_kind: 'tip',
          stripe_status: 'complete',
          payment_status: 'paid',
          ownership_status: 'exact',
        },
      ],
    })
  })

  it('fails closed when sync omits an observed Session from its partition ACK', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'synced',
        user_id: USER_ID,
        stripe_customer_id: 'cus_owner',
        scan_token: SCAN_TOKEN,
        observed_session_ids: ['cs_pending'],
        pending_session_ids: [],
        terminal_session_ids: [],
      },
      error: null,
    })

    await expect(
      persistAccountDeletionOneTimeSettlementScan({
        supabase,
        userId: USER_ID,
        stripeCustomerId: 'cus_owner',
        observations: [observation('cs_pending')],
        scanToken: SCAN_TOKEN,
      })
    ).rejects.toThrow('exact observed Session set')
  })

  it('fails closed when pending and terminal ACK partitions overlap', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'synced',
        user_id: USER_ID,
        stripe_customer_id: 'cus_owner',
        scan_token: SCAN_TOKEN,
        observed_session_ids: ['cs_a', 'cs_b'],
        pending_session_ids: ['cs_a'],
        terminal_session_ids: ['cs_a'],
      },
      error: null,
    })

    await expect(
      persistAccountDeletionOneTimeSettlementScan({
        supabase,
        userId: USER_ID,
        stripeCustomerId: 'cus_owner',
        observations: [observation('cs_a'), observation('cs_b')],
        scanToken: SCAN_TOKEN,
      })
    ).rejects.toThrow('exact observed Session set')
  })

  it('accepts a pending readiness ACK and exposes every durable blocker', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'pending',
        user_id: USER_ID,
        scan_token: SCAN_TOKEN,
        ready: false,
        pending_session_ids: ['cs_delayed'],
        pending_lifetime_reservations: 1,
        pending_tips: 2,
      },
      error: null,
    })

    await expect(
      checkAccountDeletionOneTimeSettlementsReady({
        supabase,
        userId: USER_ID,
        scanToken: SCAN_TOKEN,
      })
    ).resolves.toEqual({
      ready: false,
      pendingSessionIds: ['cs_delayed'],
      pendingLifetimeReservations: 1,
      pendingTips: 2,
    })
  })

  it('rejects a ready ACK that still reports a pending financial lifecycle', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'ready',
        user_id: USER_ID,
        scan_token: SCAN_TOKEN,
        ready: true,
        pending_session_ids: [],
        pending_lifetime_reservations: 0,
        pending_tips: 1,
      },
      error: null,
    })

    await expect(
      checkAccountDeletionOneTimeSettlementsReady({
        supabase,
        userId: USER_ID,
        scanToken: SCAN_TOKEN,
      })
    ).rejects.toThrow('contradictory pending state')
  })
})
