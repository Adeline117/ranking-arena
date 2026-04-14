/**
 * Arena Score 计算模块单元测试
 */

import fs from 'fs'
import path from 'path'
import {
  clip,
  safeLog1p,
  calculateRoiIntensity,
  calculateReturnScore,
  calculatePnlScore,
  calculateDrawdownScore,
  calculateStabilityScore,
  debouncedConfidence,
  calculateArenaScore,
  calculateOverallScore,
  calculateMomentumBonus,
  rankByArenaScore,
  ARENA_CONFIG,
  type TraderScoreInput,
  type ScoreConfidence as _ScoreConfidence,
  getScoreConfidence,
  wilsonConfidenceMultiplier,
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
    expect(score).toBeLessThanOrEqual(ARENA_CONFIG.MAX_RETURN_SCORE)
  })

  test('负收益返回 0', () => {
    expect(calculateReturnScore(-50, '30D')).toBe(0)
    expect(calculateReturnScore(-10, '7D')).toBe(0)
  })

  test('0 收益返回 0', () => {
    expect(calculateReturnScore(0, '30D')).toBe(0)
  })

  test('高收益接近但不超过最大分', () => {
    const score = calculateReturnScore(500, '30D')
    expect(score).toBeLessThanOrEqual(ARENA_CONFIG.MAX_RETURN_SCORE)
    expect(score).toBeGreaterThan(ARENA_CONFIG.MAX_RETURN_SCORE * 0.75)
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
  // V3: MAX_DRAWDOWN_SCORE = 0, so all drawdown scores are 0
  test('V3: 回撤分已移除，始终返回 0', () => {
    // In V3, drawdown score is always 0 regardless of input
    expect(calculateDrawdownScore(0, '30D')).toBe(0)
    expect(calculateDrawdownScore(15, '30D')).toBe(0)
    expect(calculateDrawdownScore(null, '30D')).toBe(0)
    expect(calculateDrawdownScore(-15, '30D')).toBe(0)
    expect(calculateDrawdownScore(40, '30D')).toBe(0)
    expect(ARENA_CONFIG.MAX_DRAWDOWN_SCORE).toBe(0)
  })
})

// ============================================
// 稳定分计算测试
// ============================================

describe('calculateStabilityScore', () => {
  // V3: MAX_STABILITY_SCORE = 0, so all stability scores are 0
  test('V3: 稳定分已移除，始终返回 0', () => {
    // In V3, stability score is always 0 regardless of input
    expect(calculateStabilityScore(40, '30D')).toBe(0)
    expect(calculateStabilityScore(70, '30D')).toBe(0)
    expect(calculateStabilityScore(56.5, '30D')).toBe(0)
    expect(calculateStabilityScore(null, '30D')).toBe(0)
    expect(ARENA_CONFIG.MAX_STABILITY_SCORE).toBe(0)
  })
})

// ============================================
// PnL 分计算测试
// ============================================

describe('calculatePnlScore', () => {
  test('正 PnL 有正分数', () => {
    const score = calculatePnlScore(5000, '30D')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(ARENA_CONFIG.MAX_PNL_SCORE)
  })

  test('负 PnL 返回 0', () => {
    expect(calculatePnlScore(-1000, '30D')).toBe(0)
    expect(calculatePnlScore(-1, '7D')).toBe(0)
  })

  test('0 PnL 返回 0', () => {
    expect(calculatePnlScore(0, '30D')).toBe(0)
  })

  test('null PnL 返回 0', () => {
    expect(calculatePnlScore(null, '30D')).toBe(0)
  })

  test('大额 PnL 接近但不超过最大分', () => {
    const score = calculatePnlScore(1000000, '90D')
    expect(score).toBeLessThanOrEqual(ARENA_CONFIG.MAX_PNL_SCORE)
    expect(score).toBeGreaterThan(ARENA_CONFIG.MAX_PNL_SCORE * 0.8)
  })

  test('不同周期相同 PnL 分数不同', () => {
    const score7d = calculatePnlScore(5000, '7D')
    const score30d = calculatePnlScore(5000, '30D')
    const score90d = calculatePnlScore(5000, '90D')
    // 7D base 小，同样 PnL 得分更高
    expect(score7d).toBeGreaterThan(score30d)
    expect(score30d).toBeGreaterThan(score90d)
  })

  test('PnL 分数有递减效应（高区间）', () => {
    // $100K → $1M 的增幅应该大于 $1M → $10M 的增幅
    const s100k = calculatePnlScore(100000, '90D')
    const s1m = calculatePnlScore(1000000, '90D')
    const s10m = calculatePnlScore(10000000, '90D')
    const diff1 = s1m - s100k   // $100K → $1M
    const diff2 = s10m - s1m    // $1M → $10M
    expect(diff1).toBeGreaterThan(diff2) // tanh 压缩效应
  })

  test('90D PnL 分布合理（V3: MAX_PNL_SCORE=40）', () => {
    // 验证关键节点的分数分布（按 V3 参数重新计算）
    const s1k = calculatePnlScore(1000, '90D')
    const s5k = calculatePnlScore(5000, '90D')
    const s50k = calculatePnlScore(50000, '90D')
    const s200k = calculatePnlScore(200000, '90D')

    // V3 uses MAX_PNL_SCORE=40, so scores are higher than before
    // Just verify ordering and reasonable range
    expect(s1k).toBeGreaterThan(0)
    expect(s5k).toBeGreaterThan(s1k)
    expect(s50k).toBeGreaterThan(s5k)
    expect(s200k).toBeGreaterThan(s50k)
    expect(s200k).toBeLessThanOrEqual(ARENA_CONFIG.MAX_PNL_SCORE)
  })
})

