/**
 * Interaction tracking utility.
 *
 * Inspired by PostHog (32K★) event batching patterns:
 * - Fire-and-forget with per-session deduplication
 * - Batch events into a queue and flush periodically (reduces network calls)
 * - Use `fetch(..., { keepalive: true })` for delivery that survives page unload
 *
 * Why keepalive fetch instead of sendBeacon: the tracking endpoints require an
 * `Authorization: Bearer` header (auth lives in localStorage, not cookies) AND
 * an `x-csrf-token` header (proxy.ts CSRF check). sendBeacon cannot set headers,
 * so every beacon was rejected with 403/401. keepalive fetch has the same
 * survives-unload guarantee but CAN carry headers.
 */

import { getCsrfHeaders } from '@/lib/api/client'
import { getLocalAccessToken, hasLocalSession } from '@/lib/auth/local-session'

export { hasLocalSession } from '@/lib/auth/local-session'

type InteractionEvent = {
  action: string
  target_type: string
  target_id: string
  metadata?: Record<string, string | number>
}

const tracked = new Set<string>()
const eventQueue: InteractionEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_INTERVAL = 5000 // Batch flush every 5s (PostHog pattern)
const MAX_QUEUE_SIZE = 20

/**
 * Fire-and-forget authenticated tracking POST. Never throws, never blocks UI.
 *
 * Uses `keepalive: true` so the request survives page unload (the reason
 * sendBeacon was used before), while still carrying the Authorization and
 * CSRF headers that sendBeacon cannot set. Silently no-ops for anonymous
 * visitors — the tracking endpoints are auth-required.
 */
export function sendTrackingEvent(url: string, payload: unknown): void {
  const token = getLocalAccessToken()
  if (!token) return
  try {
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...getCsrfHeaders(),
      },
      body: JSON.stringify(payload),
      keepalive: true, // survives page unload, like sendBeacon (body well under the 64KB keepalive cap)
    }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget tracking, client-side
  } catch {
    // fire-and-forget — tracking must never break the page
  }
}

function dedupKey(event: InteractionEvent): string {
  return `${event.action}:${event.target_type}:${event.target_id}`
}

function flushQueue(): void {
  if (eventQueue.length === 0) return
  const batch = eventQueue.splice(0, eventQueue.length)

  // /api/interactions requires auth — drop silently for anonymous
  // visitors instead of firing a request that 401/403s in the console.
  if (!hasLocalSession()) return

  // Batch format accepted by app/api/interactions/route.ts ({ events: [...] })
  sendTrackingEvent('/api/interactions', { events: batch })
}

export function trackInteraction(event: InteractionEvent): void {
  const key = dedupKey(event)
  if (tracked.has(key)) return
  tracked.add(key)

  eventQueue.push(event)

  // Flush immediately if queue is full
  if (eventQueue.length >= MAX_QUEUE_SIZE) {
    flushQueue()
    return
  }

  // Otherwise schedule batch flush
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushQueue()
    }, FLUSH_INTERVAL)
  }
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushQueue()
  })
}
