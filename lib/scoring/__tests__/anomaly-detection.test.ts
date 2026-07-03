import {
  detectAnomalies,
  calculateAnomalyScore,
  shouldFlagForReview,
  isValidRecord,
} from '../anomaly-detection'

describe('detectAnomalies — ROI', () => {
  it('≥100k% → critical', () => {
    const a = detectAnomalies({ roi: 100_000 })
    expect(a[0].field).toBe('roi')
    expect(a[0].severity).toBe('critical')
  })

  it('50k-100k% → high', () => {
    expect(detectAnomalies({ roi: 60_000 })[0].severity).toBe('high')
  })

  it('≤-99% → medium（爆仓）', () => {
    expect(detectAnomalies({ roi: -99 })[0].severity).toBe('medium')
  })

  it('正常 ROI → 无异常', () => {
    expect(detectAnomalies({ roi: 150 })).toEqual([])
  })

  it('null ROI → 跳过', () => {
    expect(detectAnomalies({ roi: null })).toEqual([])
  })
})

describe('detectAnomalies — win_rate / drawdown / arena_score / trades', () => {
  it('win_rate >100 或 <0 → critical', () => {
    expect(detectAnomalies({ win_rate: 150 })[0].severity).toBe('critical')
    expect(detectAnomalies({ win_rate: -5 })[0].severity).toBe('critical')
  })

  it('高胜率 + 极少交易 → medium（样本不足）', () => {
    expect(detectAnomalies({ win_rate: 99, trades_count: 3 })[0].severity).toBe('medium')
  })

  it('高胜率但交易充足 → 无异常', () => {
    expect(detectAnomalies({ win_rate: 99, trades_count: 500 })).toEqual([])
  })

  it('drawdown >100 → critical', () => {
    expect(detectAnomalies({ max_drawdown: 150 })[0].severity).toBe('critical')
  })

  it('drawdown =100 → high（爆仓）', () => {
    expect(detectAnomalies({ max_drawdown: 100 })[0].severity).toBe('high')
  })

  it('arena_score >150 → high；<0 → critical', () => {
    expect(detectAnomalies({ arena_score: 200 })[0].severity).toBe('high')
    expect(detectAnomalies({ arena_score: -5 })[0].severity).toBe('critical')
  })

  it('trades ≥100k → medium', () => {
    expect(detectAnomalies({ trades_count: 100_000 })[0].severity).toBe('medium')
  })

  it('多字段异常 → 多条结果', () => {
    const a = detectAnomalies({ roi: 100_000, win_rate: 150, arena_score: -1 })
    expect(a.length).toBe(3)
  })
})

describe('calculateAnomalyScore', () => {
  it('无异常 → 0', () => {
    expect(calculateAnomalyScore([])).toBe(0)
  })

  it('按严重度加权（critical=50）+ clamp 100', () => {
    expect(calculateAnomalyScore(detectAnomalies({ roi: 100_000 }))).toBe(50) // 1 critical
    // 多个 critical → clamp 100
    const many = detectAnomalies({ roi: 100_000, win_rate: 150, arena_score: -1 })
    expect(calculateAnomalyScore(many)).toBe(100) // 50*3=150 → clamp 100
  })
})

describe('shouldFlagForReview / isValidRecord', () => {
  it('含 critical 或 high → flag', () => {
    expect(shouldFlagForReview(detectAnomalies({ roi: 100_000 }))).toBe(true) // critical
    expect(shouldFlagForReview(detectAnomalies({ roi: 60_000 }))).toBe(true) // high
  })

  it('只有 medium/low → 不 flag', () => {
    expect(shouldFlagForReview(detectAnomalies({ roi: -99 }))).toBe(false) // medium
  })

  it('isValidRecord：无 critical → true', () => {
    expect(isValidRecord({ roi: 150 })).toBe(true)
    expect(isValidRecord({ roi: 60_000 })).toBe(true) // high 不算 invalid
  })

  it('isValidRecord：有 critical → false', () => {
    expect(isValidRecord({ roi: 100_000 })).toBe(false)
  })
})