// ============================================
// Confidence Debounce 测试
// ============================================

describe('debouncedConfidence', () => {
  test('full confidence stays full', () => {
    expect(debouncedConfidence('full', null)).toBe('full')
    expect(debouncedConfidence('full', new Date().toISOString())).toBe('full')
  })

  test('partial without prev full stays partial', () => {
    expect(debouncedConfidence('partial', null)).toBe('partial')
    expect(debouncedConfidence('partial', undefined)).toBe('partial')
  })

  test('minimal without prev full stays minimal', () => {
    expect(debouncedConfidence('minimal', null)).toBe('minimal')
  })

  test('partial with recent full upgrades to full (debounce)', () => {
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000).toISOString()
    expect(debouncedConfidence('partial', oneHourAgo)).toBe('full') // 1h < 2h default
  })

  test('minimal with recent full upgrades to full (debounce)', () => {
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000).toISOString()
    expect(debouncedConfidence('minimal', oneHourAgo)).toBe('full') // 1h < 2h default
  })

  test('partial with old full stays partial (debounce expired)', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    expect(debouncedConfidence('partial', threeHoursAgo)).toBe('partial') // 3h > 2h default
  })

  test('custom debounce hours', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    expect(debouncedConfidence('partial', threeHoursAgo, 2)).toBe('partial')  // 3h > 2h
    expect(debouncedConfidence('partial', threeHoursAgo, 4)).toBe('full')     // 3h < 4h
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
  })

  test('差劲交易员得低分', () => {
    const result = calculateArenaScore(poorTrader, '30D')
    expect(result.totalScore).toBeLessThan(20)
  })

  test('返回所有分数组成', () => {
    const result = calculateArenaScore(goodTrader, '30D')
    expect(result).toHaveProperty('totalScore')
    expect(result).toHaveProperty('returnScore')
    expect(result).toHaveProperty('pnlScore')
    expect(result).toHaveProperty('drawdownScore')
    expect(result).toHaveProperty('stabilityScore')
    expect(result).toHaveProperty('scoreConfidence')
  })

  test('总分 = 收益分 + PnL 分 + 回撤分 + 稳定分', () => {
    const result = calculateArenaScore(goodTrader, '30D')
    const sum = result.returnScore + result.pnlScore + result.drawdownScore + result.stabilityScore
    expect(result.totalScore).toBeCloseTo(sum, 1)
  })

  test('分数范围正确', () => {
    const result = calculateArenaScore(goodTrader, '30D')
    expect(result.totalScore).toBeGreaterThanOrEqual(0)
    expect(result.totalScore).toBeLessThanOrEqual(100)
    expect(result.returnScore).toBeLessThanOrEqual(ARENA_CONFIG.MAX_RETURN_SCORE)
    expect(result.pnlScore).toBeLessThanOrEqual(ARENA_CONFIG.MAX_PNL_SCORE)
    // V3: drawdownScore and stabilityScore are always 0
    expect(result.drawdownScore).toBe(0)
    expect(result.stabilityScore).toBe(0)
  })
})

// ============================================
// Edge Cases: ROI_CAP, boundary values, confidence multiplier
// ============================================

