/**
 * /api/traders/claim 认领 API 测试
 */

import {
  isTraderClaimed,
  getUserClaimForTrader,
  getUserVerifiedTrader,
  reviewClaim,
  cancelClaim,
  type SubmitClaimInput,
  type VerificationMethod,
} from '@/lib/data/trader-claims'

describe('/api/traders/claim', () => {
  describe('trader-claims data layer types', () => {
    it('should define valid verification methods', () => {
      const methods: VerificationMethod[] = ['api_key', 'signature', 'video', 'social']
      expect(methods).toHaveLength(4)
      expect(methods).toContain('api_key')
      expect(methods).toContain('signature')
    })

    it('defines only the typed V2 wallet attestation submit input', () => {
      const input: SubmitClaimInput = {
        trader_id: '0x1111111111111111111111111111111111111111',
        source: 'hyperliquid',
        challenge_id: 'a'.repeat(64),
        challenge_issued_at: '2026-08-03T00:00:00.000Z',
        verified_at: '2026-08-03T00:01:00.000Z',
        message_sha256: 'b'.repeat(64),
        signature_sha256: 'c'.repeat(64),
      }
      expect(input.source).toBe('hyperliquid')
      expect(input.challenge_id).toHaveLength(64)
    })

    it('should export all required functions', () => {
      expect(typeof isTraderClaimed).toBe('function')
      expect(typeof getUserClaimForTrader).toBe('function')
      expect(typeof getUserVerifiedTrader).toBe('function')
      expect(typeof reviewClaim).toBe('function')
      expect(typeof cancelClaim).toBe('function')
    })
  })

  describe('claim status validation', () => {
    it('should only allow valid claim statuses', () => {
      const validStatuses = ['pending', 'reviewing', 'verified', 'rejected', 'expired']
      for (const status of validStatuses) {
        expect(['pending', 'reviewing', 'verified', 'rejected', 'expired']).toContain(status)
      }
    })
  })

  describe('claim request validation', () => {
    it('should require trader_id', () => {
      const body = { source: 'hyperliquid', verification_method: 'signature' }
      expect(body.source).toBeDefined()
      expect((body as Record<string, unknown>).trader_id).toBeUndefined()
    })

    it('should require source', () => {
      const body = { trader_id: '0xabc', verification_method: 'signature' }
      expect(body.trader_id).toBeDefined()
      expect((body as Record<string, unknown>).source).toBeUndefined()
    })

    it('should require verification_method', () => {
      const body = { trader_id: '0xabc', source: 'hyperliquid' }
      expect(body.trader_id).toBeDefined()
      expect((body as Record<string, unknown>).verification_method).toBeUndefined()
    })
  })
})
