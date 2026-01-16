/**
 * 交易风险指标计算测试
 */

import {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateCalmarRatio,
  calculateVolatility,
  calculateMaxDrawdown,
  calculateConsecutiveStreak,
  calculateProfitLossRatio,
  calculateRiskLevel,
  calculateAllRiskMetrics,
  formatRiskMetric,
  type PerformanceData,
  type TradeRecord,
} from '../trading-metrics'

describe('交易风险指标计算', () => {
  // 模拟收益率数据（百分比）
  const mockReturns = [2.5, -1.2, 3.1, 0.5, -2.0, 1.8, -0.8, 2.2, 1.5, -1.5, 0.9, 2.0]
  
  // 模拟交易记录
  const mockTrades: TradeRecord[] = [
    { pnl: 100, pnlPct: 5, openTime: '2024-01-01', closeTime: '2024-01-02' },
    { pnl: -50, pnlPct: -2.5, openTime: '2024-01-03', closeTime: '2024-01-04' },
    { pnl: 200, pnlPct: 10, openTime: '2024-01-05', closeTime: '2024-01-06' },
    { pnl: -30, pnlPct: -1.5, openTime: '2024-01-07', closeTime: '2024-01-08' },
    { pnl: 150, pnlPct: 7.5, openTime: '2024-01-09', closeTime: '2024-01-10' },
    { pnl: 80, pnlPct: 4, openTime: '2024-01-11', closeTime: '2024-01-12' },
    { pnl: -40, pnlPct: -2, openTime: '2024-01-13', closeTime: '2024-01-14' },
  ]

  describe('calculateSharpeRatio', () => {
    it('应该返回数字或 null', () => {
      const result = calculateSharpeRatio(mockReturns, 'daily')
      expect(result === null || typeof result === 'number').toBe(true)
    })

    it('数据不足时应该返回 null', () => {
      const result = calculateSharpeRatio([1, 2, 3], 'daily')
      expect(result).toBeNull()
    })

    it('全部相同收益率（零波动）应该返回 null', () => {
      const result = calculateSharpeRatio([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 'daily')
      expect(result).toBeNull()
    })

    it('应该支持不同周期类型', () => {
      const daily = calculateSharpeRatio(mockReturns, 'daily')
      const weekly = calculateSharpeRatio(mockReturns, 'weekly')
      const monthly = calculateSharpeRatio(mockReturns, 'monthly')
      
      // 三个结果应该是不同的（因为年化因子不同）
      if (daily !== null && weekly !== null && monthly !== null) {
        expect(daily).not.toBe(weekly)
        expect(weekly).not.toBe(monthly)
      }
    })
  })

  describe('calculateSortinoRatio', () => {
    it('应该返回数字或 null', () => {
      const result = calculateSortinoRatio(mockReturns, 'daily')
      expect(result === null || typeof result === 'number').toBe(true)
    })

    it('无负收益时应该返回 null', () => {
      const allPositive = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      const result = calculateSortinoRatio(allPositive, 'daily')
      expect(result).toBeNull()
    })
  })

  describe('calculateCalmarRatio', () => {
    it('应该正确计算', () => {
      const result = calculateCalmarRatio(50, -20)
      expect(result).toBe(2.5) // 50 / 20 = 2.5
    })

    it('零回撤时应该返回 null', () => {
      const result = calculateCalmarRatio(50, 0)
      expect(result).toBeNull()
    })
  })

  describe('calculateVolatility', () => {
    it('应该返回正数或 null', () => {
      const result = calculateVolatility(mockReturns, 'daily')
      if (result !== null) {
        expect(result).toBeGreaterThan(0)
      }
    })

    it('数据不足时应该返回 null', () => {
      const result = calculateVolatility([1, 2, 3], 'daily')
      expect(result).toBeNull()
    })
  })

  describe('calculateMaxDrawdown', () => {
    it('应该正确计算最大回撤', () => {
      const result = calculateMaxDrawdown(mockReturns)
      expect(result.maxDrawdown).toBeGreaterThanOrEqual(0)
      expect(result.maxDrawdownDuration).toBeGreaterThanOrEqual(0)
    })

    it('空数组应该返回零', () => {
      const result = calculateMaxDrawdown([])
      expect(result.maxDrawdown).toBe(0)
      expect(result.maxDrawdownDuration).toBe(0)
    })

    it('全部正收益应该有较小的回撤', () => {
      const allPositive = [1, 2, 3, 4, 5]
      const result = calculateMaxDrawdown(allPositive)
      expect(result.maxDrawdown).toBe(0)
    })
  })

  describe('calculateConsecutiveStreak', () => {
    it('应该正确计算最大连续亏损', () => {
      const trades: TradeRecord[] = [
        { pnl: 100, pnlPct: 5, openTime: '', closeTime: '' },
        { pnl: -50, pnlPct: -2, openTime: '', closeTime: '' },
        { pnl: -30, pnlPct: -1, openTime: '', closeTime: '' },
        { pnl: -20, pnlPct: -1, openTime: '', closeTime: '' },
        { pnl: 80, pnlPct: 4, openTime: '', closeTime: '' },
      ]
      const result = calculateConsecutiveStreak(trades)
      expect(result.maxConsecutiveLosses).toBe(3)
    })

    it('应该正确计算最大连续盈利', () => {
      const trades: TradeRecord[] = [
        { pnl: 100, pnlPct: 5, openTime: '', closeTime: '' },
        { pnl: 50, pnlPct: 2, openTime: '', closeTime: '' },
        { pnl: 30, pnlPct: 1, openTime: '', closeTime: '' },
        { pnl: -20, pnlPct: -1, openTime: '', closeTime: '' },
      ]
      const result = calculateConsecutiveStreak(trades)
      expect(result.maxConsecutiveWins).toBe(3)
    })
  })

  describe('calculateProfitLossRatio', () => {
    it('应该正确计算盈亏比', () => {
      const result = calculateProfitLossRatio(mockTrades)
      expect(result).not.toBeNull()
      if (result !== null) {
        expect(result).toBeGreaterThan(0)
      }
    })

    it('无盈利交易时应该返回 null', () => {
      const allLosses: TradeRecord[] = [
        { pnl: -50, pnlPct: -2, openTime: '', closeTime: '' },
        { pnl: -30, pnlPct: -1, openTime: '', closeTime: '' },
      ]
      const result = calculateProfitLossRatio(allLosses)
      expect(result).toBeNull()
    })

    it('无亏损交易时应该返回 null', () => {
      const allProfits: TradeRecord[] = [
        { pnl: 50, pnlPct: 2, openTime: '', closeTime: '' },
        { pnl: 30, pnlPct: 1, openTime: '', closeTime: '' },
      ]
      const result = calculateProfitLossRatio(allProfits)
      expect(result).toBeNull()
    })
  })

  describe('calculateRiskLevel', () => {
    it('低风险应该返回 level 1 或 2', () => {
      const result = calculateRiskLevel(5, -3, 2.5)
      expect(result.level).toBeLessThanOrEqual(2)
      expect(result.description).toMatch(/低风险/)
    })

    it('高风险应该返回 level 4 或 5', () => {
      const result = calculateRiskLevel(150, -60, -0.5)
      expect(result.level).toBeGreaterThanOrEqual(4)
      expect(result.description).toMatch(/高风险/)
    })

    it('应该处理 null 值', () => {
      const result = calculateRiskLevel(null, null, null)
      expect(result.level).toBeGreaterThanOrEqual(1)
      expect(result.level).toBeLessThanOrEqual(5)
    })
  })

  describe('calculateAllRiskMetrics', () => {
    it('应该返回完整的风险指标对象', () => {
      const data: PerformanceData = {
        returns: mockReturns,
        period: 'daily',
      }
      const result = calculateAllRiskMetrics(data, mockTrades, 50)

      expect(result).toHaveProperty('sharpeRatio')
      expect(result).toHaveProperty('sortinoRatio')
      expect(result).toHaveProperty('volatility')
      expect(result).toHaveProperty('maxDrawdown')
      expect(result).toHaveProperty('riskLevel')
      expect(result).toHaveProperty('riskLevelDescription')
    })

    it('应该计算交易相关指标', () => {
      const data: PerformanceData = {
        returns: mockReturns,
        period: 'daily',
      }
      const result = calculateAllRiskMetrics(data, mockTrades)

      expect(result.maxConsecutiveLosses).not.toBeNull()
      expect(result.maxConsecutiveWins).not.toBeNull()
      expect(result.profitLossRatio).not.toBeNull()
    })
  })

  describe('formatRiskMetric', () => {
    it('应该正确格式化比率', () => {
      expect(formatRiskMetric(1.5, 'ratio')).toBe('1.50')
    })

    it('应该正确格式化百分比', () => {
      expect(formatRiskMetric(15.5, 'percentage')).toBe('15.50%')
    })

    it('应该正确格式化天数', () => {
      expect(formatRiskMetric(10, 'days')).toBe('10 天')
    })

    it('应该正确格式化次数', () => {
      expect(formatRiskMetric(5, 'count')).toBe('5 次')
    })

    it('null 值应该返回占位符', () => {
      expect(formatRiskMetric(null, 'ratio')).toBe('—')
    })
  })
})
