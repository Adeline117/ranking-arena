/**
 * trader-claims 数据层测试
 */

const mockSendNotification = jest.fn()
const mockInvalidateLinkedTraderCache = jest.fn()
const mockEnqueueFirstPartySync = jest.fn()

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

jest.mock('@/lib/data/linked-traders', () => ({
  invalidateLinkedTraderCache: (...args: unknown[]) => mockInvalidateLinkedTraderCache(...args),
}))

jest.mock('@/lib/ingest/first-party/enqueue', () => ({
  enqueueFirstPartySync: (...args: unknown[]) => mockEnqueueFirstPartySync(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import {
  activateClaim,
  getUserClaimForTrader,
  getUserVerifiedTrader,
  reviewClaim,
  submitClaim,
  updateVerifiedTrader,
  type TraderClaim,
  type VerifiedTrader,
  type UpdateVerifiedTraderInput,
} from '../trader-claims'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const REVIEWER_ID = '22222222-2222-4222-8222-222222222222'

function claim(overrides: Partial<TraderClaim> = {}): TraderClaim {
  return {
    id: CLAIM_ID,
    user_id: USER_ID,
    trader_id: 'trader-1',
    source: 'binance_futures',
    verification_method: 'api_key',
    verification_data: null,
    status: 'verified',
    reject_reason: null,
    reviewed_by: REVIEWER_ID,
    reviewed_at: '2026-07-16T10:00:00.000Z',
    verified_at: '2026-07-16T10:00:00.000Z',
    created_at: '2026-07-15T10:00:00.000Z',
    updated_at: '2026-07-16T10:00:00.000Z',
    ...overrides,
  }
}

function verifiedTrader(overrides: Partial<VerifiedTrader> = {}): VerifiedTrader {
  return {
    id: 'verified-1',
    user_id: USER_ID,
    trader_id: 'trader-1',
    source: 'binance_futures',
    display_name: 'Trader One',
    bio: 'Original bio',
    avatar_url: null,
    twitter_url: null,
    telegram_url: null,
    discord_url: null,
    website_url: null,
    verified_at: '2026-07-16T10:00:00.000Z',
    verification_method: 'api_key',
    can_pin_posts: false,
    can_reply_reviews: true,
    can_receive_messages: true,
    profile_version: 0,
    created_at: '2026-07-15T10:00:00.000Z',
    updated_at: '2026-07-16T10:00:00.000Z',
    ...overrides,
  }
}

function activationPayload(overrides: Record<string, unknown> = {}) {
  return {
    claim: claim(),
    linked_trader_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    primary_link_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    linked_count: 1,
    authorization_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    arena_trader_id: 42,
    ...overrides,
  }
}

describe('trader claim identity scope', () => {
  function scopedClient(data: TraderClaim | null) {
    const builder: Record<string, jest.Mock> = {}
    builder.select = jest.fn(() => builder)
    builder.eq = jest.fn(() => builder)
    builder.order = jest.fn(() => builder)
    builder.limit = jest.fn(() => builder)
    builder.maybeSingle = jest.fn().mockResolvedValue({ data, error: null })
    const from = jest.fn(() => builder)
    const client = { from } as unknown as SupabaseClient<Database>
    return { client, from, builder }
  }

  it('queries the exact user, trader, and source instead of the user latest claim', async () => {
    const { client, from, builder } = scopedClient(null)

    await expect(
      getUserClaimForTrader(client, USER_ID, 'trader-a', 'hyperliquid')
    ).resolves.toBeNull()

    expect(from).toHaveBeenCalledWith('trader_claims')
    expect(builder.eq.mock.calls).toEqual([
      ['user_id', USER_ID],
      ['trader_id', 'trader-a'],
      ['source', 'hyperliquid'],
    ])
  })

  it('returns the matching identity history when it exists', async () => {
    const traderBClaim = claim({
      trader_id: 'trader-b',
      source: 'drift',
      status: 'reviewing',
    })
    const { client } = scopedClient(traderBClaim)

    await expect(getUserClaimForTrader(client, USER_ID, 'trader-b', 'drift')).resolves.toEqual(
      traderBClaim
    )
  })

  it('queries the exact verified profile instead of the user oldest account', async () => {
    const builder: Record<string, jest.Mock> = {}
    builder.select = jest.fn(() => builder)
    builder.eq = jest.fn(() => builder)
    builder.maybeSingle = jest.fn().mockResolvedValue({
      data: verifiedTrader({ trader_id: 'trader-b', source: 'drift' }),
      error: null,
    })
    const from = jest.fn(() => builder)
    const client = { from } as unknown as SupabaseClient<Database>

    await expect(
      getUserVerifiedTrader(client, USER_ID, 'trader-b', 'drift')
    ).resolves.toMatchObject({
      user_id: USER_ID,
      trader_id: 'trader-b',
      source: 'drift',
    })
    expect(from).toHaveBeenCalledWith('verified_traders')
    expect(builder.eq.mock.calls).toEqual([
      ['user_id', USER_ID],
      ['trader_id', 'trader-b'],
      ['source', 'drift'],
    ])
    expect(builder.maybeSingle).toHaveBeenCalledTimes(1)
  })
})

describe('verified trader profile identity scope', () => {
  function rpcClient(data: unknown, error: unknown = null) {
    const rpc = jest.fn().mockResolvedValue({ data, error })
    return {
      client: { rpc } as unknown as SupabaseClient<Database>,
      rpc,
    }
  }

  it('compares the revision inside the exact composite-identity RPC', async () => {
    const acknowledgement = verifiedTrader({
      id: 'verified-b',
      trader_id: 'trader-b',
      display_name: 'Beta Updated',
      profile_version: 8,
    })
    const { client, rpc } = rpcClient(acknowledgement)
    await expect(
      updateVerifiedTrader(
        client,
        USER_ID,
        { trader_id: 'trader-b', source: 'binance_futures' },
        7,
        { display_name: 'Beta Updated' }
      )
    ).resolves.toEqual(acknowledgement)

    expect(rpc).toHaveBeenCalledWith('update_verified_trader_profile_cas', {
      p_user_id: USER_ID,
      p_trader_id: 'trader-b',
      p_source: 'binance_futures',
      p_expected_version: 7,
      p_updates: { display_name: 'Beta Updated' },
    })
  })

  it('accepts a no-op acknowledgement without inventing a revision bump', async () => {
    const acknowledgement = verifiedTrader({ bio: 'Original bio', profile_version: 4 })
    const { client } = rpcClient([acknowledgement])

    await expect(
      updateVerifiedTrader(
        client,
        USER_ID,
        { trader_id: 'trader-1', source: 'binance_futures' },
        4,
        { bio: 'Original bio' }
      )
    ).resolves.toEqual(acknowledgement)
  })

  it('returns null for the service-only not-owned result', async () => {
    const { client } = rpcClient(null, {
      code: 'P0002',
      message: 'owned verified-trader profile not found',
    })

    await expect(
      updateVerifiedTrader(client, USER_ID, { trader_id: 'not-owned', source: 'bybit' }, 0, {
        bio: 'Must not land elsewhere',
      })
    ).resolves.toBeNull()
  })

  it.each([
    ['user', { user_id: 'different-user' }],
    ['trader', { trader_id: 'sibling-trader' }],
    ['source', { source: 'bybit' }],
  ])('rejects a mismatched %s update acknowledgement', async (_field, mismatch) => {
    const { client } = rpcClient(
      verifiedTrader({
        trader_id: 'requested-trader',
        bio: 'Scoped update',
        profile_version: 1,
        ...mismatch,
      })
    )

    await expect(
      updateVerifiedTrader(
        client,
        USER_ID,
        { trader_id: 'requested-trader', source: 'binance_futures' },
        0,
        { bio: 'Scoped update' }
      )
    ).rejects.toThrow('Verified trader update returned a mismatched identity')
  })

  it.each([
    ['an older revision', { profile_version: 6 }],
    ['a skipped revision', { profile_version: 9 }],
    ['a value that was not persisted', { bio: 'Different value', profile_version: 8 }],
  ])('rejects %s in the database acknowledgement', async (_label, mismatch) => {
    const { client } = rpcClient(
      verifiedTrader({
        trader_id: 'requested-trader',
        bio: 'Scoped update',
        profile_version: 8,
        ...mismatch,
      })
    )
    await expect(
      updateVerifiedTrader(
        client,
        USER_ID,
        { trader_id: 'requested-trader', source: 'binance_futures' },
        7,
        { bio: 'Scoped update' }
      )
    ).rejects.toThrow('Verified trader update returned a mismatched identity')
  })

  it('propagates the exact stale-revision database error', async () => {
    const databaseError = {
      code: '40001',
      message: 'verified-trader profile changed since it was loaded',
    }
    const { client } = rpcClient(null, databaseError)

    await expect(
      updateVerifiedTrader(
        client,
        USER_ID,
        { trader_id: 'requested-trader', source: 'binance_futures' },
        7,
        { bio: 'Scoped update' }
      )
    ).rejects.toBe(databaseError)
  })
})

describe('trader claim atomic mutations', () => {
  const mockRpc = jest.fn()
  const mockFrom = jest.fn()
  const client = { rpc: mockRpc, from: mockFrom } as unknown as SupabaseClient<Database>

  beforeEach(() => {
    jest.clearAllMocks()
    mockInvalidateLinkedTraderCache.mockResolvedValue(undefined)
    mockEnqueueFirstPartySync.mockResolvedValue(true)
  })

  it.each(['object', 'singleton array'])(
    'submits through the atomic RPC (%s response)',
    async (shape) => {
      const submitted = claim({
        status: 'reviewing',
        verification_data: { uid_hash: 'proof' },
        reject_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        verified_at: null,
      })
      mockRpc.mockResolvedValue({
        data: shape === 'object' ? submitted : [submitted],
        error: null,
      })

      await expect(
        submitClaim(client, USER_ID, {
          trader_id: 'trader-1',
          source: 'binance_futures',
          verification_method: 'api_key',
          verification_data: { uid_hash: 'proof' },
        })
      ).resolves.toEqual(submitted)

      expect(mockRpc).toHaveBeenCalledWith('submit_trader_claim', {
        p_user_id: USER_ID,
        p_trader_id: 'trader-1',
        p_source: 'binance_futures',
        p_verification_method: 'api_key',
        p_verification_data: { uid_hash: 'proof' },
      })
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    [],
    [claim(), claim()],
    claim({ status: 'verified' }),
    claim({ status: 'reviewing', user_id: 'different-user' }),
    claim({ status: 'reviewing', verification_data: null }),
  ])('rejects a malformed submit acknowledgement without side effects', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(
      submitClaim(client, USER_ID, {
        trader_id: 'trader-1',
        source: 'binance_futures',
        verification_method: 'api_key',
        verification_data: { uid_hash: 'proof' },
      })
    ).rejects.toThrow('Invalid submit_trader_claim response')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('propagates an atomic submit conflict without a fallback table write', async () => {
    const rpcError = { code: '23505', message: 'active identity conflict' }
    mockRpc.mockResolvedValue({ data: null, error: rpcError })

    await expect(
      submitClaim(client, USER_ID, {
        trader_id: 'trader-1',
        source: 'binance_futures',
        verification_method: 'api_key',
        verification_data: { uid_hash: 'proof' },
      })
    ).rejects.toBe(rpcError)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('approves through one atomic RPC before all post-commit effects', async () => {
    mockRpc.mockResolvedValue({ data: activationPayload(), error: null })

    await expect(reviewClaim(client, CLAIM_ID, REVIEWER_ID, true)).resolves.toMatchObject({
      id: CLAIM_ID,
      status: 'verified',
    })

    expect(mockRpc).toHaveBeenCalledWith('activate_trader_claim', {
      p_claim_id: CLAIM_ID,
      p_reviewer_id: REVIEWER_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).toHaveBeenCalledWith(USER_ID)
    expect(mockEnqueueFirstPartySync).toHaveBeenCalledWith('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    expect(mockSendNotification).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ user_id: USER_ID, title: 'Claim approved' }),
      'trader-claim-approve'
    )
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateLinkedTraderCache.mock.invocationCallOrder[0]
    )
    expect(mockInvalidateLinkedTraderCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnqueueFirstPartySync.mock.invocationCallOrder[0]
    )
  })

  it('does not enqueue a first-party sync for a signature claim', async () => {
    mockRpc.mockResolvedValue({
      data: activationPayload({
        claim: claim({ verification_method: 'signature', source: 'hyperliquid' }),
        authorization_id: null,
      }),
      error: null,
    })

    await reviewClaim(client, CLAIM_ID, REVIEWER_ID, true)

    expect(mockInvalidateLinkedTraderCache).toHaveBeenCalledWith(USER_ID)
    expect(mockEnqueueFirstPartySync).not.toHaveBeenCalled()
    expect(mockSendNotification).toHaveBeenCalled()
  })

  it('runs no post-commit effects when the activation RPC fails', async () => {
    const rpcError = { code: '23505', message: 'identity conflict' }
    mockRpc.mockResolvedValue({ data: null, error: rpcError })

    await expect(reviewClaim(client, CLAIM_ID, REVIEWER_ID, true)).rejects.toBe(rpcError)

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).not.toHaveBeenCalled()
    expect(mockEnqueueFirstPartySync).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    activationPayload({ linked_count: 0 }),
    activationPayload({ authorization_id: null }),
    activationPayload({ claim: claim({ status: 'reviewing' }) }),
  ])('rejects a malformed activation acknowledgement without side effects', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(activateClaim(client, CLAIM_ID, REVIEWER_ID)).rejects.toThrow(
      'Invalid activate_trader_claim response'
    )
    expect(mockInvalidateLinkedTraderCache).not.toHaveBeenCalled()
    expect(mockEnqueueFirstPartySync).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('rejects only a pending or reviewing claim and then notifies', async () => {
    const rejected = claim({
      status: 'rejected',
      reject_reason: 'ownership proof failed',
      verified_at: null,
    })
    const result = Promise.resolve({ data: rejected, error: null })
    const builder: Record<string, jest.Mock> = {}
    builder.update = jest.fn(() => builder)
    builder.eq = jest.fn(() => builder)
    builder.in = jest.fn(() => builder)
    builder.select = jest.fn(() => builder)
    builder.maybeSingle = jest.fn(() => result)
    mockFrom.mockReturnValue(builder)

    await expect(
      reviewClaim(client, CLAIM_ID, REVIEWER_ID, false, 'ownership proof failed')
    ).resolves.toEqual(rejected)

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).toHaveBeenCalledWith('trader_claims')
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'rejected',
        reviewed_by: REVIEWER_ID,
        reject_reason: 'ownership proof failed',
      })
    )
    expect(builder.eq).toHaveBeenCalledWith('id', CLAIM_ID)
    expect(builder.in).toHaveBeenCalledWith('status', ['pending', 'reviewing'])
    expect(mockSendNotification).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ title: 'Claim rejected' }),
      'trader-claim-reject'
    )
  })

  it('cannot reject a terminal or concurrently reviewed claim', async () => {
    const result = Promise.resolve({ data: null, error: null })
    const builder: Record<string, jest.Mock> = {}
    builder.update = jest.fn(() => builder)
    builder.eq = jest.fn(() => builder)
    builder.in = jest.fn(() => builder)
    builder.select = jest.fn(() => builder)
    builder.maybeSingle = jest.fn(() => result)
    mockFrom.mockReturnValue(builder)

    await expect(reviewClaim(client, CLAIM_ID, REVIEWER_ID, false)).rejects.toMatchObject({
      code: 'P0002',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})

describe('trader-claims types', () => {
  it('TraderClaim should have all required fields', () => {
    const claim: TraderClaim = {
      id: 'claim-1',
      user_id: 'user-1',
      trader_id: 'trader-1',
      source: 'binance_futures',
      verification_method: 'api_key',
      verification_data: null,
      status: 'pending',
      reject_reason: null,
      reviewed_by: null,
      reviewed_at: null,
      verified_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    expect(claim.status).toBe('pending')
    expect(claim.verification_method).toBe('api_key')
  })

  it('VerifiedTrader should have profile fields', () => {
    const verified: VerifiedTrader = {
      id: 'vt-1',
      user_id: 'user-1',
      trader_id: 'trader-1',
      source: 'binance_futures',
      display_name: 'CryptoKing',
      bio: 'Top trader',
      avatar_url: null,
      twitter_url: 'https://x.com/cryptoking',
      telegram_url: null,
      discord_url: null,
      website_url: null,
      verified_at: '2026-01-01T00:00:00Z',
      verification_method: 'api_key',
      can_pin_posts: false,
      can_reply_reviews: true,
      can_receive_messages: true,
      profile_version: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    expect(verified.display_name).toBe('CryptoKing')
    expect(verified.can_reply_reviews).toBe(true)
  })

  it('UpdateVerifiedTraderInput should allow partial updates', () => {
    const update: UpdateVerifiedTraderInput = {
      display_name: 'New Name',
      bio: 'Updated bio',
    }
    expect(update.display_name).toBe('New Name')
    expect(update.avatar_url).toBeUndefined()
    expect(update.twitter_url).toBeUndefined()
  })

  it('claim status transitions should be valid', () => {
    const validTransitions: Record<string, string[]> = {
      pending: ['reviewing', 'verified', 'rejected'],
      reviewing: ['verified', 'rejected'],
      verified: [],
      rejected: [],
    }
    expect(validTransitions.pending).toContain('verified')
    expect(validTransitions.pending).toContain('rejected')
    expect(validTransitions.verified).toHaveLength(0)
  })
})

describe('group score gating', () => {
  it('should block users below min_arena_score', () => {
    const group = { min_arena_score: 80, is_verified_only: false }
    const userScore = 50
    const canJoin = userScore >= group.min_arena_score
    expect(canJoin).toBe(false)
  })

  it('should allow users at or above min_arena_score', () => {
    const group = { min_arena_score: 80, is_verified_only: false }
    const userScore = 85
    const canJoin = userScore >= group.min_arena_score
    expect(canJoin).toBe(true)
  })

  it('should block non-verified users from verified-only groups', () => {
    const group = { min_arena_score: 0, is_verified_only: true }
    const isVerified = false
    const canJoin = !group.is_verified_only || isVerified
    expect(canJoin).toBe(false)
  })

  it('should allow verified users to join verified-only groups', () => {
    const group = { min_arena_score: 0, is_verified_only: true }
    const isVerified = true
    const canJoin = !group.is_verified_only || isVerified
    expect(canJoin).toBe(true)
  })

  it('should allow anyone when no restrictions', () => {
    const group = { min_arena_score: 0, is_verified_only: false }
    const canJoin = (group.min_arena_score === 0 || true) && (!group.is_verified_only || false)
    expect(canJoin).toBe(true)
  })
})

describe('bot/human type classification', () => {
  it('should classify web3_bot source as bot', () => {
    const source = 'web3_bot'
    const traderType = source === 'web3_bot' ? 'bot' : 'human'
    expect(traderType).toBe('bot')
  })

  it('should classify normal sources as human', () => {
    const sources = ['binance_futures', 'bybit', 'okx', 'bitget']
    for (const source of sources) {
      const traderType = source === 'web3_bot' ? 'bot' : 'human'
      expect(traderType).toBe('human')
    }
  })

  it('should support is_bot flag on trader', () => {
    const trader = { is_bot: true, bot_category: 'ai_agent' as const }
    expect(trader.is_bot).toBe(true)
    expect(trader.bot_category).toBe('ai_agent')
  })
})
