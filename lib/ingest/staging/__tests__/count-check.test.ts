jest.mock('../../db', () => ({ getIngestPool: jest.fn() }))

import { median, evaluateCount } from '../count-check'

describe('median', () => {
  it('空数组 → null', () => {
    expect(median([])).toBeNull()
  })

  it('奇数长度 → 中位', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([5])).toBe(5)
  })

  it('偶数长度 → 两中位均值', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([10, 20])).toBe(15)
  })

  it('不修改入参（拷贝后排序）', () => {
    const input = [3, 1, 2]
    median(input)
    expect(input).toEqual([3, 1, 2]) // 原数组顺序不变
  })

  it('负数/混合正确排序', () => {
    expect(median([-5, 0, 5])).toBe(0)
    expect(median([-10, -20, -30])).toBe(-20)
  })
})

describe('evaluateCount — 发布门', () => {
  it('baseline=null → pass（无基线可比，放行）', () => {
    const v = evaluateCount(100, null)
    expect(v.passed).toBe(true)
    expect(v.deviationPct).toBeNull()
    expect(v.baselineUsed).toBeNull()
  })

  it('baseline<=0 → pass（无效基线，放行）', () => {
    expect(evaluateCount(100, 0).passed).toBe(true)
    expect(evaluateCount(100, -5).passed).toBe(true)
  })

  it('actual 与 baseline 一致 → pass，偏差 0', () => {
    const v = evaluateCount(1000, 1000)
    expect(v.passed).toBe(true)
    expect(v.deviationPct).toBe(0)
  })

  it('偏差在 ±10% 内 → pass', () => {
    expect(evaluateCount(1050, 1000).passed).toBe(true) // 5%
    expect(evaluateCount(950, 1000).passed).toBe(true) // 5%
  })

  it('偏差恰好 10% → pass（<= 边界含等号）', () => {
    const v = evaluateCount(1100, 1000)
    expect(v.deviationPct).toBe(10)
    expect(v.passed).toBe(true)
  })

  it('偏差 >10% → fail（截断爬取不发布）', () => {
    const v = evaluateCount(1200, 1000)
    expect(v.deviationPct).toBeCloseTo(20)
    expect(v.passed).toBe(false)
  })

  it('骤降（爬取只拿到一半）→ fail', () => {
    const v = evaluateCount(500, 1000)
    expect(v.passed).toBe(false)
    expect(v.baselineUsed).toBe(1000)
  })

  it('自定义 maxDeviationPct 生效', () => {
    expect(evaluateCount(1200, 1000, 30).passed).toBe(true) // 20% < 30%
    expect(evaluateCount(1400, 1000, 30).passed).toBe(false) // 40% > 30%
  })
})
