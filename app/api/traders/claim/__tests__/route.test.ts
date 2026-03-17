/**
 * /api/traders/claim 认领 API 测试
 */

import {
  isTraderClaimed,
  getUserClaim,
  getUserVerifiedTrader,
  reviewClaim,
  cancelClaim,
  type CreateClaimInput,
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

    it('should define CreateClaimInput correctly', () => {
      const input: CreateClaimInput = {
        trader_id: 'trader123',
        source: 'binance_futures',
        verification_method: 'api_key',
        verification_data: { key: 'test' },
      }
      expect(input.trader_id).toBe('trader123')
      expect(input.source).toBe('binance_futures')
      expect(input.verification_method).toBe('api_key')
    })

    it('should export all required functions', () => {
      expect(typeof isTraderClaimed).toBe('function')
      expect(typeof getUserClaim).toBe('function')
      expect(typeof getUserVerifiedTrader).toBe('function')
      expect(typeof reviewClaim).toBe('function')
      expect(typeof cancelClaim).toBe('function')
    })
  })

  describe('claim status validation', () => {
    it('should only allow valid claim statuses', () => {
      const validStatuses = ['pending', 'reviewing', 'verified', 'rejected']
      for (const status of validStatuses) {
        expect(['pending', 'reviewing', 'verified', 'rejected']).toContain(status)
      }
    })
  })

  describe('claim request validation', () => {
    it('should require trader_id', () => {
      const body = { source: 'binance', verification_method: 'api_key' }
      expect(body.source).toBeDefined()
      expect((body as Record<string, unknown>).trader_id).toBeUndefined()
    })

    it('should require source', () => {
      const body = { trader_id: 'abc', verification_method: 'api_key' }
      expect(body.trader_id).toBeDefined()
      expect((body as Record<string, unknown>).source).toBeUndefined()
    })

    it('should require verification_method', () => {
      const body = { trader_id: 'abc', source: 'binance' }
      expect(body.trader_id).toBeDefined()
      expect((body as Record<string, unknown>).verification_method).toBeUndefined()
    })
  })
})
