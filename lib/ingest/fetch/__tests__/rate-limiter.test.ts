import { BlockedUpstreamError, PacedGate, isBlockedStatus } from '../rate-limiter'

describe('PacedGate', () => {
  it('enforces the budget gap between request starts', async () => {
    const gate = new PacedGate({ budgetMs: 50, jitterMs: 1 })
    const t0 = Date.now()
    await gate.run(async () => 'a')
    await gate.run(async () => 'b')
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(45) // second call waited ~budget
  })

  it('resets consecutive blocks on success', async () => {
    const gate = new PacedGate({ budgetMs: 1, jitterMs: 1, backoffBaseMs: 1 })
    await expect(
      gate.run(async () => {
        throw new BlockedUpstreamError(429, 'http://x')
      })
    ).rejects.toThrow(BlockedUpstreamError)
    expect(gate.blocks).toBe(1)
    await gate.run(async () => 'ok')
    expect(gate.blocks).toBe(0)
  })

  it('backs off exponentially on consecutive blocks', async () => {
    const gate = new PacedGate({ budgetMs: 1, jitterMs: 1, backoffBaseMs: 40, backoffMaxMs: 1000 })
    const blocked = async () => {
      throw new BlockedUpstreamError(403, 'http://x')
    }
    await expect(gate.run(blocked)).rejects.toThrow() // backoff 40ms
    const t0 = Date.now()
    await expect(gate.run(blocked)).rejects.toThrow() // waited >=40, backoff 80
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35)
    expect(gate.blocks).toBe(2)
  })

  it('does not back off for non-block errors', async () => {
    const gate = new PacedGate({ budgetMs: 1, jitterMs: 1 })
    await expect(
      gate.run(async () => {
        throw new Error('parse error')
      })
    ).rejects.toThrow('parse error')
    expect(gate.blocks).toBe(0)
  })
})

describe('isBlockedStatus', () => {
  it('classifies 401/403/429 as blocks', () => {
    expect(isBlockedStatus(403)).toBe(true)
    expect(isBlockedStatus(429)).toBe(true)
    expect(isBlockedStatus(401)).toBe(true)
    expect(isBlockedStatus(500)).toBe(false)
    expect(isBlockedStatus(200)).toBe(false)
  })
})
