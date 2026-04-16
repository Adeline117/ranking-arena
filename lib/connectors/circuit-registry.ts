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

type AnyPolicy = IPolicy<any, any>

/** Per-platform policy instances */
const platformPolicies = new Map<string, AnyPolicy>()

/** Track circuit breaker states explicitly (cockatiel doesn't expose state) */
const circuitStates = new Map<string, 'closed' | 'open' | 'half_open'>()

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

  // Track state transitions for API layer visibility
  breakerPolicy.onBreak(() => {
    circuitStates.set(platform, 'open')
    exchangeLogger.warn(`[CircuitRegistry] Circuit OPENED for ${platform}`)
  })
  breakerPolicy.onHalfOpen(() => {
    circuitStates.set(platform, 'half_open')
    exchangeLogger.info(`[CircuitRegistry] Circuit half-open for ${platform}`)
  })
  breakerPolicy.onReset(() => {
    circuitStates.set(platform, 'closed')
    exchangeLogger.info(`[CircuitRegistry] Circuit CLOSED for ${platform}`)
  })

  const policy: AnyPolicy = wrap(retryPolicy, breakerPolicy)
  circuitStates.set(platform, 'closed')

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
  circuitStates.delete(platform)
  exchangeLogger.info(`[CircuitRegistry] Reset circuit for ${platform}`)
}

/**
 * Get all registered platform names.
 */
export function getRegisteredPlatforms(): string[] {
  return Array.from(platformPolicies.keys())
}

/**
 * Check if a platform's circuit is currently open (broken).
 * Returns true if the circuit is open and requests should not be attempted.
 * API routes should check this before making connector calls to return 503 early.
 */
export function isCircuitOpen(platform: string): boolean {
  return circuitStates.get(platform) === 'open'
}

/**
 * Get circuit breaker states for all registered platforms.
 * Useful for health check endpoints and monitoring dashboards.
 */
export function getCircuitStates(): Record<string, 'closed' | 'open' | 'half_open'> {
  const states: Record<string, 'closed' | 'open' | 'half_open'> = {}
  for (const [platform, state] of circuitStates.entries()) {
    states[platform] = state
  }
  return states
}
