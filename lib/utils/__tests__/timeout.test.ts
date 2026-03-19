import { withTimeout, createBudget } from '../timeout'

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test')
    expect(result).toBe(42)
  })

  it('rejects with TimeoutError when promise exceeds timeout', async () => {
    const slow = new Promise<never>((resolve) => setTimeout(resolve, 5000))
    await expect(withTimeout(slow, 50, 'slow-op')).rejects.toThrow('Timeout: slow-op exceeded 50ms')
  })

  it('rejects immediately when budget is 0', async () => {
    await expect(withTimeout(Promise.resolve(1), 0, 'expired')).rejects.toThrow('budget already expired')
  })

  it('rejects immediately when budget is negative', async () => {
    await expect(withTimeout(Promise.resolve(1), -100, 'neg')).rejects.toThrow('budget already expired')
  })

  it('propagates the original error from the promise', async () => {
    const failing = Promise.reject(new Error('original error'))
    await expect(withTimeout(failing, 1000, 'test')).rejects.toThrow('original error')
  })

  it('uses default label when none provided', async () => {
    const slow = new Promise<never>((resolve) => setTimeout(resolve, 5000))
    await expect(withTimeout(slow, 10)).rejects.toThrow('Timeout: query exceeded 10ms')
  })
})

describe('createBudget', () => {
  it('starts with full remaining time', () => {
    const budget = createBudget(5000)
    expect(budget.remaining()).toBeGreaterThan(4900)
    expect(budget.remaining()).toBeLessThanOrEqual(5000)
  })

  it('reports elapsed time', () => {
    const budget = createBudget(5000)
    expect(budget.elapsed()).toBeLessThan(100)
  })

  it('reports not expired initially', () => {
    const budget = createBudget(5000)
    expect(budget.expired()).toBe(false)
  })

  it('reports expired after total time passes', async () => {
    const budget = createBudget(50)
    await new Promise((r) => setTimeout(r, 60))
    expect(budget.expired()).toBe(true)
    expect(budget.remaining()).toBe(0)
  })

  it('remaining never goes below 0', async () => {
    const budget = createBudget(10)
    await new Promise((r) => setTimeout(r, 50))
    expect(budget.remaining()).toBe(0)
  })
})
