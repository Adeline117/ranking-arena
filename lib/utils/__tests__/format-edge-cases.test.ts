/**
 * format.ts 边界值测试
 * 补充现有测试未覆盖的边界情况
 */

import { formatNumber, formatPercent, formatCurrency, formatCompact } from '../format'

describe('format utilities - edge cases', () => {
  describe('formatNumber edge cases', () => {
    it('should handle Infinity', () => {
      expect(formatNumber(Infinity)).toBe('∞')
    })

    it('should handle -Infinity', () => {
      expect(formatNumber(-Infinity)).toBe('-∞')
    })

    it('should handle very large numbers', () => {
      const result = formatNumber(999999999999)
      expect(result).toBe('999,999,999,999')
    })

    it('should handle very small decimals', () => {
      expect(formatNumber(0.000001, 6)).toBe('0.000001')
    })

    it('should handle negative zero', () => {
      expect(formatNumber(-0)).toBe('0')
    })
  })

  describe('formatPercent edge cases', () => {
    it('should handle NaN', () => {
      expect(formatPercent(NaN)).toBe('0%')
    })

    it('should handle Infinity', () => {
      const result = formatPercent(Infinity)
      expect(result).toContain('Infinity')
    })

    it('should handle very small percentages', () => {
      expect(formatPercent(0.00001)).toBe('+0.00%')
      expect(formatPercent(0.00001, 4)).toBe('+0.0010%')
    })

    it('should handle string input', () => {
      expect(formatPercent('0.5')).toBe('+50.00%')
      expect(formatPercent('invalid')).toBe('0%')
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
      const result = formatCurrency(Infinity)
      expect(result).toContain('$')
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
      expect(formatCurrency('abc')).toBe('$0')
    })

    it('should handle string number input', () => {
      expect(formatCurrency('1234.56')).toBe('$1,234.56')
    })
  })

  describe('formatCompact edge cases', () => {
    it('should handle Infinity', () => {
      const result = formatCompact(Infinity)
      expect(result).toContain('B') // Infinity >= 1e9
    })

    it('should handle -Infinity', () => {
      const result = formatCompact(-Infinity)
      expect(result).toContain('B')
    })

    it('should handle zero', () => {
      expect(formatCompact(0)).toBe('0')
    })

    it('should handle negative zero', () => {
      expect(formatCompact(-0)).toBe('0')
    })

    it('should handle exact thresholds', () => {
      expect(formatCompact(1000)).toBe('1.0K')
      expect(formatCompact(999)).toBe('999')
      expect(formatCompact(1000000)).toBe('1.0M')
      expect(formatCompact(1000000000)).toBe('1.0B')
    })

    it('should handle negative millions', () => {
      expect(formatCompact(-5500000)).toBe('-5.5M')
    })

    it('should handle negative billions', () => {
      expect(formatCompact(-2300000000)).toBe('-2.3B')
    })

    it('should handle string input', () => {
      expect(formatCompact('1500')).toBe('1.5K')
      expect(formatCompact('invalid')).toBe('0')
    })

    it('should handle very large numbers beyond billions', () => {
      expect(formatCompact(1e12)).toBe('1000.0B')
    })

    it('should handle small negative numbers', () => {
      expect(formatCompact(-50)).toBe('-50')
    })

    it('should handle decimals with 0 precision', () => {
      expect(formatCompact(1500, 0)).toBe('2K')
      expect(formatCompact(1234567, 0)).toBe('1M')
    })
  })
})