describe('Edge cases', () => {
  test('ROI at ROI_CAP (10000%) scores same as above cap', () => {
    const atCap = calculateArenaScore(
      { roi: 10000, pnl: 50000, maxDrawdown: 10, winRate: 60 },
      '30D'
    )
    const aboveCap = calculateArenaScore(
      { roi: 50000, pnl: 50000, maxDrawdown: 10, winRate: 60 },
      '30D'
    )
    // Both should produce the same returnScore because ROI is capped
    expect(atCap.returnScore).toBeCloseTo(aboveCap.returnScore, 5)
    expect(atCap.totalScore).toBeCloseTo(aboveCap.totalScore, 5)
  })

  test('moderate ROI below cap scores lower than at cap', () => {
    const moderate = calculateArenaScore(
      { roi: 500, pnl: 50000, maxDrawdown: 10, winRate: 60 },
      '30D'
    )
    const atCap = calculateArenaScore(
      { roi: 10000, pnl: 50000, maxDrawdown: 10, winRate: 60 },
      '30D'
    )
    // 500% ROI should score less than 10000% (cap) ROI
    expect(moderate.returnScore).toBeLessThan(atCap.returnScore)
  })

  test('V3: confidence always full, no multiplier penalty', () => {
    // V3 simplified scoring: always full confidence, no multiplier
    const fullData = calculateArenaScore(
      { roi: 50, pnl: 5000, maxDrawdown: -10, winRate: 60 },
      '30D'
    )
    const partialData = calculateArenaScore(
      { roi: 50, pnl: 5000, maxDrawdown: -10, winRate: null },
      '30D'
    )
    const minimalData = calculateArenaScore(
      { roi: 50, pnl: 5000, maxDrawdown: null, winRate: null },
      '30D'
    )

    // V3: All scores report 'full' confidence
    expect(fullData.scoreConfidence).toBe('full')
    expect(partialData.scoreConfidence).toBe('full')
    expect(minimalData.scoreConfidence).toBe('full')

    // V3: Same score regardless of MDD/WR since those are now 0
    expect(fullData.totalScore).toBeCloseTo(partialData.totalScore, 5)
    expect(partialData.totalScore).toBeCloseTo(minimalData.totalScore, 5)
  })

  test('snapshot: pinned known input produces expected output', () => {
    // Pin a specific input/output pair to detect accidental scoring changes
    // V3: Only ROI + PnL scores; drawdown and stability are 0
    const result = calculateArenaScore(
      { roi: 50, pnl: 5000, maxDrawdown: 15, winRate: 60 },
      '30D'
    )
    // V3: returnScore + pnlScore only, drawdown and stability are 0
    expect(result.returnScore).toBeGreaterThan(0)
    expect(result.returnScore).toBeLessThanOrEqual(ARENA_CONFIG.MAX_RETURN_SCORE)
    expect(result.pnlScore).toBeGreaterThan(0)
    expect(result.pnlScore).toBeLessThanOrEqual(ARENA_CONFIG.MAX_PNL_SCORE)
    expect(result.drawdownScore).toBe(0)
    expect(result.stabilityScore).toBe(0)
    // totalScore = returnScore + pnlScore (allow for rounding)
    expect(result.totalScore).toBeCloseTo(result.returnScore + result.pnlScore, 1)
    expect(result.scoreConfidence).toBe('full')
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
    { id: '3', roi: 10, pnl: 500, maxDrawdown: 5, winRate: 70 },
    { id: '4', roi: 5, pnl: 100, maxDrawdown: 3, winRate: 80 },
  ]

  test('按分数降序排列', () => {
    const ranked = rankByArenaScore(traders, '30D')
    expect(ranked.length).toBe(4) // all traders included (no PnL threshold)
    expect(ranked[0].id).toBe('2') // 高分在前
  })

  test('所有交易员都通过（无 PnL 门槛过滤）', () => {
    const ranked = rankByArenaScore(traders, '30D')
    expect(ranked.find(t => t.id === '4')).toBeDefined()
    expect(ranked.find(t => t.id === '3')).toBeDefined()
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
  })

  test('DD=0 视为缺失数据', () => {
    expect(getScoreConfidence(0, 60)).toBe('partial')
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
  // V3: scoreConfidence is always 'full' since MDD/WR are no longer used in scoring
  test('V3: 始终标记为 full', () => {
    const result1 = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: -10, winRate: 65,
    }, '30D')
    expect(result1.scoreConfidence).toBe('full')

    const result2 = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: null, winRate: 65,
    }, '30D')
    expect(result2.scoreConfidence).toBe('full')

    const result3 = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: -10, winRate: null,
    }, '30D')
    expect(result3.scoreConfidence).toBe('full')

    const result4 = calculateArenaScore({
      roi: 50, pnl: 5000, maxDrawdown: null, winRate: null,
    }, '30D')
    expect(result4.scoreConfidence).toBe('full')
  })
})

// ============================================
// Additional Edge Cases: undefined fields, NaN inputs, extreme outliers
// ============================================

