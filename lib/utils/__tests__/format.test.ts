/**
 * 格式化工具测试
 */

import { formatNumber, formatPercent, formatCurrency, formatCompact, truncate, capitalize } from '../format'

describe('format utilities', () => {
  describe('formatNumber', () => {
    it('应该格式化整数', () => {
      expect(formatNumber(1000)).toBe('1,000')
      expect(formatNumber(1000000)).toBe('1,000,000')
    })

    it('应该格式化小数', () => {
      const result = formatNumber(1234.56, 2)
      expect(result).toBe('1,234.56')
    })

    it('应该处理负数', () => {
      expect(formatNumber(-1000)).toBe('-1,000')
    })

    it('应该处理零', () => {
      expect(formatNumber(0)).toBe('0')
    })

    it('应该处理字符串数字', () => {
      expect(formatNumber('1234')).toBe('1,234')
    })

    it('应该处理 NaN', () => {
      expect(formatNumber(NaN)).toBe('0')
      expect(formatNumber('not a number')).toBe('0')
    })
  })

  describe('formatPercent', () => {
    it('应该格式化百分比', () => {
      expect(formatPercent(0.1234)).toBe('+12.34%')
    })

    it('应该处理负百分比', () => {
      const result = formatPercent(-0.1234)
      expect(result).toBe('-12.34%')
    })

    it('应该处理零', () => {
      expect(formatPercent(0)).toBe('+0.00%')
    })

    it('应该处理 100%', () => {
      expect(formatPercent(1)).toBe('+100.00%')
    })

    it('应该支持自定义小数位数', () => {
      expect(formatPercent(0.1234, 1)).toBe('+12.3%')
    })

    it('应该支持不乘以 100 的模式', () => {
      expect(formatPercent(12.34, 2, false)).toBe('+12.34%')
    })
  })

  describe('formatCurrency', () => {
    it('应该格式化货币', () => {
      const result = formatCurrency(1234.56)
      expect(result).toBe('$1,234.56')
    })

    it('应该支持自定义货币符号', () => {
      const result = formatCurrency(1234.56, '¥')
      expect(result).toBe('¥1,234.56')
    })

    it('应该处理负数', () => {
      const result = formatCurrency(-1234.56)
      expect(result).toBe('$-1,234.56')
    })

    it('应该处理大数字', () => {
      const result = formatCurrency(1000000)
      expect(result).toBe('$1,000,000.00')
    })

    it('应该处理 NaN', () => {
      expect(formatCurrency(NaN)).toBe('$0')
    })
  })

  describe('formatCompact', () => {
    it('应该格式化千位数', () => {
      expect(formatCompact(1500)).toBe('1.5K')
    })

    it('应该格式化百万位数', () => {
      expect(formatCompact(1500000)).toBe('1.5M')
    })

    it('应该格式化十亿位数', () => {
      expect(formatCompact(1500000000)).toBe('1.5B')
    })

    it('应该处理小数字', () => {
      expect(formatCompact(100)).toBe('100')
    })

    it('应该处理负数', () => {
      expect(formatCompact(-1500)).toBe('-1.5K')
    })

    it('应该支持自定义小数位数', () => {
      expect(formatCompact(1234, 2)).toBe('1.23K')
    })

    it('应该处理 NaN', () => {
      expect(formatCompact(NaN)).toBe('0')
    })
  })

  describe('truncate', () => {
    it('应该截断超长文本', () => {
      expect(truncate('Hello World', 8)).toBe('Hello...')
    })

    it('应该保留短于限制的文本', () => {
      expect(truncate('Hi', 10)).toBe('Hi')
    })

    it('应该支持自定义后缀', () => {
      expect(truncate('Hello World', 8, '…')).toBe('Hello W…')
    })

    it('应该处理空字符串', () => {
      expect(truncate('', 10)).toBe('')
    })

    it('应该处理 null 和 undefined', () => {
      expect(truncate(null as unknown as string, 10)).toBe('')
      expect(truncate(undefined as unknown as string, 10)).toBe('')
    })
  })

  describe('capitalize', () => {
    it('应该首字母大写', () => {
      expect(capitalize('hello')).toBe('Hello')
    })

    it('应该处理全大写', () => {
      expect(capitalize('HELLO')).toBe('Hello')
    })

    it('应该处理单字符', () => {
      expect(capitalize('h')).toBe('H')
    })

    it('应该处理空字符串', () => {
      expect(capitalize('')).toBe('')
    })
  })
})
