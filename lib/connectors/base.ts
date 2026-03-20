/**
 * Base Connector - Abstract base class for all platform connectors.
 *
 * Provides:
 * - HTTP request helpers with retry/backoff
 * - Rate limiting integration
 * - Circuit breaker pattern
 * - Quality flag generation
 * - Data provenance tracking
 * - Error handling patterns
 */

import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  QualityFlags,
  DataProvenance,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  PlatformCapabilities,
  SnapshotMetrics,
  RateLimiterConfig,
  GranularPlatform,
} from '../types/leaderboard'
import { exchangeLogger } from '../utils/logger'
import { PLATFORM_RATE_LIMITS } from '../types/leaderboard'
import * as cache from '../cache'
import type { PlatformConnector, ConnectorConfig, RateLimiter } from './types'
import type { RouteType } from './route-config'
import { ConnectorError, DEFAULT_CONNECTOR_CONFIG, getConnectorConfigForPlatform } from './types'
export { ConnectorError, DEFAULT_CONNECTOR_CONFIG, getConnectorConfigForPlatform }
import {
  retry,
  circuitBreaker,
  handleAll,
  wrap,
  ExponentialBackoff,
  ConsecutiveBreaker,
  BrokenCircuitError,
} from 'cockatiel'

// Scraper result cache TTL (30 minutes)
const SCRAPER_CACHE_TTL = 30 * 60

// ============================================
// Circuit Breaker (standalone, for legacy usage)
// ============================================

type CircuitState = 'closed' | 'open' | 'half_open'

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircuitOpenError'
  }
}

// ============================================
// Type Guards
// ============================================

/**
 * Type guard to check if value is an Error
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error
}

/**
 * Safely extract Error from unknown catch value
 */
export function toError(value: unknown): Error {
  if (isError(value)) return value
  if (typeof value === 'string') return new Error(value)
  if (value && typeof value === 'object' && 'message' in value) {
    return new Error(String((value as { message: unknown }).message))
  }
  return new Error(String(value))
}

class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private successCount = 0

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeout: number = 60_000,
    private readonly halfOpenMaxAttempts: number = 2
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'half_open'
        this.successCount = 0
      } else {
        throw new CircuitOpenError(
          `Circuit is open. Retry after ${this.resetTimeout - (Date.now() - this.lastFailureTime)}ms`
        )
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++
      if (this.successCount >= this.halfOpenMaxAttempts) {
        this.state = 'closed'
        this.failureCount = 0
      }
    } else {
      this.failureCount = 0
    }
  }

  private onFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open'
    }
  }

  getState(): CircuitState {
    return this.state
  }
}

// ============================================
// Legacy RateLimiter (inline, for BaseConnectorLegacy)
// ============================================

class InlineRateLimiter {
  private queue: Array<() => void> = []
  private running = 0
  private timestamps: number[] = []

  constructor(private config: RateLimiterConfig) {}

  async acquire(): Promise<void> {
    if (this.running >= this.config.max_concurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }

    const now = Date.now()
    this.timestamps = this.timestamps.filter((t) => now - t < this.config.window_ms)

    if (this.timestamps.length >= this.config.max_requests) {
      const waitUntil = this.timestamps[0] + this.config.window_ms
      await sleep(waitUntil - now)
    }

    const delay =
      this.config.min_delay_ms +
      Math.random() * (this.config.max_delay_ms - this.config.min_delay_ms)
    await sleep(delay)

    this.running++
    this.timestamps.push(Date.now())
  }

  release(): void {
    this.running--
    const next = this.queue.shift()
    if (next) next()
  }
}

// ============================================
// Base Connector (New - HTTP-based)
// ============================================

/**
 * Abstract base class for platform connectors.
 * Subclasses must implement the core data-fetching methods.
 */
export abstract class BaseConnector implements PlatformConnector {
  abstract readonly platform: LeaderboardPlatform
  abstract readonly marketType: MarketType
  abstract readonly capabilities: PlatformCapabilities

  protected config: ConnectorConfig
  protected rateLimiter: RateLimiter | null = null

  /**
   * Cockatiel policy for VPS requests: retry with exponential backoff + circuit breaker.
   * Shared across all connector instances — a global VPS health signal.
   */
  private static vpsPolicy = wrap(
    retry(handleAll, { maxAttempts: 2, backoff: new ExponentialBackoff({ initialDelay: 3000 }) }),
    circuitBreaker(handleAll, { halfOpenAfter: 60_000, breaker: new ConsecutiveBreaker(5) })
  )

