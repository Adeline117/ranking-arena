'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import {
  removeOwnedRealtimeChannels,
  subscribeOwnedRealtimeChannel,
  type OwnedRealtimeClient,
} from '@/lib/realtime/owned-channel'
import { fireAndForget } from '@/lib/logger'

const ONLINE_GRACE_MS = 90_000
const MAX_FUTURE_CLOCK_SKEW_MS = 60_000

export type PresenceRoom = {
  kind: 'channel' | 'conversation'
  id: string
}

type PresenceState = {
  userId: string
  isOnline: boolean
  lastSeenAt: string | null
  typingIn: string | null
}

type PresenceSnapshot = {
  scopeKey: string | null
  realtimeSynced: boolean
  values: Record<string, PresenceState>
}

type PresenceConnection = {
  roomId: string
  scopeKey: string
  topic: string
}

const EMPTY_PRESENCE_VALUES: Record<string, PresenceState> = {}
const realtimeClient: OwnedRealtimeClient = supabase

function getPresenceConnection(
  currentUserId: string | null,
  room: PresenceRoom | null
): PresenceConnection | null {
  const roomId = room?.id.trim()
  if (!currentUserId || !roomId || !room) return null

  return {
    roomId,
    scopeKey: `${currentUserId}:${room.kind}:${roomId}`,
    topic: `presence:${room.kind}:${encodeURIComponent(roomId)}`,
  }
}

function isFreshOnlineTimestamp(lastSeenAt: string | null, now: number): boolean {
  if (!lastSeenAt) return false
  const seenAt = Date.parse(lastSeenAt)
  if (!Number.isFinite(seenAt)) return false

  const age = now - seenAt
  return age >= -MAX_FUTURE_CLOCK_SKEW_MS && age <= ONLINE_GRACE_MS
}

function latestTimestamp(first: string | null, second: string | null): string | null {
  if (!first) return second
  if (!second) return first
  const firstTime = Date.parse(first)
  const secondTime = Date.parse(second)
  if (!Number.isFinite(firstTime)) return second
  if (!Number.isFinite(secondTime)) return first
  return firstTime >= secondTime ? first : second
}

function trackBestEffort(channel: RealtimeChannel, payload: Record<string, unknown>): void {
  try {
    fireAndForget(Promise.resolve(channel.track(payload)), 'presence-room-track')
  } catch {
    // A synchronous transport failure must not break typing or page cleanup.
  }
}

/**
 * Track online/typing state inside the exact chat room shared by participants.
 * Durable last-seen heartbeats are handled globally by PresenceHeartbeat.
 */
