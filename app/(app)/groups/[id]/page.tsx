'use client'

import { features } from '@/lib/features'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState, useCallback, useMemo, useRef, useLayoutEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens, alpha } from '@/lib/design-tokens'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { getCsrfHeaders } from '@/lib/api/client'
import { localizedLabel } from '@/lib/utils/format'
import {
  GroupCardSkeleton,
  PostSkeleton,
  SkeletonAvatar,
  Skeleton,
} from '@/app/components/ui/Skeleton'
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import GroupHeader from './ui/GroupHeader'
import GroupPostList from './ui/GroupPostList'
import { GroupInfoModal, MembersListModal } from './ui/GroupMembersSection'
import { useGroupPosts, Post } from './hooks/useGroupPosts'
import PullToRefreshWrapper from '@/app/components/ui/PullToRefreshWrapper'
import { useAuthSession, type AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import { trackInteraction } from '@/lib/tracking'
import { trackEvent } from '@/lib/analytics/track'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import dynamic from 'next/dynamic'
import { buildJoinMembershipBody, parseMembershipAck } from './membership-client'
import {
  advanceGroupDetailResourceScope,
  canonicalGroupDetailId,
  GroupDetailParamsSourceLedger,
  groupDetailOwnerKey,
  isGroupDetailOwnerCurrent,
  type GroupDetailOwnerScope,
} from './group-detail-viewer-scope'

const ProUpsellModal = dynamic(
  () => import('@/app/components/ui/ProGate').then((m) => ({ default: m.ProUpsellModal })),
  { ssr: false }
)

interface Group {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  created_at?: string | null
  created_by?: string | null
  rules?: string | null
  rules_json?: Array<{ zh: string; en: string }> | null
  owner_handle?: string | null
  is_premium_only?: boolean | null
  status?: string | null
  dissolved_at?: string | null
  visibility?: 'open' | 'apply' | null
}

interface GroupMember {
  user_id: string
  role: string
  handle?: string | null
  avatar_url?: string | null
  joined_at?: string | null
}

type GroupDetailAuth = Pick<
  AuthSessionReturn,
  'accessToken' | 'authChecked' | 'email' | 'sessionGeneration' | 'userId' | 'viewerKey'
>

// Inline bilingual text helper (for one-off strings not in the i18n dictionary)
function _bilingualText(zh: string, en: string, language: string): string {
  return language === 'zh' ? zh : en
}

function isChineseText(text: string): boolean {
  if (!text) return false
  const chineseMatches = text.match(/[\u4e00-\u9fa5]/g)
  const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
  return chineseRatio > 0.1
}

interface PageWrapperProps {
  email: string | null
  children: React.ReactNode
}

function PageWrapper({ email, children }: PageWrapperProps): React.ReactElement {
  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      {children}
    </Box>
  )
}

export default function GroupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!features.social) redirect('/')

  const paramsSourceLedgerRef = useRef(new GroupDetailParamsSourceLedger())
  const paramsSourceScope = paramsSourceLedgerRef.current.capture(params)
  const [resolvedParams, setResolvedParams] = useState({ paramsRevision: 0, groupId: '' })
  const groupId =
    resolvedParams.paramsRevision === paramsSourceScope.paramsRevision
      ? canonicalGroupDetailId(resolvedParams.groupId) || ''
      : ''
  useEffect(() => {
    const expectedSource = paramsSourceScope
    Promise.resolve(params as Promise<{ id: string }> | { id: string })
      .then((resolved) => {
        if (!paramsSourceLedgerRef.current.isCurrent(expectedSource)) return
        setResolvedParams({
          paramsRevision: expectedSource.paramsRevision,
          groupId: String(resolved?.id ?? ''),
        })
      })
      .catch(() => {
        if (!paramsSourceLedgerRef.current.isCurrent(expectedSource)) return
        setResolvedParams({ paramsRevision: expectedSource.paramsRevision, groupId: '' })
      })
  }, [params, paramsSourceScope])

  const auth = useAuthSession()
  const resourceScopeRef = useRef({
    paramsRevision: 0,
    groupId: null as string | null,
    resourceGeneration: 0,
  })
  resourceScopeRef.current = advanceGroupDetailResourceScope(
    resourceScopeRef.current,
    paramsSourceScope.paramsRevision,
    groupId
  )
  const scopedParamsRevision = resourceScopeRef.current.paramsRevision
  const scopedGroupId = resourceScopeRef.current.groupId
  const scopedResourceGeneration = resourceScopeRef.current.resourceGeneration
  const ownerScope: GroupDetailOwnerScope = useMemo(
    () => ({
      userId: auth.userId,
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      paramsRevision: scopedParamsRevision,
      groupId: scopedGroupId,
      resourceGeneration: scopedResourceGeneration,
    }),
    [
      auth.sessionGeneration,
      auth.userId,
      auth.viewerKey,
      scopedGroupId,
      scopedParamsRevision,
      scopedResourceGeneration,
    ]
  )
  const currentOwnerScopeRef = useRef(ownerScope)
  const currentAccessTokenRef = useRef(auth.accessToken)
  currentOwnerScopeRef.current = ownerScope
  currentAccessTokenRef.current = auth.accessToken
  const ownerKey = groupDetailOwnerKey(ownerScope, auth.accessToken)
  return (
    <GroupDetailScopedPage
      key={ownerKey}
      groupId={groupId}
      ownerScope={ownerScope}
      auth={auth}
      currentOwnerScopeRef={currentOwnerScopeRef}
      currentAccessTokenRef={currentAccessTokenRef}
    />
  )
}

