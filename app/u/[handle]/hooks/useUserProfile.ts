'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import useSWR from 'swr'
import { traderFetcher } from '@/lib/hooks/traderFetcher'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

import type { ServerProfile, ProfileTabKey, TraderPageData } from '../components/types'

// #31: traderFetcher extracted to lib/hooks/traderFetcher.ts (shared with TraderProfileClient)

interface UseUserProfileProps {
  handle: string
  serverProfile: ServerProfile | null
  serverTraderData?: TraderPageData | null
}

export function useUserProfile({ handle, serverProfile, serverTraderData }: UseUserProfileProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const { isPro } = useSubscription()

  const { userId: authUserId, email: authEmail } = useAuthSession()
  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<ServerProfile | null>(serverProfile)
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(serverProfile?.followers || 0)
  const [mounted, setMounted] = useState(false)
  const profileCreationRef = useRef(false)
  const searchParams = useSearchParams()
  const pathname = usePathname()

  useEffect(() => { setMounted(true) }, [])

  // Trader data - SWR with server fallback
  const isTrader = !!serverProfile?.traderHandle
  const { data: traderData, error: traderError, isLoading: traderLoading } = useSWR<TraderPageData>(
    isTrader ? `/api/traders/${encodeURIComponent(serverProfile!.traderHandle!)}` : null,
    traderFetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 0,
      dedupingInterval: 5000,
      errorRetryCount: 2,
      fallbackData: serverTraderData ?? undefined,
    }
  )

  // Tabs
  const urlTab = searchParams.get('tab')
  const [activeProfileTab, setActiveProfileTab] = useState<ProfileTabKey>(
    urlTab && ['overview', 'stats', 'portfolio'].includes(urlTab) ? urlTab as ProfileTabKey : 'overview'
  )

  const updateUrl = useCallback((tab: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'overview') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  const handleProfileTabChange = useCallback((tab: ProfileTabKey) => {
    setActiveProfileTab(tab)
    updateUrl(tab)
  }, [updateUrl])

  // Sync auth state from useAuthSession (no network call)
  useEffect(() => {
    setEmail(authEmail)
    setCurrentUserId(authUserId)

    if (!serverProfile && authUserId) {
      const emailHandle = authEmail?.split('@')[0]
      const isOwnProfile = handle === authUserId || handle === emailHandle
      if (isOwnProfile) {
        handleOwnProfileCreation(authUserId, emailHandle)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handle/serverProfile are initial props
  }, [authUserId, authEmail])

  async function handleOwnProfileCreation(userId: string, emailHandle?: string) {
    if (profileCreationRef.current) return
    profileCreationRef.current = true

    try {
      const { data: existingProfile } = await supabase
        .from('user_profiles')
        .select('id, handle, bio, avatar_url, cover_url, show_followers, show_following, subscription_tier, role')
        .eq('id', userId)
        .maybeSingle()

      if (existingProfile) {
        if (existingProfile.handle && existingProfile.handle !== handle) {
          router.replace(`/u/${encodeURIComponent(existingProfile.handle)}`)
          return
        }
        setProfile({
          id: existingProfile.id,
          handle: existingProfile.handle || handle,
          bio: existingProfile.bio || undefined,
          avatar_url: existingProfile.avatar_url || undefined,
          cover_url: existingProfile.cover_url || undefined,
          followers: 0,
          following: 0,
          followingTraders: 0,
          isRegistered: true,
          proBadgeTier: null,
          role: existingProfile.role || undefined,
        })
      } else {
        const defaultHandle = emailHandle || userId.slice(0, 8)
        const { error: insertError } = await supabase
          .from('user_profiles')
          .insert({ id: userId, handle: defaultHandle })

        if (insertError && insertError.code !== '23505') {
          logger.warn('Profile insert failed (non-conflict):', insertError)
        }

        const { data: newProfile, error: createError } = await supabase
          .from('user_profiles')
          .select('id, handle, bio, avatar_url, cover_url')
          .eq('id', userId)
          .maybeSingle()

        if (newProfile && !createError) {
          if (newProfile.handle && newProfile.handle !== handle) {
            router.replace(`/u/${encodeURIComponent(newProfile.handle)}`)
            return
          }
          setProfile({
            id: newProfile.id,
            handle: newProfile.handle || handle,
            bio: newProfile.bio || undefined,
            avatar_url: newProfile.avatar_url || undefined,
            cover_url: newProfile.cover_url || undefined,
            followers: 0,
            following: 0,
            followingTraders: 0,
            isRegistered: true,
            proBadgeTier: null,
          })
        }
      }
    } catch (error) {
      logger.error('Error creating own profile:', error)
      showToast(t('loadUserDataFailed'), 'error')
    }
  }

  const isOwnProfile = currentUserId === profile?.id
  const followingCount = (profile?.following || 0) + (profile?.followingTraders || 0)

  // Trader loading/error states
  const isTraderDataLoading = isTrader && traderLoading && !serverTraderData
  const isTraderDataError = isTrader && traderError && !traderData

  // Block check: bidirectional
  const [isBlocked, setIsBlocked] = useState(false)
  useEffect(() => {
    if (!currentUserId || !profile?.id || isOwnProfile) return
    supabase
      .from('blocked_users')
      .select('blocker_id')
      .or(`and(blocker_id.eq.${currentUserId},blocked_id.eq.${profile.id}),and(blocker_id.eq.${profile.id},blocked_id.eq.${currentUserId})`)
      .limit(1)
      .then(({ data }) => { if (data && data.length > 0) setIsBlocked(true) })
  }, [currentUserId, profile?.id, isOwnProfile])

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