  constructor(config?: Partial<ConnectorConfig>) {
    this.config = { ...DEFAULT_CONNECTOR_CONFIG, ...config }
    // Defer tier config application to first request (platform is abstract at construction)
    this._tierApplied = !!config?.timeout // Skip tier if timeout was explicitly provided
  }

  private _tierApplied: boolean

  /** Lazily apply tier-based config on first access */
  protected getConfig(): ConnectorConfig {
    if (!this._tierApplied) {
      this._tierApplied = true
      const tierConfig = getConnectorConfigForPlatform(this.platform)
      this.config = { ...this.config, timeout: tierConfig.timeout, maxRetries: tierConfig.maxRetries, retryBaseDelay: tierConfig.retryBaseDelay }
    }
    return this.config
  }

  /** Set the rate limiter for this connector */
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter
  }

  // ============================================
  // Abstract methods (must be implemented by subclass)
  // ============================================

  abstract discoverLeaderboard(
    window: Window,
    limit?: number,
    offset?: number
  ): Promise<DiscoverResult>

  abstract fetchTraderProfile(traderKey: string): Promise<ProfileResult | null>

  abstract fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null>

  abstract fetchTimeseries(traderKey: string): Promise<TimeseriesResult>

  abstract normalize(raw: unknown): Record<string, unknown>

  // ============================================
  // HTTP Request Helpers
  // ============================================

  /**
   * Make an HTTP request with retry, backoff, and rate limiting.
   */
  protected async request<T>(url: string, options?: RequestInit): Promise<T> {
    const cfg = this.getConfig()
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      // Rate limiting
      if (this.rateLimiter) {
        if (this.rateLimiter.isCircuitOpen()) {
          throw new ConnectorError(
            'Circuit breaker is open, platform temporarily unavailable',
            this.platform,
            this.marketType,
            503,
            false
          )
        }
        await this.rateLimiter.acquire()
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), cfg.timeout)

        // Proxy support: route through VPS proxy for geo-blocked APIs
        let response: Response
        if (this.config.proxyUrl) {
          // VPS proxy: POST with JSON body containing the target request
          // Parse body string back to object to avoid double-JSON-encoding
          let proxyBody: unknown = null
          if (options?.body) {
            try { proxyBody = typeof options.body === 'string' ? JSON.parse(options.body) : options.body }
            catch { proxyBody = options.body }
          }
          response = await fetch(this.config.proxyUrl, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'X-Proxy-Key': (process.env.VPS_PROXY_KEY || '').trim(),
            },
            body: JSON.stringify({
              url,
              method: options?.method || 'GET',
              headers: {
                'User-Agent': this.config.userAgent,
                Accept: 'application/json',
                ...this.config.headers,
                ...options?.headers,
              },
              body: proxyBody,
            }),
          })
        } else {
          response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
              'User-Agent': this.config.userAgent,
              Accept: 'application/json',
              ...this.config.headers,
              ...options?.headers,
            },
          })
        }

        clearTimeout(timeout)

        // WAF/CloudFlare detection: check content-type before parsing JSON
        const contentType = response.headers.get('content-type') || ''
        if (response.ok && !contentType.includes('application/json')) {
          this.rateLimiter?.recordFailure()
          throw new ConnectorError(
            `WAF/CloudFlare block detected: expected JSON but got ${contentType}`,
            this.platform,
            this.marketType,
            response.status,
            true // retryable — may succeed after backoff
          )
        }

        // Rate limited
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10)
          this.rateLimiter?.recordFailure()
          throw new ConnectorError(
            `Rate limited, retry after ${retryAfter}s`,
            this.platform,
            this.marketType,
            429,
            true,
            retryAfter
          )
        }

        // Server error
        if (response.status >= 500) {
          this.rateLimiter?.recordFailure()
          throw new ConnectorError(
            `Server error: ${response.status}`,
            this.platform,
            this.marketType,
            response.status
          )
        }

        // Client error (not retryable)
        if (response.status >= 400) {
          throw new ConnectorError(
            `Client error: ${response.status}`,
            this.platform,
            this.marketType,
            response.status
          )
        }

        this.rateLimiter?.recordSuccess()
        this.rateLimiter?.release()

        const data = (await response.json()) as T
        return data
      } catch (error) {
        this.rateLimiter?.release()

        if (
          error instanceof ConnectorError &&
          !error.isRateLimited &&
          (error.statusCode ?? 0) < 500
        ) {
          throw error // Non-retryable errors
        }

        lastError = toError(error)

        // Exponential backoff
        if (attempt < cfg.maxRetries) {
          const delay = cfg.retryBaseDelay * Math.pow(2, attempt)
          const jitter = Math.random() * 1000
          await this.sleep(delay + jitter)
        }
      }
    }

    // NOTE: Auto-fallback via VPS removed — connectors that need VPS have explicit
    // try/catch with fetchViaVPS() or proxyViaVPS() in their discoverLeaderboard().
    // Smart routing in request() interfered by returning WAF HTML as "success",
    // preventing connectors from reaching their own VPS fallback logic.

    throw lastError || new ConnectorError('Max retries exceeded', this.platform, this.marketType)
  }

  /**
   * Fetch via VPS Scraper
   * 
   * @param endpoint - VPS endpoint path (e.g., '/bingx/leaderboard')
   * @param params - Query parameters
   * @param timeoutMs - Request timeout (default: 120000ms = 2min)
   * @returns Response data or null if failed
   */
  protected async fetchViaVPS<T = unknown>(
    endpoint: string,
    params: Record<string, string | number> = {},
    timeoutMs = 120000
  ): Promise<T | null> {
    // Use scraper port (3457) for named endpoints, proxy port (3456) as fallback
    const vpsHost = process.env.VPS_SCRAPER_SG || process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_SCRAPER_HOST;
    const vpsKey = process.env.VPS_PROXY_KEY?.trim();

    if (!vpsHost || !vpsKey) {
      return null; // VPS not configured, return null to allow fallback
    }

    // Check scraper result cache to avoid hammering the serial queue
    const paramsHash = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const cacheKey = `scraper:cache:${this.platform}:${endpoint}:${paramsHash}`
    try {
      const cached = await cache.get<T>(cacheKey)
      if (cached !== null) {
        exchangeLogger.info(`[VPS] ${this.platform} cache hit for ${endpoint}`)
        return cached
      }
    } catch {
      // Cache read failed, proceed to scraper
    }

    const queryString = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();

    const rawScraperSg = (process.env.VPS_SCRAPER_SG || '').replace(/\\n$/, '').trim()
    const scraperHost = rawScraperSg || vpsHost.replace(':3456', ':3457');
    const scraperUrl = `${scraperHost}${endpoint}${queryString ? `?${queryString}` : ''}`;
    const proxyHost = (process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || vpsHost).replace(':3457', ':3456');
    const localScraperUrl = `http://localhost:3457${endpoint}${queryString ? `?${queryString}` : ''}`;

    // Use cockatiel policy: retry with exponential backoff + circuit breaker
    try {
      const data = await BaseConnector.vpsPolicy.execute(async () => {
        // Strategy 1: Direct to scraper port 3457
        let response: Response | null = null;
        try {
          response = await fetch(scraperUrl, {
            method: 'GET',
            headers: { 'X-Proxy-Key': vpsKey, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          // Port 3457 might be firewalled from Vercel — try routing through proxy
        }

        // Strategy 2: Route through proxy (3456) → scraper (localhost:3457)
        if (!response || !response.ok) {
          response = await fetch(proxyHost, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Proxy-Key': vpsKey,
            },
            body: JSON.stringify({
              url: localScraperUrl,
              method: 'GET',
              headers: { 'X-Proxy-Key': vpsKey },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        }

        if (!response?.ok) {
          throw new Error(`VPS returned ${response?.status ?? 'no response'}`);
        }

        return await response.json() as T;
      });

      // Cache successful scraper result for 90 min
      const dataObj = data as Record<string, unknown>
      if (!dataObj?.error) {
        cache.set(cacheKey, data, { ttl: 90 * 60 }).catch(() => {})
      }
      return data;
    } catch (error) {
      if (error instanceof BrokenCircuitError) {
        exchangeLogger.warn(`[VPS] ${this.platform} circuit breaker open, skipping ${endpoint}`)
      } else {
        exchangeLogger.warn(`[VPS] ${this.platform} failed for ${endpoint}: ${toError(error).message}`)
      }
      return null;
    }
  }

  /**
   * Forward an arbitrary request through the VPS proxy.
   * Unlike fetchViaVPS which constructs a URL from endpoint+params,
   * this accepts a full URL and optional method/body/headers.
   */
  protected async proxyViaVPS<T = unknown>(
    targetUrl: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    timeoutMs = 120000
  ): Promise<T | null> {
    const vpsHost = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_SCRAPER_HOST;
    const vpsKey = process.env.VPS_PROXY_KEY?.trim();

    if (!vpsHost || !vpsKey) return null;

    try {
      const proxyBody: Record<string, unknown> = {
        url: targetUrl,
        method: options.method || 'GET',
      };
      if (options.body) {
        proxyBody.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }
      if (options.headers) {
        proxyBody.headers = options.headers;
      }

      const response = await fetch(`${vpsHost}/proxy`, {
        method: 'POST',
        headers: {
          'X-Proxy-Key': vpsKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(proxyBody),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        console.warn(`[VPS-proxy] ${this.platform} returned ${response.status}`);
        return null;
      }

      return await response.json() as T;
    } catch (error) {
      console.warn(`[VPS-proxy] ${this.platform} failed:`, toError(error).message);
      return null;
    }
  }

  // ============================================
  // Smart Routing
  // ============================================

  /**
   * Fetch a URL using the smart route configuration for this platform.
   * Tries routes in priority order with automatic failover.
   *
   * Unlike `request()` which uses a single proxyUrl from config,
   * this method consults PLATFORM_ROUTES for ordered fallback routes.
   *
   * @param url - Target API URL
   * @param options - Fetch options (method, headers, body)
   * @param timeoutMs - Per-route timeout (default: 15s)
   * @returns Parsed JSON response
   * @throws Error if all routes fail
   */
  protected async fetchWithSmartRoute<T>(
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: unknown },
    timeoutMs = 15000
  ): Promise<T> {
    const routeModule = await import('./route-config')
    const config = routeModule.getRouteConfig(this.platform)
    const errors: string[] = []

    for (const route of config.routes) {
      try {
        const result = await this.executeRoute<T>(route, url, options, timeoutMs)
        if (result !== null) {
          return result
        }
        errors.push(`${route}: null response`)
      } catch (e) {
        errors.push(`${route}: ${toError(e).message.substring(0, 80)}`)
      }
    }

    throw new ConnectorError(
      `All routes failed for ${url}: ${errors.join(' | ')}`,
      this.platform,
      this.marketType
    )
  }

  /**
   * Execute a single route attempt.
   */
  private async executeRoute<T>(
    route: string,
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: unknown },
    timeoutMs = 15000
  ): Promise<T | null> {
    const { resolveRouteUrl, resolveRouteKey } = await import('./route-config')
    const method = options?.method || 'GET'

    if (route === 'direct') {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': this.config.userAgent,
            Accept: 'application/json',
            ...options?.headers,
          },
          body: options?.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json() as T
      } finally {
        clearTimeout(timeout)
      }
    }

    // Proxy routes: vps_sg, vps_jp, scraper_sg, mac_mini
    const proxyUrl = resolveRouteUrl(route as RouteType)
    const proxyKey = resolveRouteKey(route as RouteType)
    if (!proxyUrl) return null // Route not configured

    // For scraper routes, use named endpoints if available
    if (route === 'scraper_sg') {
      // Scraper endpoints are on the same host as the proxy
      // But we still use /proxy for generic forwarding
      // Named endpoints like /bybit/leaderboard are handled by connectors directly
    }

    const proxyBody: Record<string, unknown> = {
      url,
      method,
      headers: {
        'User-Agent': this.config.userAgent,
        Accept: 'application/json',
        ...options?.headers,
      },
    }
    if (options?.body) proxyBody.body = options.body

    const res = await fetch(`${proxyUrl}/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Key': proxyKey,
      },
      body: JSON.stringify(proxyBody),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) throw new Error(`Proxy ${route} returned ${res.status}`)
    return await res.json() as T
  }

  // ============================================
  // Quality Flag Helpers
  // ============================================

  /**
   * Build quality flags based on available metrics.
   */
  protected buildQualityFlags(
    metrics: Partial<SnapshotMetrics>,
    window: Window,
    isNativeWindow: boolean
  ): QualityFlags {
    const missingFields: string[] = []
    const nonStandardFields: Record<string, string> = {}

    if (metrics.roi === null || metrics.roi === undefined) missingFields.push('roi')
    if (metrics.pnl === null || metrics.pnl === undefined) missingFields.push('pnl')
    if (metrics.win_rate === null || metrics.win_rate === undefined) missingFields.push('win_rate')
    if (metrics.max_drawdown === null || metrics.max_drawdown === undefined)
      missingFields.push('max_drawdown')
    if (metrics.trades_count === null || metrics.trades_count === undefined)
      missingFields.push('trades_count')
    if (metrics.followers === null || metrics.followers === undefined)
      missingFields.push('followers')
    if (metrics.copiers === null || metrics.copiers === undefined) missingFields.push('copiers')

    const notes: string[] = []
    if (!isNativeWindow) {
      notes.push(`Window ${window} is not natively provided by ${this.platform}`)
    }

    return {
      missing_fields: missingFields,
      non_standard_fields: nonStandardFields,
      window_native: isNativeWindow,
      notes,
    }
  }

  /**
   * Build provenance information.
   */
  protected buildProvenance(
    sourceUrl: string | null,
    method: 'api' | 'scrape' | 'derived' | 'enrichment' = 'api'
  ): DataProvenance {
    return {
      source_platform: this.platform,
      acquisition_method: method,
      fetched_at: new Date().toISOString(),
      source_url: sourceUrl,
      scraper_version: '2.0.0',
    }
  }

  /**
   * Check if a window is natively supported by this platform.
   */
  protected isNativeWindow(window: Window): boolean {
    return this.capabilities.native_windows.includes(window)
  }

  /**
   * Map a window to the platform's equivalent.
   * Returns null if no mapping exists.
   */
  protected mapWindowToPlatform(window: Window): string | null {
    const mappings: Record<Window, string> = {
      '7d': 'WEEKLY',
      '30d': 'MONTHLY',
      '90d': 'QUARTERLY',
    }
    return mappings[window] || null
  }

  // ============================================
  // Utility Methods
  // ============================================

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Create an empty SnapshotMetrics with all null values.
   */
  protected emptyMetrics(): SnapshotMetrics {
    return {
      roi: null,
      pnl: null,
      win_rate: null,
      max_drawdown: null,
      sharpe_ratio: null,
      sortino_ratio: null,
      trades_count: null,
      followers: null,
      copiers: null,
      aum: null,
      platform_rank: null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
    }
  }

  /**
   * Generate the date bucket for idempotent writes.
   * Truncates to the current hour.
   */
  protected getDateBucket(): string {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    return now.toISOString()
  }
}

// ============================================
// Legacy Base Connector (with inline rate limiter)
// ============================================

/**
 * Legacy BaseConnector that uses inline rate limiter and circuit breaker.
 * Kept for backward compatibility with existing connectors.
 */
export abstract class BaseConnectorLegacy {
  abstract readonly platform: GranularPlatform

  protected inlineRateLimiter: InlineRateLimiter
  protected circuitBreaker: CircuitBreaker

  constructor(rateLimitOverride?: Partial<RateLimiterConfig>) {
    this.inlineRateLimiter = null as unknown as InlineRateLimiter
    this.circuitBreaker = new CircuitBreaker()

    if (rateLimitOverride) {
      this._rateLimitOverride = rateLimitOverride
    }
  }

  private _rateLimitOverride?: Partial<RateLimiterConfig>

  /** Must be called after construction to initialize rate limiter */
  protected init(): void {
    const config = {
      ...PLATFORM_RATE_LIMITS[this.platform],
      ...this._rateLimitOverride,
    }
    this.inlineRateLimiter = new InlineRateLimiter(config)
  }

  /**
   * Execute a request with rate limiting, circuit breaker, and retry.
   */
  protected async requestWithCircuitBreaker<T>(
    fn: () => Promise<T>,
    options: { retries?: number; label?: string } = {}
  ): Promise<T> {
    const { retries = 3, label = 'request' } = options

    return this.circuitBreaker.execute(async () => {
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await this.inlineRateLimiter.acquire()
          try {
            return await fn()
          } finally {
            this.inlineRateLimiter.release()
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          if (attempt < retries) {
            const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 1000
            exchangeLogger.warn(
              `[${this.platform}] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(backoff)}ms: ${lastError.message}`
            )
            await sleep(backoff)
          }
        }
      }

      throw new Error(
        `[${this.platform}] ${label} failed after ${retries + 1} attempts: ${lastError?.message}`
      )
    })
  }

  /**
   * Build a SnapshotQuality object from available metrics.
   */
  protected buildQuality<T extends object>(metrics: T): {
    is_complete: boolean
    missing_fields: string[]
    confidence: number
    is_interpolated: boolean
  } {
    const metricsRecord = metrics as unknown as Record<string, unknown>
    const allFields = Object.keys(metricsRecord)
    const missingFields = allFields.filter((f) => metricsRecord[f] === null || metricsRecord[f] === undefined)
    const totalFields = allFields.length
    const presentFields = totalFields - missingFields.length

    return {
      is_complete: missingFields.length === 0,
      missing_fields: missingFields,
      confidence: totalFields > 0 ? presentFields / totalFields : 0,
      is_interpolated: false,
    }
  }

  /**
   * Generate the date bucket for idempotent writes.
   */
  protected getDateBucket(): string {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    return now.toISOString()
  }
}

// ============================================
// Utility
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
