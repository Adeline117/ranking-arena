import { safeNumber, safePercent, safeMdd, safeNonNeg, safeInt, safeStr } from '../utils'

describe('safeNumber', () => {
  it('returns null for null/undefined', () => {
    expect(safeNumber(null)).toBeNull()
    expect(safeNumber(undefined)).toBeNull()
  })

  it('returns null for NaN/Infinity', () => {
    expect(safeNumber(NaN)).toBeNull()
    expect(safeNumber(Infinity)).toBeNull()
    expect(safeNumber(-Infinity)).toBeNull()
  })

  it('returns null for non-numeric strings', () => {
    expect(safeNumber('abc')).toBeNull()
    expect(safeNumber('')).toBeNull()
  })

  it('converts valid numbers', () => {
    expect(safeNumber(0)).toBe(0)
    expect(safeNumber(123.45)).toBe(123.45)
    expect(safeNumber(-50)).toBe(-50)
    expect(safeNumber('123.45')).toBe(123.45)
    expect(safeNumber('0')).toBe(0)
  })
})

describe('safePercent', () => {
  it('returns null for invalid input', () => {
    expect(safePercent(null)).toBeNull()
    expect(safePercent(undefined)).toBeNull()
    expect(safePercent(NaN)).toBeNull()
  })

  it('passes through percentage values by default', () => {
    expect(safePercent(50)).toBe(50)
    expect(safePercent(-10)).toBe(-10)
    expect(safePercent(0)).toBe(0)
  })

  it('converts ratios to percent when isRatio=true', () => {
    expect(safePercent(0.5, { isRatio: true })).toBe(50)
    expect(safePercent(1.0852, { isRatio: true })).toBeCloseTo(108.52)
    expect(safePercent(0, { isRatio: true })).toBe(0)
    expect(safePercent(-0.05, { isRatio: true })).toBe(-5)
  })

  it('filters outliers beyond maxReasonable', () => {
    expect(safePercent(999999)).toBeNull()
    expect(safePercent(500000)).toBe(500000)
    expect(safePercent(500001)).toBeNull()
  })
})

describe('safeMdd', () => {
  it('returns absolute percentage', () => {
    expect(safeMdd(-8.5)).toBe(8.5)
    expect(safeMdd(8.5)).toBe(8.5)
    expect(safeMdd(0)).toBe(0)
  })

  it('converts ratio when isRatio=true', () => {
    expect(safeMdd(0.085, true)).toBeCloseTo(8.5)
    expect(safeMdd(-0.15, true)).toBeCloseTo(15)
  })

  it('returns null for values > 100%', () => {
    expect(safeMdd(101)).toBeNull()
    expect(safeMdd(1.5, true)).toBeNull() // 150%
  })

  it('returns null for invalid input', () => {
    expect(safeMdd(null)).toBeNull()
    expect(safeMdd(NaN)).toBeNull()
  })
})

describe('safeNonNeg', () => {
  it('returns null for negative values', () => {
    expect(safeNonNeg(-1)).toBeNull()
  })
  it('allows zero and positive', () => {
    expect(safeNonNeg(0)).toBe(0)
    expect(safeNonNeg(100)).toBe(100)
  })
})

describe('safeInt', () => {
  it('rounds to integer', () => {
    expect(safeInt(3.7)).toBe(4)
    expect(safeInt(3.2)).toBe(3)
  })
  it('returns null for invalid', () => {
    expect(safeInt(null)).toBeNull()
    expect(safeInt(NaN)).toBeNull()
  })
})

describe('safeStr', () => {
  it('returns null for empty/null', () => {
    expect(safeStr(null)).toBeNull()
    expect(safeStr(undefined)).toBeNull()
    expect(safeStr('')).toBeNull()
    expect(safeStr('   ')).toBeNull()
  })
  it('trims and returns valid strings', () => {
    expect(safeStr('  hello  ')).toBe('hello')
    expect(safeStr('test')).toBe('test')
  })
})
