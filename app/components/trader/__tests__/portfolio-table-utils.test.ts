jest.mock('@/lib/design-tokens', () => ({
  tokens: {
    spacing: { 4: '4px' },
    typography: { fontSize: { xs: '12px' }, fontWeight: { bold: 700 } },
    colors: { text: { tertiary: '#999' }, border: { primary: '#333' } },
  },
}))
jest.mock('@/lib/utils/format', () => ({ NULL_DISPLAY: '—' }))

import {
  formatPriceWithComma,
  formatSizeWithUnit,
  formatPrice,
  formatDateTime,
} from '../portfolio-table-utils'

describe('formatPriceWithComma', () => {
  it('undefined/0 → NULL_DISPLAY', () => {
    expect(formatPriceWithComma(undefined)).toBe('—')
    expect(formatPriceWithComma(0)).toBe('—')
  })

  it('≥1 → 2 位小数 + 千分位', () => {
    expect(formatPriceWithComma(1234.5)).toBe('1,234.50')
  })

  it('<1 → 4 位小数', () => {
    expect(formatPriceWithComma(0.12345)).toBe('0.1235') // 四舍五入到 4 位
  })
})

describe('formatPrice', () => {
  it('undefined/0 → NULL_DISPLAY', () => {
    expect(formatPrice(undefined)).toBe('—')
    expect(formatPrice(0)).toBe('—')
  })

  it('≥1 → 2 位小数（无千分位）', () => {
    expect(formatPrice(1234.567)).toBe('1234.57')
  })

  it('<1 → 4 位小数', () => {
    expect(formatPrice(0.5)).toBe('0.5000')
  })
})

describe('formatSizeWithUnit', () => {
  it('undefined/0 → NULL_DISPLAY', () => {
    expect(formatSizeWithUnit(undefined, 'BTC')).toBe('—')
    expect(formatSizeWithUnit(0, 'BTC')).toBe('—')
  })

  it('数值 → 3 位小数 + 单位', () => {
    expect(formatSizeWithUnit(1.5, 'ETH')).toBe('1.500 ETH')
    expect(formatSizeWithUnit(0.123456, 'BTC')).toBe('0.123 BTC')
  })
})

describe('formatDateTime', () => {
  it('空字符串 → NULL_DISPLAY', () => {
    expect(formatDateTime('')).toBe('—')
  })

  it('合法时间 → 格式化（含月日时分）', () => {
    const out = formatDateTime('2026-03-15T14:30:00Z', 'en')
    // 只验证包含数字与分隔（避免时区导致的具体值脆弱）
    expect(out).toMatch(/\d{2}/)
    expect(out).not.toBe('—')
  })

  it('语言映射不崩（zh/ja/ko/未知）', () => {
    const s = '2026-03-15T14:30:00Z'
    expect(() => formatDateTime(s, 'zh')).not.toThrow()
    expect(() => formatDateTime(s, 'ja')).not.toThrow()
    expect(() => formatDateTime(s, 'ko')).not.toThrow()
    expect(() => formatDateTime(s, 'unknown')).not.toThrow()
    expect(() => formatDateTime(s)).not.toThrow()
  })
})
