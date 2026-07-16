'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import { traderFetcher } from '@/lib/hooks/traderFetcher'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import {
  captureProfileViewer,
  isProfileViewerCurrent,
  type ProfileViewerSnapshot,
} from './profile-viewer-scope'

import type { ServerProfile, ProfileTabKey, TraderPageData } from '../components/types'

// #31: traderFetcher extracted to lib/hooks/traderFetcher.ts (shared with TraderProfileClient)

interface UseUserProfileProps {
  handle: string
  serverProfile: ServerProfile | null
  serverTraderData?: TraderPageData | null
}

type ProfileStateOwner = Pick<
  ProfileViewerSnapshot,
  'sessionGeneration' | 'userId' | 'viewerKey'
> & {
  handle: string
}

type RecoveredProfileState = ProfileStateOwner & {
  profile: ServerProfile
}

type BlockState = ProfileStateOwner & {
  profileId: string
  blocked: boolean
}

function sameProfileOwner(
  state: ProfileStateOwner | null,
  viewer: ProfileViewerSnapshot | null,
  handle: string
): boolean {
  return (
    state !== null &&
    viewer !== null &&
    state.handle === handle &&
    state.viewerKey === viewer.viewerKey &&
    state.sessionGeneration === viewer.sessionGeneration &&
    state.userId === viewer.userId
  )
}

