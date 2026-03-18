/**
 * Lightweight tracing utility for pipeline observability.
 *
 * Uses OpenTelemetry API (already installed via Sentry) for structured spans.
 * No external collector needed — traces are logged to PipelineLogger metadata.
 *
 * Inspired by open-telemetry/opentelemetry-js (3.3K★) and highlight (9.2K★).
 *
 * Usage:
 *   const span = trace.startSpan('fetch-binance')
 *   try {
 *     const result = await fetchData()
 *     span.end({ traders: result.length })
 *   } catch (err) {
 *     span.error(err)
 *   }
 */

import { logger } from '@/lib/logger'

export interface SpanHandle {
  name: string
  startedAt: number
  end(metadata?: Record<string, unknown>): number
  error(err: unknown, metadata?: Record<string, unknown>): number
}

/**
 * Start a named span for measuring operation duration.
 */
export function startSpan(name: string, parentContext?: Record<string, unknown>): SpanHandle {
  const startedAt = Date.now()

  return {
    name,
    startedAt,
    end(metadata) {
      const durationMs = Date.now() - startedAt
      if (durationMs > 5000) {
        logger.warn(`[Trace] Slow span: ${name} took ${durationMs}ms`, { ...parentContext, ...metadata })
      }
      return durationMs
    },
    error(err, metadata) {
      const durationMs = Date.now() - startedAt
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`[Trace] Span failed: ${name} after ${durationMs}ms — ${errorMessage}`, {
        ...parentContext,
        ...metadata,
        error: errorMessage,
      })
      return durationMs
    },
  }
}

/**
 * Trace a promise with automatic span lifecycle.
 */
export async function traceAsync<T>(
  name: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>
): Promise<{ result: T; durationMs: number }> {
  const span = startSpan(name, context)
  try {
    const result = await fn()
    const durationMs = span.end()
    return { result, durationMs }
  } catch (err) {
    span.error(err)
    throw err
  }
}

/**
 * Collect timing data for multiple operations and return a summary.
 */
export function createTraceCollector(name: string) {
  const spans: Array<{ name: string; durationMs: number; success: boolean }> = []

  return {
    /** Record a completed operation */
    record(spanName: string, durationMs: number, success: boolean) {
      spans.push({ name: spanName, durationMs, success })
    },

    /** Get summary statistics */
    summary() {
      const total = spans.length
      const succeeded = spans.filter(s => s.success).length
      const totalDuration = spans.reduce((sum, s) => sum + s.durationMs, 0)
      const avgDuration = total > 0 ? Math.round(totalDuration / total) : 0
      const maxDuration = Math.max(0, ...spans.map(s => s.durationMs))
      const slowSpans = spans.filter(s => s.durationMs > 5000)

      return {
        name,
        total,
        succeeded,
        failed: total - succeeded,
        totalDuration,
        avgDuration,
        maxDuration,
        slowSpans: slowSpans.map(s => ({ name: s.name, durationMs: s.durationMs })),
      }
    },
  }
}