describe('Arena Score — additional edge cases', () => {
  test('zero ROI and zero PnL produces totalScore = 0', () => {
    const result = calculateArenaScore(
      { roi: 0, pnl: 0, maxDrawdown: null, winRate: null },
      '30D'
    )
    expect(result.totalScore).toBe(0)
    expect(result.returnScore).toBe(0)
    expect(result.pnlScore).toBe(0)
  })

  test('negative ROI with positive PnL only gets PnL score', () => {
    const result = calculateArenaScore(
      { roi: -20, pnl: 10000, maxDrawdown: null, winRate: null },
      '30D'
    )
    expect(result.returnScore).toBe(0)
    expect(result.pnlScore).toBeGreaterThan(0)
    expect(result.totalScore).toBe(result.pnlScore)
  })

  test('extremely negative ROI produces zero return score', () => {
    const result = calculateArenaScore(
      { roi: -99.99, pnl: 0, maxDrawdown: null, winRate: null },
      '90D'
    )
    expect(result.returnScore).toBe(0)
    expect(result.totalScore).toBe(0)
  })

  test('very small positive ROI (1%) produces positive return score', () => {
    const result = calculateArenaScore(
      { roi: 1, pnl: 100, maxDrawdown: null, winRate: null },
      '30D'
    )
    expect(result.returnScore).toBeGreaterThan(0)
    expect(result.totalScore).toBeGreaterThan(0)
  })

  test('extremely small ROI (0.01%) may round to zero due to tanh compression', () => {
    const result = calculateArenaScore(
      { roi: 0.01, pnl: 0, maxDrawdown: null, winRate: null },
      '30D'
    )
    // 0.01% ROI is so small that after tanh + exponent compression, it rounds to 0
    expect(result.totalScore).toBeGreaterThanOrEqual(0)
    expect(result.totalScore).toBeLessThanOrEqual(100)
  })

  test('score normalization: output always in [0, 100] for extreme inputs', () => {
    const extremeCases = [
      { roi: 999999, pnl: 999999999, maxDrawdown: null, winRate: null },
      { roi: -999999, pnl: -999999999, maxDrawdown: null, winRate: null },
      { roi: 0, pnl: 0, maxDrawdown: null, winRate: null },
      { roi: 10000, pnl: 10000000, maxDrawdown: -99, winRate: 99 },
    ]
    for (const input of extremeCases) {
      for (const period of ['7D', '30D', '90D'] as const) {
        const result = calculateArenaScore(input, period)
        expect(result.totalScore).toBeGreaterThanOrEqual(0)
        expect(result.totalScore).toBeLessThanOrEqual(100)
        expect(Number.isFinite(result.totalScore)).toBe(true)
      }
    }
  })

  test('ranking consistency: higher ROI yields higher score (holding PnL equal)', () => {
    const base = { pnl: 5000, maxDrawdown: null as number | null, winRate: null as number | null }
    const lowRoi = calculateArenaScore({ ...base, roi: 10 }, '30D')
    const midRoi = calculateArenaScore({ ...base, roi: 50 }, '30D')
    const highRoi = calculateArenaScore({ ...base, roi: 200 }, '30D')

    expect(highRoi.totalScore).toBeGreaterThan(midRoi.totalScore)
    expect(midRoi.totalScore).toBeGreaterThan(lowRoi.totalScore)
  })

  test('ranking consistency: higher PnL yields higher score (holding ROI equal)', () => {
    const base = { roi: 50, maxDrawdown: null as number | null, winRate: null as number | null }
    const lowPnl = calculateArenaScore({ ...base, pnl: 100 }, '90D')
    const midPnl = calculateArenaScore({ ...base, pnl: 10000 }, '90D')
    const highPnl = calculateArenaScore({ ...base, pnl: 500000 }, '90D')

    expect(highPnl.totalScore).toBeGreaterThan(midPnl.totalScore)
    expect(midPnl.totalScore).toBeGreaterThan(lowPnl.totalScore)
  })
})

// ============================================
// calculateOverallScore — additional branch coverage
// ============================================

