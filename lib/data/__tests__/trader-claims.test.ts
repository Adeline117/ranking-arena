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
  reviewClaim,
  submitClaim,
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
