'use client'

/**
 * Typing Indicator Hook
 * Uses Supabase Realtime Broadcast (no DB writes) to show "X is typing..." in DMs.
 * Pattern from Rocket.Chat/Mattermost: send typing events via ephemeral channel,
 * auto-expire after 3 seconds of inactivity.
 */

import { useState, useCallback, useRef, useEffect } from 'react'

let _supabase: Awaited<typeof import('@/lib/supabase/client')>['supabase'] | null = null
const getSupabase = () => _supabase
  ? Promise.resolve(_supabase)
  : import('@/lib/supabase/client').then(m => { _supabase = m.supabase; return _supabase })

const TYPING_TIMEOUT_MS = 3000
const THROTTLE_MS = 1500

interface UseTypingIndicatorOptions {
  conversationId: string | null
  userId: string | null
  enabled?: boolean
}

export function useTypingIndicator({ conversationId, userId, enabled = true }: UseTypingIndicatorOptions) {
  const [isOtherTyping, setIsOtherTyping] = useState(false)
  const [typingUserHandle, setTypingUserHandle] = useState<string | null>(null)
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastSentRef = useRef(0)
  const channelRef = useRef<ReturnType<Awaited<ReturnType<typeof getSupabase>>['channel']> | null>(null)

  // Subscribe to typing events from the other user
  useEffect(() => {
    if (!conversationId || !userId || !enabled) return

    let alive = true

    getSupabase().then(sb => {
      if (!alive) return

      const channel = sb.channel(`typing:${conversationId}`, {
        config: { broadcast: { self: false } },
      })

      channel.on('broadcast', { event: 'typing' }, (payload) => {
        const data = payload.payload as { userId: string; handle?: string }
        if (data.userId === userId) return // ignore own typing

        setIsOtherTyping(true)
        setTypingUserHandle(data.handle || null)

        // Auto-clear after timeout
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
        typingTimeoutRef.current = setTimeout(() => {
          setIsOtherTyping(false)
          setTypingUserHandle(null)
        }, TYPING_TIMEOUT_MS)
      })

      channel.on('broadcast', { event: 'stop_typing' }, (payload) => {
        const data = payload.payload as { userId: string }
        if (data.userId !== userId) {
          setIsOtherTyping(false)
          setTypingUserHandle(null)
        }
      })

      channel.subscribe()
      channelRef.current = channel
    })

    return () => {
      alive = false
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      if (channelRef.current) {
        channelRef.current.unsubscribe()
        channelRef.current = null
      }
      setIsOtherTyping(false)
    }
  }, [conversationId, userId, enabled])

  // Send typing event (throttled to avoid flooding)
  const sendTyping = useCallback((handle?: string) => {
    if (!channelRef.current || !userId) return

    const now = Date.now()
    if (now - lastSentRef.current < THROTTLE_MS) return
    lastSentRef.current = now

    channelRef.current.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId, handle },
    })
  }, [userId])

  // Send stop typing event
  const sendStopTyping = useCallback(() => {
    if (!channelRef.current || !userId) return

    channelRef.current.send({
      type: 'broadcast',
      event: 'stop_typing',
      payload: { userId },
    })
  }, [userId])

  return {
    isOtherTyping,
    typingUserHandle,
    sendTyping,
    sendStopTyping,
  }
}
