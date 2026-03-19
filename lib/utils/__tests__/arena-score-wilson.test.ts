import { wilsonLowerBound, wilsonConfidenceMultiplier } from '../arena-score'

describe('wilsonLowerBound', () => {
  it('returns 0 when totalSignals is 0', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
  })

  it('returns a value between 0 and 1', () => {
    const result = wilsonLowerBound(3, 5)
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(1)
  })

  it('returns higher value when more signals are positive', () => {
    const low = wilsonLowerBound(1, 5)
    const high = wilsonLowerBound(4, 5)
    expect(high).toBeGreaterThan(low)
  })

  it('returns 1 when all signals are positive with large sample', () => {
    // With very large n, wilson(n, n) approaches 1
    const result = wilsonLowerBound(1000, 1000)
    expect(result).toBeGreaterThan(0.99)
  })

  it('returns lower bound, not point estimate', () => {
    // Wilson lower bound should be less than the point estimate
    const pointEstimate = 3 / 5 // 0.6
    const wilson = wilsonLowerBound(3, 5)
    expect(wilson).toBeLessThan(pointEstimate)
  })

  it('respects custom z-score parameter', () => {
    const z1 = wilsonLowerBound(3, 5, 1.0)  // ~68% confidence
    const z2 = wilsonLowerBound(3, 5, 2.58) // ~99% confidence
    // Higher z-score = wider interval = lower lower-bound
    expect(z2).toBeLessThan(z1)
  })
})

describe('wilsonConfidenceMultiplier', () => {
  it('returns minimum 0.3 when all signals are null', () => {
    const result = wilsonConfidenceMultiplier(null, null, null, null, null)
    expect(result).toBeCloseTo(0.3, 1)
  })

  it('returns higher value when all signals are present', () => {
    const result = wilsonConfidenceMultiplier(10, 1000, -5, 0.65, 1.2)
    // With 5/5 signals available, should be well above baseline
    expect(result).toBeGreaterThan(0.6)
    expect(result).toBeLessThanOrEqual(1.0)
  })

  it('returns intermediate value for partial signals', () => {
    const result = wilsonConfidenceMultiplier(10, 1000, null, null, null)
    expect(result).toBeGreaterThan(0.3)
    expect(result).toBeLessThan(1.0)
  })

  it('treats undefined the same as null', () => {
    const withNull = wilsonConfidenceMultiplier(10, null, null, null, null)
    const withUndefined = wilsonConfidenceMultiplier(10, undefined, undefined, undefined, undefined)
    expect(withNull).toBeCloseTo(withUndefined, 5)
  })
})
