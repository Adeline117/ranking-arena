/**
 * Custom event tracking utility — emits to Vercel Analytics and mirrors to
 * Plausible/PostHog when those optional providers are configured.
 *
 * Safe to call anywhere: server calls are ignored and optional providers no-op
 * when not loaded. Vercel Analytics is the production baseline because its
 * <Analytics /> component is already mounted in the app layout.
 */

import { track as trackVercelEvent } from '@vercel/analytics'
import { getCsrfHeaders } from '@/lib/api/csrf'
import { getLocalAccessToken } from '@/lib/auth/local-session'
import type { AnalyticsEventName } from './events'

export { ANALYTICS_EVENTS, type AnalyticsEventName } from './events'

type EventProps = Record<string, string | number | boolean>

interface PlausibleFn {
  (name: string, opts?: { props: Record<string, string | number | boolean> }): void
}

interface PostHogLike {
  capture: (name: string, props?: Record<string, unknown>) => void
}

type AnalyticsWindow = Window & {
  plausible?: PlausibleFn
  posthog?: PostHogLike
}

const ANONYMOUS_ID_KEY = 'arena_analytics_anonymous_id'
const SESSION_ID_KEY = 'arena_analytics_session_id'

function createUuid(): string | null {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return null
  }
}

function getOrCreateId(storage: Storage, key: string): string | null {
  try {
    const existing = storage.getItem(key)
    if (existing) return existing
    const created = createUuid()
    if (created) storage.setItem(key, created)
    return created
  } catch {
    return null
  }
}

function mirrorFirstPartyEvent(name: AnalyticsEventName, props: EventProps): void {
  const eventId = createUuid()
  const anonymousId = getOrCreateId(window.localStorage, ANONYMOUS_ID_KEY)
  const sessionId = getOrCreateId(window.sessionStorage, SESSION_ID_KEY)
  if (!eventId || !anonymousId || !sessionId) return

  const token = getLocalAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getCsrfHeaders(),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    fetch('/api/analytics/events', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event_id: eventId,
        event_name: name,
        anonymous_id: anonymousId,
        session_id: sessionId,
        path: window.location.pathname,
        properties: props,
        occurred_at: new Date().toISOString(),
      }),
      keepalive: true,
    }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- best-effort telemetry must not affect UX
  } catch {
    // Product measurement must never interrupt the product journey.
  }
}

export function trackEvent(name: AnalyticsEventName, props?: EventProps) {
  if (typeof window === 'undefined') return

  // Vercel Web Analytics is the always-on production baseline. Keep payloads
  // flat and primitive so they satisfy the custom-event ingestion contract.
  trackVercelEvent(name, props ?? {})

  // Plausible
  const plausible = (window as AnalyticsWindow).plausible
  if (plausible) {
    plausible(name, { props: props ?? {} })
  }

  // PostHog (posthog-js attaches itself to window.posthog after init)
  const posthog = (window as AnalyticsWindow).posthog
  if (posthog && typeof posthog.capture === 'function') {
    posthog.capture(name, props)
  }

  mirrorFirstPartyEvent(name, props ?? {})
}
