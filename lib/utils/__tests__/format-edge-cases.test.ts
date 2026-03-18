/**
 * format.ts 边界值测试
 * 补充现有测试未覆盖的边界情况
 */

import { formatNumber, formatPercent, formatCurrency, formatCompact } from '../format'

describe('format utilities - edge cases', () => {
  describe('formatNumber edge cases', () => {
    it('should handle Infinity as a formatted number', () => {
      // Infinity is not NaN, so it goes through toLocaleString
      const result = formatNumber(Infinity)
      expect(typeof result).toBe('string')
    })

    it('should handle -Infinity as a formatted number', () => {
      const result = formatNumber(-Infinity)
      expect(typeof result).toBe('string')
    })

    it('should handle very large numbers', () => {
      const result = formatNumber(999999999999)
      expect(result).toBe('999,999,999,999')
    })

    it('should handle very small decimals', () => {
      expect(formatNumber(0.000001, 6)).toBe('0.000001')
    })

    it('should handle negative zero', () => {
      // -0 formatted may show as "0" or "-0" depending on locale
      const result = formatNumber(-0)
      expect(result).toMatch(/^-?0$/)
    })
  })

  describe('formatPercent edge cases', () => {
    it('should handle NaN', () => {
      // non-finite returns NULL_DISPLAY ('—')
      expect(formatPercent(NaN)).toBe('—')
    })

    it('should handle Infinity', () => {
      // non-finite returns NULL_DISPLAY ('—')
      expect(formatPercent(Infinity)).toBe('—')
    })

    it('should handle very small percentages', () => {
      expect(formatPercent(0.00001)).toBe('+0.00%')
      expect(formatPercent(0.00001, 4)).toBe('+0.0010%')
    })

    it('should handle string input', () => {
      expect(formatPercent('0.5')).toBe('+50.00%')
      // invalid string → parseFloat → NaN → NULL_DISPLAY
      expect(formatPercent('invalid')).toBe('—')
    })

    it('should handle extremely large percentage', () => {
      expect(formatPercent(100)).toBe('+10000.00%')
    })

    it('should handle negative with multiply=false', () => {
      expect(formatPercent(-5.5, 2, false)).toBe('-5.50%')
    })
  })

  describe('formatCurrency edge cases', () => {
    it('should handle Infinity', () => {
      // non-finite returns NULL_DISPLAY ('—')
      expect(formatCurrency(Infinity)).toBe('—')
    })

    it('should handle zero with different currencies', () => {
      expect(formatCurrency(0, '€')).toBe('€0.00')
      expect(formatCurrency(0, '£')).toBe('£0.00')
    })

    it('should handle very small amounts', () => {
      expect(formatCurrency(0.01)).toBe('$0.01')
      expect(formatCurrency(0.001, '$', 3)).toBe('$0.001')
    })

    it('should handle string NaN input', () => {
      // invalid string → parseFloat → NaN → NULL_DISPLAY
      expect(formatCurrency('abc')).toBe('—')
    })

    it('should handle string number input', () => {
      expect(formatCurrency('1234.56')).toBe('$1,234.56')
    })
  })

  describe('formatCompact edge cases', () => {
    it('should handle Infinity', () => {
      // non-finite returns NULL_DISPLAY ('—')
      expect(formatCompact(Infinity)).toBe('—')
    })

    it('should handle -Infinity', () => {
      expect(formatCompact(-Infinity)).toBe('—')
    })

    it('should handle zero', () => {
      // default decimals=2
      expect(formatCompact(0)).toBe('0.00')
    })

    it('should handle negative zero', () => {
      // -0 treated as 0, sign='' since -0 < 0 is false
      expect(formatCompact(-0)).toBe('0.00')
    })

    it('should handle exact thresholds', () => {
      // default decimals=2
      expect(formatCompact(1000)).toBe('1.00K')
      expect(formatCompact(999)).toBe('999.00')
      expect(formatCompact(1000000)).toBe('1.00M')
      expect(formatCompact(1000000000)).toBe('1.00B')
    })

    it('should handle negative millions', () => {
      expect(formatCompact(-5500000)).toBe('-5.50M')
    })

    it('should handle negative billions', () => {
      expect(formatCompact(-2300000000)).toBe('-2.30B')
    })

    it('should handle string input', () => {
      expect(formatCompact('1500')).toBe('1.50K')
      // invalid string → parseFloat → NaN → NULL_DISPLAY
      expect(formatCompact('invalid')).toBe('—')
    })

    it('should handle very large numbers beyond billions', () => {
      expect(formatCompact(1e12)).toBe('1000.00B')
    })

    it('should handle small negative numbers', () => {
      // default decimals=2
      expect(formatCompact(-50)).toBe('-50.00')
    })

    it('should handle decimals with 0 precision', () => {
      expect(formatCompact(1500, 0)).toBe('2K')
      expect(formatCompact(1234567, 0)).toBe('1M')
    })
  })
})
