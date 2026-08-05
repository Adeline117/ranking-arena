/**
 * Correlation ID system for request tracing
 * Uses AsyncLocalStorage to propagate correlation IDs through async call chains.
 *
 * Safe for Node and Edge routes; client-capable consumers use a neutral bridge.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextRequest } from 'next/server'
import { installCorrelationIdReader, readCorrelationId } from '@/lib/telemetry/correlation-context'

// ============================================
// AsyncLocalStorage context (Node.js only)
// ============================================

// Next.js supplies an AsyncLocalStorage polyfill in Edge Runtime. This module
// is route-only; browser-capable consumers never import it directly.
const correlationStore = new AsyncLocalStorage<string>()

// Publish the Node-owned context through a runtime-neutral bridge. Client and
// Edge-capable consumers never import or dynamically resolve this module.
installCorrelationIdReader(() => correlationStore.getStore())

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
  const existing = request.headers.get('x-correlation-id') ?? request.headers.get('x-request-id')

  return existing || generateId()
}

/**
 * Retrieve the correlation ID for the current async context.
 * Returns undefined if called outside of a correlation context or in Edge/Client.
 */
export function getCorrelationId(): string | undefined {
  return readCorrelationId()
}

/**
 * Run a callback within a correlation ID context.
 * All code (including async continuations) executed inside `fn`
 * will be able to retrieve the ID via `getCorrelationId()`.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStore.run(correlationId, fn)
}
