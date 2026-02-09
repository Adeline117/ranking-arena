import {
  moneyAdd, moneySub, moneyMul, moneyDiv, moneySum,
  roundTo, round2, round1, formatUSD,
} from '../currency'

describe('currency utils', () => {
  describe('moneyAdd', () => {
    it('adds without floating-point drift', () => {
      expect(moneyAdd(0.1, 0.2)).toBe(0.30)
    })
    it('handles negatives', () => {
      expect(moneyAdd(10, -3)).toBe(7)
    })
  })

  describe('moneySub', () => {
    it('subtracts precisely', () => {
      expect(moneySub(1.0, 0.9)).toBe(0.10)
    })
  })

  describe('moneyMul', () => {
    it('multiplies precisely', () => {
      expect(moneyMul(19.99, 3)).toBe(59.97)
    })
  })

  describe('moneyDiv', () => {
    it('divides precisely', () => {
      expect(moneyDiv(10, 3)).toBe(3.33)
    })
    it('returns 0 for division by zero', () => {
      expect(moneyDiv(10, 0)).toBe(0)
    })
  })

  describe('moneySum', () => {
    it('sums array precisely', () => {
      expect(moneySum([0.1, 0.2, 0.3])).toBe(0.60)
    })
    it('returns 0 for empty array', () => {
      expect(moneySum([])).toBe(0)
    })
  })

  describe('rounding', () => {
    it('roundTo rounds to N decimals', () => {
      expect(roundTo(3.14159, 3)).toBe(3.142)
    })
    it('round2 rounds to 2 decimals', () => {
      expect(round2(1.005)).toBe(1.01)
    })
    it('round1 rounds to 1 decimal', () => {
      expect(round1(2.75)).toBe(2.8)
    })
  })

  describe('formatUSD', () => {
    it('formats basic amount', () => {
      expect(formatUSD(1234.5)).toBe('$1,234.50')
    })
    it('formats with custom decimals', () => {
      expect(formatUSD(99, 0)).toBe('$99')
    })
  })
})
