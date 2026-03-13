/**
 * Normalize tests for key connectors — verifies correct field mapping
 * and defensive handling of missing/malformed data.
 */

describe('Connector normalize() robustness', () => {
  // We test normalize() in isolation since it's a pure function

  describe('xt-futures (ratio-to-percent conversion)', () => {
    let normalize: (raw: unknown) => Record<string, unknown>

    beforeAll(async () => {
      const { XtFuturesConnector } = await import('../platforms/xt-futures')
      const connector = new XtFuturesConnector()
      normalize = (raw) => connector.normalize(raw)
    })

    it('converts incomeRate ratio to percentage', () => {
      const result = normalize({ accountId: 'x1', incomeRate: 1.0852, income: 5000 })
      expect(result.roi).toBeCloseTo(108.52)
    })

    it('handles small ratio correctly', () => {
      const result = normalize({ accountId: 'x2', incomeRate: 0.05 })
      expect(result.roi).toBeCloseTo(5)
    })

    it('handles missing fields gracefully', () => {
      const result = normalize({})
      expect(result.roi).toBeNull()
      expect(result.pnl).toBeNull()
      expect(result.win_rate).toBeNull()
      expect(result.trader_key).toBeNull()
    })
  })

  describe('gmx-perp (BigInt decimals + null handling)', () => {
    let normalize: (raw: unknown) => Record<string, unknown>

    beforeAll(async () => {
      const { GmxPerpConnector } = await import('../platforms/gmx-perp')
      const connector = new GmxPerpConnector()
      normalize = (raw) => connector.normalize(raw)
    })

    it('computes ROI from realizedPnl/maxCapital', () => {
      const result = normalize({ account: '0xabc', realizedPnl: 5000, maxCapital: 10000, wins: 7, losses: 3 })
      expect(result.roi).toBe(50)
      expect(result.win_rate).toBe(70)
    })

    it('returns null for missing PnL (not 0)', () => {
      const result = normalize({ account: '0xabc', realizedPnl: null, maxCapital: null })
      expect(result.pnl).toBeNull()
      expect(result.roi).toBeNull()
      expect(result.aum).toBeNull()
    })

    it('handles empty object', () => {
      const result = normalize({})
      expect(result.trader_key).toBe('')
      expect(result.pnl).toBeNull()
    })
  })

  describe('aevo-perp (no fake ROI)', () => {
    let normalize: (raw: unknown) => Record<string, unknown>

    beforeAll(async () => {
      const { AevoPerpConnector } = await import('../platforms/aevo-perp')
      const connector = new AevoPerpConnector()
      normalize = (raw) => connector.normalize(raw)
    })

    it('estimates ROI from volume for sufficient volume', () => {
      const result = normalize({ username: 'alice', pnl: '5000', totalVolume: '100000' })
      expect(result.roi).toBe(50) // 5000 / (100000/10) * 100
    })

    it('returns null ROI for low volume (not hardcoded ±10)', () => {
      const result = normalize({ username: 'bob', pnl: '100', totalVolume: '500' })
      expect(result.roi).toBeNull() // estimatedCapital = 50 < 100
    })

    it('handles missing fields', () => {
      const result = normalize({ username: 'empty' })
      expect(result.roi).toBeNull()
      expect(result.pnl).toBeNull()
    })
  })

  describe('binance-web3 (NaN prevention)', () => {
    let normalize: (raw: unknown) => Record<string, unknown>

    beforeAll(async () => {
      const { BinanceWeb3Connector } = await import('../platforms/binance-web3')
      const connector = new BinanceWeb3Connector()
      normalize = (raw) => connector.normalize(raw)
    })

    it('converts decimal ROI and winRate to percentage', () => {
      const result = normalize({ address: '0xabc', realizedPnlPercent: 0.27, winRate: 0.65, realizedPnl: 1000 })
      expect(result.roi).toBeCloseTo(27)
      expect(result.win_rate).toBeCloseTo(65)
    })

    it('returns null (not NaN) for missing percentage fields', () => {
      const result = normalize({ address: '0xabc' })
      expect(result.roi).toBeNull()
      expect(result.win_rate).toBeNull()
      expect(result.pnl).toBeNull()
      // Verify it's actually null, not NaN
      expect(Number.isNaN(result.roi)).toBe(false)
    })
  })

  describe('toobit-futures (ratio conversion)', () => {
    let normalize: (raw: unknown) => Record<string, unknown>

    beforeAll(async () => {
      const { ToobitFuturesConnector } = await import('../platforms/toobit-futures')
      const connector = new ToobitFuturesConnector()
      normalize = (raw) => connector.normalize(raw)
    })

    it('converts profitRatio to percentage', () => {
      const result = normalize({ leaderUserId: 't1', profitRatio: 2.7061 })
      expect(result.roi).toBeCloseTo(270.61)
    })

    it('handles zero correctly', () => {
      const result = normalize({ leaderUserId: 't2', profitRatio: 0 })
      expect(result.roi).toBe(0)
    })

    it('returns null for missing fields', () => {
      const result = normalize({})
      expect(result.roi).toBeNull()
      expect(result.trader_key).toBeNull()
    })
  })
})
