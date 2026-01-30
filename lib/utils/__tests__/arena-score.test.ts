/**
 * Arena Score 计算模块单元测试
 */

import {
  clip,
  safeLog1p,
  calculateRoiIntensity,
  calculateReturnScore,
  calculatePnlScore,
  calculateDrawdownScore,
  calculateStabilityScore,
  meetsThreshold,
  meetsHardThreshold,
  calculatePnlQualifier,
  isWithinGracePeriod,
  debouncedConfidence,
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
    expect(score).toBeLessThanOrEqual(70)
  })

  test('负收益返回 0', () => {
    expect(calculateReturnScore(-50, '30D')).toBe(0)
    expect(calculateReturnScore(-10, '7D')).toBe(0)
  })

  test('0 收益返回 0', () => {
    expect(calculateReturnScore(0, '30D')).toBe(0)
  })

  test('高收益接近但不超过 70 分', () => {
    const score = calculateReturnScore(500, '30D')
    expect(score).toBeLessThanOrEqual(70)
    expect(score).toBeGreaterThan(55)
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
  test('0 回撤视为缺失数据（使用默认中位值）', () => {
    // DD=0 被当作数据缺失，使用默认 -20%
    const score = calculateDrawdownScore(0, '30D')
    expect(score).toBeCloseTo(2.67, 1)
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
// PnL 分计算测试
// ============================================

describe('calculatePnlScore', () => {
  test('正 PnL 有正分数', () => {
    const score = calculatePnlScore(5000, '30D')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(15)
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

  test('大额 PnL 接近但不超过 15 分', () => {
    const score = calculatePnlScore(1000000, '90D')
    expect(score).toBeLessThanOrEqual(15)
    expect(score).toBeGreaterThan(13)
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

  test('90D PnL 分布合理', () => {
    // 验证关键节点的分数分布
    const s1k = calculatePnlScore(1000, '90D')
    const s5k = calculatePnlScore(5000, '90D')
    const s50k = calculatePnlScore(50000, '90D')
    const s200k = calculatePnlScore(200000, '90D')

    expect(s1k).toBeCloseTo(0.8, 0)
    expect(s5k).toBeCloseTo(3.1, 0)
    expect(s50k).toBeCloseTo(9.3, 0)
    expect(s200k).toBeCloseTo(12.1, 0)
  })
})

// ============================================
// 入榜门槛测试
// ============================================

describe('meetsThreshold (soft)', () => {
  // meetsThreshold now uses softFloor = threshold * 0.5
  // 7D: softFloor = 100, 30D: softFloor = 250, 90D: softFloor = 500

  test('7D 软门槛检查 (softFloor = $100)', () => {
    expect(meetsThreshold(50, '7D')).toBe(false)   // below softFloor
    expect(meetsThreshold(100, '7D')).toBe(false)   // at softFloor boundary (not >)
    expect(meetsThreshold(101, '7D')).toBe(true)    // above softFloor
    expect(meetsThreshold(200, '7D')).toBe(true)    // at old threshold
    expect(meetsThreshold(500, '7D')).toBe(true)    // well above
  })

  test('30D 软门槛检查 (softFloor = $250)', () => {
    expect(meetsThreshold(200, '30D')).toBe(false)  // below softFloor
    expect(meetsThreshold(250, '30D')).toBe(false)  // at softFloor boundary
    expect(meetsThreshold(251, '30D')).toBe(true)   // above softFloor
    expect(meetsThreshold(500, '30D')).toBe(true)   // at old threshold
  })

  test('90D 软门槛检查 (softFloor = $500)', () => {
    expect(meetsThreshold(400, '90D')).toBe(false)  // below softFloor
    expect(meetsThreshold(500, '90D')).toBe(false)  // at softFloor boundary
    expect(meetsThreshold(501, '90D')).toBe(true)   // above softFloor
    expect(meetsThreshold(1000, '90D')).toBe(true)  // at old threshold
  })
})

describe('meetsHardThreshold', () => {
  test('7D 硬门槛检查 (原始行为)', () => {
    expect(meetsHardThreshold(100, '7D')).toBe(false)
    expect(meetsHardThreshold(200, '7D')).toBe(false) // 边界，不满足 >
    expect(meetsHardThreshold(201, '7D')).toBe(true)
    expect(meetsHardThreshold(500, '7D')).toBe(true)
  })

  test('30D 硬门槛检查', () => {
    expect(meetsHardThreshold(500, '30D')).toBe(false)
    expect(meetsHardThreshold(501, '30D')).toBe(true)
  })

  test('90D 硬门槛检查', () => {
    expect(meetsHardThreshold(1000, '90D')).toBe(false)
    expect(meetsHardThreshold(1001, '90D')).toBe(true)
  })
})

// ============================================
// PnL Qualifier 测试（软门槛）
// ============================================

describe('calculatePnlQualifier', () => {
  // 7D: softFloor=100, threshold=200, fullQualify=300
  test('7D: below softFloor returns 0', () => {
    expect(calculatePnlQualifier(50, '7D')).toBe(0)
    expect(calculatePnlQualifier(100, '7D')).toBe(0) // at boundary, not >
  })

  test('7D: in ramp zone returns 0~1', () => {
    // midpoint: (200 - 100) / (300 - 100) = 0.5
    expect(calculatePnlQualifier(200, '7D')).toBeCloseTo(0.5, 2)
    // quarter: (150 - 100) / (300 - 100) = 0.25
    expect(calculatePnlQualifier(150, '7D')).toBeCloseTo(0.25, 2)
  })

  test('7D: at or above fullQualify returns 1', () => {
    expect(calculatePnlQualifier(300, '7D')).toBe(1)
    expect(calculatePnlQualifier(1000, '7D')).toBe(1)
  })

  // 30D: softFloor=250, threshold=500, fullQualify=750
  test('30D: below softFloor returns 0', () => {
    expect(calculatePnlQualifier(200, '30D')).toBe(0)
    expect(calculatePnlQualifier(250, '30D')).toBe(0)
  })

  test('30D: in ramp zone returns 0~1', () => {
    // (500 - 250) / (750 - 250) = 0.5
    expect(calculatePnlQualifier(500, '30D')).toBeCloseTo(0.5, 2)
  })

  test('30D: above fullQualify returns 1', () => {
    expect(calculatePnlQualifier(750, '30D')).toBe(1)
    expect(calculatePnlQualifier(5000, '30D')).toBe(1)
  })

  // 90D: softFloor=500, threshold=1000, fullQualify=1500
  test('90D: below softFloor returns 0', () => {
    expect(calculatePnlQualifier(400, '90D')).toBe(0)
    expect(calculatePnlQualifier(500, '90D')).toBe(0)
  })

  test('90D: in ramp zone linear interpolation', () => {
    // (800 - 500) / (1500 - 500) = 0.3
    expect(calculatePnlQualifier(800, '90D')).toBeCloseTo(0.3, 2)
    // (1000 - 500) / (1500 - 500) = 0.5
    expect(calculatePnlQualifier(1000, '90D')).toBeCloseTo(0.5, 2)
    // (1200 - 500) / (1500 - 500) = 0.7
    expect(calculatePnlQualifier(1200, '90D')).toBeCloseTo(0.7, 2)
  })

  test('90D: above fullQualify returns 1', () => {
    expect(calculatePnlQualifier(1500, '90D')).toBe(1)
    expect(calculatePnlQualifier(100000, '90D')).toBe(1)
  })

  test('negative PnL returns 0', () => {
    expect(calculatePnlQualifier(-1000, '30D')).toBe(0)
    expect(calculatePnlQualifier(-1, '7D')).toBe(0)
  })
})

// ============================================
// Grace Period 测试
// ============================================

describe('isWithinGracePeriod', () => {
  test('null lastQualifiedAt returns false', () => {
    expect(isWithinGracePeriod(null)).toBe(false)
    expect(isWithinGracePeriod(undefined)).toBe(false)
  })

  test('recent timestamp within grace period returns true', () => {
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000).toISOString()
    expect(isWithinGracePeriod(oneHourAgo)).toBe(true)
  })

  test('timestamp at 23 hours within default 24h grace period', () => {
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 3600 * 1000).toISOString()
    expect(isWithinGracePeriod(twentyThreeHoursAgo)).toBe(true)
  })

  test('timestamp beyond grace period returns false', () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    expect(isWithinGracePeriod(twoDaysAgo)).toBe(false)
  })

  test('custom grace period hours', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString()
    expect(isWithinGracePeriod(fiveHoursAgo, 4)).toBe(false) // 5h > 4h
    expect(isWithinGracePeriod(fiveHoursAgo, 6)).toBe(true)  // 5h < 6h
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
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    expect(debouncedConfidence('partial', twoHoursAgo)).toBe('full')
  })

  test('minimal with recent full upgrades to full (debounce)', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString()
    expect(debouncedConfidence('minimal', fiveHoursAgo)).toBe('full') // 5h < 8h default
  })

  test('partial with old full stays partial (debounce expired)', () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000).toISOString()
    expect(debouncedConfidence('partial', tenHoursAgo)).toBe('partial') // 10h > 8h
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
    expect(result).toHaveProperty('pnlScore')
    expect(result).toHaveProperty('drawdownScore')
    expect(result).toHaveProperty('stabilityScore')
    expect(result).toHaveProperty('meetsThreshold')
    expect(result).toHaveProperty('pnlQualifier')
  })

  test('pnlQualifier 反映软门槛位置', () => {
    // goodTrader: pnl=5000, 30D fullQualify=750 → qualifier=1
    const result = calculateArenaScore(goodTrader, '30D')
    expect(result.pnlQualifier).toBe(1)

    // poorTrader: pnl=-500 → qualifier=0
    const poorResult = calculateArenaScore(poorTrader, '30D')
    expect(poorResult.pnlQualifier).toBe(0)

    // Border trader: pnl=500, 30D softFloor=250, fullQualify=750
    // qualifier = (500-250)/(750-250) = 0.5
    const borderResult = calculateArenaScore(
      { roi: 30, pnl: 500, maxDrawdown: 10, winRate: 55 },
      '30D'
    )
    expect(borderResult.pnlQualifier).toBeCloseTo(0.5, 2)
    expect(borderResult.meetsThreshold).toBe(true) // pnl=500 > softFloor=250
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
    expect(result.returnScore).toBeLessThanOrEqual(70)
    expect(result.pnlScore).toBeLessThanOrEqual(15)
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
    { id: '3', roi: 10, pnl: 500, maxDrawdown: 5, winRate: 70 },  // 30D softFloor=250, passes
    { id: '4', roi: 5, pnl: 100, maxDrawdown: 3, winRate: 80 },   // 30D softFloor=250, fails
  ]

  test('按分数降序排列', () => {
    const ranked = rankByArenaScore(traders, '30D')
    expect(ranked.length).toBe(3) // id:4 被过滤（pnl=100 < softFloor=250）
    expect(ranked[0].id).toBe('2') // 高分在前
  })

  test('过滤未达软门槛的交易员', () => {
    const ranked = rankByArenaScore(traders, '30D')
    expect(ranked.find(t => t.id === '4')).toBeUndefined() // pnl=100 < softFloor=250
    expect(ranked.find(t => t.id === '3')).toBeDefined()   // pnl=500 > softFloor=250
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
                  ARENA_CONFIG.MAX_PNL_SCORE +
                  ARENA_CONFIG.MAX_DRAWDOWN_SCORE +
                  ARENA_CONFIG.MAX_STABILITY_SCORE
    expect(total).toBe(100)
  })

  test('排行榜稳定性配置正确', () => {
    expect(ARENA_CONFIG.GRACE_PERIOD_HOURS).toBe(24)
    expect(ARENA_CONFIG.CONFIDENCE_DEBOUNCE_HOURS).toBe(8)
    expect(ARENA_CONFIG.PNL_RAMP.SOFT_FLOOR_FACTOR).toBe(0.5)
    expect(ARENA_CONFIG.PNL_RAMP.FULL_QUALIFY_FACTOR).toBe(1.5)
  })

  test('软门槛区间合理', () => {
    // 验证每个周期的软门槛区间
    const periods: Array<'7D' | '30D' | '90D'> = ['7D', '30D', '90D']
    for (const period of periods) {
      const threshold = ARENA_CONFIG.PNL_THRESHOLD[period]
      const softFloor = threshold * ARENA_CONFIG.PNL_RAMP.SOFT_FLOOR_FACTOR
      const fullQualify = threshold * ARENA_CONFIG.PNL_RAMP.FULL_QUALIFY_FACTOR
      expect(softFloor).toBeLessThan(threshold)
      expect(threshold).toBeLessThan(fullQualify)
    }
  })
})
