import {
  classifyStyle,
  getStyleInfo,
  getFilterableStyles,
  TRADING_STYLE_LEGACY_MAP,
  VALID_TRADING_STYLES,
} from '../trading-style'

describe('classifyStyle（持仓时间边界）', () => {
  it('<4h 且交易数>50 → scalper（高频）', () => {
    expect(classifyStyle({ avg_holding_hours: 2, trades_count: 100 })).toBe('scalper')
  })

  it('<4h 但交易数不足(≤50) → swing（不算高频）', () => {
    expect(classifyStyle({ avg_holding_hours: 2, trades_count: 30 })).toBe('swing')
    expect(classifyStyle({ avg_holding_hours: 2, trades_count: 50 })).toBe('swing')
  })

  it('4-48h → swing（波段）', () => {
    expect(classifyStyle({ avg_holding_hours: 4, trades_count: 999 })).toBe('swing')
    expect(classifyStyle({ avg_holding_hours: 47, trades_count: 10 })).toBe('swing')
  })

  it('48-336h(2周) → trend（趋势）', () => {
    expect(classifyStyle({ avg_holding_hours: 48 })).toBe('trend')
    expect(classifyStyle({ avg_holding_hours: 335 })).toBe('trend')
  })

  it('≥336h → position（长线）', () => {
    expect(classifyStyle({ avg_holding_hours: 336 })).toBe('position')
    expect(classifyStyle({ avg_holding_hours: 10000 })).toBe('position')
  })
})

describe('classifyStyle（无持仓时间时的推断）', () => {
  it('无持仓时间 + 高胜率(>60)低盈亏比(<1.5) → scalper', () => {
    expect(classifyStyle({ win_rate: 70, profit_factor: 1.2 })).toBe('scalper')
  })

  it('无持仓时间 + 一般指标 → unknown', () => {
    expect(classifyStyle({ win_rate: 50, profit_factor: 2 })).toBe('unknown')
    expect(classifyStyle({})).toBe('unknown')
  })

  it('avg_holding_hours=0 或 null 视为无数据', () => {
    expect(classifyStyle({ avg_holding_hours: 0 })).toBe('unknown')
    expect(classifyStyle({ avg_holding_hours: null })).toBe('unknown')
  })

  it('profit_factor 缺失默认 2（不触发 scalper 分支）', () => {
    // win_rate 70 但 profit_factor 默认 2 ≥ 1.5 → 不是 scalper
    expect(classifyStyle({ win_rate: 70 })).toBe('unknown')
  })
})

describe('getStyleInfo', () => {
  it('返回含 style + label 的完整信息', () => {
    const info = getStyleInfo('scalper')
    expect(info.style).toBe('scalper')
    expect(info.labelEn).toBe('Scalper')
    expect(info.label).toBe('高频')
  })

  it('每种 style 都有非空 label/labelEn', () => {
    ;(['scalper', 'swing', 'trend', 'position', 'unknown'] as const).forEach((s) => {
      const info = getStyleInfo(s)
      expect(info.label.length).toBeGreaterThan(0)
      expect(info.labelEn.length).toBeGreaterThan(0)
    })
  })
})

describe('getFilterableStyles', () => {
  it('返回 4 种可筛选风格，不含 unknown', () => {
    const styles = getFilterableStyles()
    expect(styles).toHaveLength(4)
    expect(styles.map((s) => s.style)).toEqual(['scalper', 'swing', 'trend', 'position'])
    expect(styles.map((s) => s.style)).not.toContain('unknown')
  })
})

describe('TRADING_STYLE_LEGACY_MAP（旧命名兼容）', () => {
  it('高频类旧名全部映射到 scalper', () => {
    expect(TRADING_STYLE_LEGACY_MAP.high_frequency).toBe('scalper')
    expect(TRADING_STYLE_LEGACY_MAP.hft).toBe('scalper')
    expect(TRADING_STYLE_LEGACY_MAP.scalping).toBe('scalper')
  })

  it('day_trader 映射到 swing', () => {
    expect(TRADING_STYLE_LEGACY_MAP.day_trader).toBe('swing')
  })

  it('每个映射目标都是合法风格', () => {
    Object.values(TRADING_STYLE_LEGACY_MAP).forEach((v) => {
      expect([...VALID_TRADING_STYLES]).toContain(v)
    })
  })
})