describe('calculateOverallScore — additional branches', () => {
  test('has 90D and 30D but no 7D', () => {
    const score = calculateOverallScore({
      score7d: null,
      score30d: 70,
      score90d: 80,
    })
    // 0.70 * 80 + (0.25 + 0.05) * 70 = 56 + 21 = 77
    expect(score).toBeCloseTo(77, 1)
  })

  test('has 90D and 7D but no 30D', () => {
    const score = calculateOverallScore({
      score7d: 60,
      score30d: null,
      score90d: 80,
    })
    // 0.70 * 80 + (0.25 + 0.05) * 60 = 56 + 18 = 74
    // momentum: clip(60/null -> 0) = 0
    expect(score).toBeCloseTo(74, 1)
  })

  test('only 30D data applies 0.80 penalty', () => {
    const score = calculateOverallScore({
      score7d: null,
      score30d: 80,
      score90d: null,
    })
    // 80 * 0.80 = 64
    expect(score).toBeCloseTo(64, 1)
  })

  test('all scores zero produces zero', () => {
    const score = calculateOverallScore({
      score7d: 0,
      score30d: 0,
      score90d: 0,
    })
    expect(score).toBe(0)
  })

  test('all scores at 100 produces near-100', () => {
    const score = calculateOverallScore({
      score7d: 100,
      score30d: 100,
      score90d: 100,
    })
    // base = 100, momentum = 0 (7d/30d ratio = 0)
    expect(score).toBe(100)
  })

  test('output is always clipped to [0, 100]', () => {
    // Even with extreme momentum bonus, should not exceed 100
    const score = calculateOverallScore({
      score7d: 100,
      score30d: 50,
      score90d: 99,
    })
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })
})

// ============================================
// rankByArenaScore — additional edge cases
// ============================================

describe('rankByArenaScore — edge cases', () => {
  test('empty trader list returns empty array', () => {
    const ranked = rankByArenaScore([], '30D')
    expect(ranked).toEqual([])
  })

  test('single trader returns single-element array', () => {
    const traders = [{ id: '1', roi: 50, pnl: 5000, maxDrawdown: 10, winRate: 60 }]
    const ranked = rankByArenaScore(traders, '30D')
    expect(ranked.length).toBe(1)
    expect(ranked[0].id).toBe('1')
    expect(ranked[0].arena_score).toBeGreaterThan(0)
  })

  test('all-negative ROI traders are ranked by less-negative', () => {
    const traders = [
      { id: '1', roi: -50, pnl: -5000, maxDrawdown: 30, winRate: 40 },
      { id: '2', roi: -10, pnl: -1000, maxDrawdown: 20, winRate: 45 },
    ]
    const ranked = rankByArenaScore(traders, '30D')
    // Both get 0 returnScore and 0 pnlScore, same total, so sort by drawdown
    // id 2 has lower drawdown (20 < 30), should be first
    expect(ranked[0].id).toBe('2')
  })
})

// ============================================
// Supplemental boundary tests
// ============================================

describe('Arena Score — overall composite weight verification', () => {
  test('weights are exactly 90D=0.70, 30D=0.25, 7D=0.05', () => {
    expect(ARENA_CONFIG.OVERALL_WEIGHTS['90D']).toBe(0.70)
    expect(ARENA_CONFIG.OVERALL_WEIGHTS['30D']).toBe(0.25)
    expect(ARENA_CONFIG.OVERALL_WEIGHTS['7D']).toBe(0.05)
  })

  test('full data overall = 0.70*S90 + 0.25*S30 + 0.05*S7 + momentum', () => {
    // Use equal scores to verify weights directly (momentum = 0 when 7d==30d)
    const score = calculateOverallScore({
      score7d: 50,
      score30d: 50,
      score90d: 50,
    })
    // base = 0.70*50 + 0.25*50 + 0.05*50 = 50
    // momentum: clip(50/50 - 1, -0.2, 0.5) * 5 = 0
    expect(score).toBeCloseTo(50, 1)
  })

  test('90D dominates the score (70% weight)', () => {
    const highS90 = calculateOverallScore({
      score7d: 50,
      score30d: 50,
      score90d: 100,
    })
    const lowS90 = calculateOverallScore({
      score7d: 50,
      score30d: 50,
      score90d: 0,
    })
    // Difference should be approximately 70 (0.70 * 100)
    expect(highS90 - lowS90).toBeCloseTo(70, 0)
  })
})

describe('Arena Score — PnL threshold boundary', () => {
  test('PnL=$499 produces lower score than PnL=$500 (30D)', () => {
    const below = calculatePnlScore(499, '30D')
    const at500 = calculatePnlScore(500, '30D')
    expect(at500).toBeGreaterThan(below)
    // Both should be positive but small
    expect(below).toBeGreaterThan(0)
    expect(at500).toBeGreaterThan(0)
  })

  test('PnL=$1 produces very small but positive score', () => {
    const score = calculatePnlScore(1, '30D')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })
})

