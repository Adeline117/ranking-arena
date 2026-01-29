/**
 * Max Drawdown 计算模块单元测试
 */

import {
  calculateMaxDrawdown,
  calculateMaxDrawdownFromPnl,
} from '../calculate-mdd'

describe('calculateMaxDrawdown', () => {
  test('单调上涨无回撤，返回 0', () => {
    const curve = [
      { ts: '2024-01-01', value: 10000 },
      { ts: '2024-01-02', value: 11000 },
      { ts: '2024-01-03', value: 12000 },
    ]
    expect(calculateMaxDrawdown(curve)).toBe(0)
  })

  test('简单回撤计算正确', () => {
    const curve = [
      { ts: '2024-01-01', value: 10000 },
      { ts: '2024-01-02', value: 12000 }, // peak
      { ts: '2024-01-03', value: 10200 }, // drawdown: (10200 - 12000) / 12000 = -15%
      { ts: '2024-01-04', value: 11000 },
    ]
    expect(calculateMaxDrawdown(curve)).toBeCloseTo(-15.0, 0)
  })

  test('多次回撤取最大', () => {
    const curve = [
      { ts: '2024-01-01', value: 10000 },
      { ts: '2024-01-02', value: 12000 }, // peak 1
      { ts: '2024-01-03', value: 11000 }, // drawdown 1: -8.3%
      { ts: '2024-01-04', value: 13000 }, // peak 2
      { ts: '2024-01-05', value: 10000 }, // drawdown 2: -23.1% (worst)
      { ts: '2024-01-06', value: 14000 },
    ]
    const mdd = calculateMaxDrawdown(curve)!
    expect(mdd).toBeCloseTo(-23.1, 0)
  })

  test('数据不足返回 null', () => {
    expect(calculateMaxDrawdown([])).toBeNull()
    expect(calculateMaxDrawdown([{ ts: '2024-01-01', value: 10000 }])).toBeNull()
  })

  test('null 输入返回 null', () => {
    expect(calculateMaxDrawdown(null as unknown as [])).toBeNull()
  })

  test('全部亏损的极端情况', () => {
    const curve = [
      { ts: '2024-01-01', value: 10000 },
      { ts: '2024-01-02', value: 8000 },
      { ts: '2024-01-03', value: 5000 },
      { ts: '2024-01-04', value: 2000 },
    ]
    expect(calculateMaxDrawdown(curve)).toBeCloseTo(-80.0, 0)
  })

  test('V 形反弹', () => {
    const curve = [
      { ts: '2024-01-01', value: 10000 },
      { ts: '2024-01-02', value: 7000 }, // -30% drawdown
      { ts: '2024-01-03', value: 15000 }, // new peak
    ]
    expect(calculateMaxDrawdown(curve)).toBeCloseTo(-30.0, 0)
  })

  test('忽略无效数据点', () => {
    const curve = [
      { ts: '2024-01-01', value: 10000 },
      { ts: '2024-01-02', value: NaN },
      { ts: '2024-01-03', value: 0 },
      { ts: '2024-01-04', value: -100 },
      { ts: '2024-01-05', value: 8000 },
    ]
    const mdd = calculateMaxDrawdown(curve)!
    expect(mdd).toBeCloseTo(-20.0, 0)
  })
})

describe('calculateMaxDrawdownFromPnl', () => {
  test('从 PnL 序列计算 MDD', () => {
    const pnl = [
      { ts: '2024-01-01', value: 500 },   // equity: 10500
      { ts: '2024-01-02', value: -1800 },  // equity: 8700  → drawdown from 10500 = -17.1%
      { ts: '2024-01-03', value: 300 },    // equity: 9000
    ]
    const mdd = calculateMaxDrawdownFromPnl(pnl, 10000)!
    // peak = 10500, trough = 8700 → (8700 - 10500) / 10500 ≈ -17.1%
    expect(mdd).toBeCloseTo(-17.1, 0)
  })

  test('全是盈利无回撤', () => {
    const pnl = [
      { ts: '2024-01-01', value: 100 },
      { ts: '2024-01-02', value: 200 },
      { ts: '2024-01-03', value: 300 },
    ]
    expect(calculateMaxDrawdownFromPnl(pnl, 10000)).toBe(0)
  })

  test('归零返回 -100%', () => {
    const pnl = [
      { ts: '2024-01-01', value: -5000 },
      { ts: '2024-01-02', value: -5000 }, // equity goes to 0
    ]
    expect(calculateMaxDrawdownFromPnl(pnl, 10000)).toBe(-100)
  })

  test('空数据返回 null', () => {
    expect(calculateMaxDrawdownFromPnl([], 10000)).toBeNull()
    expect(calculateMaxDrawdownFromPnl(null as unknown as [], 10000)).toBeNull()
  })

  test('无效初始资金返回 null', () => {
    expect(calculateMaxDrawdownFromPnl([{ ts: '2024-01-01', value: 100 }], 0)).toBeNull()
    expect(calculateMaxDrawdownFromPnl([{ ts: '2024-01-01', value: 100 }], -1000)).toBeNull()
  })
})
