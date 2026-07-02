'use client'

/**
 * PresenceHeartbeat — global "user is alive" pinger.
 *
 * Mounted inside the (app) Providers tree so it runs on EVERY authenticated
 * page. Fires POST /api/presence (updates user_profiles.last_seen_at +
 * is_online) once on sign-in and every 60s thereafter.
 *
 * WHY THIS EXISTS: the only other caller of /api/presence is usePresence(),
 * which is mounted ONLY inside /messages/[conversationId] and
 * /channels/[channelId]. Virtually no user ever opens a DM/channel, so
 * last_seen_at stayed NULL for every account — the app's active-user sensor
 * was dead. This component makes the sensor fire for all logged-in users,
 * regardless of which page they're on. (See docs/USER_TRUTH_2026-07.md.)
 *
 * Behavior:
 * - Beats on mount (if signed in), on auth → signed-in transition, and every
 *   60s while the tab is visible. Skips beats while the tab is hidden to avoid
 *   inflating "online" for background tabs; re-beats immediately on re-focus.
 * - Best-effort: never throws, never blocks render, renders null.
 */

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { authedFetch } from '@/lib/api/client'

const HEARTBEAT_INTERVAL_MS = 60_000

async function beat(): Promise<void> {
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return
    // status is ignored — a failed heartbeat auto-recovers on the next tick.
    await authedFetch('/api/presence', 'POST', token, { action: 'heartbeat' })
  } catch {
    // Intentionally swallowed on the client: presence is best-effort. The
    // SERVER logs any real DB write failure (that's where the sensor broke).
  }
}

export default function PresenceHeartbeat() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Beat immediately (covers a page load into an already-authenticated session).
    void beat()

    intervalRef.current = setInterval(() => {
      void beat()
    }, HEARTBEAT_INTERVAL_MS)

    // Beat on auth → signed-in transitions (login without a full reload).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        void beat()
      }
    })

    // Beat the moment a backgrounded tab becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void beat()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      subscription.unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return null
}
