'use client'

import { useCallback, useEffect, useState, useRef, useMemo, useId } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { trackEvent } from '@/lib/analytics/track'
import { selectScopedTotalUnread, useInboxStore } from '@/lib/stores/inboxStore'
import {
  authInboxScope,
  captureInboxViewer,
  inboxViewerScopeKey,
  isInboxViewerCurrent,
} from '@/lib/inbox/viewer-scope'
import { isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'
import { logger } from '@/lib/logger'
import {
  removeOwnedRealtimeChannels,
  subscribeOwnedRealtimeChannel,
} from '@/lib/realtime/owned-channel'

// Lazy-load Supabase to keep it out of the initial client bundle (~50KB savings)
const getSupabase = () => import('@/lib/supabase/client').then((m) => m.supabase)

type TopNavProfileState = {
  avatarUrl: string | null
  handle: string | null
  loading: boolean
}

const emptyProfileState = (): TopNavProfileState => ({
  avatarUrl: null,
  handle: null,
  loading: true,
})

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value ? value : null
}

export function useTopNavState() {
  const router = useRouter()
  const realtimeOwnerId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'top-nav'
  const realtimeAttemptRef = useRef(0)
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const currentViewer = useMemo(() => captureInboxViewer(auth), [auth])
  const authScope = useMemo(() => authInboxScope(auth), [auth])
  const viewerScopeKey = currentViewer
    ? inboxViewerScopeKey(currentViewer)
    : `invalid:${inboxViewerScopeKey(authScope)}`
  const viewerFallbackProfile = useMemo(
    () =>
      currentViewer
        ? {
            avatarUrl:
              metadataString(currentViewer.userMetadata, 'avatar_url') ||
              metadataString(currentViewer.userMetadata, 'picture'),
            handle: currentViewer.email?.split('@')[0] || null,
          }
        : null,
    [currentViewer]
  )
  const [isReady, setIsReady] = useState(false)
  const [profile, setProfile] = useViewerOwnedState<TopNavProfileState>(
    emptyProfileState,
    emptyProfileState,
    viewerScopeKey
  )
  const [showUserMenu, setShowUserMenuState] = useViewerOwnedState(
    false,
    () => false,
    viewerScopeKey
  )
  const setShowUserMenu = useCallback(
    (show: boolean) => {
      if (!show || captureInboxViewer(authRef.current)) setShowUserMenuState(show)
    },
    [setShowUserMenuState]
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [showMobileSearch, setShowMobileSearch] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  const activateInboxViewer = useInboxStore((state) => state.activateViewer)
  const setUnreadNotifications = useInboxStore((state) => state.setUnreadNotifications)
  const setUnreadMessages = useInboxStore((state) => state.setUnreadMessages)
  const totalUnread = useInboxStore((state) =>
    currentViewer ? selectScopedTotalUnread(state, currentViewer) : 0
  )

  // Bind the singleton store to every canonical generation. The scoped
  // selector above already renders zero before this effect can run.
  useEffect(() => {
    if (isViewerScopeCurrent(authScope)) activateInboxViewer(authScope)
  }, [activateInboxViewer, authScope])

  // Performance: Defer profile/notification fetching - not LCP-critical
  useEffect(() => {
    if ('requestIdleCallback' in window) {
      const idleId = (
        window as unknown as {
          requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number
        }
      ).requestIdleCallback(() => setIsReady(true), { timeout: 2000 })
      return () => {
        ;(window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(
          idleId
        )
      }
    } else {
      const timer = setTimeout(() => setIsReady(true), 1000)
      return () => clearTimeout(timer)
    }
  }, [])

  // Initialize every exact viewer generation. Each awaited boundary performs
  // a fresh hook + process CAS before publishing private data.
  useEffect(() => {
    if (!isReady || !currentViewer) return

    let alive = true
    const viewer = currentViewer
    setProfile(emptyProfileState())
    const operationIsCurrent = () => alive && isInboxViewerCurrent(viewer, authRef.current)

    const consumeInitialWork = (work: () => Promise<void>, onFailure?: () => void) => {
      void work().catch(() => {
        if (operationIsCurrent()) onFailure?.()
      })
    }

    const initializeViewer = async () => {
      const supabase = await getSupabase()
      if (!operationIsCurrent()) return

      // Profile and badge reads are independent. A slow/missing profile row
      // must not hold the notification or message count behind it.
      consumeInitialWork(
        async () => {
          if (!operationIsCurrent()) return
          const profileResult = await supabase
            .from('user_profiles')
            .select('handle, avatar_url')
            .eq('id', viewer.userId)
            .maybeSingle()
          if (!operationIsCurrent()) return

          const userProfile = profileResult.data
          const fallbackHandle = viewer.email?.split('@')[0] || null
          const oauthAvatar =
            metadataString(viewer.userMetadata, 'avatar_url') ||
            metadataString(viewer.userMetadata, 'picture')
          setProfile({
            avatarUrl:
              typeof userProfile?.avatar_url === 'string' && userProfile.avatar_url
                ? userProfile.avatar_url
                : oauthAvatar,
            handle:
              typeof userProfile?.handle === 'string' && userProfile.handle
                ? userProfile.handle
                : fallbackHandle,
            loading: false,
          })
        },
        () => setProfile((previous) => ({ ...previous, loading: false }))
      )

      // KEEP `exact`: these values are shown literally in the badge and each
      // query is filtered to the captured principal.
      consumeInitialWork(async () => {
        if (!operationIsCurrent()) return
        const notificationsResult = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', viewer.userId)
          .eq('read', false)
        if (!operationIsCurrent()) return
        if (!notificationsResult.error && typeof notificationsResult.count === 'number') {
          setUnreadNotifications(viewer, notificationsResult.count)
        }
      })

      consumeInitialWork(async () => {
        if (!operationIsCurrent()) return
        const messagesResult = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', viewer.userId)
          .eq('read', false)
        if (!operationIsCurrent()) return
        if (!messagesResult.error && typeof messagesResult.count === 'number') {
          setUnreadMessages(viewer, messagesResult.count)
        }
      })
    }

    void initializeViewer().catch(() => {
      if (operationIsCurrent()) {
        setProfile((previous) => ({ ...previous, loading: false }))
      }
    })

    return () => {
      alive = false
    }
  }, [
    isReady,
    currentViewer,
    setProfile,
    setUnreadMessages,
    setUnreadNotifications,
    viewerScopeKey,
  ])

  // Real-time subscriptions are also owned by the exact viewer generation.
  useEffect(() => {
    if (!isReady || !currentViewer) return

    const viewer = currentViewer
    let alive = true
    let notifChannel: ReturnType<Awaited<ReturnType<typeof getSupabase>>['channel']> | null = null
    let msgChannel: ReturnType<Awaited<ReturnType<typeof getSupabase>>['channel']> | null = null
    let sbRef: Awaited<ReturnType<typeof getSupabase>> | null = null
    const operationIsCurrent = () => alive && isInboxViewerCurrent(viewer, authRef.current)

    const consumeSubscriptionWork = (work: () => Promise<void>, context: string) => {
      // Realtime is best-effort. Initial scoped reads still populate the
      // badge, and a transient failure must not become an unhandled rejection.
      void work().catch((error: unknown) => {
        if (operationIsCurrent()) logger.warn(`[TopNav] ${context} failed`, error)
      })
    }

    const setupSubscriptions = async () => {
      const supabase = await getSupabase()
      if (!operationIsCurrent()) return
      sbRef = supabase
      const attempt = ++realtimeAttemptRef.current

      const fetchUnreadCount = async () => {
        if (!operationIsCurrent()) return
        const { count, error } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', viewer.userId)
          .eq('read', false)
        if (operationIsCurrent() && !error && typeof count === 'number') {
          setUnreadNotifications(viewer, count)
        }
      }

      const fetchUnreadMessageCount = async () => {
        if (!operationIsCurrent()) return
        const { count, error } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', viewer.userId)
          .eq('read', false)
        if (operationIsCurrent() && !error && typeof count === 'number') {
          setUnreadMessages(viewer, count)
        }
      }

      const nextNotifChannel = subscribeOwnedRealtimeChannel({
        client: supabase,
        context: 'top-nav-notifications',
        topic: `notifications:${viewer.userId}:${viewer.sessionGeneration}:${realtimeOwnerId}:${attempt}`,
        configure: (channel) => {
          channel.on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'notifications',
              filter: `user_id=eq.${viewer.userId}`,
            },
            () => consumeSubscriptionWork(fetchUnreadCount, 'top-nav-notification-recount')
          )
        },
      })
      if (nextNotifChannel) notifChannel = nextNotifChannel

      const nextMsgChannel = subscribeOwnedRealtimeChannel({
        client: supabase,
        context: 'top-nav-messages',
        topic: `messages:${viewer.userId}:${viewer.sessionGeneration}:${realtimeOwnerId}:${attempt}`,
        configure: (channel) => {
          channel.on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'direct_messages',
              filter: `receiver_id=eq.${viewer.userId}`,
            },
            () => consumeSubscriptionWork(fetchUnreadMessageCount, 'top-nav-message-recount')
          )
        },
      })
      if (nextMsgChannel) msgChannel = nextMsgChannel
    }

    const hasIdleCallback = typeof requestIdleCallback !== 'undefined'
    const idleId = hasIdleCallback
      ? requestIdleCallback(
          () => consumeSubscriptionWork(setupSubscriptions, 'top-nav-realtime-setup'),
          { timeout: 3000 }
        )
      : undefined
    const fallbackTimer = hasIdleCallback
      ? undefined
      : setTimeout(
          () => consumeSubscriptionWork(setupSubscriptions, 'top-nav-realtime-setup'),
          2000
        )

    return () => {
      alive = false
      if (idleId !== undefined) cancelIdleCallback(idleId)
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
      const channels = [msgChannel, notifChannel]
      msgChannel = null
      notifChannel = null
      if (sbRef) void removeOwnedRealtimeChannels(sbRef, channels, 'top-nav-realtime-cleanup')
    }
  }, [
    isReady,
    currentViewer,
    realtimeOwnerId,
    setUnreadMessages,
    setUnreadNotifications,
    viewerScopeKey,
  ])

  useEffect(() => {
    if (!showUserMenu && !showSearchDropdown) return

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false)
      }
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearchDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [setShowUserMenu, showSearchDropdown, showUserMenu])

  // Cmd+K / Ctrl+K handled by TopNavClient (more robust version with editable field check)
  // Removed duplicate listener that was registered here

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedQuery = searchQuery.trim()
    if (trimmedQuery) {
      if (typeof window !== 'undefined') {
        try {
          const stored = localStorage.getItem('arena_search_history')
          const history: string[] = stored ? JSON.parse(stored) : []
          const filtered = history.filter((item) => item !== trimmedQuery)
          const updated = [trimmedQuery, ...filtered].slice(0, 10)
          localStorage.setItem('arena_search_history', JSON.stringify(updated))
        } catch (_error) {
          try {
            localStorage.removeItem('arena_search_history')
            localStorage.setItem('arena_search_history', JSON.stringify([trimmedQuery]))
          } catch {
            // Intentionally swallowed: localStorage unavailable (private mode), search history is optional
          }
        }
      }
      trackEvent('search', { query: trimmedQuery })
      router.push(`/search?q=${encodeURIComponent(trimmedQuery)}`)
    }
  }

  return {
    authLoggedIn: auth.isLoggedIn,
    authChecked: auth.authChecked,
    authPending: auth.loading || !auth.authChecked || (auth.isLoggedIn && currentViewer === null),
    isReady,
    myId: currentViewer?.userId ?? null,
    myHandle: currentViewer ? profile.handle || viewerFallbackProfile?.handle || null : null,
    myAvatarUrl: currentViewer
      ? profile.avatarUrl || viewerFallbackProfile?.avatarUrl || null
      : null,
    myEmail: currentViewer?.email ?? null,
    profileLoading: Boolean(currentViewer && profile.loading),
    viewerScopeKey,
    showUserMenu,
    setShowUserMenu,
    searchQuery,
    setSearchQuery,
    showSearchDropdown,
    setShowSearchDropdown,
    showMobileSearch,
    setShowMobileSearch,
    totalUnread,
    menuRef,
    searchRef,
    handleSearch,
  }
}
