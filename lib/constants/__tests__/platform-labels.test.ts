import { platformLabel, formatRoiShort, PLATFORM_LABELS } from '../platform-labels'

describe('platformLabel', () => {
  it('已知 source key → 规范标签', () => {
    expect(platformLabel('binance_futures')).toBe('Binance')
    expect(platformLabel('gateio')).toBe('Gate.io')
    expect(platformLabel('dydx')).toBe('dYdX')
    expect(platformLabel('okx_web3')).toBe('OKX Web3')
  })

  it('未知 source → title-case 兜底（下划线转空格 + 首字母大写）', () => {
    expect(platformLabel('new_exchange')).toBe('New Exchange')
    expect(platformLabel('foo')).toBe('Foo')
  })

  it('null/空 → 空字符串', () => {
    expect(platformLabel(null)).toBe('')
    expect(platformLabel(undefined)).toBe('')
    expect(platformLabel('')).toBe('')
  })

  it('binance_futures 与 okx_futures 都归一到主品牌名', () => {
    expect(platformLabel('binance_futures')).toBe('Binance')
    expect(platformLabel('okx_futures')).toBe('OKX')
  })
})

describe('formatRoiShort', () => {
  it('≥1000% → K 格式带一位小数', () => {
    expect(formatRoiShort(1200)).toBe('+1.2K%')
    expect(formatRoiShort(34500)).toBe('+34.5K%')
  })

  it('<1000% → 一位小数百分比', () => {
    expect(formatRoiShort(34.5)).toBe('+34.5%')
    expect(formatRoiShort(8)).toBe('+8.0%')
  })

  it('负数带 - 号', () => {
    expect(formatRoiShort(-8)).toBe('-8.0%')
    expect(formatRoiShort(-1500)).toBe('-1.5K%')
  })

  it('0 → +0.0%', () => {
    expect(formatRoiShort(0)).toBe('+0.0%')
  })
})

describe('PLATFORM_LABELS 数据完整性', () => {
  it('所有 label 非空', () => {
    Object.values(PLATFORM_LABELS).forEach((v) => expect(v.length).toBeGreaterThan(0))
  })
})
