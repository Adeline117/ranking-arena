/**
 * Timeout utilities for query execution and cascading timeout budgets.
 *
 * Usage:
 *   // Single timeout
 *   const result = await withTimeout(fetch(url), 5000, 'fetch-rankings')
 *
 *   // Cascading budget
 *   const budget = createBudget(30000) // 30s total
 *   const data = await withTimeout(query1(), budget.remaining(), 'query1')
 *   const detail = await withTimeout(query2(), budget.remaining(), 'query2')
 */

/**
 * Execute a promise with a timeout. Rejects with TimeoutError if exceeded.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'query'): Promise<T> {
  if (ms <= 0) {
    throw new Error(`Timeout: ${label} — budget already expired`)
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

/**
 * Create a budget tracker for cascading timeouts.
 *
 * Usage:
 *   const budget = createBudget(30000) // 30s total
 *   await withTimeout(query1, budget.remaining(), 'query1')
 *   await withTimeout(query2, budget.remaining(), 'query2')
 *   if (budget.expired()) throw new Error('Out of time')
 */
export function createBudget(totalMs: number) {
  const start = Date.now()
  return {
    /** Milliseconds remaining in the budget (minimum 0). */
    remaining: () => Math.max(0, totalMs - (Date.now() - start)),
    /** Milliseconds elapsed since budget creation. */
    elapsed: () => Date.now() - start,
    /** Whether the budget has been fully consumed. */
    expired: () => Date.now() - start >= totalMs,
  }
}
