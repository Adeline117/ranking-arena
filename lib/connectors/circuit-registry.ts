/**
 * Per-platform circuit breaker registry.
 *
 * Each platform gets an independent circuit breaker instance.
 * One platform failing doesn't affect others.
 *
 * Replaces the global static BaseConnector.vpsPolicy which
 * caused all VPS-dependent platforms to break when one failed.
 */

import {
  retry,
  circuitBreaker,
  handleAll,
  wrap,
  ExponentialBackoff,
  ConsecutiveBreaker,
  BrokenCircuitError,
  type IPolicy,
} from 'cockatiel'
import { exchangeLogger } from '../utils/logger'

export { BrokenCircuitError }

interface CircuitConfig {
  /** Max retry attempts (default: 3) */
  maxAttempts: number
  /** Initial retry delay in ms (default: 1000) */
  initialDelay: number
  /** Consecutive failures to open circuit (default: 5) */
  breakerThreshold: number
  /** Time in ms before half-open attempt (default: 30 * 60 * 1000 = 30min) */
  halfOpenAfter: number
}

const DEFAULT_CONFIG: CircuitConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  breakerThreshold: 5,
  halfOpenAfter: 30 * 60 * 1000, // 30 minutes
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPolicy = IPolicy<any, any>

/** Per-platform policy instances */
const platformPolicies = new Map<string, AnyPolicy>()

/**
 * Get or create a circuit breaker policy for a specific platform.
 * Each platform has its own independent retry + circuit breaker.
 */
export function getPlatformPolicy(platform: string, config?: Partial<CircuitConfig>): AnyPolicy {
  const existing = platformPolicies.get(platform)
  if (existing) return existing

  const cfg = { ...DEFAULT_CONFIG, ...config }

  const retryPolicy = retry(handleAll, {
    maxAttempts: cfg.maxAttempts,
    backoff: new ExponentialBackoff({ initialDelay: cfg.initialDelay }),
  })

  const breakerPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: cfg.halfOpenAfter,
    breaker: new ConsecutiveBreaker(cfg.breakerThreshold),
  })

  const policy: AnyPolicy = wrap(retryPolicy, breakerPolicy)

  exchangeLogger.info(
    `[CircuitRegistry] Created policy for ${platform}: maxAttempts=${cfg.maxAttempts}, breakerThreshold=${cfg.breakerThreshold}, halfOpenAfter=${cfg.halfOpenAfter}ms`
  )

  platformPolicies.set(platform, policy)
  return policy
}

/**
 * Reset a platform's circuit breaker (e.g., after manual recovery).
 * Next call to getPlatformPolicy will create a fresh instance.
 */
export function resetCircuit(platform: string): void {
  platformPolicies.delete(platform)
  exchangeLogger.info(`[CircuitRegistry] Reset circuit for ${platform}`)
}

/**
 * Get all registered platform names.
 */
export function getRegisteredPlatforms(): string[] {
  return Array.from(platformPolicies.keys())
}
