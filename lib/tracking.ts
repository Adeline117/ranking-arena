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

/**
 * Best-effort synchronous read of the Supabase access token from the persisted
 * session (same `arena-auth` key as hasLocalSession). The tracking endpoints
 * authenticate via `Authorization: Bearer` only — cookies are never read — so
 * fire-and-forget tracking must attach this token. NOT a security boundary;
 * the server validates the token. A stale/expired token just means the event
 * is silently dropped server-side, which is acceptable for tracking.
 */
function getLocalAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const token = (JSON.parse(raw) as { access_token?: unknown }).access_token
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null // unparseable session or localStorage blocked — treat as anonymous
  }
}

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
