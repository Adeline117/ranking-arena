'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import useSWR from 'swr'
import { fetcher as rawFetcher } from '@/lib/hooks/useSWR'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

import type { ServerProfile, ProfileTabKey, TraderPageData } from '../components/types'

// Unwrap the API envelope { success, data } to get the raw TraderPageData
async function traderFetcher(url: string): Promise<TraderPageData> {
  const raw = await rawFetcher<{ success: boolean; data: TraderPageData }>(url)
  if (raw && typeof raw === 'object' && 'data' in raw && 'success' in raw) {
    return raw.data
  }
  return raw as unknown as TraderPageData
}

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
      refreshInterval: 60_000,
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

  // Auth check
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)

      if (!serverProfile && data.user) {
        const emailHandle = data.user.email?.split('@')[0]
        const isOwnProfile = handle === data.user.id || handle === emailHandle
        if (isOwnProfile) {
          handleOwnProfileCreation(data.user.id, emailHandle)
        }
      }
    }).catch((err) => {
      logger.error('[UserProfile] Auth check failed:', err)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; handle/serverProfile are initial props, supabase is stable
  }, [])

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

  return {
    // Core state
    email,
    currentUserId,
    profile,
    mounted,
    isPro,
    isOwnProfile,
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
