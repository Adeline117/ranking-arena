/**
 * Correlation ID system for request tracing
 * Uses AsyncLocalStorage to propagate correlation IDs through async call chains
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { NextRequest } from 'next/server'

// ============================================
// AsyncLocalStorage context
// ============================================

const correlationStore = new AsyncLocalStorage<string>()

// ============================================
// ID Generation
// ============================================

/**
 * Generate a short unique ID suitable for correlation tracking.
 * Prefers crypto.randomUUID() when available, falls back to timestamp + random.
 */
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback: timestamp-based short ID
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

// ============================================
// Public API
// ============================================

/**
 * Extract an existing correlation ID from request headers, or generate a new one.
 * Checks X-Correlation-ID and X-Request-ID headers (in that order).
 */
export function getOrCreateCorrelationId(request: NextRequest): string {
  const existing =
    request.headers.get('x-correlation-id') ??
    request.headers.get('x-request-id')

  return existing || generateId()
}

/**
 * Retrieve the correlation ID for the current async context.
 * Returns undefined if called outside of a correlation context.
 */
export function getCorrelationId(): string | undefined {
  return correlationStore.getStore()
}

/**
 * Run a callback within a correlation ID context.
 * All code (including async continuations) executed inside `fn`
 * will be able to retrieve the ID via `getCorrelationId()`.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStore.run(correlationId, fn)
}