export function useUserProfile({ handle, serverProfile, serverTraderData }: UseUserProfileProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const { isPro } = useSubscription()

  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const currentViewer = captureProfileViewer(auth)
  const email = currentViewer?.email ?? null
  const currentUserId = currentViewer?.userId ?? null

  const [recoveredProfileState, setRecoveredProfileState] = useState<RecoveredProfileState | null>(
    null
  )
  const recoveredProfileBelongsToRender = sameProfileOwner(
    recoveredProfileState,
    currentViewer,
    handle
  )
  const profile =
    serverProfile ??
    (recoveredProfileBelongsToRender ? (recoveredProfileState?.profile ?? null) : null)
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(serverProfile?.followers || 0)
  const [mounted, setMounted] = useState(false)
  const mountedRef = useRef(false)
  const profileOperationRef = useRef(0)
  const blockOperationRef = useRef(0)
  const routeRef = useRef({ handle, hasServerProfile: serverProfile !== null })
  routeRef.current = { handle, hasServerProfile: serverProfile !== null }
  const profileIdRef = useRef(profile?.id ?? null)
  profileIdRef.current = profile?.id ?? null
  const searchParams = useSearchParams()
  const pathname = usePathname()

  useEffect(() => {
    mountedRef.current = true
    setMounted(true)
    return () => {
      mountedRef.current = false
      profileOperationRef.current += 1
      blockOperationRef.current += 1
    }
  }, [])

  // Trader data - React Query with server fallback
  const isTrader = !!serverProfile?.traderHandle
  const traderUrl = isTrader
    ? `/api/traders/${encodeURIComponent(serverProfile!.traderHandle!)}`
    : ''
  const {
    data: traderData,
    error: traderError,
    isLoading: traderLoading,
  } = useQuery<TraderPageData>({
    queryKey: ['user-trader-data', serverProfile?.traderHandle],
    queryFn: () => traderFetcher(traderUrl),
    enabled: isTrader,
    refetchOnWindowFocus: false,
    refetchInterval: 0,
    staleTime: STALE_STANDARD,
    retry: 2,
    initialData: serverTraderData ?? undefined,
  })

  // Tabs
  const urlTab = searchParams.get('tab')
  const [activeProfileTab, setActiveProfileTab] = useState<ProfileTabKey>(
    urlTab && ['overview', 'stats', 'portfolio'].includes(urlTab)
      ? (urlTab as ProfileTabKey)
      : 'overview'
  )

  const updateUrl = useCallback(
    (tab: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (tab === 'overview') {
        params.delete('tab')
      } else {
        params.set('tab', tab)
      }
      const qs = params.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [searchParams, pathname, router]
  )

  const handleProfileTabChange = useCallback(
    (tab: ProfileTabKey) => {
      setActiveProfileTab(tab)
      updateUrl(tab)
    },
    [updateUrl]
  )

  // SSR can time out and return no profile for the signed-in user's own route.
  // Recover by reading the trigger-provisioned row only. The browser must never
  // manufacture identity rows after the database revoked authenticated INSERT.
  useEffect(() => {
    const operationId = ++profileOperationRef.current
    const viewer = captureProfileViewer(authRef.current)
    if (serverProfile || !viewer) return

    const emailHandle = viewer.email?.split('@')[0]
    const isOwnProfileAlias = handle === viewer.userId || handle === emailHandle

    let cancelled = false
    const abortController = new AbortController()
    const operationIsCurrent = () =>
      !cancelled &&
      mountedRef.current &&
      profileOperationRef.current === operationId &&
      routeRef.current.handle === handle &&
      !routeRef.current.hasServerProfile &&
      isProfileViewerCurrent(viewer, authRef.current)

    void (async () => {
      try {
        const { data: existingProfile, error: profileError } = await supabase
          .from('user_profiles')
          .select('id, handle, bio, avatar_url, cover_url, show_followers, show_following, role')
          .eq('id', viewer.userId)
          .abortSignal(abortController.signal)
          .maybeSingle()

        if (!operationIsCurrent()) return
        if (
          profileError ||
          !existingProfile ||
          existingProfile.id !== viewer.userId ||
          typeof existingProfile.handle !== 'string' ||
          !existingProfile.handle
        ) {
          // A missing arbitrary public route is still an ordinary not-found.
          // Surface provisioning failure only when the route itself identifies
          // the signed-in user by UUID or the legacy email-prefix alias.
          if (isOwnProfileAlias) {
            logger.warn('Own profile lookup failed closed:', profileError)
            showToast(t('loadUserDataFailed'), 'error')
          }
          return
        }

        if (existingProfile.handle !== handle) {
          if (isOwnProfileAlias) {
            router.replace(`/u/${encodeURIComponent(existingProfile.handle)}`)
          }
          return
        }

        setRecoveredProfileState({
          handle,
          viewerKey: viewer.viewerKey,
          sessionGeneration: viewer.sessionGeneration,
          userId: viewer.userId,
          profile: {
            id: existingProfile.id,
            handle: existingProfile.handle,
            bio: existingProfile.bio || undefined,
            avatar_url: existingProfile.avatar_url || undefined,
            cover_url: existingProfile.cover_url || undefined,
            show_followers: existingProfile.show_followers ?? undefined,
            show_following: existingProfile.show_following ?? undefined,
            followers: 0,
            following: 0,
            followingTraders: 0,
            isRegistered: true,
            proBadgeTier: null,
            role: existingProfile.role || undefined,
          },
        })
      } catch (error) {
        if (!operationIsCurrent()) return
        logger.error('Own profile lookup threw:', error)
        showToast(t('loadUserDataFailed'), 'error')
      }
    })()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [
    auth.accessToken,
    auth.authChecked,
    auth.loading,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
    handle,
    router,
    serverProfile,
    showToast,
    t,
  ])

  const isOwnProfile = currentUserId === profile?.id
  const followingCount = (profile?.following || 0) + (profile?.followingTraders || 0)

  // Trader loading/error states
  const isTraderDataLoading = isTrader && traderLoading && !serverTraderData
  const isTraderDataError = isTrader && traderError && !traderData

  // Block check: bidirectional
  const [blockState, setBlockState] = useState<BlockState | null>(null)
  const blockStateBelongsToRender =
    sameProfileOwner(blockState, currentViewer, handle) && blockState?.profileId === profile?.id
  const isBlocked = blockStateBelongsToRender ? blockState?.blocked === true : false

  useEffect(() => {
    const operationId = ++blockOperationRef.current
    const viewer = captureProfileViewer(authRef.current)
    const profileId = profile?.id
    if (!viewer || !profileId || viewer.userId === profileId) return

    let cancelled = false
    const abortController = new AbortController()
    const operationIsCurrent = () =>
      !cancelled &&
      mountedRef.current &&
      blockOperationRef.current === operationId &&
      profileIdRef.current === profileId &&
      routeRef.current.handle === handle &&
      isProfileViewerCurrent(viewer, authRef.current)

    void (async () => {
      try {
        const { data, error } = await supabase
          .from('blocked_users')
          .select('blocker_id')
          .or(
            `and(blocker_id.eq.${viewer.userId},blocked_id.eq.${profileId}),and(blocker_id.eq.${profileId},blocked_id.eq.${viewer.userId})`
          )
          .limit(1)
          .abortSignal(abortController.signal)

        if (!operationIsCurrent()) return
        if (error) {
          logger.warn('Profile block lookup failed:', error)
          return
        }

        setBlockState({
          handle,
          viewerKey: viewer.viewerKey,
          sessionGeneration: viewer.sessionGeneration,
          userId: viewer.userId,
          profileId,
          blocked: Array.isArray(data) && data.length > 0,
        })
      } catch (error) {
        if (operationIsCurrent()) logger.warn('Profile block lookup threw:', error)
      }
    })()

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [
    auth.accessToken,
    auth.authChecked,
    auth.loading,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
    handle,
    profile?.id,
  ])

  return {
    // Core state
    email,
    currentUserId,
    profile,
    mounted,
    isPro,
    isOwnProfile,
    isBlocked,
    router,
    t,

    // Follower state
    modalType,
    setModalType,
    followersCount,
    setFollowersCount,
    followingCount,

    // Tab state
    activeProfileTab,
    handleProfileTabChange,

    // Trader state
    isTrader,
    traderData,
    isTraderDataLoading,
    isTraderDataError,
  }
}
