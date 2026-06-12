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

// Matches `storageKey` in lib/supabase/client.ts — Supabase persists the session here.
// Cheap synchronous login signal: lets us skip auth-required tracking endpoints for
// anonymous visitors (avoids 401/403 console noise) without importing the Supabase client.
const AUTH_STORAGE_KEY = 'arena-auth'

/**
 * Synchronous best-effort login check (reads the persisted Supabase session key).
 * Use to gate fire-and-forget tracking calls to auth-required endpoints so
 * anonymous visitors don't generate 401/403 console errors. NOT a security
 * boundary — the server still validates the real token.
 */
export function hasLocalSession(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !!window.localStorage.getItem(AUTH_STORAGE_KEY)
  } catch {
    return false // localStorage blocked (private mode) — treat as anonymous
  }
}

function dedupKey(event: InteractionEvent): string {
  return `${event.action}:${event.target_type}:${event.target_id}`
}

function flushQueue(): void {
  if (eventQueue.length === 0) return
  const batch = eventQueue.splice(0, eventQueue.length)

  // /api/interactions[/batch] requires auth — drop silently for anonymous
  // visitors instead of firing a request that 401/403s in the console.
  if (!hasLocalSession()) return
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
