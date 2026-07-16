'use client'

import { features } from '@/lib/features'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState, useCallback, useRef } from 'react'
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
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import { trackInteraction } from '@/lib/tracking'
import { trackEvent } from '@/lib/analytics/track'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import dynamic from 'next/dynamic'
import { buildJoinMembershipBody, parseMembershipAck } from './membership-client'

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

  const [groupId, setGroupId] = useState<string>('')
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      ;(params as Promise<{ id: string }>)
        .then((resolved) => {
          setGroupId(resolved.id)
        })
        // eslint-disable-next-line no-restricted-syntax
        .catch(() => {
          /* Intentionally swallowed: params resolution should not fail */
        })
    } else {
      setGroupId(String((params as { id: string })?.id ?? ''))
    }
  }, [params])

  useEffect(() => {
    if (groupId && groupId !== 'loading') {
      trackInteraction({ action: 'view', target_type: 'group', target_id: groupId })
    }
  }, [groupId])

  const { language, t } = useLanguage()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const { isFeaturesUnlocked: isPro } = useSubscription()
  const searchParams = useSearchParams()
  const auth = useAuthSession()
  const { accessToken, email, userId } = auth

  // Group state
  const [group, setGroup] = useState<Group | null>(null)
  const [isMember, setIsMember] = useState(false)
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member' | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [proUpsellOpen, setProUpsellOpen] = useState(false)

  // Member preview (avatar stack)
  const [memberPreviews, setMemberPreviews] = useState<
    Array<{ avatar_url?: string | null; handle?: string | null }>
  >([])

  // Modals
  const [showGroupInfo, setShowGroupInfo] = useState(false)
  const [showMembersList, setShowMembersList] = useState(false)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)

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
      try {
        const key = `trans:${postId}:${lang}`
        sessionStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* storage full, ignore */
      }
    },
    []
  )

  // Batch translate posts (with sessionStorage cache)
  const translatePosts = useCallback(
    async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
      if (translatingPosts) return
      setTranslatingPosts(true)

      // Check cache first
      const cachedResults: Record<string, { title?: string; content?: string }> = {}
      const needsTranslation = postsToTranslate.filter((p) => {
        if (translatedPosts[p.id]?.title) return false
        if (!p.title) return false
        const titleIsChinese = isChineseText(p.title)
        const needsIt = targetLang === 'en' ? titleIsChinese : !titleIsChinese
        if (!needsIt) return false
        // Check sessionStorage cache
        const cached = getTranslationCache(p.id, targetLang)
        if (cached) {
          cachedResults[p.id] = cached
          return false
        }
        return true
      })

      // Apply cached results
      if (Object.keys(cachedResults).length > 0) {
        setTranslatedPosts((prev) => ({ ...prev, ...cachedResults }))
      }

      if (needsTranslation.length === 0) {
        setTranslatingPosts(false)
        return
      }

      // /api/translate requires auth — skip silently for anonymous visitors
      if (!accessToken) {
        setTranslatingPosts(false)
        return
      }

      try {
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

        if (items.length === 0) {
          setTranslatingPosts(false)
          return
        }

        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ items, targetLang }),
        })

        if (!response.ok) {
          logger.warn('Translation API failed:', response.status)
          setTranslatingPosts(false)
          return
        }

        const data = await response.json()
        if (data.success && data.data?.results) {
          const results = data.data.results as Record<
            string,
            { translatedText: string; cached: boolean }
          >
          setTranslatedPosts((prev) => {
            const updated = { ...prev }
            needsTranslation.forEach((post) => {
              const translated = {
                title: results[`${post.id}-title`]?.translatedText || post.title || '',
                content: results[`${post.id}-content`]?.translatedText || post.content || '',
              }
              updated[post.id] = translated
              // Cache in sessionStorage
              setTranslationCache(post.id, targetLang, translated)
            })
            return updated
          })
        }
      } catch (error) {
        logger.warn('Translation failed:', error)
      } finally {
        setTranslatingPosts(false)
      }
    },
    [translatingPosts, translatedPosts, getTranslationCache, setTranslationCache, accessToken]
  )

  // Trigger translation when posts change
  useEffect(() => {
    if (postsHook.posts.length > 0 && !translatingPosts) {
      // en/ja/ko → English (API only supports en/zh); zh → Chinese
      translatePosts(postsHook.posts, language === 'zh' ? 'zh' : 'en')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- translatePosts excluded to avoid infinite loop; only trigger on posts/language change
  }, [postsHook.posts, language])

  // Related groups
  useEffect(() => {
    if (!groupId || groupId === 'loading') return

    const fetchRelatedGroups = async () => {
      setLoadingRelatedGroups(true)

      try {
        const { data, error } = await supabase.rpc('get_related_groups', {
          p_group_id: groupId,
          p_limit: 5,
        })

        if (error || !data || data.length === 0) {
          // Fallback to hot groups
          const { data: fallback } = await supabase
            .from('groups')
            .select('id, name, name_en, avatar_url, member_count')
            .neq('id', groupId)
            .order('member_count', { ascending: false, nullsFirst: false })
            .limit(5)
          setRelatedGroups(fallback || [])
        } else {
          setRelatedGroups(data)
        }
      } catch (err) {
        logger.error('Error fetching related groups:', err)
        setRelatedGroups([])
      } finally {
        setLoadingRelatedGroups(false)
      }
    }

    fetchRelatedGroups()
  }, [groupId])

  // Load group data + initial posts
  useEffect(() => {
    if (!groupId || groupId === 'loading') return

    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    const load = async () => {
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
            .eq('id', groupId)
            .maybeSingle(),
          // 2. Member avatar previews (5 most recent)
          // NOTE: no FK from group_members.user_id → user_profiles (it references
          // auth.users), so PostgREST embeds 400 with PGRST200. Two-step fetch below.
          supabase
            .from('group_members')
            .select('user_id')
            .eq('group_id', groupId)
            .order('joined_at', { ascending: false })
            .limit(5),
          // 3. Membership check (if logged in)
          userId
            ? supabase
                .from('group_members')
                .select('role')
                .eq('group_id', groupId)
                .eq('user_id', userId)
                .maybeSingle()
            : Promise.resolve({ data: null }),
        ])

        const { data: groupData, error: groupErr } = groupResult

        if (groupErr) {
          const isInvalidId =
            groupErr.code === '22P02' || groupErr.message?.includes('invalid input syntax')
          setError(isInvalidId ? t('groupNotFound') : t('loadFailed'))
          setLoading(false)
          return
        }

        // Owner handle lookup (depends on groupData.created_by)
        let ownerHandle = null
        if (groupData?.created_by) {
          const { data: ownerData } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('id', groupData.created_by)
            .maybeSingle()
          ownerHandle = ownerData?.handle
        }

        setGroup(groupData ? ({ ...groupData, owner_handle: ownerHandle } as Group) : null)

        // Process member previews (step 2: fetch profiles by id)
        if (previewResult.data && previewResult.data.length > 0) {
          const previewIds = previewResult.data.map((m) => m.user_id).filter(Boolean)
          const { data: previewProfiles } = previewIds.length
            ? await supabase
                .from('user_profiles')
                .select('id, handle, avatar_url')
                .in('id', previewIds)
            : { data: null }
          const profileById = new Map((previewProfiles || []).map((p) => [p.id, p]))
          setMemberPreviews(
            previewResult.data
              .map((m) => {
                const p = profileById.get(m.user_id)
                return {
                  avatar_url: p?.avatar_url,
                  handle: p?.handle,
                }
              })
              .filter((m) => m.avatar_url || m.handle)
          )
        }

        // Process membership
        let _membershipConfirmed = false
        if (userId && membershipResult.data) {
          setIsMember(true)
          setUserRole(membershipResult.data.role as 'owner' | 'admin' | 'member' | null)
          _membershipConfirmed = true
        } else if (userId) {
          setIsMember(false)
          setUserRole(null)
        }

        // Load posts for all visitors (non-members can browse read-only)
        postsHook.loadPosts(true)
      } catch (_err) {
        if (controller.signal.aborted) return
        setError(t('loadFailed'))
        showToast(t('loadFailed'), 'error')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    load()
    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase/postsHook/showToast/t are stable; load group data on mount or when userId changes
  }, [groupId, userId])

  // Fallback: Load posts when membership state changes (for non-cold-start cases)
  useEffect(() => {
    if (groupId && !loading && postsHook.posts.length === 0 && !postsHook.loadingMore) {
      postsHook.loadPosts(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- postsHook.loadPosts/posts/loadingMore excluded to avoid infinite loop; fallback trigger only
  }, [isMember, groupId, loading])

  // Invite auto-join
  useEffect(() => {
    const inviteToken = searchParams.get('invite')
    if (!inviteToken || !userId || !groupId || isMember || loading) return

    // Redemption is one write: the membership API verifies and consumes this
    // exact token atomically. A separate GET must never pre-consume capacity.
    void handleJoin(inviteToken)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleJoin excluded; only re-run when invite params or auth state change
  }, [searchParams, userId, groupId, isMember, loading])

  // Join group (via API)
  const handleJoin = useCallback(
    async (inviteToken?: string) => {
      if (!userId) {
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

      setJoining(true)
      try {
        const res = await fetch(`/api/groups/${groupId}/membership`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify(buildJoinMembershipBody(inviteToken)),
        })

        const data: unknown = await res.json().catch(() => null)
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
          showToast(t('joinRequestSubmitted'), 'success')
          return
        }

        if (ack.member_count !== undefined) {
          setGroup((prev) => (prev ? { ...prev, member_count: ack.member_count } : prev))
        }
        setIsMember(true)
        setUserRole(ack.action === 'already_member' ? (ack.role ?? 'member') : 'member')
        if (ack.action === 'joined') {
          trackEvent('group_join', { group_id: groupId })
        }
        showToast(t('joinSuccess'), 'success')
      } catch (err) {
        logger.error('Join error:', err)
        showToast(t(inviteToken ? 'inviteInvalidOrExpired' : 'joinFailed'), 'error')
      } finally {
        setJoining(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, group, isPro, groupId, accessToken, showToast]
  )

  // Leave group (with confirmation)
  const handleLeave = useCallback(async () => {
    if (!userId) return
    if (!(await showDangerConfirm(t('leaveGroup'), t('leaveGroupConfirm')))) return
    setJoining(true)
    try {
      const res = await fetch(`/api/groups/${groupId}/membership`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ action: 'leave' }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || t('leaveFailed'))
      }

      setGroup((prev) =>
        prev ? { ...prev, member_count: Math.max(0, (prev.member_count || 1) - 1) } : prev
      )
      setIsMember(false)
      setUserRole(null)
      showToast(t('leftGroup'), 'success')
    } catch (err) {
      logger.error('Leave error:', err)
      showToast(t('leaveFailed'), 'error')
    } finally {
      setJoining(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; getCsrfHeaders is a pure utility
  }, [userId, groupId, accessToken, showToast, showDangerConfirm])

  // Load members
  const loadMembers = async () => {
    if (loadingMembers || !groupId) return
    setLoadingMembers(true)
    try {
      // Two-step query: group_members has no FK to user_profiles (user_id references
      // auth.users), so a PostgREST embed 400s with PGRST200. Fetch members, then profiles.
      const { data: membersData } = await supabase
        .from('group_members')
        .select('user_id, role, joined_at')
        .eq('group_id', groupId)
        .order('role', { ascending: true })
        .order('joined_at', { ascending: true })

      if (membersData && membersData.length > 0) {
        const memberIds = membersData.map((m) => m.user_id).filter(Boolean)
        const { data: memberProfiles } = memberIds.length
          ? await supabase
              .from('user_profiles')
              .select('id, handle, avatar_url')
              .in('id', memberIds)
          : { data: null }
        const profileById = new Map((memberProfiles || []).map((p) => [p.id, p]))
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
      }
    } catch (err) {
      logger.error('Load members error:', err)
      showToast(t('loadMembersFailed'), 'error')
    } finally {
      setLoadingMembers(false)
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
