/**
 * Race a promise against a hard timeout using Promise.race.
 * 
 * Unlike AbortSignal.timeout(), this RELIABLY cancels stuck operations by
 * rejecting the promise, which is critical for Node.js TCP connections that
 * may hang indefinitely even with AbortSignal.
 * 
 * @param promise - The async operation to race
 * @param timeoutMs - Hard deadline in milliseconds
 * @param context - Description for error messages
 * @returns Result of promise if it completes before timeout
 * @throws Error if timeout is reached first
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${context} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ])
}