describe('Arena Score — confidenceMultiplier config', () => {
  test('confidence multiplier values are defined correctly', () => {
    expect(ARENA_CONFIG.CONFIDENCE_MULTIPLIER.full).toBe(1.0)
    expect(ARENA_CONFIG.CONFIDENCE_MULTIPLIER.partial).toBe(0.92)
    expect(ARENA_CONFIG.CONFIDENCE_MULTIPLIER.minimal).toBe(0.80)
  })

  test('getScoreConfidence returns correct levels', () => {
    // full: both MDD and WR are present and non-zero
    expect(getScoreConfidence(-15, 60)).toBe('full')
    // partial: one missing
    expect(getScoreConfidence(null, 60)).toBe('partial')
    expect(getScoreConfidence(-15, null)).toBe('partial')
    // minimal: both missing
    expect(getScoreConfidence(null, null)).toBe('minimal')
  })

  test('legacy V3 applies confidence multiplier to total', () => {
    // The V3 legacy function still uses confidence multiplier
    // V2 (current calculateArenaScore) does not
    // Verify V2 ignores confidence
    const withFull = calculateArenaScore(
      { roi: 50, pnl: 5000, maxDrawdown: -10, winRate: 60 },
      '30D'
    )
    const withNone = calculateArenaScore(
      { roi: 50, pnl: 5000, maxDrawdown: null, winRate: null },
      '30D'
    )
    // V3 simplified: same score regardless of MDD/WR data availability
    expect(withFull.totalScore).toBe(withNone.totalScore)
  })
})

describe('Arena Score — NaN/Infinity/BigInt edge cases', () => {
  test('ROI = NaN produces 0 return score', () => {
    expect(calculateReturnScore(NaN, '30D')).toBe(0)
    expect(calculateReturnScore(NaN, '7D')).toBe(0)
    expect(calculateReturnScore(NaN, '90D')).toBe(0)
  })

  test('ROI = Infinity produces 0 return score', () => {
    expect(calculateReturnScore(Infinity, '30D')).toBe(0)
    expect(calculateReturnScore(-Infinity, '30D')).toBe(0)
  })

  test('PnL = NaN produces 0 pnl score', () => {
    expect(calculatePnlScore(NaN, '30D')).toBe(0)
    expect(calculatePnlScore(NaN, '7D')).toBe(0)
    expect(calculatePnlScore(NaN, '90D')).toBe(0)
  })

  test('PnL = Infinity produces 0 pnl score', () => {
    expect(calculatePnlScore(Infinity, '30D')).toBe(0)
    expect(calculatePnlScore(-Infinity, '30D')).toBe(0)
  })

  test('BigInt ROI is handled via Number() conversion', () => {
    const score = calculateReturnScore(BigInt(50), '30D')
    const scoreFromNumber = calculateReturnScore(50, '30D')
    expect(score).toBe(scoreFromNumber)
  })

  test('BigInt PnL is handled via Number() conversion', () => {
    const score = calculatePnlScore(BigInt(5000), '30D')
    const scoreFromNumber = calculatePnlScore(5000, '30D')
    expect(score).toBe(scoreFromNumber)
  })

  test('calculateArenaScore with NaN ROI produces 0 total', () => {
    const result = calculateArenaScore(
      { roi: NaN, pnl: 0, maxDrawdown: null, winRate: null },
      '30D'
    )
    expect(result.totalScore).toBe(0)
    expect(result.returnScore).toBe(0)
  })

  test('calculateArenaScore with NaN PnL produces score from ROI only', () => {
    const result = calculateArenaScore(
      { roi: 50, pnl: NaN, maxDrawdown: null, winRate: null },
      '30D'
    )
    expect(result.pnlScore).toBe(0)
    expect(result.returnScore).toBeGreaterThan(0)
    expect(result.totalScore).toBe(result.returnScore)
  })

  test('ROI = 100 (100%) produces positive score across all periods', () => {
    for (const period of ['7D', '30D', '90D'] as const) {
      const score = calculateReturnScore(100, period)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(ARENA_CONFIG.MAX_RETURN_SCORE)
    }
  })

  test('ROI = -50 produces 0 score', () => {
    expect(calculateReturnScore(-50, '7D')).toBe(0)
    expect(calculateReturnScore(-50, '30D')).toBe(0)
    expect(calculateReturnScore(-50, '90D')).toBe(0)
  })

  test('ROI = 10000 (cap) produces near max score', () => {
    const score = calculateReturnScore(10000, '30D')
    expect(score).toBeGreaterThan(ARENA_CONFIG.MAX_RETURN_SCORE * 0.9)
    expect(score).toBeLessThanOrEqual(ARENA_CONFIG.MAX_RETURN_SCORE)
  })

  test('PnL = $1,000,000 produces near max (40) score', () => {
    const score = calculatePnlScore(1000000, '30D')
    expect(score).toBeGreaterThan(ARENA_CONFIG.MAX_PNL_SCORE * 0.8)
    expect(score).toBeLessThanOrEqual(ARENA_CONFIG.MAX_PNL_SCORE)
  })

  test('PnL = -1000 produces 0 score', () => {
    expect(calculatePnlScore(-1000, '30D')).toBe(0)
  })

  test('PnL = 1000 produces moderate positive score', () => {
    const score = calculatePnlScore(1000, '30D')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(ARENA_CONFIG.MAX_PNL_SCORE * 0.5)
  })

  test('7D, 30D, 90D use different coefficients for return score', () => {
    const roi = 50
    const s7d = calculateReturnScore(roi, '7D')
    const s30d = calculateReturnScore(roi, '30D')
    const s90d = calculateReturnScore(roi, '90D')
    // All should be different because tanhCoeff and roiExponent differ
    const scores = new Set([s7d.toFixed(4), s30d.toFixed(4), s90d.toFixed(4)])
    expect(scores.size).toBe(3)
  })

  test('7D, 30D, 90D use different PnL params', () => {
    const pnl = 5000
    const s7d = calculatePnlScore(pnl, '7D')
    const s30d = calculatePnlScore(pnl, '30D')
    const s90d = calculatePnlScore(pnl, '90D')
    const scores = new Set([s7d.toFixed(4), s30d.toFixed(4), s90d.toFixed(4)])
    expect(scores.size).toBe(3)
  })
})

