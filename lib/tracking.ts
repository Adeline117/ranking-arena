/**
 * Interaction tracking utility.
 *
 * Inspired by PostHog (32K★) event batching patterns:
 * - Fire-and-forget with per-session deduplication
 * - Batch events into a queue and flush periodically (reduces network calls)
 * - Use sendBeacon on page unload for reliable delivery
 */

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

function dedupKey(event: InteractionEvent): string {
  return `${event.action}:${event.target_type}:${event.target_id}`
}

function flushQueue(): void {
  if (eventQueue.length === 0) return
  const batch = eventQueue.splice(0, eventQueue.length)
  const body = JSON.stringify({ events: batch })

  // Use sendBeacon for reliability (survives page close)
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const sent = navigator.sendBeacon('/api/interactions/batch', body)
    if (sent) return
  }

  // Fallback to fetch with keepalive
  fetch('/api/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch[0]), // Fallback: send first event only
    keepalive: true,
  }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget tracking, client-side
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
