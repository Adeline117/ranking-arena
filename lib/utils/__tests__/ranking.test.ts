/**
 * 排名算法测试
 */

import {
  rankTraders,
  simpleRankTraders,
  calculateRiskAdjustedReturn,
  calculateStabilityScore,
  detectSuspiciousTrader,
  calculateRankingScore,
  RankingConfig,
  type TraderRankingData,
} from '../ranking'

describe('排名算法', () => {
  // 测试数据
  const mockTraders: TraderRankingData[] = [
    {
      id: 'trader1',
      roi: 150,
      pnl: 5000,
      win_rate: 65,
      max_drawdown: -15,
      trades_count: 50,
      source: 'binance',
    },
    {
      id: 'trader2',
      roi: 200,
      pnl: 10000,
      win_rate: 70,
      max_drawdown: -25,
      trades_count: 100,
      source: 'bybit',
    },
    {
      id: 'trader3',
      roi: 100,
      pnl: 500, // 低于 MIN_PNL
      win_rate: 80,
      max_drawdown: -10,
      trades_count: 30,
      source: 'bitget',
    },
    {
      id: 'trader4',
      roi: 600, // 可疑高 ROI
      pnl: 2000,
      win_rate: 90,
      max_drawdown: 0, // 零回撤
      trades_count: 3, // 极少交易
      source: 'mexc',
    },
  ]

  describe('calculateRiskAdjustedReturn', () => {
    it('应该正确计算风险调整收益', () => {
      const result = calculateRiskAdjustedReturn(150, -15)
      expect(result).toBe(10) // 150 / 15 = 10
    })

    it('应该使用最小回撤值避免除零', () => {
      const result = calculateRiskAdjustedReturn(100, 0)
      expect(result).toBe(100 / RankingConfig.MIN_DRAWDOWN)
    })

    it('应该处理 null 回撤', () => {
      const result = calculateRiskAdjustedReturn(100, null)
      expect(result).toBe(100 / RankingConfig.MIN_DRAWDOWN)
    })
  })

  describe('calculateStabilityScore', () => {
    it('应该返回 0-100 之间的分数', () => {
      const score = calculateStabilityScore(65, -15, 50)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    })

    it('高胜率低回撤应该得分更高', () => {
      const highScore = calculateStabilityScore(80, -10, 100)
      const lowScore = calculateStabilityScore(40, -50, 10)
      expect(highScore).toBeGreaterThan(lowScore)
    })

    it('应该处理 null 值', () => {
      const score = calculateStabilityScore(null, null, null)
      expect(score).toBeDefined()
      expect(typeof score).toBe('number')
    })
  })

  describe('detectSuspiciousTrader', () => {
    it('应该检测出高 ROI 为可疑', () => {
      const result = detectSuspiciousTrader(mockTraders[3])
      expect(result.isSuspicious).toBe(true)
      expect(result.reasons.length).toBeGreaterThan(0)
    })

    it('应该检测出零回撤配合高 ROI 为可疑', () => {
      const trader = {
        id: 'suspicious',
        roi: 100,
        pnl: 5000,
        win_rate: 90,
        max_drawdown: 0,
        trades_count: 50,
        source: 'binance',
      }
      const result = detectSuspiciousTrader(trader)
      expect(result.isSuspicious).toBe(true)
    })

    it('正常交易员不应该被标记为可疑', () => {
      const result = detectSuspiciousTrader(mockTraders[0])
      expect(result.isSuspicious).toBe(false)
      expect(result.reasons).toHaveLength(0)
    })
  })

  describe('calculateRankingScore', () => {
    it('应该返回正数分数', () => {
      const score = calculateRankingScore(mockTraders[0])
      expect(score).toBeGreaterThan(0)
    })

    it('更高 ROI 和更好的风险指标应该得分更高', () => {
      const highScore = calculateRankingScore({
        id: 'high',
        roi: 200,
        pnl: 10000,
        win_rate: 80,
        max_drawdown: -10,
        trades_count: 100,
        source: 'binance',
      })
      const lowScore = calculateRankingScore({
        id: 'low',
        roi: 50,
        pnl: 2000,
        win_rate: 40,
        max_drawdown: -50,
        trades_count: 10,
        source: 'binance',
      })
      expect(highScore).toBeGreaterThan(lowScore)
    })
  })

  describe('rankTraders', () => {
    it('应该过滤低 PnL 交易员（Bybit 除外）', () => {
      const ranked = rankTraders(mockTraders)
      const hasLowPnl = ranked.some(t => t.id === 'trader3')
      expect(hasLowPnl).toBe(false)
    })

    it('应该保留 Bybit 交易员（不受 PnL 限制）', () => {
      const ranked = rankTraders(mockTraders)
      const hasBybit = ranked.some(t => t.source === 'bybit')
      expect(hasBybit).toBe(true)
    })

    it('应该为每个交易员分配排名', () => {
      const ranked = rankTraders(mockTraders)
      ranked.forEach((trader, idx) => {
        expect(trader.rank).toBe(idx + 1)
      })
    })

    it('应该标记可疑交易员', () => {
      const ranked = rankTraders(mockTraders)
      const suspicious = ranked.find(t => t.id === 'trader4')
      if (suspicious) {
        expect(suspicious.is_suspicious).toBe(true)
        expect(suspicious.suspicion_reasons.length).toBeGreaterThan(0)
      }
    })

    it('应该计算风险调整分数', () => {
      const ranked = rankTraders(mockTraders)
      ranked.forEach(trader => {
        expect(trader.risk_adjusted_score).toBeDefined()
        expect(typeof trader.risk_adjusted_score).toBe('number')
      })
    })
  })

  describe('simpleRankTraders', () => {
    it('应该按 ROI 降序排序', () => {
      const ranked = simpleRankTraders(mockTraders)
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].roi).toBeGreaterThanOrEqual(ranked[i].roi)
      }
    })

    it('应该过滤低 PnL 交易员', () => {
      const ranked = simpleRankTraders(mockTraders)
      const hasLowPnl = ranked.some(t => t.id === 'trader3')
      expect(hasLowPnl).toBe(false)
    })

    it('ROI 相同时应该按回撤排序', () => {
      const traders: TraderRankingData[] = [
        { id: 'a', roi: 100, pnl: 5000, win_rate: 50, max_drawdown: -30, trades_count: 50, source: 'binance' },
        { id: 'b', roi: 100, pnl: 5000, win_rate: 50, max_drawdown: -10, trades_count: 50, source: 'binance' },
      ]
      const ranked = simpleRankTraders(traders)
      expect(ranked[0].id).toBe('b') // 回撤更小的在前
    })
  })
})

describe('RankingConfig', () => {
  it('应该有合理的默认配置', () => {
    expect(RankingConfig.MIN_PNL).toBeGreaterThan(0)
    expect(RankingConfig.SUSPICIOUS_ROI_THRESHOLD).toBeGreaterThan(100)
    expect(RankingConfig.MIN_DRAWDOWN).toBeGreaterThan(0)
  })

  it('权重总和应该为 1', () => {
    const totalWeight =
      RankingConfig.WEIGHTS.ROI +
      RankingConfig.WEIGHTS.RISK_ADJUSTED +
      RankingConfig.WEIGHTS.STABILITY +
      RankingConfig.WEIGHTS.VOLUME
    expect(totalWeight).toBe(1)
  })
})
