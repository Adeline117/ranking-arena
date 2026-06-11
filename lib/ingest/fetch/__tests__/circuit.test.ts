import { Circuit, CircuitOpenError } from '../circuit'

describe('Circuit', () => {
  it('opens after the block threshold and rejects until cooldown', () => {
    const c = new Circuit('bitget_futures', { blockThreshold: 2, cooldownMs: 60_000 })
    c.recordFailure(true)
    expect(c.getState()).toBe('closed')
    c.recordFailure(true)
    expect(c.getState()).toBe('open')
    expect(() => c.assertCanProceed()).toThrow(CircuitOpenError)
  })

  it('non-block failures never open the circuit', () => {
    const c = new Circuit('x', { blockThreshold: 2 })
    for (let i = 0; i < 10; i++) c.recordFailure(false)
    expect(c.getState()).toBe('closed')
  })

  it('half-opens after cooldown; probe success closes, probe failure re-opens', () => {
    jest.useFakeTimers()
    try {
      const c = new Circuit('x', { blockThreshold: 1, cooldownMs: 1000 })
      c.recordFailure(true)
      expect(c.getState()).toBe('open')

      jest.advanceTimersByTime(1001)
      expect(c.getState()).toBe('half_open')
      c.recordSuccess()
      expect(c.getState()).toBe('closed')

      c.recordFailure(true)
      jest.advanceTimersByTime(1001)
      expect(c.getState()).toBe('half_open')
      c.recordFailure(false) // failed probe re-opens regardless of block-ness
      expect(c.getState()).toBe('open')
    } finally {
      jest.useRealTimers()
    }
  })

  it('tracks per-cycle failure rate and alert threshold (spec: >20%)', () => {
    const c = new Circuit('x', { failureRateAlert: 0.2 })
    for (let i = 0; i < 8; i++) c.recordSuccess()
    c.recordFailure(false)
    c.recordFailure(false)
    expect(c.cycleFailureRate()).toBeCloseTo(0.2)
    expect(c.endCycle().shouldAlert).toBe(false) // exactly 20% is not >20%

    for (let i = 0; i < 7; i++) c.recordSuccess()
    c.recordFailure(false)
    c.recordFailure(false)
    c.recordFailure(false)
    const cycle = c.endCycle()
    expect(cycle.failureRate).toBeCloseTo(0.3)
    expect(cycle.shouldAlert).toBe(true)
    expect(c.cycleFailureRate()).toBe(0) // reset
  })
})
