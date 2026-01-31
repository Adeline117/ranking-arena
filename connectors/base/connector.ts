/**
 * Base connector class with shared utilities
 * All platform connectors extend this class
 */

import type {
  IConnector,
  Platform,
  MarketType,
  Window,
  ConnectorResult,
  LeaderboardEntry,
  CanonicalProfile,
  CanonicalSnapshot,
  CanonicalTimeseries,
  SnapshotMetrics,
  QualityFlags,
  Provenance,
  RateLimitHint,
} from './types';

const CONNECTOR_VERSION = '1.0.0';

export abstract class BaseConnector implements IConnector {
  abstract platform: Platform;
  abstract market_type: MarketType;

  protected rate_limit: RateLimitHint = { rpm: 30, concurrent: 2, delay_ms: 2000 };
  protected last_request_at = 0;

  // User-Agent rotation pool
  protected static USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ];

  abstract discoverLeaderboard(window: Window, limit?: number): Promise<ConnectorResult<LeaderboardEntry[]>>;
  abstract fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>>;
  abstract fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>>;
  abstract fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>>;
  abstract normalize(raw: Record<string, unknown>, field_map?: Record<string, string>): Partial<SnapshotMetrics>;

  // ============================================
  // HTTP Utilities
  // ============================================

  protected async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    retries = 3,
    backoff = 1000
  ): Promise<Response> {
    await this.enforceRateLimit();

    const proxyUrl = process.env.CLOUDFLARE_PROXY_URL;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const headers: Record<string, string> = {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'application/json',
          ...(options.headers as Record<string, string> || {}),
        };

        const response = await fetch(url, {
          ...options,
          headers,
          signal: AbortSignal.timeout(30000), // 30s timeout
        });

        // If region-blocked (451) and proxy available, retry via proxy
        if (response.status === 451 && proxyUrl) {
          const proxiedUrl = `${proxyUrl}/proxy?url=${encodeURIComponent(url)}`;
          const proxyResponse = await fetch(proxiedUrl, {
            ...options,
            headers,
            signal: AbortSignal.timeout(30000),
          });
          if (proxyResponse.ok) {
            this.last_request_at = Date.now();
            return proxyResponse;
          }
        }

        if (response.ok) {
          this.last_request_at = Date.now();
          return response;
        }

        // Rate limited
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '5');
          await this.sleep(retryAfter * 1000);
          continue;
        }

        // Server error - retry
        if (response.status >= 500 && attempt < retries) {
          await this.sleep(backoff * Math.pow(2, attempt));
          continue;
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      } catch (error) {
        // On timeout/network error, try proxy as fallback
        if (proxyUrl && attempt < retries) {
          try {
            const proxiedUrl = `${proxyUrl}/proxy?url=${encodeURIComponent(url)}`;
            const headers: Record<string, string> = {
              'User-Agent': this.getRandomUserAgent(),
              'Accept': 'application/json',
              ...(options.headers as Record<string, string> || {}),
            };
            const proxyResponse = await fetch(proxiedUrl, {
              ...options,
              headers,
              signal: AbortSignal.timeout(30000),
            });
            if (proxyResponse.ok) {
              this.last_request_at = Date.now();
              return proxyResponse;
            }
          } catch {
            // Proxy also failed, continue retry loop
          }
        }
        if (attempt === retries) throw error;
        await this.sleep(backoff * Math.pow(2, attempt));
      }
    }

    throw new Error('Max retries exceeded');
  }

  protected async fetchJSON<T = unknown>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await this.fetchWithRetry(url, options);
    return response.json() as Promise<T>;
  }

  protected async postJSON<T = unknown>(
    url: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    return this.fetchJSON<T>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  // ============================================
  // Rate Limiting
  // ============================================

  protected async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.last_request_at;
    const minInterval = this.rate_limit.delay_ms;

    if (elapsed < minInterval) {
      await this.sleep(minInterval - elapsed);
    }
  }

  // ============================================
  // Result Builders
  // ============================================

  protected success<T>(data: T, provenance: Partial<Provenance> = {}, quality_flags: QualityFlags = {}): ConnectorResult<T> {
    return {
      success: true,
      data,
      quality_flags,
      provenance: {
        fetched_at: new Date().toISOString(),
        connector_version: CONNECTOR_VERSION,
        ...provenance,
      },
    };
  }

  protected failure<T>(error: string, provenance: Partial<Provenance> = {}): ConnectorResult<T> {
    return {
      success: false,
      data: null,
      error,
      quality_flags: { reason: error },
      provenance: {
        fetched_at: new Date().toISOString(),
        connector_version: CONNECTOR_VERSION,
        ...provenance,
      },
    };
  }

  protected buildProvenance(source_url: string, extras: Partial<Provenance> = {}): Provenance {
    return {
      source_url,
      fetched_at: new Date().toISOString(),
      connector_version: CONNECTOR_VERSION,
      ...extras,
    };
  }

  protected buildQualityFlags(metrics: Partial<SnapshotMetrics>): QualityFlags {
    const flags: QualityFlags = {};
    if (metrics.roi_pct == null) flags.missing_roi = true;
    if (metrics.pnl_usd == null) flags.missing_pnl = true;
    if (metrics.max_drawdown == null) flags.missing_drawdown = true;
    if (metrics.win_rate == null) flags.missing_win_rate = true;
    if (metrics.sharpe_ratio == null) flags.missing_sharpe = true;
    if (metrics.trades_count == null) flags.missing_trades_count = true;
    return flags;
  }

  // ============================================
  // Normalization Helpers
  // ============================================

  protected parseNumber(value: unknown): number | null {
    if (value == null || value === '' || value === 'N/A') return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  protected parsePercentage(value: unknown): number | null {
    if (value == null || value === '') return null;
    const num = Number(value);
    if (isNaN(num)) return null;
    // If value is already in percentage form (e.g., 85.5)
    if (Math.abs(num) > 10) return num;
    // If value is in decimal form (e.g., 0.855)
    return num * 100;
  }

  protected windowToApiParam(window: Window): string {
    switch (window) {
      case '7d': return '7';
      case '30d': return '30';
      case '90d': return '90';
    }
  }

  // ============================================
  // Utilities
  // ============================================

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected getRandomUserAgent(): string {
    return BaseConnector.USER_AGENTS[Math.floor(Math.random() * BaseConnector.USER_AGENTS.length)];
  }

  protected getRandomDelay(min = 2000, max = 5000): number {
    return Math.floor(Math.random() * (max - min) + min);
  }
}
