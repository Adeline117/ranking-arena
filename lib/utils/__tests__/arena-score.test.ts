/**
 * Arena Score 计算模块单元测试
 */

import {
  clip,
  safeLog1p,
  calculateRoiIntensity,
  calculateReturnScore,
  calculateDrawdownScore,
  calculateStabilityScore,
  meetsThreshold,
  calculateArenaScore,
  calculateOverallScore,
  calculateMomentumBonus,
  rankByArenaScore,
  getScoreConfidence,
  ARENA_CONFIG,
  type TraderScoreInput,
  type ScoreConfidence,
} from '../arena-score'

// ============================================
// 工具函数测试
// ============================================

describe('clip', () => {
  test('返回值在范围内不变', () => {
    expect(clip(5, 0, 10)).toBe(5)
    expect(clip(0, 0, 10)).toBe(0)
    expect(clip(10, 0, 10)).toBe(10)
  })

  test('小于最小值返回最小值', () => {
    expect(clip(-5, 0, 10)).toBe(0)
    expect(clip(-100, 0, 10)).toBe(0)
  })

  test('大于最大值返回最大值', () => {
    expect(clip(15, 0, 10)).toBe(10)
    expect(clip(100, 0, 10)).toBe(10)
  })
})

describe('safeLog1p', () => {
  test('正常值计算正确', () => {
    expect(safeLog1p(0)).toBe(0)
    expect(safeLog1p(1)).toBeCloseTo(Math.log(2), 10)
    expect(safeLog1p(0.5)).toBeCloseTo(Math.log(1.5), 10)
  })

  test('处理边界情况', () => {
    expect(safeLog1p(-1)).toBe(0)
    expect(safeLog1p(-2)).toBe(0)
    expect(safeLog1p(-100)).toBe(0)
  })

  test('负数但大于-1正常计算', () => {
    expect(safeLog1p(-0.5)).toBeCloseTo(Math.log(0.5), 10)
  })
})

// ============================================
// ROI 强度计算测试
// ============================================

describe('calculateRoiIntensity', () => {
  test('7D 周期计算正确', () => {
    const intensity = calculateRoiIntensity(100, '7D') // 100% ROI
    expect(intensity).toBeGreaterThan(0)
    // I = (365/7) * ln(1 + 1) = 52.14 * 0.693 ≈ 36.13
    expect(intensity).toBeCloseTo(36.13, 1)
  })

  test('30D 周期计算正确', () => {
    const intensity = calculateRoiIntensity(100, '30D')
    // I = (365/30) * ln(2) ≈ 12.17 * 0.693 ≈ 8.43
    expect(intensity).toBeCloseTo(8.43, 1)
  })

  test('90D 周期计算正确', () => {
    const intensity = calculateRoiIntensity(100, '90D')
    // I = (365/90) * ln(2) ≈ 4.06 * 0.693 ≈ 2.81
    expect(intensity).toBeCloseTo(2.81, 1)
  })

  test('负 ROI 返回负强度', () => {
    const intensity = calculateRoiIntensity(-50, '30D') // -50% ROI
    expect(intensity).toBeLessThan(0)
  })

  test('0 ROI 返回 0 强度', () => {
    expect(calculateRoiIntensity(0, '30D')).toBe(0)
  })
})

// ============================================
// 收益分计算测试
// ============================================

describe('calculateReturnScore', () => {
  test('正收益有正分数', () => {
    const score = calculateReturnScore(50, '30D')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(85)
  })

  test('负收益返回 0', () => {
    expect(calculateReturnScore(-50, '30D')).toBe(0)
    expect(calculateReturnScore(-10, '7D')).toBe(0)
  })

  test('0 收益返回 0', () => {
    expect(calculateReturnScore(0, '30D')).toBe(0)
  })

  test('高收益接近但不超过 85 分', () => {
    const score = calculateReturnScore(500, '30D')
    expect(score).toBeLessThanOrEqual(85)
    expect(score).toBeGreaterThan(70)
  })

  test('不同周期相同 ROI 分数不同', () => {
    const score7d = calculateReturnScore(50, '7D')
    const score30d = calculateReturnScore(50, '30D')
    const score90d = calculateReturnScore(50, '90D')
    
    // 7D 的 ROI 年化后强度更高，但 tanh 系数更小
    // 分数应该有差异
    expect(score7d).not.toBe(score30d)
    expect(score30d).not.toBe(score90d)
  })
})

// ============================================
// 回撤分计算测试
// ============================================

