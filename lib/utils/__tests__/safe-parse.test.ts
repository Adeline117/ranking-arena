import { safeParseInt, parseLimit, parseOffset, parsePage } from '../safe-parse'

describe('safeParseInt', () => {
  it('parses a valid integer string', () => {
    expect(safeParseInt('42', 0)).toBe(42)
  })

  it('returns fallback for null', () => {
    expect(safeParseInt(null, 10)).toBe(10)
  })

  it('returns fallback for undefined', () => {
    expect(safeParseInt(undefined, 10)).toBe(10)
  })

  it('returns fallback for empty string', () => {
    expect(safeParseInt('', 10)).toBe(10)
  })

  it('returns fallback for non-numeric string', () => {
    expect(safeParseInt('abc', 5)).toBe(5)
  })

  it('truncates a float string to integer part', () => {
    expect(safeParseInt('3.14', 0)).toBe(3)
  })

  it('parses "0" as 0, not fallback', () => {
    // "0" is a non-empty string so !value is false; parseInt("0",10) = 0
    expect(safeParseInt('0', 99)).toBe(0)
  })

  it('parses negative numbers', () => {
    expect(safeParseInt('-5', 0)).toBe(-5)
  })

  it('parses strings with leading zeros (octal-safe via radix 10)', () => {
    expect(safeParseInt('08', 0)).toBe(8)
    expect(safeParseInt('010', 0)).toBe(10)
  })

  it('parses very large numbers', () => {
    expect(safeParseInt('999999999', 0)).toBe(999999999)
  })

  it('parses string with trailing non-numeric chars (parseInt behavior)', () => {
    expect(safeParseInt('42abc', 0)).toBe(42)
  })

  it('returns fallback for whitespace-only string if parseInt fails', () => {
    // parseInt('   ', 10) => NaN
    expect(safeParseInt('   ', 0)).toBe(0)
  })
})

describe('parseLimit', () => {
  it('returns parsed value when within range', () => {
    expect(parseLimit('25', 50, 100)).toBe(25)
  })

  it('returns fallback when input is NaN', () => {
    expect(parseLimit('abc', 50, 100)).toBe(50)
  })

  it('returns fallback when input is null', () => {
    expect(parseLimit(null, 50, 100)).toBe(50)
  })

  it('clamps to max when value exceeds max', () => {
    expect(parseLimit('200', 50, 100)).toBe(100)
  })

  it('clamps to 1 when value is 0', () => {
    expect(parseLimit('0', 50, 100)).toBe(1)
  })

  it('clamps to 1 when value is negative', () => {
    expect(parseLimit('-10', 50, 100)).toBe(1)
  })

  it('returns max when value equals max', () => {
    expect(parseLimit('100', 50, 100)).toBe(100)
  })

  it('returns 1 when value is 1 (lower boundary)', () => {
    expect(parseLimit('1', 50, 100)).toBe(1)
  })
})

describe('parseOffset', () => {
  it('returns parsed value for valid positive number', () => {
    expect(parseOffset('10')).toBe(10)
  })

  it('returns 0 for NaN input', () => {
    expect(parseOffset('abc')).toBe(0)
  })

  it('returns 0 for null', () => {
    expect(parseOffset(null)).toBe(0)
  })

  it('returns 0 for undefined', () => {
    expect(parseOffset(undefined)).toBe(0)
  })

  it('returns 0 for negative values (floors at 0)', () => {
    expect(parseOffset('-5')).toBe(0)
  })

  it('returns 0 for "0"', () => {
    expect(parseOffset('0')).toBe(0)
  })
})

describe('parsePage', () => {
  it('returns parsed value for valid page number', () => {
    expect(parsePage('3')).toBe(3)
  })

  it('returns default fallback (1) for NaN input', () => {
    expect(parsePage('abc')).toBe(1)
  })

  it('returns custom fallback for NaN input when fallback provided', () => {
    expect(parsePage('abc', 5)).toBe(5)
  })

  it('returns 1 for "0" (floors at 1)', () => {
    expect(parsePage('0')).toBe(1)
  })

  it('returns 1 for negative values', () => {
    expect(parsePage('-3')).toBe(1)
  })

  it('returns 1 for null', () => {
    expect(parsePage(null)).toBe(1)
  })

  it('returns 1 for undefined', () => {
    expect(parsePage(undefined)).toBe(1)
  })

  it('returns page value when it equals 1', () => {
    expect(parsePage('1')).toBe(1)
  })

  it('handles large page numbers', () => {
    expect(parsePage('9999')).toBe(9999)
  })
})
