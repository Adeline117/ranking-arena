/**
 * Per-platform rate limiter
 * Ensures we don't exceed platform-specific request limits
 */

export interface RateLimiterConfig {
  rpm: number;       // Requests per minute
  concurrent: number; // Max concurrent requests
}

export class RateLimiter {
  private readonly name: string;
  private readonly config: RateLimiterConfig;
  private requestTimes: number[] = [];
  private activeRequests = 0;

  constructor(name: string, config: Partial<RateLimiterConfig> = {}) {
    this.name = name;
    this.config = {
      rpm: config.rpm ?? 15,
      concurrent: config.concurrent ?? 2,
    };
  }

  async waitForSlot(): Promise<void> {
    // Wait for concurrent slot
    while (this.activeRequests >= this.config.concurrent) {
      await this.sleep(100);
    }

    // Wait for RPM limit
    const now = Date.now();
    const windowStart = now - 60000;

    // Clean old entries
    this.requestTimes = this.requestTimes.filter(t => t > windowStart);

    if (this.requestTimes.length >= this.config.rpm) {
      const oldestInWindow = this.requestTimes[0];
      const waitTime = oldestInWindow + 60000 - now + 100;
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
    }

    this.requestTimes.push(Date.now());
    this.activeRequests++;
  }

  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  getStatus(): { rpm_used: number; active: number; rpm_limit: number; concurrent_limit: number } {
    const now = Date.now();
    const recentRequests = this.requestTimes.filter(t => t > now - 60000).length;
    return {
      rpm_used: recentRequests,
      active: this.activeRequests,
      rpm_limit: this.config.rpm,
      concurrent_limit: this.config.concurrent,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
