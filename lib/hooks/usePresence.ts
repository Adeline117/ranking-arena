'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'

function getPresenceShard(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i)
    hash |= 0
  }
  return `presence:${Math.abs(hash) % 100}`
}

type PresenceState = {
  userId: string
  isOnline: boolean
  lastSeenAt: string | null
}

/**
 * Track online presence for a set of user IDs using Supabase Realtime Presence.
 * Also updates the current user's last_seen_at periodically.
 */
export function usePresence(currentUserId: string | null, watchUserIds: string[]) {
  const [presenceMap, setPresenceMap] = useState<Record<string, PresenceState>>({})
  const channelRef = useRef<RealtimeChannel | null>(null)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // AbortController for in-flight heartbeat POSTs and last_seen fetches.
  // Without this, a slow heartbeat request that resolves after unmount
  // holds the Response body + JSON parser scope in memory until GC.
  const fetchAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!currentUserId) return

    // Create a fresh AbortController for this mount cycle.
    const abortController = new AbortController()
    fetchAbortRef.current = abortController

    const channel = supabase.channel(getPresenceShard(currentUserId), {
      config: { presence: { key: currentUserId } },
    })

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const newMap: Record<string, PresenceState> = {}
        
        for (const [key, presences] of Object.entries(state)) {
          if (presences && presences.length > 0) {
            newMap[key] = {
              userId: key,
              isOnline: true,
              lastSeenAt: new Date().toISOString(),
            }
          }
        }
        
        setPresenceMap(prev => {
          // Merge: keep offline users from previous state, update online ones
          const merged = { ...prev }
          // Mark all previously online as potentially offline
          for (const uid of Object.keys(merged)) {
            if (!newMap[uid]) {
              merged[uid] = { ...merged[uid], isOnline: false }
            }
          }
          // Update with current online users
          for (const [uid, state] of Object.entries(newMap)) {
            merged[uid] = state
          }
          return merged
        })
      })
      .on('presence', { event: 'join' }, ({ key }) => {
        if (key) {
          setPresenceMap(prev => ({
            ...prev,
            [key]: { userId: key, isOnline: true, lastSeenAt: new Date().toISOString() },
          }))
        }
      })
      .on('presence', { event: 'leave' }, ({ key }) => {
        if (key) {
          setPresenceMap(prev => ({
            ...prev,
            [key]: { ...prev[key], userId: key, isOnline: false, lastSeenAt: new Date().toISOString() },
          }))
        }
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: currentUserId, online_at: new Date().toISOString() })
        }
      })

    channelRef.current = channel

    // Heartbeat: update presence every 30s
    heartbeatRef.current = setInterval(() => {
      channel.track({ user_id: currentUserId, online_at: new Date().toISOString() })
    }, 30000)

    // Update last_seen_at in DB periodically (every 60s)
    const dbHeartbeat = setInterval(async () => {
      if (abortController.signal.aborted) return
      try {
        await fetch('/api/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'heartbeat' }),
          signal: abortController.signal,
        })
      } catch (_err) {
        // Intentionally swallowed: presence heartbeat is best-effort, missed heartbeats auto-recover
      }
    }, 60000)

    return () => {
      // Abort any in-flight heartbeat fetch before tearing down intervals —
      // otherwise an in-flight request resolves post-unmount and holds the
      // response body in memory until GC.
      abortController.abort()
      if (fetchAbortRef.current === abortController) fetchAbortRef.current = null
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
      clearInterval(dbHeartbeat)
      channel.unsubscribe()
      supabase.removeChannel(channel)
    }
  }, [currentUserId])

  // Fetch initial last_seen_at for watched users
  useEffect(() => {
    if (watchUserIds.length === 0) return

    // Track whether this effect instance has been unmounted so we can
    // skip the setState after the async supabase call resolves.
    // The Supabase client doesn't support AbortController directly, so a
    // mounted flag is the idiomatic guard.
    let aborted = false

    const fetchLastSeen = async () => {
      try {
        const { data } = await supabase
          .from('user_profiles')
          .select('id, last_seen_at, is_online')
          .in('id', watchUserIds)

        if (aborted) return

        if (data) {
          setPresenceMap(prev => {
            const updated = { ...prev }
            for (const user of data) {
              if (!updated[user.id]?.isOnline) {
                updated[user.id] = {
                  userId: user.id,
                  isOnline: user.is_online || false,
                  lastSeenAt: user.last_seen_at || null,
                }
              }
            }
            return updated
          })
        }
      } catch (_err) {
        // Intentionally swallowed: last_seen fetch is non-critical, presence defaults to offline
      }
    }

    fetchLastSeen()
    return () => { aborted = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- join produces stable string key
  }, [watchUserIds.join(',')])

  const getUserPresence = useCallback((userId: string): PresenceState => {
    return presenceMap[userId] || { userId, isOnline: false, lastSeenAt: null }
  }, [presenceMap])

  const setTyping = useCallback((conversationId: string, isTyping: boolean) => {
    if (!currentUserId || !channelRef.current) return
    channelRef.current.track({
      user_id: currentUserId,
      online_at: new Date().toISOString(),
      typing_in: isTyping ? conversationId : null,
    })
  }, [currentUserId])

  const isUserTyping = useCallback((userId: string, conversationId: string): boolean => {
    const channel = channelRef.current
    if (!channel) return false
    const state = channel.presenceState()
    const presences = state[userId]
    if (!presences || presences.length === 0) return false
    return presences.some((p: Record<string, unknown>) => p.typing_in === conversationId)
  }, [])

  return { presenceMap, getUserPresence, setTyping, isUserTyping }
}

/**
 * Format last seen time as human-readable string
 */
export function formatLastSeen(lastSeenAt: string | null, t: (key: string) => string): string {
  if (!lastSeenAt) return t('offlineStatus')
  
  const now = Date.now()
  const seen = new Date(lastSeenAt).getTime()
  const diffMs = now - seen
  const diffMin = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return t('lastSeenJustNow')
  if (diffMin < 60) return t('lastSeenMinutesAgo').replace('{n}', String(diffMin))
  if (diffHours < 24) return t('lastSeenHoursAgo').replace('{n}', String(diffHours))
  return t('lastSeenDaysAgo').replace('{n}', String(diffDays))
}
