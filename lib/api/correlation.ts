/**
 * Correlation ID system for request tracing
 * Uses AsyncLocalStorage to propagate correlation IDs through async call chains.
 *
 * Safe for Edge/Client bundles: AsyncLocalStorage is only loaded on Node.js.
 */

import { NextRequest } from 'next/server'

// ============================================
// AsyncLocalStorage context (Node.js only)
// ============================================

// Dynamic import to prevent Turbopack from bundling node:async_hooks in Client/Edge
let correlationStore: { getStore(): string | undefined; run<T>(id: string, fn: () => T): T } | null = null
if (typeof globalThis.process !== 'undefined' && typeof globalThis.process.versions?.node === 'string') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AsyncLocalStorage } = require('node:async_hooks')
    correlationStore = new AsyncLocalStorage()
  } catch (_err) {
    // AsyncLocalStorage unavailable in Edge Runtime — correlation IDs disabled
  }
}

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
 * Returns undefined if called outside of a correlation context or in Edge/Client.
 */
export function getCorrelationId(): string | undefined {
  return correlationStore?.getStore()
}

/**
 * Run a callback within a correlation ID context.
 * All code (including async continuations) executed inside `fn`
 * will be able to retrieve the ID via `getCorrelationId()`.
 * Falls back to direct execution if AsyncLocalStorage is unavailable.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  if (!correlationStore) return fn()
  return correlationStore.run(correlationId, fn)
}
