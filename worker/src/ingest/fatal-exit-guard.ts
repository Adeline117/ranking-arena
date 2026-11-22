/**
 * A fatal shutdown must end the process (incident 2026-11-21).
 *
 * The native process coordinator only sets process.exitCode and lets the
 * event loop drain. After a network blip the worker lost its regional
 * authority, the coordinator reported "native process shutdown failed
 * (authority_lost)", stopped every consumer and the heartbeat, and then a
 * handle that never closed (a browser child, a blocked connection, a drain
 * that never settled) kept the process alive. PM2 saw it online and never
 * restarted it: about seven hours without a crawl, unnoticed because the
 * 48-hour freshness window kept the published boards up.
 *
 * Once the coordinator reports a fatal code, this guard gives the graceful
 * cleanup a bounded time to finish and then exits non-zero, so the process
 * supervisor restarts the worker. A clean signal shutdown never arms it.
 */

/** Longer than a normal drain of in-flight Redis/DB work, far shorter than a crawl cycle. */
export const FATAL_EXIT_DEADLINE_MS = 60_000

export interface FatalExitGuard {
  /** Start the countdown; later calls are no-ops. */
  arm(code: string): void
  readonly armed: boolean
}

export function createFatalExitGuard(options: {
  exit: (code: number) => void
  log?: (message: string) => void
  deadlineMs?: number
  /** Must not keep the event loop alive: a process that can exit on its own should. */
  schedule?: (callback: () => void, delayMs: number) => void
}): FatalExitGuard {
  const deadlineMs = options.deadlineMs ?? FATAL_EXIT_DEADLINE_MS
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      setTimeout(callback, delayMs).unref()
    })
  let armed = false
  return {
    get armed() {
      return armed
    },
    arm(code: string): void {
      if (armed) return
      armed = true
      schedule(() => {
        options.log?.(
          `[ingest-worker] still running ${Math.round(deadlineMs / 1000)}s after a fatal shutdown (${code}); exiting`
        )
        options.exit(1)
      }, deadlineMs)
    },
  }
}
