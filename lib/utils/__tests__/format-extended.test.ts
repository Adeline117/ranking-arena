import { formatPercent, formatCurrency, formatCompact, truncate, capitalize } from '../format'

describe('formatPercent edge cases', () => {
  it('formats negative ROI', () => {
    expect(formatPercent(-0.5)).toBe('-50.00%')
    expect(formatPercent(-0.0001)).toBe('-0.01%')
  })

  it('formats zero ROI', () => {
    // zero is not > 0 so no '+' sign
    expect(formatPercent(0)).toBe('0.00%')
  })

  it('formats large positive ROI', () => {
    expect(formatPercent(10)).toBe('+1000.00%')
  })

  it('handles multiply=false', () => {
    expect(formatPercent(50, 2, false)).toBe('+50.00%')
    expect(formatPercent(-25, 1, false)).toBe('-25.0%')
  })

  it('handles NaN', () => {
    // non-finite values return NULL_DISPLAY ('—')
    expect(formatPercent(NaN)).toBe('—')
    expect(formatPercent('abc')).toBe('—')
  })

  it('custom decimals', () => {
    expect(formatPercent(0.123456, 4)).toBe('+12.3456%')
  })
})

describe('formatCurrency edge cases', () => {
  it('formats basic currency', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56')
  })

  it('formats negative amounts', () => {
    expect(formatCurrency(-500)).toBe('$-500.00')
  })

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00')
  })

  it('handles custom currency symbol', () => {
    expect(formatCurrency(100, '¥')).toBe('¥100.00')
    expect(formatCurrency(100, '€', 0)).toBe('€100')
  })

  it('handles NaN', () => {
    // non-finite values return NULL_DISPLAY ('—')
    expect(formatCurrency('abc')).toBe('—')
  })

  it('formats very large PnL', () => {
    expect(formatCurrency(1000000, '$', 0)).toBe('$1,000,000')
  })
})

describe('formatCompact edge cases', () => {
  it('formats billions', () => {
    // default decimals=2
    expect(formatCompact(1500000000)).toBe('1.50B')
  })

  it('formats millions', () => {
    expect(formatCompact(3400000)).toBe('3.40M')
  })

  it('formats thousands', () => {
    expect(formatCompact(1200)).toBe('1.20K')
  })

  it('small numbers pass through', () => {
    // default decimals=2 applies to sub-1000 numbers too
    expect(formatCompact(500)).toBe('500.00')
  })

  it('handles negative values', () => {
    expect(formatCompact(-5000)).toBe('-5.00K')
    expect(formatCompact(-2000000)).toBe('-2.00M')
  })

  it('handles NaN', () => {
    // non-finite values return NULL_DISPLAY ('—')
    expect(formatCompact('abc')).toBe('—')
  })

  it('custom decimals', () => {
    expect(formatCompact(1234, 2)).toBe('1.23K')
  })
})

describe('truncate edge cases', () => {
  it('returns empty for null/undefined-ish', () => {
    expect(truncate('', 10)).toBe('')
  })

  it('does not truncate short text', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('truncates long text', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
  })

  it('custom suffix', () => {
    expect(truncate('hello world', 9, '…')).toBe('hello wo…')
  })
})

describe('capitalize edge cases', () => {
  it('handles empty', () => {
    expect(capitalize('')).toBe('')
  })

  it('capitalizes first letter', () => {
    expect(capitalize('hello')).toBe('Hello')
  })

  it('lowercases rest', () => {
    expect(capitalize('HELLO')).toBe('Hello')
  })
})