function GroupDetailScopedPage({
  groupId,
  ownerScope,
  auth,
  currentOwnerScopeRef,
  currentAccessTokenRef,
}: {
  groupId: string
  ownerScope: GroupDetailOwnerScope
  auth: GroupDetailAuth
  currentOwnerScopeRef: React.MutableRefObject<GroupDetailOwnerScope>
  currentAccessTokenRef: React.MutableRefObject<string | null>
}) {
  const abortControllerRef = useRef<AbortController | null>(null)

  const { language, t } = useLanguage()
  const { showToast: unsafeShowToast } = useToast()
  const { showDangerConfirm: unsafeShowDangerConfirm } = useDialog()
  const { isFeaturesUnlocked: isPro } = useSubscription()
  const searchParams = useSearchParams()
  const { accessToken, email, userId } = auth
  const mountedRef = useRef(true)
  const renderedOwnerScopeRef = useRef<GroupDetailOwnerScope>(ownerScope)
  const renderedAccessTokenRef = useRef(accessToken)
  renderedOwnerScopeRef.current = {
    ...ownerScope,
    userId: auth.userId,
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
  }
  renderedAccessTokenRef.current = accessToken
  const isCurrent = useCallback(
    (expected: GroupDetailOwnerScope) => {
      return (
        mountedRef.current &&
        isGroupDetailOwnerCurrent(
          expected,
          currentOwnerScopeRef.current,
          currentAccessTokenRef.current
        ) &&
        isGroupDetailOwnerCurrent(
          expected,
          renderedOwnerScopeRef.current,
          renderedAccessTokenRef.current
        )
      )
    },
    [currentAccessTokenRef, currentOwnerScopeRef]
  )
  const ownerReady =
    isGroupDetailOwnerCurrent(
      ownerScope,
      currentOwnerScopeRef.current,
      currentAccessTokenRef.current
    ) &&
    isGroupDetailOwnerCurrent(
      ownerScope,
      renderedOwnerScopeRef.current,
      renderedAccessTokenRef.current
    )
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortControllerRef.current?.abort()
    }
  }, [])
  const showToast = useCallback(
    (...args: Parameters<typeof unsafeShowToast>) => {
      if (isCurrent(ownerScope)) unsafeShowToast(...args)
    },
    [isCurrent, ownerScope, unsafeShowToast]
  )
  const showDangerConfirm = useCallback(
    async (...args: Parameters<typeof unsafeShowDangerConfirm>) => {
      const requestScope = ownerScope
      if (!isCurrent(requestScope)) return false
      const confirmed = await unsafeShowDangerConfirm(...args)
      return isCurrent(requestScope) ? confirmed : false
    },
    [isCurrent, ownerScope, unsafeShowDangerConfirm]
  )

  useEffect(() => {
    const expectedScope = ownerScope
    if (!isCurrent(expectedScope)) return
    trackInteraction({ action: 'view', target_type: 'group', target_id: groupId })
  }, [groupId, isCurrent, ownerReady, ownerScope])

  // Group state
  const [group, setGroup] = useState<Group | null>(null)
  const [isMember, setIsMember] = useState(false)
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member' | null>(null)
  const [rawLoading, setLoading] = useState(true)
  const loading = rawLoading || !ownerReady
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [proUpsellOpen, unsafeSetProUpsellOpen] = useState(false)
  const membershipOperationRef = useRef<symbol | null>(null)

  // Member preview (avatar stack)
  const [memberPreviews, setMemberPreviews] = useState<
    Array<{ avatar_url?: string | null; handle?: string | null }>
  >([])

  // Modals
  const [showGroupInfo, unsafeSetShowGroupInfo] = useState(false)
  const [showMembersList, unsafeSetShowMembersList] = useState(false)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const membersOperationRef = useRef<symbol | null>(null)

  const setProUpsellOpen = useCallback(
    (value: boolean) => {
      if (isCurrent(ownerScope)) unsafeSetProUpsellOpen(value)
    },
    [isCurrent, ownerScope]
  )
  const setShowGroupInfo = useCallback(
    (value: boolean) => {
      if (isCurrent(ownerScope)) unsafeSetShowGroupInfo(value)
    },
    [isCurrent, ownerScope]
  )
  const setShowMembersList = useCallback(
    (value: boolean) => {
      if (isCurrent(ownerScope)) unsafeSetShowMembersList(value)
    },
    [isCurrent, ownerScope]
  )

  // Translation
  const [translatedPosts, setTranslatedPosts] = useState<
    Record<string, { title?: string; content?: string }>
  >({})
  const [translatingPosts, setTranslatingPosts] = useState(false)

  // Related groups
  const [relatedGroups, setRelatedGroups] = useState<
    Array<{
      id: string
      name: string
      name_en?: string | null
      avatar_url?: string | null
      member_count?: number | null
    }>
  >([])
  const [loadingRelatedGroups, setLoadingRelatedGroups] = useState(true)

  // Posts hook
  const postsHook = useGroupPosts({
    groupId,
    userId,
    accessToken,
    authChecked: auth.authChecked,
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    isMember,
    groupVisibility: group?.visibility ?? null,
    audienceResolved: !loading && !!group,
    language,
    t,
    showToast,
    showDangerConfirm,
  })

  // sessionStorage cache helpers for translations
  const getTranslationCache = useCallback(
    (postId: string, lang: string): { title?: string; content?: string } | null => {
      try {
        const key = `trans:${postId}:${lang}`
        const cached = sessionStorage.getItem(key)
        return cached ? JSON.parse(cached) : null
      } catch {
        return null
      }
    },
    []
  )

  const setTranslationCache = useCallback(
    (postId: string, lang: string, value: { title?: string; content?: string }) => {
      if (!isCurrent(ownerScope)) return
      try {
        const key = `trans:${postId}:${lang}`
        sessionStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* storage full, ignore */
      }
    },
    [isCurrent, ownerScope]
  )

  // Batch translate posts (with sessionStorage cache)
  const translatePosts = useCallback(
    async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
      const requestScope = ownerScope
      const requestToken = accessToken
      const requestIsCurrent = () => isCurrent(requestScope)
      if (translatingPosts || !requestIsCurrent()) return
      setTranslatingPosts(true)

      try {
        // Check cache first
        const cachedResults: Record<string, { title?: string; content?: string }> = {}
        const needsTranslation = postsToTranslate.filter((p) => {
          if (translatedPosts[p.id]?.title) return false
          if (!p.title) return false
          const titleIsChinese = isChineseText(p.title)
          const needsIt = targetLang === 'en' ? titleIsChinese : !titleIsChinese
          if (!needsIt) return false
          const cached = getTranslationCache(p.id, targetLang)
          if (cached) {
            cachedResults[p.id] = cached
            return false
          }
          return true
        })

        if (!requestIsCurrent()) return
        if (Object.keys(cachedResults).length > 0) {
          setTranslatedPosts((prev) => ({ ...prev, ...cachedResults }))
        }

        if (needsTranslation.length === 0) return
        // /api/translate requires auth — skip silently for anonymous visitors
        if (!requestToken || !requestIsCurrent()) return

        const items: Array<{
          id: string
          text: string
          contentType: 'post_title' | 'post_content'
          contentId: string
        }> = []
        needsTranslation.slice(0, 10).forEach((post) => {
          if (post.title)
            items.push({
              id: `${post.id}-title`,
              text: post.title,
              contentType: 'post_title',
              contentId: post.id,
            })
          if (post.content)
            items.push({
              id: `${post.id}-content`,
              text: post.content,
              contentType: 'post_content',
              contentId: post.id,
            })
        })

        if (items.length === 0 || !requestIsCurrent()) return

        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${requestToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ items, targetLang }),
        })
        if (!requestIsCurrent()) return

        if (!response.ok) {
          if (requestIsCurrent()) logger.warn('Translation API failed:', response.status)
          return
        }

        const data = await response.json()
        if (!requestIsCurrent()) return
        if (data.success && data.data?.results) {
          const results = data.data.results as Record<
            string,
            { translatedText: string; cached: boolean }
          >
          const translatedResults: Record<string, { title?: string; content?: string }> = {}
          needsTranslation.forEach((post) => {
            translatedResults[post.id] = {
              title: results[`${post.id}-title`]?.translatedText || post.title || '',
              content: results[`${post.id}-content`]?.translatedText || post.content || '',
            }
          })
          if (!requestIsCurrent()) return
          for (const [postId, translated] of Object.entries(translatedResults)) {
            setTranslationCache(postId, targetLang, translated)
          }
          setTranslatedPosts((prev) => ({ ...prev, ...translatedResults }))
        }
      } catch (error) {
        if (requestIsCurrent()) logger.warn('Translation failed:', error)
      } finally {
        if (requestIsCurrent()) setTranslatingPosts(false)
      }
    },
    [
      accessToken,
      getTranslationCache,
      isCurrent,
      ownerScope,
      setTranslationCache,
      translatedPosts,
      translatingPosts,
    ]
  )

  // Trigger translation when posts change
  useEffect(() => {
    const expectedScope = ownerScope
    if (isCurrent(expectedScope) && postsHook.posts.length > 0 && !translatingPosts) {
      // en/ja/ko → English (API only supports en/zh); zh → Chinese
      translatePosts(postsHook.posts, language === 'zh' ? 'zh' : 'en')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- translatePosts excluded to avoid infinite loop; only trigger on posts/language change
  }, [postsHook.posts, language, ownerReady])

  // Related groups
  useEffect(() => {
    const expectedScope = ownerScope
    const requestGroupId = expectedScope.groupId
    if (!requestGroupId || !isCurrent(expectedScope)) return
    let active = true
    const requestIsCurrent = () => active && isCurrent(expectedScope)

    const fetchRelatedGroups = async () => {
      if (!requestIsCurrent()) return
      setLoadingRelatedGroups(true)

      try {
        const { data, error } = await supabase.rpc('get_related_groups', {
          p_group_id: requestGroupId,
          p_limit: 5,
        })
        if (!requestIsCurrent()) return

        if (error || !data || data.length === 0) {
          // Fallback to hot groups
          const { data: fallback, error: fallbackError } = await supabase
            .from('groups')
            .select('id, name, name_en, avatar_url, member_count')
            .neq('id', requestGroupId)
            .order('member_count', { ascending: false, nullsFirst: false })
            .limit(5)
          if (!requestIsCurrent()) return
          if (fallbackError) throw fallbackError
          setRelatedGroups(fallback || [])
        } else {
          setRelatedGroups(data)
        }
      } catch (err) {
        if (requestIsCurrent()) {
          logger.error('Error fetching related groups:', err)
          setRelatedGroups([])
        }
      } finally {
        if (requestIsCurrent()) setLoadingRelatedGroups(false)
      }
    }

    void fetchRelatedGroups()
    return () => {
      active = false
    }
  }, [groupId, isCurrent, ownerReady, ownerScope])

  // Load group data + initial posts
  useEffect(() => {
    const expectedScope = ownerScope
    const requestGroupId = expectedScope.groupId
    const requestUserId = expectedScope.userId
    if (!requestGroupId || !isCurrent(expectedScope)) return

    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller
    let active = true
    const requestIsCurrent = () => active && isCurrent(expectedScope)

    const load = async () => {
      if (!requestIsCurrent()) return
      setLoading(true)
      setError(null)

      try {
        // Parallelize all independent queries (was sequential waterfall)
        const [groupResult, previewResult, membershipResult] = await Promise.all([
          // 1. Group data
          supabase
            .from('groups')
            .select(
              'id, name, name_en, description, description_en, avatar_url, member_count, created_at, created_by, rules, rules_json, is_premium_only, visibility, dissolved_at'
            )
            .eq('id', requestGroupId)
            .maybeSingle(),
          // 2. Member avatar previews (5 most recent)
          // NOTE: no FK from group_members.user_id → user_profiles (it references
          // auth.users), so PostgREST embeds 400 with PGRST200. Two-step fetch below.
          supabase
            .from('group_member_directory')
            .select('user_id')
            .eq('group_id', requestGroupId)
            .order('joined_at', { ascending: false })
            .limit(5),
          // 3. Membership check (if logged in)
          requestUserId
            ? supabase
                .from('own_group_memberships')
                .select('role')
                .eq('group_id', requestGroupId)
                .eq('user_id', requestUserId)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ])
        if (!requestIsCurrent()) return

        const { data: groupData, error: groupErr } = groupResult

        if (groupErr) {
          const isInvalidId =
            groupErr.code === '22P02' || groupErr.message?.includes('invalid input syntax')
          setError(isInvalidId ? t('groupNotFound') : t('loadFailed'))
          return
        }
        if (previewResult.error) throw previewResult.error
        if ('error' in membershipResult && membershipResult.error) throw membershipResult.error
        if (groupData && canonicalGroupDetailId(groupData.id) !== requestGroupId) {
          throw new Error('Group response did not match the requested resource')
        }

        const previewRows = previewResult.data || []
        const previewIds = previewRows.map((member) => member.user_id).filter(Boolean)
        if (!requestIsCurrent()) return
        const [ownerResult, previewProfilesResult] = await Promise.all([
          groupData?.created_by
            ? supabase
                .from('user_profiles')
                .select('handle')
                .eq('id', groupData.created_by)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          previewIds.length
            ? supabase.from('user_profiles').select('id, handle, avatar_url').in('id', previewIds)
            : Promise.resolve({ data: null, error: null }),
        ])
        if (!requestIsCurrent()) return
        if (ownerResult.error) throw ownerResult.error
        if (previewProfilesResult.error) throw previewProfilesResult.error

        const ownerHandle = ownerResult.data?.handle ?? null
        const profileById = new Map(
          (previewProfilesResult.data || []).map((profile) => [profile.id, profile])
        )
        const loadedMemberPreviews = previewRows
          .map((member) => {
            const profile = profileById.get(member.user_id)
            return {
              avatar_url: profile?.avatar_url,
              handle: profile?.handle,
            }
          })
          .filter((member) => member.avatar_url || member.handle)

        if (!requestIsCurrent()) return
        const loadedRole =
          requestUserId && membershipResult.data
            ? (membershipResult.data.role as 'owner' | 'admin' | 'member' | null)
            : null
        setGroup(groupData ? ({ ...groupData, owner_handle: ownerHandle } as Group) : null)
        setMemberPreviews(loadedMemberPreviews)
        setIsMember(Boolean(requestUserId && membershipResult.data))
        setUserRole(loadedRole)

        // Load posts for all visitors (non-members can browse read-only)
        if (!requestIsCurrent()) return
        await postsHook.loadPosts(true)
        if (!requestIsCurrent()) return
      } catch (err) {
        if (!requestIsCurrent()) return
        logger.error('Error loading group detail:', err)
        setError(t('loadFailed'))
        showToast(t('loadFailed'), 'error')
      } finally {
        if (requestIsCurrent()) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase/postsHook/showToast/t are stable; load group data on mount or when userId changes
  }, [groupId, isCurrent, ownerReady, ownerScope, userId])

  // Fallback: Load posts when membership state changes (for non-cold-start cases)
  useEffect(() => {
    const expectedScope = ownerScope
    if (
      !isCurrent(expectedScope) ||
      !groupId ||
      loading ||
      postsHook.posts.length > 0 ||
      postsHook.loadingMore
    )
      return
    let active = true
    const trigger = async () => {
      if (!active || !isCurrent(expectedScope)) return
      await postsHook.loadPosts(true)
      if (!active || !isCurrent(expectedScope)) return
    }
    void trigger()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- postsHook.loadPosts/posts/loadingMore excluded to avoid infinite loop; fallback trigger only
  }, [isMember, groupId, loading, ownerReady])

  // Invite auto-join
  useEffect(() => {
    const expectedScope = ownerScope
    const inviteToken = searchParams.get('invite')
    if (!isCurrent(expectedScope) || !inviteToken || !userId || !groupId || isMember || loading)
      return

    // Redemption is one write: the membership API verifies and consumes this
    // exact token atomically. A separate GET must never pre-consume capacity.
    void handleJoin(inviteToken)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleJoin excluded; only re-run when invite params or auth state change
  }, [searchParams, userId, groupId, isMember, loading, ownerReady])

  // Join group (via API)
  const handleJoin = useCallback(
    async (inviteToken?: string) => {
      const requestScope = ownerScope
      const requestUserId = requestScope.userId
      const requestGroupId = requestScope.groupId
      const requestToken = accessToken
      const requestIsCurrent = () => isCurrent(requestScope)
      if (!requestIsCurrent()) return
      if (!requestUserId) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }
      if (!inviteToken && group?.is_premium_only && !isPro) {
        // Upsell modal instead of a dead-end toast (API still enforces
        // premium membership server-side — this is the UX layer only).
        trackEvent('paywall_blocked', { source: 'premium_group_join' })
        setProUpsellOpen(true)
        return
      }
      if (!requestGroupId || !requestToken || membershipOperationRef.current) return

      const operation = Symbol('group-membership-join')
      membershipOperationRef.current = operation
      setJoining(true)
      try {
        if (!requestIsCurrent()) return
        const res = await fetch(`/api/groups/${requestGroupId}/membership`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${requestToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify(buildJoinMembershipBody(inviteToken)),
        })
        if (!requestIsCurrent()) return

        const data: unknown = await res.json().catch(() => null)
        if (!requestIsCurrent()) return
        if (!res.ok) {
          const errorMessage =
            data && typeof data === 'object' && !Array.isArray(data)
              ? (data as { error?: unknown }).error
              : null
          throw new Error(typeof errorMessage === 'string' ? errorMessage : t('joinFailed'))
        }

        const ack = parseMembershipAck(data)
        if (!ack) {
          throw new Error('Invalid membership acknowledgement')
        }

        if (ack.action === 'requested') {
          if (!requestIsCurrent()) return
          showToast(t('joinRequestSubmitted'), 'success')
          return
        }

        if (!requestIsCurrent()) return
        if (ack.member_count !== undefined) {
          setGroup((prev) => (prev ? { ...prev, member_count: ack.member_count } : prev))
        }
        setIsMember(true)
        setUserRole(ack.action === 'already_member' ? (ack.role ?? 'member') : 'member')
        if (ack.action === 'joined') {
          trackEvent('group_join', { group_id: requestGroupId })
        }
        showToast(t('joinSuccess'), 'success')
      } catch (err) {
        if (requestIsCurrent()) {
          logger.error('Join error:', err)
          showToast(t(inviteToken ? 'inviteInvalidOrExpired' : 'joinFailed'), 'error')
        }
      } finally {
        if (membershipOperationRef.current === operation) {
          membershipOperationRef.current = null
          if (requestIsCurrent()) setJoining(false)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, group, isPro, groupId, accessToken, showToast, ownerScope, isCurrent]
  )

  // Leave group (with confirmation)
  const handleLeave = useCallback(async () => {
    const requestScope = ownerScope
    const requestUserId = requestScope.userId
    const requestGroupId = requestScope.groupId
    const requestToken = accessToken
    const requestIsCurrent = () => isCurrent(requestScope)
    if (!requestUserId || !requestGroupId || !requestToken || !requestIsCurrent()) return
    const confirmed = await showDangerConfirm(t('leaveGroup'), t('leaveGroupConfirm'))
    if (!confirmed || !requestIsCurrent() || membershipOperationRef.current) return
    const operation = Symbol('group-membership-leave')
    membershipOperationRef.current = operation
    setJoining(true)
    try {
      if (!requestIsCurrent()) return
      const res = await fetch(`/api/groups/${requestGroupId}/membership`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${requestToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ action: 'leave' }),
      })
      if (!requestIsCurrent()) return

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (!requestIsCurrent()) return
        const errorMessage =
          data && typeof data === 'object' && 'error' in data
            ? (data as { error?: unknown }).error
            : null
        throw new Error(typeof errorMessage === 'string' ? errorMessage : t('leaveFailed'))
      }

      if (!requestIsCurrent()) return
      setGroup((prev) =>
        prev ? { ...prev, member_count: Math.max(0, (prev.member_count || 1) - 1) } : prev
      )
      setIsMember(false)
      setUserRole(null)
      showToast(t('leftGroup'), 'success')
    } catch (err) {
      if (requestIsCurrent()) {
        logger.error('Leave error:', err)
        showToast(t('leaveFailed'), 'error')
      }
    } finally {
      if (membershipOperationRef.current === operation) {
        membershipOperationRef.current = null
        if (requestIsCurrent()) setJoining(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; getCsrfHeaders is a pure utility
  }, [userId, groupId, accessToken, showToast, showDangerConfirm, ownerScope, isCurrent])

  // Load members
  const loadMembers = async () => {
    const requestScope = ownerScope
    const requestGroupId = requestScope.groupId
    const requestIsCurrent = () => isCurrent(requestScope)
    if (loadingMembers || !requestGroupId || !requestIsCurrent() || membersOperationRef.current)
      return
    const operation = Symbol('group-members-load')
    membersOperationRef.current = operation
    setLoadingMembers(true)
    try {
      // Two-step query: group_members has no FK to user_profiles (user_id references
      // auth.users), so a PostgREST embed 400s with PGRST200. Fetch members, then profiles.
      const membersResult = await supabase
        .from('group_member_directory')
        .select('user_id, role, joined_at')
        .eq('group_id', requestGroupId)
        .order('role', { ascending: true })
        .order('joined_at', { ascending: true })
      if (!requestIsCurrent()) return
      if (membersResult.error) throw membersResult.error

      const membersData = membersResult.data || []
      let memberProfiles: Array<{
        id: string
        handle?: string | null
        avatar_url?: string | null
      }> = []
      if (membersData.length > 0) {
        const memberIds = membersData.map((m) => m.user_id).filter(Boolean)
        if (memberIds.length > 0) {
          const profilesResult = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url')
            .in('id', memberIds)
          if (!requestIsCurrent()) return
          if (profilesResult.error) throw profilesResult.error
          memberProfiles = profilesResult.data || []
        }
      }

      if (!requestIsCurrent()) return
      const profileById = new Map(memberProfiles.map((p) => [p.id, p]))
      const sortedMembers = membersData
        .map((m) => {
          const profile = profileById.get(m.user_id)
          return {
            user_id: m.user_id,
            role: m.role,
            joined_at: m.joined_at,
            handle: profile?.handle,
            avatar_url: profile?.avatar_url,
          }
        })
        .sort((a, b) => {
          const roleOrder: Record<string, number> = { owner: 0, admin: 1, member: 2 }
          return (roleOrder[a.role] || 2) - (roleOrder[b.role] || 2)
        })

      setMembers(sortedMembers)
    } catch (err) {
      if (requestIsCurrent()) {
        logger.error('Load members error:', err)
        showToast(t('loadMembersFailed'), 'error')
      }
    } finally {
      if (membersOperationRef.current === operation) {
        membersOperationRef.current = null
        if (requestIsCurrent()) setLoadingMembers(false)
      }
    }
  }

  // Loading state
  if (loading) {
    return (
      <PageWrapper email={email}>
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Box style={{ marginBottom: tokens.spacing[6] }}>
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[4],
                marginBottom: tokens.spacing[4],
              }}
            >
              <SkeletonAvatar size={80} />
              <Box style={{ flex: 1 }}>
                <Skeleton width="200px" height="24px" />
                <Skeleton width="120px" height="14px" />
              </Box>
            </Box>
            <Skeleton width="100%" height="60px" />
          </Box>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {[1, 2, 3].map((i) => (
              <PostSkeleton key={i} />
            ))}
          </Box>
        </Box>
      </PageWrapper>
    )
  }

  // Error state
  if (error || !group) {
    return (
      <PageWrapper email={email}>
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text
            size="lg"
            weight="bold"
            style={{ marginBottom: tokens.spacing[2], color: 'var(--color-accent-error)' }}
          >
            {t('error')}: {error || t('groupNotFound')}
          </Text>
          <Link
            href="/groups"
            style={{
              color: tokens.colors.accent?.primary || tokens.colors.text.secondary,
              textDecoration: 'none',
              marginTop: tokens.spacing[3],
              display: 'inline-block',
            }}
          >
            ← {t('backToGroups')}
          </Link>
        </Box>
      </PageWrapper>
    )
  }

  return (
    <PageWrapper email={email}>
      {group?.dissolved_at && (
        <Box
          style={{
            background: 'var(--color-accent-warning-10)',
            border: '1px solid var(--color-accent-warning)',
            borderRadius: 8,
            padding: '10px 16px',
            margin: '0 16px 16px',
            textAlign: 'center',
            fontSize: 13,
            color: 'var(--color-accent-warning)',
            fontWeight: 600,
          }}
        >
          {t('groupDissolvedBanner')}
        </Box>
      )}
      <Box
        as="main"
        className="content-sidebar-grid"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
          display: 'grid',
          gap: tokens.spacing[6],
        }}
      >
        {/* Main Content */}
        <PullToRefreshWrapper
          onRefresh={async () => {
            await postsHook.loadPosts()
          }}
          disabled={!isMember}
        >
          <Box>
            <Breadcrumb
              items={[
                { label: t('groups'), href: '/groups' },
                {
                  label:
                    (language !== 'zh' && group?.name_en ? group?.name_en : group?.name) ||
                    t('loading'),
                },
              ]}
            />
            <GroupHeader
              group={group}
              groupId={groupId}
              language={language}
              userId={userId}
              accessToken={accessToken}
              isMember={isMember}
              userRole={userRole}
              joining={joining}
              isDissolved={!!group?.dissolved_at}
              onJoin={() => handleJoin()}
              onLeave={handleLeave}
              onShowGroupInfo={() => setShowGroupInfo(true)}
              onShowMembers={() => {
                setShowMembersList(true)
                loadMembers()
              }}
              memberPreviews={memberPreviews}
            />

            <SectionErrorBoundary fallbackMessage={t('postsSectionFailed')}>
              <GroupPostList
                groupId={groupId}
                language={language}
                userId={userId}
                accessToken={accessToken}
                userRole={userRole}
                isMember={isMember}
                joining={joining}
                onJoin={() => handleJoin()}
                sortedPosts={postsHook.sortedPosts}
                sortMode={postsHook.sortMode}
                setSortMode={postsHook.setSortMode}
                viewMode={postsHook.viewMode}
                setViewMode={postsHook.setViewMode}
                hasMorePosts={postsHook.hasMorePosts}
                loadingMore={postsHook.loadingMore}
                sentinelRef={postsHook.sentinelRef}
                editingPost={postsHook.editingPost}
                setEditingPost={postsHook.setEditingPost}
                editTitle={postsHook.editTitle}
                setEditTitle={postsHook.setEditTitle}
                editContent={postsHook.editContent}
                setEditContent={postsHook.setEditContent}
                savingEdit={postsHook.savingEdit}
                deletingPost={postsHook.deletingPost}
                likeLoading={postsHook.likeLoading}
                bookmarkLoading={postsHook.bookmarkLoading}
                repostLoading={postsHook.repostLoading}
                showRepostModal={postsHook.showRepostModal}
                setShowRepostModal={postsHook.setShowRepostModal}
                repostComment={postsHook.repostComment}
                setRepostComment={postsHook.setRepostComment}
                expandedComments={postsHook.expandedComments}
                comments={postsHook.comments}
                newComment={postsHook.newComment}
                setNewComment={postsHook.setNewComment}
                commentLoading={postsHook.commentLoading}
                replyingTo={postsHook.replyingTo}
                setReplyingTo={postsHook.setReplyingTo}
                replyContent={postsHook.replyContent}
                setReplyContent={postsHook.setReplyContent}
                expandedReplies={postsHook.expandedReplies}
                setExpandedReplies={postsHook.setExpandedReplies}
                expandedPosts={postsHook.expandedPosts}
                setExpandedPosts={postsHook.setExpandedPosts}
                translatedPosts={translatedPosts}
                handleLike={postsHook.handleLike}
                handleBookmark={postsHook.handleBookmark}
                handleRepost={postsHook.handleRepost}
                handleDeletePost={postsHook.handleDeletePost}
                handleSaveEdit={postsHook.handleSaveEdit}
                handlePinPost={postsHook.handlePinPost}
                toggleComments={postsHook.toggleComments}
                submitComment={postsHook.submitComment}
                submitReply={postsHook.submitReply}
                getHeatColor={postsHook.getHeatColor}
              />
            </SectionErrorBoundary>

            {/* Floating Post Button */}
            {isMember && !group?.dissolved_at && (
              <Link
                href={`/groups/${groupId}/new`}
                aria-label={t('groupNewPost')}
                style={{
                  position: 'fixed',
                  bottom: `calc(${tokens.spacing[20]} + env(safe-area-inset-bottom, 0px))`,
                  right: tokens.spacing[6],
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: tokens.gradient.primary,
                  color: tokens.colors.white,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textDecoration: 'none',
                  boxShadow: `0 4px 16px ${alpha(tokens.colors.accent?.primary || tokens.colors.accent.brand, 31)}`,
                  zIndex: tokens.zIndex.sticky,
                  transition: `all ${tokens.transition.base}`,
                }}
                className="hover-scale"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </Link>
            )}
          </Box>
        </PullToRefreshWrapper>

        {/* Right Sidebar */}
        <Box
          className="hide-mobile"
          style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}
        >
          <RelatedGroupsSidebar
            groups={relatedGroups}
            loading={loadingRelatedGroups}
            language={language}
          />
        </Box>

        {/* Modals */}
        {showGroupInfo && group && (
          <GroupInfoModal
            group={group}
            language={language}
            onClose={() => setShowGroupInfo(false)}
            onShowMembers={() => {
              setShowMembersList(true)
              loadMembers()
            }}
          />
        )}

        {showMembersList && (
          <MembersListModal
            members={members}
            memberCount={group?.member_count || 0}
            loading={loadingMembers}
            language={language}
            onClose={() => setShowMembersList(false)}
          />
        )}

        <ProUpsellModal
          open={proUpsellOpen}
          onClose={() => setProUpsellOpen(false)}
          featureKey="proMembersOnly"
        />
      </Box>
    </PageWrapper>
  )
}

