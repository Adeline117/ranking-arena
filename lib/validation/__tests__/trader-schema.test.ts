jest.mock('../../utils/logger', () => ({
  dataLogger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

import { validateAndInsertTrader, validateTraderBatch } from '../trader-schema'

function valid(overrides: Record<string, unknown> = {}) {
  return {
    source: 'bybit',
    source_trader_id: 'ABC123',
    roi: 125.5,
    pnl: 45230.12,
    captured_at: '2026-07-03T00:00:00Z',
    ...overrides,
  }
}

describe('validateAndInsertTrader — 必需字段', () => {
  it('合法数据 → 返回校验结果', async () => {
    const r = await validateAndInsertTrader(valid())
    expect(r.source).toBe('bybit')
    expect(r.source_trader_id).toBe('ABC123')
    expect(r.captured_at).toBeInstanceOf(Date) // z.coerce.date
  })

  it('未支持交易所 → 抛 ZodError', async () => {
    await expect(validateAndInsertTrader(valid({ source: 'ftx' }))).rejects.toThrow()
  })

  it('空 trader id → 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ source_trader_id: '' }))).rejects.toThrow()
  })

  it('roi 非有限（Infinity/NaN）→ 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ roi: Infinity }))).rejects.toThrow()
    await expect(validateAndInsertTrader(valid({ roi: NaN }))).rejects.toThrow()
  })

  it('缺 pnl → 抛错', async () => {
    const d = valid()
    delete (d as Record<string, unknown>).pnl
    await expect(validateAndInsertTrader(d)).rejects.toThrow()
  })
})

describe('validateAndInsertTrader — 可选字段范围守卫', () => {
  it('win_rate 超 100 → 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ win_rate: 150 }))).rejects.toThrow()
  })

  it('win_rate 负 → 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ win_rate: -1 }))).rejects.toThrow()
  })

  it('max_drawdown 为正 → 抛错（应 <= 0）', async () => {
    await expect(validateAndInsertTrader(valid({ max_drawdown: 5 }))).rejects.toThrow()
  })

  it('max_drawdown <= 0 合法', async () => {
    const r = await validateAndInsertTrader(valid({ max_drawdown: -20 }))
    expect(r.max_drawdown).toBe(-20)
  })

  it('trades_count 非整数 → 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ trades_count: 1.5 }))).rejects.toThrow()
  })

  it('aum 负 → 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ aum: -100 }))).rejects.toThrow()
  })

  it('avatar_url 非法 URL → 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ avatar_url: 'not a url' }))).rejects.toThrow()
  })

  it('rank 非正 → 抛错', async () => {
    await expect(validateAndInsertTrader(valid({ rank: 0 }))).rejects.toThrow()
  })
})

describe('validateTraderBatch — 分区', () => {
  it('混合批次正确分成 valid/invalid', async () => {
    const { valid: v, invalid } = await validateTraderBatch([
      valid({ source_trader_id: 'good1' }),
      valid({ source: 'bogus_exchange' }), // 非法
      valid({ source_trader_id: 'good2' }),
      valid({ win_rate: 999 }), // 非法
    ])
    expect(v).toHaveLength(2)
    expect(invalid).toHaveLength(2)
    expect(v.map((t) => t.source_trader_id)).toEqual(['good1', 'good2'])
  })

  it('全合法 → invalid 为空', async () => {
    const { valid: v, invalid } = await validateTraderBatch([valid(), valid()])
    expect(v).toHaveLength(2)
    expect(invalid).toHaveLength(0)
  })

  it('非 Zod 异常不吞（只捕获 ZodError）', async () => {
    // 空批次不崩
    const { valid: v, invalid } = await validateTraderBatch([])
    expect(v).toHaveLength(0)
    expect(invalid).toHaveLength(0)
  })
})
