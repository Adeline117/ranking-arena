/**
 * Interaction tracking utility.
 * Fire-and-forget with per-session deduplication.
 */

type InteractionEvent = {
  action: string
  target_type: string
  target_id: string
}

const tracked = new Set<string>()

function dedupKey(event: InteractionEvent): string {
  return `${event.action}:${event.target_type}:${event.target_id}`
}

export function trackInteraction(event: InteractionEvent): void {
  const key = dedupKey(event)
  if (tracked.has(key)) return
  tracked.add(key)

  const body = JSON.stringify(event)

  // sendBeacon doesn't send auth headers, so use fetch with keepalive
  // Auth token is read from supabase session cookie by the API
  fetch('/api/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {})
}