export function usePresence(
  currentUserId: string | null,
  watchUserIds: string[],
  room: PresenceRoom | null
) {
  const connection = getPresenceConnection(currentUserId, room)
  const scopeKey = connection?.scopeKey ?? null
  const roomId = connection?.roomId ?? null
  const topic = connection?.topic ?? null
  const watchedIds = [...new Set(watchUserIds.filter(Boolean))].sort()
  const watchedIdsKey = JSON.stringify(watchedIds)
  const [snapshot, setSnapshot] = useState<PresenceSnapshot>({
    scopeKey: null,
    realtimeSynced: false,
    values: {},
  })
  const renderedScopeRef = useRef<string | null>(scopeKey)
  const channelRef = useRef<{
    channel: RealtimeChannel
    roomId: string
    scopeKey: string
  } | null>(null)

  // Reject callbacks from the previous viewer/room in the same render that the
  // owner changes; waiting for an effect cleanup would expose stale presence.
  renderedScopeRef.current = scopeKey

  useEffect(() => {
    if (!scopeKey || !roomId || !topic || !currentUserId) return

    const effectScopeKey = scopeKey
    let active = true
    let callbackChannel: RealtimeChannel | null = null
    const isCurrent = () => active && renderedScopeRef.current === effectScopeKey

    const syncFromRoom = () => {
      if (!isCurrent() || !callbackChannel) return

      const roomState = callbackChannel.presenceState()
      const observedAt = new Date().toISOString()
      setSnapshot((previous) => {
        if (!isCurrent()) return previous

        const previousValues =
          previous.scopeKey === effectScopeKey ? previous.values : EMPTY_PRESENCE_VALUES
        const values: Record<string, PresenceState> = {}

        for (const [userId, prior] of Object.entries(previousValues)) {
          values[userId] = {
            ...prior,
            isOnline: false,
            lastSeenAt: prior.isOnline ? observedAt : prior.lastSeenAt,
            typingIn: null,
          }
        }

        for (const [userId, presences] of Object.entries(roomState)) {
          if (!Array.isArray(presences) || presences.length === 0) continue
          const typingPresence = presences.find(
            (presence) =>
              typeof (presence as Record<string, unknown>).typing_in === 'string' &&
              (presence as Record<string, unknown>).typing_in === roomId
          ) as Record<string, unknown> | undefined

          values[userId] = {
            userId,
            isOnline: true,
            lastSeenAt: observedAt,
            typingIn:
              typeof typingPresence?.typing_in === 'string' ? typingPresence.typing_in : null,
          }
        }

        return {
          scopeKey: effectScopeKey,
          realtimeSynced: true,
          values,
        }
      })
    }

    const channel = subscribeOwnedRealtimeChannel({
      client: realtimeClient,
      channelOptions: {
        config: { presence: { key: currentUserId } },
      },
      configure: (candidate) => {
        callbackChannel = candidate
        candidate
          .on('presence', { event: 'sync' }, syncFromRoom)
          .on('presence', { event: 'join' }, syncFromRoom)
          .on('presence', { event: 'leave' }, syncFromRoom)
      },
      context: `presence:${effectScopeKey}`,
      onSubscribeStatus: (status) => {
        if (status !== 'SUBSCRIBED' || !isCurrent() || !callbackChannel) return
        trackBestEffort(callbackChannel, {
          user_id: currentUserId,
          online_at: new Date().toISOString(),
          typing_in: null,
        })
      },
      topic,
    })

    setSnapshot((previous) =>
      previous.scopeKey === effectScopeKey
        ? previous
        : { scopeKey: effectScopeKey, realtimeSynced: false, values: {} }
    )

    if (channel) {
      channelRef.current = {
        channel,
        roomId,
        scopeKey: effectScopeKey,
      }
    } else {
      callbackChannel = null
    }

    return () => {
      active = false
      if (channelRef.current?.scopeKey === effectScopeKey) channelRef.current = null
      void removeOwnedRealtimeChannels(
        realtimeClient,
        [channel],
        `presence:${effectScopeKey}:cleanup`
      )
    }
  }, [currentUserId, roomId, scopeKey, topic])

  // Fetch initial last_seen_at for watched users
  useEffect(() => {
    if (!scopeKey || watchedIds.length === 0) return

    const effectScopeKey = scopeKey
    let cancelled = false

    const fetchLastSeen = async () => {
      try {
        const { data } = await supabase
          .from('user_profiles')
          .select('id, last_seen_at, is_online')
          .in('id', watchedIds)

        if (cancelled || renderedScopeRef.current !== effectScopeKey) return

        if (data) {
          const now = Date.now()
          setSnapshot((previous) => {
            if (cancelled || renderedScopeRef.current !== effectScopeKey) return previous

            const base =
              previous.scopeKey === effectScopeKey
                ? previous
                : { scopeKey: effectScopeKey, realtimeSynced: false, values: {} }
            const values = { ...base.values }

            for (const user of data) {
              const existing = values[user.id]
              if (existing?.isOnline) continue

              const lastSeenAt = latestTimestamp(
                existing?.lastSeenAt ?? null,
                user.last_seen_at || null
              )
              values[user.id] = {
                userId: user.id,
                // A successful Realtime sync is authoritative for this room.
                // Before it arrives, the durable heartbeat is only "online"
                // inside a bounded grace window; is_online is never permanent.
                isOnline:
                  !base.realtimeSynced &&
                  Boolean(user.is_online) &&
                  isFreshOnlineTimestamp(user.last_seen_at || null, now),
                lastSeenAt,
                typingIn: existing?.typingIn ?? null,
              }
            }

            return { ...base, values }
          })
        }
      } catch (_err) {
        // Intentionally swallowed: last_seen fetch is non-critical, presence defaults to offline
      }
    }

    fetchLastSeen()
    return () => {
      cancelled = true
    }
    // watchedIdsKey is a canonical de-duplicated/sorted representation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, watchedIdsKey])

  const visibleValues = snapshot.scopeKey === scopeKey ? snapshot.values : EMPTY_PRESENCE_VALUES

  const getUserPresence = useCallback(
    (userId: string): PresenceState => {
      return (
        visibleValues[userId] || {
          userId,
          isOnline: false,
          lastSeenAt: null,
          typingIn: null,
        }
      )
    },
    [visibleValues]
  )

  const setTyping = useCallback(
    (conversationId: string, isTyping: boolean) => {
      const ownedChannel = channelRef.current
      if (
        !currentUserId ||
        !roomId ||
        !scopeKey ||
        !ownedChannel ||
        renderedScopeRef.current !== scopeKey ||
        ownedChannel.scopeKey !== scopeKey ||
        ownedChannel.roomId !== conversationId
      ) {
        return
      }

      trackBestEffort(ownedChannel.channel, {
        user_id: currentUserId,
        online_at: new Date().toISOString(),
        typing_in: isTyping ? conversationId : null,
      })
    },
    [currentUserId, roomId, scopeKey]
  )

  const isUserTyping = useCallback(
    (userId: string, conversationId: string): boolean =>
      roomId === conversationId && visibleValues[userId]?.typingIn === conversationId,
    [roomId, visibleValues]
  )

  return { presenceMap: visibleValues, getUserPresence, setTyping, isUserTyping }
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