function RelatedGroupsSidebar({
  groups,
  loading,
  language,
}: {
  groups: Array<{
    id: string
    name: string
    name_en?: string | null
    avatar_url?: string | null
    member_count?: number | null
  }>
  loading: boolean
  language: string
}) {
  const { t } = useLanguage()
  return (
    <Box
      style={{
        position: 'sticky',
        top: 80,
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
        {t('peopleHereAlsoVisit')}
      </Text>

      {loading ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {[1, 2, 3].map((i) => (
            <GroupCardSkeleton key={i} />
          ))}
        </Box>
      ) : groups.length === 0 ? (
        <Text
          size="sm"
          color="tertiary"
          style={{ textAlign: 'center', padding: tokens.spacing[4] }}
        >
          {t('noRecommendations')}
        </Text>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {groups.map((relGroup) => (
            <Link
              key={relGroup.id}
              href={`/groups/${relGroup.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg,
                background: 'transparent',
                border: '1px solid transparent',
                textDecoration: 'none',
                color: tokens.colors.text.primary,
                transition: `all ${tokens.transition.base}`,
              }}
              className="hover-slide-right"
            >
              <Box
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: tokens.radius.md,
                  background:
                    'linear-gradient(135deg, var(--color-accent-primary-20) 0%, var(--color-accent-primary-10) 100%)',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  flexShrink: 0,
                  position: 'relative',
                }}
              >
                <Text size="sm" weight="bold" style={{ color: 'var(--color-brand-accent)' }}>
                  {relGroup.name.charAt(0).toUpperCase()}
                </Text>
                {relGroup.avatar_url && (
                  <img
                    src={avatarSrc(relGroup.avatar_url)}
                    alt={relGroup.name}
                    width={40}
                    height={40}
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      position: 'absolute',
                      inset: 0,
                    }}
                    onError={(e) => {
                      ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                    }}
                  />
                )}
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text
                  size="sm"
                  weight="medium"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginBottom: 2,
                  }}
                >
                  {localizedLabel(relGroup.name, relGroup.name_en, language)}
                </Text>
                {relGroup.member_count != null && (
                  <Text size="xs" color="tertiary">
                    {relGroup.member_count} {t('membersUnit')}
                  </Text>
                )}
              </Box>
            </Link>
          ))}
        </Box>
      )}
    </Box>
  )
}
