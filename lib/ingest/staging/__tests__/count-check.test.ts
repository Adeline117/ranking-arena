jest.mock('../../db', () => ({ getIngestPool: jest.fn() }))

import { getIngestPool } from '../../db'
import { median, evaluateCount, getCountBaseline } from '../count-check'

const mockQuery = jest.fn()
const mockGetIngestPool = jest.mocked(getIngestPool)

beforeEach(() => {
  mockQuery.mockReset()
  mockGetIngestPool.mockReturnValue({ query: mockQuery } as never)
})

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

  it.each([
    [5, 8, true],
    [5, 9, false],
    [5, 10, false],
    [6, 8, true],
    [6, 9, true],
    [6, 10, false],
    [8, 10, true],
    [25, 28, true],
    [26, 29, false],
  ])('小榜向上扩张 baseline=%i actual=%i → passed=%s', (baseline, actual, passed) => {
    expect(evaluateCount(actual, baseline).passed).toBe(passed)
  })

  it.each([
    [20, 26],
    [21, 26],
  ])('小榜相对增长 baseline=%i actual=%i 放行', (baseline, actual) => {
    expect(evaluateCount(actual, baseline).passed).toBe(true)
  })

  it('小榜放宽不外溢到大榜', () => {
    expect(evaluateCount(1200, 1000).passed).toBe(false)
    expect(evaluateCount(34, 26).passed).toBe(false)
  })

  it('骤降（爬取只拿到一半）→ fail', () => {
    const v = evaluateCount(500, 1000)
    expect(v.passed).toBe(false)
    expect(v.baselineUsed).toBe(1000)
  })

  it.each([
    [6, 2],
    [20, 10],
    [21, 15],
  ])('小榜真实截断 baseline=%i actual=%i 仍拒绝', (baseline, actual) => {
    expect(evaluateCount(actual, baseline).passed).toBe(false)
  })

  it('自定义 maxDeviationPct 生效', () => {
    expect(evaluateCount(1200, 1000, 30).passed).toBe(true) // 20% < 30%
    expect(evaluateCount(1400, 1000, 30).passed).toBe(false) // 40% > 30%
  })
})

describe('getCountBaseline — 独立观测周期', () => {
  const passingBaseline = [
    { actual_count: 100, cycle_id: 'pass-c' },
    { actual_count: 100, cycle_id: 'pass-b' },
    { actual_count: 100, cycle_id: 'pass-a' },
  ]

  it('第三个独立周期把当前观测计入 level-shift 证据', async () => {
    mockQuery.mockResolvedValueOnce({ rows: passingBaseline }).mockResolvedValueOnce({
      rows: [
        { actual_count: 130, cycle_id: 'shift-b', explicit_cycle: true },
        { actual_count: 130, cycle_id: 'shift-a', explicit_cycle: true },
      ],
    })

    await expect(
      getCountBaseline(19, 30, 100, { actualCount: 130, cycleId: 'shift-c' })
    ).resolves.toEqual({ baseline: 130, isBootstrap: false, shifted: true })

    expect(mockQuery.mock.calls[1][1]).toEqual([19, 30, 2, false, 'shift-c'])
  })

  it('同一 BullMQ cycle 的 retry 被排除，不能凑 level-shift quorum', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: passingBaseline })
      // The SQL returns at most one row per other cycle. Prior attempts carrying
      // the current cycle id are excluded before LIMIT.
      .mockResolvedValueOnce({
        rows: [{ actual_count: 130, cycle_id: 'shift-prior', explicit_cycle: true }],
      })

    await expect(
      getCountBaseline(19, 30, 100, { actualCount: 130, cycleId: 'same-job' })
    ).resolves.toEqual({ baseline: 100, isBootstrap: false })

    const sql = String(mockQuery.mock.calls[1][0])
    expect(sql).toContain('DISTINCT ON (cycle_id)')
    expect(sql).toContain('cycle_id <> $5')
    expect(mockQuery.mock.calls[1][1]).toEqual([19, 30, 2, false, 'same-job'])
  })

  it('没有稳定 cycle id 时 fail closed，不启用 level-shift', async () => {
    mockQuery.mockResolvedValueOnce({ rows: passingBaseline })

    await expect(
      getCountBaseline(19, 30, 100, { actualCount: 130, cycleId: null })
    ).resolves.toEqual({ baseline: 100, isBootstrap: false })
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('最新证据中夹有 legacy 观测时 fail closed，不回看更老 explicit 行', async () => {
    mockQuery.mockResolvedValueOnce({ rows: passingBaseline }).mockResolvedValueOnce({
      rows: [
        { actual_count: 130, cycle_id: 'shift-new', explicit_cycle: true },
        { actual_count: 50, cycle_id: 'legacy:42', explicit_cycle: false },
      ],
    })

    await expect(
      getCountBaseline(19, 30, 100, { actualCount: 130, cycleId: 'shift-current' })
    ).resolves.toEqual({ baseline: 100, isBootstrap: false })
  })

  it('passing baseline 也按 cycle 去重，避免部分成功窗口的 retry 污染 median', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { actual_count: 95, cycle_id: 'older-cycle-b' },
          { actual_count: 95, cycle_id: 'older-cycle-a' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    await expect(
      getCountBaseline(19, 30, 100, { actualCount: 95, cycleId: 'current' })
    ).resolves.toEqual({ baseline: 100, isBootstrap: true })

    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toContain('DISTINCT ON (cycle_id)')
    expect(sql).toContain('cycle_id <> $5')
    expect(mockQuery.mock.calls[0][1]).toEqual([19, 30, 7, true, 'current'])
  })
})
