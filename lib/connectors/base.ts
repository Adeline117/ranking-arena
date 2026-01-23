/**
 * Base connector class with rate limiting, circuit breaker, retry/backoff.
 * All platform connectors extend this class.
 */

import type {
  Platform,
  PlatformConnector,
  RateLimiterConfig,
  RankingWindow,
  TraderIdentity,
  TraderSnapshot,
  TraderProfileEnriched,
  TraderTimeseries,
  TimeseriesType,
  SnapshotMetrics,
  SnapshotQuality,
} from '@/lib/types/leaderboard';
import { PLATFORM_RATE_LIMITS } from '@/lib/types/leaderboard';

// ============================================
// Rate Limiter
// ============================================

class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;
  private timestamps: number[] = [];

  constructor(private config: RateLimiterConfig) {}

  async acquire(): Promise<void> {
    // Wait if at max concurrency
    if (this.running >= this.config.max_concurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    // Check rate window
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.config.window_ms);

    if (this.timestamps.length >= this.config.max_requests) {
      const waitUntil = this.timestamps[0] + this.config.window_ms;
      await sleep(waitUntil - now);
    }

    // Add jitter delay
    const delay =
      this.config.min_delay_ms +
      Math.random() * (this.config.max_delay_ms - this.config.min_delay_ms);
    await sleep(delay);

    this.running++;
    this.timestamps.push(Date.now());
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ============================================
// Circuit Breaker
// ============================================

type CircuitState = 'closed' | 'open' | 'half_open';

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private successCount = 0;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeout: number = 60_000, // 1 min
    private readonly halfOpenMaxAttempts: number = 2,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'half_open';
        this.successCount = 0;
      } else {
        throw new CircuitOpenError(
          `Circuit is open. Retry after ${this.resetTimeout - (Date.now() - this.lastFailureTime)}ms`,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      if (this.successCount >= this.halfOpenMaxAttempts) {
        this.state = 'closed';
        this.failureCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// ============================================
// Error Types
// ============================================

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly platform: Platform,
    public readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

// ============================================
// Base Connector
// ============================================

export abstract class BaseConnector implements PlatformConnector {
  abstract readonly platform: Platform;

  protected rateLimiter: RateLimiter;
  protected circuitBreaker: CircuitBreaker;

  constructor(rateLimitOverride?: Partial<RateLimiterConfig>) {
    // Defer rateLimiter init since `platform` is abstract
    this.rateLimiter = null as unknown as RateLimiter;
    this.circuitBreaker = new CircuitBreaker();

    // Will be initialized in init()
    if (rateLimitOverride) {
      this._rateLimitOverride = rateLimitOverride;
    }
  }

  private _rateLimitOverride?: Partial<RateLimiterConfig>;

  /** Must be called after construction to initialize rate limiter */
  protected init(): void {
    const config = {
      ...PLATFORM_RATE_LIMITS[this.platform],
      ...this._rateLimitOverride,
    };
    this.rateLimiter = new RateLimiter(config);
  }

  /**
   * Execute a request with rate limiting, circuit breaker, and retry.
   */
  protected async request<T>(
    fn: () => Promise<T>,
    options: { retries?: number; label?: string } = {},
  ): Promise<T> {
    const { retries = 3, label = 'request' } = options;

    return this.circuitBreaker.execute(async () => {
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await this.rateLimiter.acquire();
          try {
            return await fn();
          } finally {
            this.rateLimiter.release();
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          if (attempt < retries) {
            const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            console.warn(
              `[${this.platform}] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(backoff)}ms: ${lastError.message}`,
            );
            await sleep(backoff);
          }
        }
      }

      throw new ConnectorError(
        `[${this.platform}] ${label} failed after ${retries + 1} attempts: ${lastError?.message}`,
        this.platform,
      );
    });
  }

  /**
   * Build a SnapshotQuality object from available metrics.
   */
  protected buildQuality(metrics: SnapshotMetrics): SnapshotQuality {
    const allFields = Object.keys(metrics) as (keyof SnapshotMetrics)[];
    const missingFields = allFields.filter((f) => metrics[f] === null || metrics[f] === undefined);
    const totalFields = allFields.length;
    const presentFields = totalFields - missingFields.length;

    return {
      is_complete: missingFields.length === 0,
      missing_fields: missingFields,
      confidence: totalFields > 0 ? presentFields / totalFields : 0,
      is_interpolated: false,
    };
  }

  /**
   * Generate the date bucket for idempotent writes.
   * Truncates to the current hour.
   */
  protected getDateBucket(): string {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return now.toISOString();
  }

  // ============================================
  // Abstract methods (each connector must implement)
  // ============================================

  abstract discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]>;

  abstract fetchTraderSnapshot(
    traderKey: string,
    window: RankingWindow,
  ): Promise<Omit<TraderSnapshot, 'id' | 'created_at'>>;

  abstract fetchTraderProfile(
    traderKey: string,
  ): Promise<Omit<TraderProfileEnriched, 'last_enriched_at'>>;

  abstract fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseries, 'id' | 'created_at'>>;
}

// ============================================
// Utility
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
