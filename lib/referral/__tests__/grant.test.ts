const mockSendNotification = jest.fn()

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { grantProDays } from '../grant'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const GRANTED_AT = '2026-07-01T00:00:00.000Z'
const identity = {
  sourceKey: 'friend:22222222-2222-4222-8222-222222222222',
  grantedAt: GRANTED_AT,
  metadata: {
    kind: 'friend_trial',
    attribution_id: '22222222-2222-4222-8222-222222222222',
  },
}
const notification = {
  title: 'Pro unlocked',
  message: 'You earned seven days of Pro.',
}

describe('grantProDays', () => {
  const rpc = jest.fn()
  const supabase = { rpc } as unknown as SupabaseClient<Database>

  beforeEach(() => {
    jest.clearAllMocks()
    rpc.mockResolvedValue({ data: { status: 'granted' }, error: null })
  })

  it('writes one stable referral authority through the atomic grant ledger', async () => {
    await expect(grantProDays(supabase, USER_ID, 7, identity, notification)).resolves.toBe(true)

    expect(rpc).toHaveBeenCalledWith('grant_pro_entitlement_days_atomic', {
      p_user_id: USER_ID,
      p_source: 'referral',
      p_source_key: identity.sourceKey,
      p_days: 7,
      p_granted_at: GRANTED_AT,
      p_metadata: identity.metadata,
    })
    expect(mockSendNotification).toHaveBeenCalledWith(
      supabase,
      {
        user_id: USER_ID,
        type: 'referral_reward',
        title: notification.title,
        message: notification.message,
        link: '/settings',
        reference_id: identity.sourceKey,
      },
      'Referral reward notification',
      { deduplicate: true, dedupWindowSeconds: 604800 }
    )
  })

  it('treats an exact ledger replay as success without extending it again', async () => {
    rpc.mockResolvedValue({ data: { status: 'already_granted' }, error: null })

    await expect(grantProDays(supabase, USER_ID, 7, identity, notification)).resolves.toBe(true)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    [{ data: null, error: null }, 'missing ACK'],
    [{ data: { status: 'granted', extra: true }, error: null }, 'non-exact ACK'],
    [{ data: { status: 'identity_conflict' }, error: null }, 'identity conflict'],
    [{ data: { status: 'revoked_grant' }, error: null }, 'revoked grant'],
    [{ data: null, error: { code: 'XX000', message: 'failed' } }, 'RPC failure'],
  ])('fails closed for %s', async (rpcResult) => {
    rpc.mockResolvedValue(rpcResult)

    await expect(grantProDays(supabase, USER_ID, 7, identity, notification)).resolves.toBe(false)

    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})