describe('calculateDrawdownScore', () => {
  test('0 回撤得满分', () => {
    expect(calculateDrawdownScore(0, '30D')).toBe(ARENA_CONFIG.MAX_DRAWDOWN_SCORE)
  })

  test('超过阈值得 0 分', () => {
    expect(calculateDrawdownScore(40, '30D')).toBe(0) // 30D 阈值是 30%
    expect(calculateDrawdownScore(50, '30D')).toBe(0)
  })

  test('阈值内线性插值', () => {
    const score = calculateDrawdownScore(15, '30D') // 30D 阈值 30%
    // score = 8 * (1 - 15/30) = 8 * 0.5 = 4
    expect(score).toBeCloseTo(4, 1)
  })

  test('null 回撤使用默认中位值 -20%', () => {
    const score = calculateDrawdownScore(null, '30D')
    // MDD=-20, threshold=30: 8 * (1 - 20/30) = 8 * 0.333 ≈ 2.67
    expect(score).toBeCloseTo(2.67, 1)
  })

  test('负数回撤（取绝对值）正确计算', () => {
    const score = calculateDrawdownScore(-15, '30D')
    expect(score).toBeCloseTo(4, 1)
  })
})

// ============================================
// 稳定分计算测试
// ============================================

describe('calculateStabilityScore', () => {
  test('低于基线胜率得 0 分', () => {
    expect(calculateStabilityScore(40, '30D')).toBe(0) // 基线是 45%
    expect(calculateStabilityScore(44, '30D')).toBe(0)
  })

  test('达到上限胜率得满分', () => {
    const score = calculateStabilityScore(70, '30D') // 30D 上限是 68%
    expect(score).toBe(ARENA_CONFIG.MAX_STABILITY_SCORE)
  })

  test('中间胜率线性插值', () => {
    const score = calculateStabilityScore(56.5, '30D') // 30D: 基线 45%, 上限 68%
    // (56.5 - 45) / (68 - 45) = 11.5 / 23 = 0.5
    // 7 * 0.5 = 3.5
    expect(score).toBeCloseTo(3.5, 1)
  })

  test('null 胜率使用默认中位值 50%', () => {
    const score = calculateStabilityScore(null, '30D')
    // WR=50, baseline=45, cap=68: 7 * (50-45)/(68-45) = 7 * 5/23 ≈ 1.52
    expect(score).toBeCloseTo(1.52, 1)
  })
})

// ============================================
// 入榜门槛测试
// ============================================

describe('meetsThreshold', () => {
  test('7D 门槛检查', () => {
    expect(meetsThreshold(100, '7D')).toBe(false)
    expect(meetsThreshold(200, '7D')).toBe(false) // 边界，不满足 >
    expect(meetsThreshold(201, '7D')).toBe(true)
    expect(meetsThreshold(500, '7D')).toBe(true)
  })

  test('30D 门槛检查', () => {
    expect(meetsThreshold(400, '30D')).toBe(false)
    expect(meetsThreshold(500, '30D')).toBe(false)
    expect(meetsThreshold(501, '30D')).toBe(true)
  })

  test('90D 门槛检查', () => {
    expect(meetsThreshold(800, '90D')).toBe(false)
    expect(meetsThreshold(1000, '90D')).toBe(false)
    expect(meetsThreshold(1001, '90D')).toBe(true)
  })
})

// ============================================
// Arena Score 综合计算测试
// ============================================

describe('calculateArenaScore', () => {
  const goodTrader: TraderScoreInput = {
    roi: 50,
    pnl: 5000,
    maxDrawdown: 10,
    winRate: 65,
  }

  const poorTrader: TraderScoreInput = {
    roi: -10,
    pnl: -500,
    maxDrawdown: 40,
    winRate: 35,
  }

  test('优秀交易员得高分', () => {
    const result = calculateArenaScore(goodTrader, '30D')
    expect(result.totalScore).toBeGreaterThan(50)
    expect(result.meetsThreshold).toBe(true)
  })

  test('差劲交易员得低分', () => {
    const result = calculateArenaScore(poorTrader, '30D')
    expect(result.totalScore).toBeLessThan(20)
    expect(result.meetsThreshold).toBe(false)
  })

  test('返回所有分数组成', () => {
    const result = calculateArenaScore(goodTrader, '30D')
    expect(result).toHaveProperty('totalScore')
    expect(result).toHaveProperty('returnScore')
    expect(result).toHaveProperty('drawdownScore')
    expect(result).toHaveProperty('stabilityScore')
    expect(result).toHaveProperty('meetsThreshold')
  })

  test('总分 = 收益分 + 回撤分 + 稳定分', () => {
    const result = calculateArenaScore(goodTrader, '30D')
    const sum = result.returnScore + result.drawdownScore + result.stabilityScore
    expect(result.totalScore).toBeCloseTo(sum, 1)
  })

  test('分数范围正确', () => {
    const result = calculateArenaScore(goodTrader, '30D')
    expect(result.totalScore).toBeGreaterThanOrEqual(0)
    expect(result.totalScore).toBeLessThanOrEqual(100)
    expect(result.returnScore).toBeLessThanOrEqual(85)
    expect(result.drawdownScore).toBeLessThanOrEqual(8)
    expect(result.stabilityScore).toBeLessThanOrEqual(7)
  })
})

