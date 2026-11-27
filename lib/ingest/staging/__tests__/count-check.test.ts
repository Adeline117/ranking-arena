jest.mock('../../db', () => ({ getIngestPool: jest.fn() }))

import { getIngestPool } from '../../db'
import { median, evaluateCount, getCountBaseline } from '../count-check'

const mockQuery = jest.fn()
const mockGetIngestPool = jest.mocked(getIngestPool)

beforeEach(() => {
  mockQuery.mockReset()
  mockGetIngestPool.mockClear()
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

  it('0 行快照永不通过（含 baseline=null 的新源自举期）', () => {
    expect(evaluateCount(0, null).passed).toBe(false)
    expect(evaluateCount(0, 0).passed).toBe(false)
    expect(evaluateCount(0, null, 30).passed).toBe(false)
    const v = evaluateCount(0, 40)
    expect(v.passed).toBe(false)
    expect(v.deviationPct).toBe(100)
    expect(evaluateCount(Number.NaN, null).passed).toBe(false)
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

    expect(mockQuery.mock.calls[1][1]).toEqual([19, 30, 2, false, 'shift-c', null])
  })

  it('传入事务 executor 时 baseline 与 shift 查询都只走该 executor', async () => {
    const transactionQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: passingBaseline })
      .mockResolvedValueOnce({
        rows: [
          { actual_count: 130, cycle_id: 'shift-b', explicit_cycle: true },
          { actual_count: 130, cycle_id: 'shift-a', explicit_cycle: true },
        ],
      })

    await expect(
      getCountBaseline(19, 30, 100, { actualCount: 130, cycleId: 'shift-c' }, {
        query: transactionQuery,
      } as never)
    ).resolves.toEqual({ baseline: 130, isBootstrap: false, shifted: true })

    expect(mockGetIngestPool).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
    expect(transactionQuery).toHaveBeenCalledTimes(2)
    expect(transactionQuery.mock.calls[0][1]).toEqual([19, 30, 7, true, 'shift-c', null])
    expect(transactionQuery.mock.calls[1][1]).toEqual([19, 30, 2, false, 'shift-c', null])
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
    expect(mockQuery.mock.calls[1][1]).toEqual([19, 30, 2, false, 'same-job', null])
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
    expect(mockQuery.mock.calls[0][1]).toEqual([19, 30, 7, true, 'current', null])
  })

  describe('下行 level-shift 下限保护', () => {
    const truncated = [
      { actual_count: 60, cycle_id: 'trunc-b', explicit_cycle: true },
      { actual_count: 60, cycle_id: 'trunc-a', explicit_cycle: true },
    ]

    it('连续 3 次截断到历史中位数 70% 以下：不自动采纳，按旧基线判并标记待确认', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: passingBaseline })
        .mockResolvedValueOnce({ rows: truncated })
        .mockResolvedValueOnce({ rows: [{ ack: null }] })

      const result = await getCountBaseline(19, 30, 100, { actualCount: 60, cycleId: 'trunc-c' })
      expect(result).toEqual({
        baseline: 100,
        isBootstrap: false,
        shiftPendingConfirmation: { proposedBaseline: 60, currentBaseline: 100 },
      })
      expect(evaluateCount(60, result.baseline).passed).toBe(false)
      expect(String(mockQuery.mock.calls[2][0])).toContain("meta->'count_shift_ack'")
      expect(mockQuery.mock.calls[2][1]).toEqual([19, 30])
    })

    it('运维确认（count_shift_ack 与观测水位一致）后才采纳下行新基线', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: passingBaseline })
        .mockResolvedValueOnce({ rows: truncated })
        .mockResolvedValueOnce({ rows: [{ ack: '61' }] })

      await expect(
        getCountBaseline(19, 30, 100, { actualCount: 60, cycleId: 'trunc-c' })
      ).resolves.toEqual({
        baseline: 60,
        isBootstrap: false,
        shifted: true,
        shiftAcknowledged: true,
      })
    })

    it('确认值与观测水位不符时仍然不采纳', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: passingBaseline })
        .mockResolvedValueOnce({ rows: truncated })
        .mockResolvedValueOnce({ rows: [{ ack: 40 }] })

      await expect(
        getCountBaseline(19, 30, 100, { actualCount: 60, cycleId: 'trunc-c' })
      ).resolves.toMatchObject({
        baseline: 100,
        shiftPendingConfirmation: { proposedBaseline: 60 },
      })
    })

    it('10%–30% 的持续下降（如丢一页）同样不自动采纳，需运维确认', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: passingBaseline })
        .mockResolvedValueOnce({
          rows: [
            { actual_count: 80, cycle_id: 'drop-b', explicit_cycle: true },
            { actual_count: 80, cycle_id: 'drop-a', explicit_cycle: true },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ ack: null }] })
      const result = await getCountBaseline(19, 30, 100, { actualCount: 80, cycleId: 'drop-c' })
      expect(result).toEqual({
        baseline: 100,
        isBootstrap: false,
        shiftPendingConfirmation: { proposedBaseline: 80, currentBaseline: 100 },
      })
      expect(evaluateCount(80, result.baseline).passed).toBe(false)
    })

    it('确认 10%–30% 的下降后采纳', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: passingBaseline })
        .mockResolvedValueOnce({
          rows: [
            { actual_count: 80, cycle_id: 'drop-b', explicit_cycle: true },
            { actual_count: 80, cycle_id: 'drop-a', explicit_cycle: true },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ ack: 80 }] })
      await expect(
        getCountBaseline(19, 30, 100, { actualCount: 80, cycleId: 'drop-c' })
      ).resolves.toEqual({
        baseline: 80,
        isBootstrap: false,
        shifted: true,
        shiftAcknowledged: true,
      })
    })
  })

  it('new baseline generation excludes incompatible historical observations', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })

    await expect(
      getCountBaseline(19, 30, 300, {
        actualCount: 270,
        cycleId: 'derived-cycle',
        baselineGeneration: 'derived-native-eligibility-v1',
      })
    ).resolves.toEqual({ baseline: 300, isBootstrap: true })

    const sql = String(mockQuery.mock.calls[0][0])
    expect(sql).toContain("meta->>'count_baseline_generation'")
    expect(mockQuery.mock.calls[0][1]).toEqual([
      19,
      30,
      7,
      true,
      'derived-cycle',
      'derived-native-eligibility-v1',
    ])
    expect(mockQuery.mock.calls[1][1]).toEqual([
      19,
      30,
      2,
      false,
      'derived-cycle',
      'derived-native-eligibility-v1',
    ])
  })

  describe('adopted level-shift anchors the baseline', () => {
    it('fewer than three passing cycles since the shift: the adopted level is the baseline', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ actual_count: 342, cycle_id: 'c', explicit_cycle: true, anchor_level: '341' }],
        })
        .mockResolvedValueOnce({ rows: [] })

      await expect(
        getCountBaseline(19, 30, 781, { actualCount: 333, cycleId: 'd' })
      ).resolves.toEqual({ baseline: 341, isBootstrap: false })
    })

    it('no passing cycle since the shift: the anchor-only row still carries its level', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ actual_count: null, cycle_id: null, explicit_cycle: null, anchor_level: '341' }],
        })
        .mockResolvedValueOnce({ rows: [] })

      await expect(
        getCountBaseline(19, 30, 781, { actualCount: 342, cycleId: 'c' })
      ).resolves.toEqual({ baseline: 341, isBootstrap: false })
    })

    it('three or more passing cycles since the shift: their median, not the anchor', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { actual_count: 334, cycle_id: 'e', explicit_cycle: true, anchor_level: '341' },
            { actual_count: 333, cycle_id: 'd', explicit_cycle: true, anchor_level: '341' },
            { actual_count: 342, cycle_id: 'c', explicit_cycle: true, anchor_level: '341' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })

      await expect(
        getCountBaseline(19, 30, 781, { actualCount: 330, cycleId: 'f' })
      ).resolves.toEqual({ baseline: 334, isBootstrap: false })
    })
  })
})
