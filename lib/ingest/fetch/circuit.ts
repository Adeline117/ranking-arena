/**
 * Per-source circuit breaker + failure-rate accounting (spec §4):
 *   - auto-quarantine after N consecutive blocks (default 2)
 *   - half-open after a cooldown; one probe decides close vs re-open
 *   - per-cycle failure-rate tracking; >20% in a cycle flags an alert
 */

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitOptions {
  /** Consecutive blocks before opening (spec: quarantine after 2). */
  blockThreshold?: number
  /** How long the circuit stays open before allowing a probe. */
  cooldownMs?: number
  /** Failure-rate alert threshold over a cycle (spec: 20%). */
  failureRateAlert?: number
}

export class CircuitOpenError extends Error {
  constructor(
    source: string,
    public readonly reopensAt: number
  ) {
    super(`[ingest] circuit open for ${source} until ${new Date(reopensAt).toISOString()}`)
    this.name = 'CircuitOpenError'
  }
}

export class Circuit {
  private state: CircuitState = 'closed'
  private consecutiveBlocks = 0
  private openedAt = 0
  private cycleSuccesses = 0
  private cycleFailures = 0

  private readonly blockThreshold: number
  private readonly cooldownMs: number
  private readonly failureRateAlert: number

  constructor(
    private readonly source: string,
    opts: CircuitOptions = {}
  ) {
    this.blockThreshold = opts.blockThreshold ?? 2
    this.cooldownMs = opts.cooldownMs ?? 10 * 60_000
    this.failureRateAlert = opts.failureRateAlert ?? 0.2
  }

  getState(): CircuitState {
    this.maybeHalfOpen()
    return this.state
  }

  /** Throws CircuitOpenError if requests must not be attempted right now. */
  assertCanProceed(): void {
    this.maybeHalfOpen()
    if (this.state === 'open') {
      throw new CircuitOpenError(this.source, this.openedAt + this.cooldownMs)
    }
  }

  recordSuccess(): void {
    this.cycleSuccesses += 1
    this.consecutiveBlocks = 0
    if (this.state === 'half_open') this.state = 'closed'
  }

  /** blocked=true for 403/429/captcha; other failures count toward the
   *  cycle rate but do not open the circuit. */
  recordFailure(blocked: boolean): void {
    this.cycleFailures += 1
    if (this.state === 'half_open') {
      // probe failed — re-open
      this.open()
      return
    }
    if (blocked) {
      this.consecutiveBlocks += 1
      if (this.consecutiveBlocks >= this.blockThreshold) this.open()
    }
  }

  /** Failure rate of the current cycle; call endCycle() to reset. */
  cycleFailureRate(): number {
    const total = this.cycleSuccesses + this.cycleFailures
    return total === 0 ? 0 : this.cycleFailures / total
  }

  /** Ends an orchestrator cycle; returns whether the alert threshold tripped. */
  endCycle(): { failureRate: number; shouldAlert: boolean } {
    const failureRate = this.cycleFailureRate()
    const shouldAlert = failureRate > this.failureRateAlert
    this.cycleSuccesses = 0
    this.cycleFailures = 0
    return { failureRate, shouldAlert }
  }

  private open(): void {
    this.state = 'open'
    this.openedAt = Date.now()
    this.consecutiveBlocks = 0
  }

  private maybeHalfOpen(): void {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open'
    }
  }
}