// ============================================
// 动量加分计算测试
// ============================================

describe('calculateMomentumBonus', () => {
  test('7D 优于 30D 获得正加分', () => {
    // 7D=80, 30D=60 → ratio = 80/60 - 1 = 0.333, clip to 0.333, * 5 = 1.667
    const bonus = calculateMomentumBonus(80, 60)
    expect(bonus).toBeCloseTo(1.67, 1)
    expect(bonus).toBeGreaterThan(0)
  })

  test('7D 远超 30D 加分封顶 2.5', () => {
    // 7D=90, 30D=30 → ratio = 2.0, clip to 0.5, * 5 = 2.5
    const bonus = calculateMomentumBonus(90, 30)
    expect(bonus).toBe(ARENA_CONFIG.MOMENTUM_MAX_BONUS)
  })

  test('7D 低于 30D 获得负加分', () => {
    // 7D=60, 30D=70 → ratio = -0.143, clip to -0.143, * 5 = -0.714
    const bonus = calculateMomentumBonus(60, 70)
    expect(bonus).toBeCloseTo(-0.71, 1)
    expect(bonus).toBeLessThan(0)
  })

  test('7D 远低于 30D 扣分封顶 -1', () => {
    // 7D=10, 30D=80 → ratio = -0.875, clip to -0.2, * 5 = -1.0
    const bonus = calculateMomentumBonus(10, 80)
    expect(bonus).toBe(-ARENA_CONFIG.MOMENTUM_MAX_PENALTY)
  })

  test('score7d 为 null 返回 0', () => {
    expect(calculateMomentumBonus(null, 70)).toBe(0)
  })

  test('score30d 为 null 返回 0', () => {
    expect(calculateMomentumBonus(60, null)).toBe(0)
  })

  test('score30d 为 0 返回 0', () => {
    expect(calculateMomentumBonus(60, 0)).toBe(0)
  })

  test('7D 等于 30D 返回 0', () => {
    // ratio = 0, * 5 = 0
    expect(calculateMomentumBonus(50, 50)).toBe(0)
  })
})

// ============================================
// 总体分数计算测试
// ============================================

describe('calculateOverallScore', () => {
  test('完整数据标准加权 + 动量', () => {
    const score = calculateOverallScore({
      score7d: 60,
      score30d: 70,
      score90d: 80,
    })
    // base: 0.70 * 80 + 0.25 * 70 + 0.05 * 60 = 76.5
    // momentum: clip(60/70 - 1, -0.2, 0.5) * 5 = -0.714
    // total: 76.5 - 0.714 = 75.79
    expect(score).toBeCloseTo(75.79, 1)
  })

  test('缺失 90D 降权惩罚 + 动量', () => {
    const score = calculateOverallScore({
      score7d: 60,
      score30d: 70,
      score90d: null,
    })
    // base: (0.80 * 70 + 0.20 * 60) * 0.85 = 57.8
    // momentum: clip(60/70 - 1, -0.2, 0.5) * 5 = -0.714
    // total: 57.8 - 0.714 = 57.09
    expect(score).toBeCloseTo(57.09, 1)
  })

  test('只有 7D 强惩罚', () => {
    const score = calculateOverallScore({
      score7d: 80,
      score30d: null,
      score90d: null,
    })
    // 80 * 0.70 = 56
    expect(score).toBeCloseTo(56, 1)
  })

  test('只有 90D', () => {
    const score = calculateOverallScore({
      score7d: null,
      score30d: null,
      score90d: 80,
    })
    // 80 * 0.90 = 72
    expect(score).toBeCloseTo(72, 1)
  })

  test('无数据返回 0', () => {
    const score = calculateOverallScore({
      score7d: null,
      score30d: null,
      score90d: null,
    })
    expect(score).toBe(0)
  })
})

