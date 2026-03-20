'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { trackEvent } from '@/lib/analytics/track'

// Lazy-load Supabase to keep it out of the initial client bundle (~50KB savings)
const getSupabase = () => import('@/lib/supabase/client').then(m => m.supabase)

export function useTopNavState() {
  const router = useRouter()
  const { userId: authUserId, isLoggedIn: authLoggedIn, authChecked } = useAuthSession()
  const [isReady, setIsReady] = useState(false)
  const [myId, setMyId] = useState<string | null>(null)
  const [myHandle, setMyHandle] = useState<string | null>(null)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [showMobileSearch, setShowMobileSearch] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [_unreadMessageCount, setUnreadMessageCount] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  // Badge shows only notification count (not messages) to match /inbox notifications tab
  const totalUnread = unreadCount

  // Sync auth state from global hook immediately (prevents login flicker on navigation)
  useEffect(() => {
    if (authChecked && authUserId && !myId) {
      setMyId(authUserId)
    }
  }, [authChecked, authUserId, myId])

  // Performance: Defer profile/notification fetching - not LCP-critical
  useEffect(() => {
    if ('requestIdleCallback' in window) {
      const idleId = (window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback(() => setIsReady(true), { timeout: 2000 })
      return () => {
        (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(idleId)
      }
    } else {
      const timer = setTimeout(() => setIsReady(true), 1000)
      return () => clearTimeout(timer)
    }
  }, [])

  // Performance: Fetch user auth and profile/notifications/messages in parallel (deferred)
  useEffect(() => {
    if (!isReady) return

    let alive = true

    const initAuth = async () => {
      try {
        const supabase = await getSupabase()
        const { data, error } = await supabase.auth.getSession()
        if (!alive || error || !data.session?.user) return

        const userId = data.session.user.id
        setMyId(userId)

        const [profileResult, notificationsResult, messagesResult] = await Promise.all([
          supabase
            .from('user_profiles')
            .select('handle, avatar_url')
            .eq('id', userId)
            .maybeSingle(),
          supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('read', false),
          supabase
            .from('direct_messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('read', false),
        ])

        if (!alive) return

        const userProfile = profileResult.data
        if (userProfile?.handle) {
          setMyHandle(userProfile.handle)
        } else if (data.session?.user?.email) {
          setMyHandle(data.session.user.email.split('@')[0])
        }
        if (userProfile?.avatar_url) {
          setMyAvatarUrl(userProfile.avatar_url)
        } else {
          // Fallback: try to get avatar from OAuth metadata (Google, GitHub, etc.)
          const meta = data.session.user.user_metadata
          const oauthAvatar = meta?.avatar_url || meta?.picture || null
          if (oauthAvatar) {
            setMyAvatarUrl(oauthAvatar)
            // Also persist to user_profiles for future loads
            getSupabase().then(sb => sb.from('user_profiles')
              .update({ avatar_url: oauthAvatar })
              .eq('id', userId)
              .then(() => { /* best-effort sync */ }))
          }
        }

        if (!notificationsResult.error && typeof notificationsResult.count === 'number') {
          setUnreadCount(notificationsResult.count)
        }

        if (!messagesResult.error && typeof messagesResult.count === 'number') {
          setUnreadMessageCount(messagesResult.count)
        }
      } catch (err) {
        if (!alive) return
        if (err instanceof Error && err.message?.includes('Auth session')) return
      }
    }

    initAuth()

    return () => {
      alive = false
    }
  }, [isReady])

  // Real-time subscriptions deferred to after idle to avoid competing with LCP
  useEffect(() => {
    if (!myId) return

    let notifChannel: ReturnType<Awaited<ReturnType<typeof getSupabase>>['channel']> | null = null
    let msgChannel: ReturnType<Awaited<ReturnType<typeof getSupabase>>['channel']> | null = null
    let sbRef: Awaited<ReturnType<typeof getSupabase>> | null = null

    const setupSubscriptions = async () => {
      const supabase = await getSupabase()
      sbRef = supabase

      const fetchUnreadCount = async () => {
        const { count, error } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', myId)
          .eq('read', false)
        if (!error && typeof count === 'number') {
          setUnreadCount(count)
        }
      }

      const fetchUnreadMessageCount = async () => {
        const { count, error } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', myId)
          .eq('read', false)
        if (!error && typeof count === 'number') {
          setUnreadMessageCount(count)
        }
      }

      notifChannel = supabase
        .channel(`notifications:${myId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${myId}` },
          () => fetchUnreadCount()
        )
        .subscribe()

      msgChannel = supabase
        .channel(`messages:${myId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'direct_messages', filter: `receiver_id=eq.${myId}` },
          () => fetchUnreadMessageCount()
        )
        .subscribe()
    }

    const hasIdleCallback = typeof requestIdleCallback !== 'undefined'
    const idleId = hasIdleCallback ? requestIdleCallback(() => { setupSubscriptions() }, { timeout: 3000 }) : undefined
    const fallbackTimer = hasIdleCallback ? undefined : setTimeout(() => { setupSubscriptions() }, 2000)

    return () => {
      if (idleId !== undefined) cancelIdleCallback(idleId)
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
      if (notifChannel && sbRef) sbRef.removeChannel(notifChannel)
      if (msgChannel && sbRef) sbRef.removeChannel(msgChannel)
    }
  }, [myId])

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
  }, [showUserMenu, showSearchDropdown])

  // Cmd+K / Ctrl+K keyboard shortcut to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        const input = searchRef.current?.querySelector('input')
        if (input) {
          input.focus()
          setShowSearchDropdown(true)
        } else {
          setShowMobileSearch(true)
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

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
    authLoggedIn,
    authChecked,
    isReady,
    myId,
    myHandle,
    myAvatarUrl,
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
