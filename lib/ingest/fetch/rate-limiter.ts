/**
 * Per-session pacing for adapter fetches (spec §4 anti-bot baseline):
 * start at 1 req / rate_budget_ms with jitter; exponential backoff on
 * 403/429/captcha. One PacedGate per FetchSession — sources scale by
 * adding parallel sessions on different IPs, never by speeding one up.
 */

export interface PacedGateOptions {
  /** Minimum gap between request starts (sources.rate_budget_ms). */
  budgetMs: number
  /** Random extra delay added per request: [0, jitterMs). */
  jitterMs?: number
  /** Base backoff after a blocked response (doubles per consecutive block). */
  backoffBaseMs?: number
  /** Cap for exponential backoff. */
  backoffMaxMs?: number
}

export class BlockedUpstreamError extends Error {
  constructor(
    public readonly status: number,
    url: string
  ) {
    super(`[ingest] blocked upstream (${status}): ${url}`)
    this.name = 'BlockedUpstreamError'
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class PacedGate {
  private nextAllowedAt = 0
  private consecutiveBlocks = 0
  private readonly budgetMs: number
  private readonly jitterMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number

  constructor(opts: PacedGateOptions) {
    this.budgetMs = opts.budgetMs
    this.jitterMs = opts.jitterMs ?? Math.round(opts.budgetMs / 2)
    this.backoffBaseMs = opts.backoffBaseMs ?? 5_000
    this.backoffMaxMs = opts.backoffMaxMs ?? 120_000
  }

  /** Current consecutive-block count (feeds the circuit breaker). */
  get blocks(): number {
    return this.consecutiveBlocks
  }

  /**
   * Run fn under the gate. On BlockedUpstreamError the gate backs off
   * exponentially and rethrows — retry policy belongs to the caller (BullMQ
   * job attempts), not the gate, so a hard-blocked source fails fast into
   * the circuit breaker instead of spinning here.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const wait = Math.max(0, this.nextAllowedAt - now)
    const jitter = Math.floor(Math.random() * this.jitterMs)
    if (wait + jitter > 0) await sleep(wait + jitter)

    this.nextAllowedAt = Date.now() + this.budgetMs

    try {
      const result = await fn()
      this.consecutiveBlocks = 0
      return result
    } catch (err) {
      if (err instanceof BlockedUpstreamError) {
        this.consecutiveBlocks += 1
        const backoff = Math.min(
          this.backoffBaseMs * 2 ** (this.consecutiveBlocks - 1),
          this.backoffMaxMs
        )
        this.nextAllowedAt = Date.now() + backoff
      }
      throw err
    }
  }
}

/** Classify an HTTP status as a block signal (403/429/anti-bot challenge). */
export function isBlockedStatus(status: number): boolean {
  return status === 403 || status === 429 || status === 401
}