// ============================================
// 排名函数测试
// ============================================

describe('rankByArenaScore', () => {
  const traders = [
    { id: '1', roi: 30, pnl: 2000, maxDrawdown: 15, winRate: 55 },
    { id: '2', roi: 50, pnl: 5000, maxDrawdown: 10, winRate: 65 },
    { id: '3', roi: 10, pnl: 500, maxDrawdown: 5, winRate: 70 },  // 低于门槛
  ]

  test('按分数降序排列', () => {
    const ranked = rankByArenaScore(traders, '30D')
    expect(ranked.length).toBe(2) // id:3 被过滤
    expect(ranked[0].id).toBe('2') // 高分在前
    expect(ranked[1].id).toBe('1')
  })

  test('过滤未达门槛的交易员', () => {
    const ranked = rankByArenaScore(traders, '30D')
    expect(ranked.find(t => t.id === '3')).toBeUndefined()
  })

  test('结果包含 arena_score 和 score_details', () => {
    const ranked = rankByArenaScore(traders, '30D')
    ranked.forEach(trader => {
      expect(trader).toHaveProperty('arena_score')
      expect(trader).toHaveProperty('score_details')
      expect(trader.score_details).toHaveProperty('totalScore')
    })
  })

  test('相同分数按回撤排序', () => {
    const sameScoreTraders = [
      { id: '1', roi: 50, pnl: 5000, maxDrawdown: 20, winRate: 60 },
      { id: '2', roi: 50, pnl: 5000, maxDrawdown: 10, winRate: 60 },
    ]
    const ranked = rankByArenaScore(sameScoreTraders, '30D')
    // 回撤小的排前面
    expect(ranked[0].id).toBe('2')
    expect(ranked[1].id).toBe('1')
  })
})

// ============================================
// Score Confidence 测试
// ============================================

describe('getScoreConfidence', () => {
  test('两项都有数据返回 full', () => {
    expect(getScoreConfidence(-15, 60)).toBe('full')
    expect(getScoreConfidence(0, 0)).toBe('full')
  })

  test('缺 MDD 返回 partial', () => {
    expect(getScoreConfidence(null, 60)).toBe('partial')
    expect(getScoreConfidence(undefined, 55)).toBe('partial')
  })

  test('缺 WR 返回 partial', () => {
    expect(getScoreConfidence(-10, null)).toBe('partial')
    expect(getScoreConfidence(-20, undefined)).toBe('partial')
  })

  test('两项都缺失返回 minimal', () => {
    expect(getScoreConfidence(null, null)).toBe('minimal')
    expect(getScoreConfidence(undefined, undefined)).toBe('minimal')
  })
})

describe('calculateArenaScore scoreConfidence', () => {
  test('完整数据标记为 full', () => {
    const result = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: -10, winRate: 65,
    }, '30D')
    expect(result.scoreConfidence).toBe('full')
  })

  test('缺 MDD 标记为 partial', () => {
    const result = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: null, winRate: 65,
    }, '30D')
    expect(result.scoreConfidence).toBe('partial')
  })

  test('缺 WR 标记为 partial', () => {
    const result = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: -10, winRate: null,
    }, '30D')
    expect(result.scoreConfidence).toBe('partial')
  })

  test('两项都缺标记为 minimal', () => {
    const result = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: null, winRate: null,
    }, '30D')
    expect(result.scoreConfidence).toBe('minimal')
  })
})

// ============================================
// 配置常量测试
// ============================================

describe('ARENA_CONFIG', () => {
  test('PnL 门槛配置正确', () => {
    expect(ARENA_CONFIG.PNL_THRESHOLD['7D']).toBe(200)
    expect(ARENA_CONFIG.PNL_THRESHOLD['30D']).toBe(500)
    expect(ARENA_CONFIG.PNL_THRESHOLD['90D']).toBe(1000)
  })

  test('总体权重之和为 1', () => {
    const weights = ARENA_CONFIG.OVERALL_WEIGHTS
    const sum = weights['7D'] + weights['30D'] + weights['90D']
    expect(sum).toBe(1)
  })

  test('最大分数配置正确', () => {
    const total = ARENA_CONFIG.MAX_RETURN_SCORE + 
                  ARENA_CONFIG.MAX_DRAWDOWN_SCORE + 
                  ARENA_CONFIG.MAX_STABILITY_SCORE
    expect(total).toBe(100)
  })
})