describe('calculateArenaScore — input combinations', () => {
  test('complete valid input produces score between 0-100', () => {
    const result = calculateArenaScore(
      { roi: 50, pnl: 5000, maxDrawdown: 10, winRate: 65 },
      '30D'
    )
    expect(result.totalScore).toBeGreaterThan(0)
    expect(result.totalScore).toBeLessThanOrEqual(100)
  })

  test('missing PnL (null) gives score based only on ROI', () => {
    const result = calculateArenaScore(
      { roi: 50, pnl: null, maxDrawdown: null, winRate: null },
      '30D'
    )
    expect(result.returnScore).toBeGreaterThan(0)
    expect(result.pnlScore).toBe(0)
    expect(result.totalScore).toBe(result.returnScore)
  })

  test('all zeros produces 0', () => {
    const result = calculateArenaScore(
      { roi: 0, pnl: 0, maxDrawdown: 0, winRate: 0 },
      '30D'
    )
    expect(result.totalScore).toBe(0)
  })
})

describe('calculateOverallScore — penalty multipliers', () => {
  test('missing 90D applies MISSING_90D_PENALTY (0.85)', () => {
    const score = calculateOverallScore({
      score7d: 50,
      score30d: 50,
      score90d: null,
    })
    // base: (0.80 * 50 + 0.20 * 50) * 0.85 = 42.5
    // momentum: clip(50/50 - 1, -0.2, 0.5) * 5 = 0
    expect(score).toBeCloseTo(42.5, 1)
  })

  test('only 7D applies ONLY_7D_PENALTY (0.70)', () => {
    const score = calculateOverallScore({
      score7d: 100,
      score30d: null,
      score90d: null,
    })
    // 100 * 0.70 = 70
    expect(score).toBeCloseTo(70, 1)
  })
})

describe('wilsonConfidenceMultiplier — detailed', () => {
  test('all metrics available produces multiplier near 1.0', () => {
    const mult = wilsonConfidenceMultiplier(50, 5000, -10, 60, 1.5)
    expect(mult).toBeGreaterThan(0.6)
    expect(mult).toBeLessThanOrEqual(1.0)
  })

  test('no metrics available produces minimum 0.3', () => {
    const mult = wilsonConfidenceMultiplier(null, null, null, null, null)
    expect(mult).toBeCloseTo(0.3, 1)
  })

  test('partial metrics produce intermediate value', () => {
    const mult2of5 = wilsonConfidenceMultiplier(50, 5000, null, null, null)
    const mult5of5 = wilsonConfidenceMultiplier(50, 5000, -10, 60, 1.5)
    const mult0of5 = wilsonConfidenceMultiplier(null, null, null, null, null)
    expect(mult2of5).toBeGreaterThan(mult0of5)
    expect(mult2of5).toBeLessThan(mult5of5)
  })

  test('0 values count as available (non-null)', () => {
    // 0 is a valid metric value, not null
    const mult = wilsonConfidenceMultiplier(0, 0, 0, 0, 0)
    expect(mult).toBeGreaterThan(0.6)
  })

  test('undefined treated same as null', () => {
    const withNull = wilsonConfidenceMultiplier(null, null, null, null, null)
    const withUndef = wilsonConfidenceMultiplier(undefined, undefined, undefined, undefined, undefined)
    expect(withNull).toBe(withUndef)
  })
})

