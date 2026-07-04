/**
 * PipelineNormalizer — 全部落库数据的归一化层。
 * ROI 三格式(percentage/decimal/needs_detection)、PnL 单位(usd/wei)、
 * winRate/mdd 小数嗅探、Hyperliquid windowPerformances、GMX 派生 ROI、
 * roi≈pnl 污染修复、置信度分级。单位错一档=全站数字错一档。
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }),
}))

import { PipelineNormalizer, getNormalizer } from '../normalizer'
import type { RawFetchResult } from '../types'

const n = new PipelineNormalizer()

function raw(
  platform: string,
  traders: Array<{ id: string; data: Record<string, unknown> }>,
  window = '30d'
): RawFetchResult {
  return {
    platform,
    market_type: 'futures',
    window: window as RawFetchResult['window'],
    raw_traders: traders.map((t) => ({ trader_id: t.id, raw_data: t.data })),
    total_available: traders.length,
    fetched_at: new Date('2026-07-03T00:00:00Z'),
    api_latency_ms: 100,
  } as RawFetchResult
}

describe('ROI 三格式', () => {
  it('percentage 平台(binance):25.5 → 25.5', () => {
    const [t] = n.normalize(raw('binance_futures', [{ id: 'a', data: { roi: 25.5 } }]))
    expect(t.roi_pct).toBe(25.5)
  })

  it('decimal 平台(drift):0.255 → 25.5', () => {
    const [t] = n.normalize(raw('drift', [{ id: 'a', data: { roi: 0.255 } }]))
    expect(t.roi_pct).toBeCloseTo(25.5)
  })

  it('needs_detection(hyperliquid):|raw|<=10 当小数 ×100,>10 当百分比', () => {
    const [small] = n.normalize(raw('hyperliquid', [{ id: 'a', data: { roi: 0.5 } }]))
    expect(small.roi_pct).toBe(50) // 0.5 → 50%
    const [big] = n.normalize(raw('hyperliquid', [{ id: 'a', data: { roi: 45 } }]))
    expect(big.roi_pct).toBe(45) // 45 已是百分比
  })

  it('ROI clamp 到 ±10000', () => {
    const [t] = n.normalize(raw('binance_futures', [{ id: 'a', data: { roi: 99999 } }]))
    expect(t.roi_pct).toBe(10000)
  })

  it('无 ROI 字段 → null(不猜)', () => {
    const [t] = n.normalize(raw('binance_futures', [{ id: 'a', data: { pnl: 100 } }]))
    expect(t.roi_pct).toBeNull()
  })
})

describe('GMX 派生 ROI(平台无 roi 字段,从 pnl/capital 算,wei 单位)', () => {
  it('wei pnl + wei capital → 正确百分比(30 decimals)', () => {
    // GMX v2: pnl_decimals=30。pnl=5e30 wei=5 USD, capital=100e30 wei=100 USD → 5%
    const [t] = n.normalize(
      raw('gmx', [{ id: 'a', data: { realizedPnl: 5e30, maxCapital: 100e30 } }])
    )
    expect(t.roi_pct).toBeCloseTo(5)
  })

  it('capital 为 0 → 不派生,null', () => {
    const [t] = n.normalize(raw('gmx', [{ id: 'a', data: { realizedPnl: 5e30, maxCapital: 0 } }]))
    expect(t.roi_pct).toBeNull()
  })
})

describe('PnL 单位', () => {
  it('usd 平台原样', () => {
    const [t] = n.normalize(raw('bybit', [{ id: 'a', data: { pnl: 1234.5 } }]))
    expect(t.pnl_usd).toBe(1234.5)
  })

  it('wei 平台(gains,18 decimals)→ USD', () => {
    const [t] = n.normalize(raw('gains', [{ id: 'a', data: { pnl: 2.5e18 } }]))
    expect(t.pnl_usd).toBeCloseTo(2.5)
  })

  it('多字段名回退(realizedPnl/totalPnl/profit)', () => {
    const [t] = n.normalize(raw('bybit', [{ id: 'a', data: { netProfit: 42 } }]))
    expect(t.pnl_usd).toBe(42)
  })
})

describe('winRate / maxDrawdown 小数嗅探', () => {
  it('winRate <=1 当小数 ×100;>1 原样;clamp 100', () => {
    const [dec] = n.normalize(raw('bybit', [{ id: 'a', data: { winRate: 0.65 } }]))
    expect(dec.win_rate_pct).toBe(65)
    const [pct] = n.normalize(raw('bybit', [{ id: 'a', data: { winRate: 65 } }]))
    expect(pct.win_rate_pct).toBe(65)
    const [over] = n.normalize(raw('bybit', [{ id: 'a', data: { winRate: 140 } }]))
    expect(over.win_rate_pct).toBe(100) // clamp,不 null(与 staging validate 策略不同)
  })

  it('mdd 负数取绝对值 + 小数嗅探', () => {
    const [neg] = n.normalize(raw('bybit', [{ id: 'a', data: { maxDrawdown: -25 } }]))
    expect(neg.max_drawdown_pct).toBe(25)
    const [dec] = n.normalize(raw('bybit', [{ id: 'a', data: { mdd: -0.15 } }]))
    expect(dec.max_drawdown_pct).toBeCloseTo(15)
  })
})

describe('Hyperliquid windowPerformances', () => {
  it('从 week 优先提取 roi/pnl', () => {
    const [t] = n.normalize(
      raw('hyperliquid', [
        {
          id: 'a',
          data: {
            windowPerformances: {
              week: { roi: 0.2, pnl: 5000 },
              month: { roi: 0.9, pnl: 99999 },
            },
          },
        },
      ])
    )
    expect(t.roi_pct).toBeCloseTo(20) // week 的 0.2,needs_detection ×100
    expect(t.pnl_usd).toBe(5000)
  })

  it('week 缺失回退 month → allTime', () => {
    const [t] = n.normalize(
      raw('hyperliquid', [{ id: 'a', data: { windowPerformances: { allTime: { pnl: 777 } } } }])
    )
    expect(t.pnl_usd).toBe(777)
  })
})

describe('roi≈pnl 污染修复(HL API 双字段同值 bug)', () => {
  it('|roi|>1000 且 roi≈pnl → 用 accountValue 重算', () => {
    // roi=5000(其实是 pnl 值), pnl=5000, accountValue=50000 → 真 roi=10%
    const [t] = n.normalize(
      raw('binance_futures', [{ id: 'a', data: { roi: 5000, pnl: 5000, accountValue: 50000 } }])
    )
    expect(t.roi_pct).toBeCloseTo(10)
  })

  it('无 accountValue 可重算 → roi 置 null(宁缺勿错)', () => {
    const [t] = n.normalize(raw('binance_futures', [{ id: 'a', data: { roi: 5000, pnl: 5000 } }]))
    expect(t.roi_pct).toBeNull()
    expect(t.pnl_usd).toBe(5000) // pnl 保留
  })

  it('roi 小(<1000)即使 =pnl 也不触发修复', () => {
    const [t] = n.normalize(raw('binance_futures', [{ id: 'a', data: { roi: 50, pnl: 50 } }]))
    expect(t.roi_pct).toBe(50)
  })
})

describe('字段提取', () => {
  it('camelCase 自动尝试 snake_case 变体', () => {
    const [t] = n.normalize(
      raw('bybit', [{ id: 'a', data: { win_rate: 0.6, avg_holding_hours: 12 } }])
    )
    expect(t.win_rate_pct).toBe(60)
    expect(t.avg_holding_hours).toBe(12)
  })

  it('displayName/avatar 多键回退,空串不取', () => {
    const [t] = n.normalize(
      raw('bybit', [
        { id: 'a', data: { nickName: 'whale', avatar_url: 'https://x/a.png', name: '' } },
      ])
    )
    expect(t.display_name).toBe('whale')
    expect(t.avatar_url).toBe('https://x/a.png')
  })

  it('capabilities 关闭的字段(DEX 无 followers)→ null 即使数据有', () => {
    const [t] = n.normalize(raw('hyperliquid', [{ id: 'a', data: { roi: 0.1, followers: 500 } }]))
    expect(t.followers).toBeNull() // hyperliquid caps.fields.followers=false
  })

  it('非数值垃圾(NaN/Infinity 字符串)不提取', () => {
    const [t] = n.normalize(
      raw('bybit', [{ id: 'a', data: { pnl: 'not-a-number', roi: 'Infinity' } }])
    )
    expect(t.pnl_usd).toBeNull()
    expect(t.roi_pct).toBeNull()
  })
})

describe('置信度分级', () => {
  it('4/4 期望字段齐 → full', () => {
    const [t] = n.normalize(
      raw('binance_futures', [
        { id: 'a', data: { roi: 10, pnl: 100, winRate: 60, maxDrawdown: 20 } },
      ])
    )
    expect(t.confidence).toBe('full')
  })

  it('2/4 → partial,更少 → minimal', () => {
    const [half] = n.normalize(raw('binance_futures', [{ id: 'a', data: { roi: 10, pnl: 100 } }]))
    expect(half.confidence).toBe('partial')
    const [none] = n.normalize(raw('binance_futures', [{ id: 'a', data: {} }]))
    expect(none.confidence).toBe('minimal')
  })
})

describe('窗口归一化 + 整批行为', () => {
  it('week/month/quarter 别名 → 7d/30d/90d;未知 → 90d', () => {
    expect(n.normalize(raw('bybit', [{ id: 'a', data: {} }], 'week'))[0].window).toBe('7d')
    expect(n.normalize(raw('bybit', [{ id: 'a', data: {} }], 'MONTH'))[0].window).toBe('30d')
    expect(n.normalize(raw('bybit', [{ id: 'a', data: {} }], 'whatever'))[0].window).toBe('90d')
  })

  it('单个 trader 抛错不炸整批(被过滤)', () => {
    // raw_data 为 null 会让 normalizeTrader 抛错('in' 操作符用于 null)
    const out = n.normalize(
      raw('bybit', [
        { id: 'bad', data: null as never },
        { id: 'good', data: { roi: 5 } },
      ])
    )
    expect(out).toHaveLength(1)
    expect(out[0].trader_id).toBe('good')
  })

  it('getNormalizer 单例', () => {
    expect(getNormalizer()).toBe(getNormalizer())
  })
})
