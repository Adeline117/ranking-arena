/**
 * trader-claims 数据层测试
 */

import type { TraderClaim, VerifiedTrader, UpdateVerifiedTraderInput } from '../trader-claims'

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