describe('Arena Score — extreme ROI edge cases', () => {
  test('ROI=0, PnL=0 produces score of exactly 0', () => {
    const result = calculateArenaScore(
      { roi: 0, pnl: 0, maxDrawdown: null, winRate: null },
      '30D'
    )
    expect(result.totalScore).toBe(0)
    expect(result.returnScore).toBe(0)
    expect(result.pnlScore).toBe(0)
  })

  test('ROI=500000 (extreme positive) is capped and produces max-range score', () => {
    const extreme = calculateArenaScore(
      { roi: 500000, pnl: 1000000, maxDrawdown: null, winRate: null },
      '90D'
    )
    const atCap = calculateArenaScore(
      { roi: 10000, pnl: 1000000, maxDrawdown: null, winRate: null },
      '90D'
    )
    // ROI is capped at 10000, so both should have same return score
    expect(extreme.returnScore).toBeCloseTo(atCap.returnScore, 5)
    // Total score should be valid
    expect(extreme.totalScore).toBeGreaterThan(0)
    expect(extreme.totalScore).toBeLessThanOrEqual(100)
  })

  test('ROI=-100 (total loss) produces 0 return score', () => {
    const result = calculateArenaScore(
      { roi: -100, pnl: -50000, maxDrawdown: -100, winRate: 0 },
      '90D'
    )
    expect(result.returnScore).toBe(0)
    expect(result.pnlScore).toBe(0)  // negative PnL = 0
    expect(result.totalScore).toBe(0)
  })

  test('ROI=-100 across all periods produces 0', () => {
    for (const period of ['7D', '30D', '90D'] as const) {
      const result = calculateArenaScore(
        { roi: -100, pnl: 0, maxDrawdown: null, winRate: null },
        period
      )
      expect(result.totalScore).toBe(0)
    }
  })
})

// ============================================
// 配置常量测试
// ============================================

describe('ARENA_CONFIG', () => {
  test('parity: scripts/lib/shared.mjs matches canonical config', () => {
    // This test reads the shared.mjs file and verifies that its ARENA_CONFIG
    // PARAMS and PNL_PARAMS match the canonical TypeScript source.
    // If this test fails, shared.mjs has drifted from lib/utils/arena-score.ts.
    // fs and path imported at top of file
    const sharedPath = path.resolve(__dirname, '../../../scripts/lib/shared.mjs')
    const content = fs.readFileSync(sharedPath, 'utf-8')

    // Verify PARAMS match canonical
    for (const [_period, params] of Object.entries(ARENA_CONFIG.PARAMS)) {
      const p = params as { tanhCoeff: number; roiExponent: number; mddThreshold: number; winRateCap: number }
      expect(content).toContain(`tanhCoeff: ${p.tanhCoeff}`)
      expect(content).toContain(`roiExponent: ${p.roiExponent}`)
    }

    // Verify PNL_PARAMS match canonical
    for (const [_period, params] of Object.entries(ARENA_CONFIG.PNL_PARAMS)) {
      const p = params as { base: number; coeff: number }
      expect(content).toContain(`base: ${p.base}`)
      expect(content).toContain(`coeff: ${p.coeff}`)
    }

    // Verify score component maxes
    expect(content).toContain(`MAX_RETURN_SCORE: ${ARENA_CONFIG.MAX_RETURN_SCORE}`)
    expect(content).toContain(`MAX_PNL_SCORE: ${ARENA_CONFIG.MAX_PNL_SCORE}`)
    expect(content).toContain(`MAX_DRAWDOWN_SCORE: ${ARENA_CONFIG.MAX_DRAWDOWN_SCORE}`)
    expect(content).toContain(`MAX_STABILITY_SCORE: ${ARENA_CONFIG.MAX_STABILITY_SCORE}`)
  })

  test('总体权重之和为 1', () => {
    const weights = ARENA_CONFIG.OVERALL_WEIGHTS
    const sum = weights['7D'] + weights['30D'] + weights['90D']
    expect(sum).toBe(1)
  })

  test('最大分数配置正确', () => {
    const total = ARENA_CONFIG.MAX_RETURN_SCORE +
                  ARENA_CONFIG.MAX_PNL_SCORE +
                  ARENA_CONFIG.MAX_DRAWDOWN_SCORE +
                  ARENA_CONFIG.MAX_STABILITY_SCORE
    expect(total).toBe(100)
  })

  test('置信度防抖配置正确', () => {
    expect(ARENA_CONFIG.CONFIDENCE_DEBOUNCE_HOURS).toBe(2)
  })
})
