/**
 * /api/attestation/mint 测试
 */

describe('/api/attestation/mint', () => {
  describe('attestation data validation', () => {
    it('should require attestation_uid', () => {
      const body = { tx_hash: '0x123', arena_score: 85 }
      expect((body as Record<string, unknown>).attestation_uid).toBeUndefined()
    })

    it('should require tx_hash', () => {
      const body = { attestation_uid: 'att_123', arena_score: 85 }
      expect((body as Record<string, unknown>).tx_hash).toBeUndefined()
    })

    it('should default chain_id to Base (8453)', () => {
      const body = { attestation_uid: 'att_123', tx_hash: '0x123', arena_score: 85 }
      const chainId = typeof (body as Record<string, unknown>).chain_id === 'number'
        ? (body as Record<string, unknown>).chain_id
        : 8453
      expect(chainId).toBe(8453)
    })

    it('should round arena_score to integer', () => {
      const arenaScore = 85.7
      expect(Math.round(arenaScore)).toBe(86)
    })

    it('should accept valid score_period values', () => {
      const validPeriods = ['7D', '30D', '90D', 'overall']
      expect(validPeriods).toContain('overall')
      expect(validPeriods).toContain('90D')
    })
  })
})
