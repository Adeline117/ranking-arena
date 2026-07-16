'use client'

import { features } from '@/lib/features'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens, alpha } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { authedFetch, getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { logger } from '@/lib/logger'
import { jwtSubject } from '@/lib/auth/token-subject'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import {
  acquireGroupApplicationOperation,
  canonicalizeGroupProfileEditPayload,
  completeGroupApplicationOperation,
  groupProfileEditSubmitScope,
  isCurrentGroupApplicationOperation,
  isExactSubmitGroupProfileEditAck,
  startGroupApplicationSingleFlight,
  type GroupApplicationOperation,
} from '@/lib/groups/application-operation'
import { useViewerSlotState } from '@/lib/groups/use-viewer-slot-state'

import MemberList from './components/MemberList'
import ContentManagement from './components/ContentManagement'
import GroupSettings from './components/GroupSettings'
import { MuteModal, NotifyModal } from './components/ManageModals'
import {
  advanceGroupMemberModerationResourceScope,
  GroupMemberModerationOperationLedger,
  GroupMemberModerationRequestSingleFlight,
  isGroupMemberModerationViewerCurrent,
  runGroupMemberModerationRequest,
  type GroupMemberModerationOperation,
  type GroupMemberModerationViewerScope,
} from './member-moderation-operation'

type GroupMember = {
  user_id: string
  role: 'owner' | 'admin' | 'member'
  handle?: string | null
  avatar_url?: string | null
  joined_at?: string | null
  muted_until?: string | null
  mute_reason?: string | null
}

type Post = {
  id: string
  title: string
  content?: string | null
  author_handle?: string | null
  created_at: string
  deleted_at?: string | null
  is_pinned?: boolean | null
}

type Comment = {
  id: string
  content: string
  author_handle?: string | null
  created_at: string
  deleted_at?: string | null
  post_id: string
}

type Group = {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  rules?: string | null
  rules_json?: Array<{ zh: string; en: string }> | null
  role_names?: { admin: { zh: string; en: string }; member: { zh: string; en: string } } | null
  is_premium_only?: boolean | null
  created_by?: string | null
  created_at?: string | null
}

type Rule = { zh: string; en: string }

const MUTE_DURATION_MS = {
  '3h': 3 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  permanent: 100 * 365 * 24 * 60 * 60 * 1000,
} as const

function ActivityLogSection({ groupId }: { groupId: string }) {
  const { language, t } = useLanguage()
  const [activities, setActivities] = useState<
    Array<{
      id: string
      type: string
      title: string
      message: string
      created_at: string
      actor_id?: string
    }>
  >([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!groupId) return
    const load = async () => {
      setLoading(true)
      const { data } = await supabase
        .from('notifications')
        .select('id, type, title, message, created_at, actor_id')
        .eq('reference_id', groupId)
        .eq('type', 'system')
        .order('created_at', { ascending: false })
        .limit(50)
      setActivities(data || [])
      setLoading(false)
    }
    load()
  }, [groupId])

  if (loading)
    return (
      <Text size="sm" color="tertiary">
        {t('loading')}
      </Text>
    )
  if (activities.length === 0)
    return (
      <Text size="sm" color="tertiary">
        {t('noActivity')}
      </Text>
    )

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {activities.map((activity) => (
        <Box
          key={activity.id}
          style={{
            padding: tokens.spacing[2],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
            borderLeft: `3px solid ${tokens.colors.accent?.primary || tokens.colors.accent.brand}`,
          }}
        >
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text size="sm" weight="bold">
              {activity.title}
            </Text>
            <Text size="xs" color="tertiary">
              {new Date(activity.created_at).toLocaleString(getLocaleFromLanguage(language))}
            </Text>
          </Box>
          <Text size="xs" color="secondary" style={{ marginTop: 2 }}>
            {activity.message}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export default function GroupManagePage({ params }: { params: Promise<{ id: string }> }) {
  if (!features.social) redirect('/')

  const [groupId, setGroupId] = useState<string>('')
  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      ;(params as Promise<{ id: string }>)
        .then((resolved) => setGroupId(resolved.id))
        // eslint-disable-next-line no-restricted-syntax
        .catch(() => {
          /* Intentionally swallowed: params resolution should not fail */
        })
    } else {
      setGroupId(String((params as { id: string })?.id ?? ''))
    }
  }, [params])

  const { language, t } = useLanguage()
  const { isPro } = useSubscription()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const { accessToken, email, userId, viewerKey, sessionGeneration } = useAuthSession()
  const router = useRouter()
  const [group, setGroup] = useState<Group | null>(null)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [posts, setPosts] = useState<Post[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member' | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'members' | 'content' | 'settings' | 'activity'>(
    'members'
  )
  const [editMode, setEditMode] = useState(false)
  const [editName, setEditName] = useState('')
  const [editNameEn, setEditNameEn] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editDescriptionEn, setEditDescriptionEn] = useState('')
  const [editRules, setEditRules] = useState<Rule[]>([])
  const [newRuleZh, setNewRuleZh] = useState('')
  const [newRuleEn, setNewRuleEn] = useState('')
  const profileEditStateOwnerKey = `${viewerKey}:${sessionGeneration}:${groupId}`
  const [submitting, setSubmitting] = useViewerSlotState(profileEditStateOwnerKey, false)
  const [langTab, setLangTab] = useState<'zh' | 'en'>('zh')
  const [showMultiLang, setShowMultiLang] = useState(false)
  const [editAvatarUrl, setEditAvatarUrl] = useState('')
  const [editRoleNames, setEditRoleNames] = useState<{
    admin: { zh: string; en: string }
    member: { zh: string; en: string }
  }>({ admin: { zh: '管理员', en: 'Admin' }, member: { zh: '成员', en: 'Member' } })
  const [isPremiumOnly, setIsPremiumOnly] = useState(false)
  const [contentSearch, setContentSearch] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [debouncedMemberSearch, setDebouncedMemberSearch] = useState('')
  const [memberPage, setMemberPage] = useState(0)
  const [memberRoleFilter, setMemberRoleFilter] = useState<'all' | 'owner' | 'admin' | 'member'>(
    'all'
  )
  const [hasMorePosts, setHasMorePosts] = useState(false)
  const [loadingMorePosts, setLoadingMorePosts] = useState(false)
  const [pinningPost, setPinningPost] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [generatingInvite, setGeneratingInvite] = useState(false)
  const [showMuteModal, setShowMuteModal] = useState<string | null>(null)
  const [muteDuration, setMuteDuration] = useState<'3h' | '1d' | '7d' | 'permanent'>('1d')
  const [muteReason, setMuteReason] = useState('')
  const [showNotifyModal, setShowNotifyModal] = useState(false)
  const [notifyTitle, setNotifyTitle] = useState('')
  const [notifyMessage, setNotifyMessage] = useState('')
  const [notifySending, setNotifySending] = useState(false)
  const profileEditSubmitOperationIdRef = useRef<Record<string, string>>({})
  const profileEditContextRef = useRef({
    accessToken,
    groupId,
    sessionGeneration,
    userId,
    viewerKey,
  })
  profileEditContextRef.current = {
    accessToken,
    groupId,
    sessionGeneration,
    userId,
    viewerKey,
  }
  const moderationOperationsRef = useRef(new GroupMemberModerationOperationLedger())
  const moderationRequestsRef = useRef(new GroupMemberModerationRequestSingleFlight())
  const moderationAccessTokenRef = useRef(accessToken)
  const moderationResourceScopeRef = useRef({
    groupId: null as string | null,
    resourceGeneration: 0,
  })
  moderationResourceScopeRef.current = advanceGroupMemberModerationResourceScope(
    moderationResourceScopeRef.current,
    groupId
  )
  const moderationViewerScope: GroupMemberModerationViewerScope = {
    actorId: userId,
    viewerKey,
    sessionGeneration,
    ...moderationResourceScopeRef.current,
  }
  const moderationViewerScopeRef = useRef(moderationViewerScope)
  moderationAccessTokenRef.current = accessToken
  moderationViewerScopeRef.current = moderationViewerScope
  moderationOperationsRef.current.scope(moderationViewerScope)
  const POSTS_PER_PAGE = 20

  const isModerationViewerScopeCurrent = useCallback(
    (expected: GroupMemberModerationViewerScope) => {
      return isGroupMemberModerationViewerCurrent(
        expected,
        moderationViewerScopeRef.current,
        moderationAccessTokenRef.current
      )
    },
    []
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedMemberSearch(memberSearch)
      setMemberPage(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [memberSearch])
  useEffect(() => {
    setMemberPage(0)
  }, [memberRoleFilter, activeTab])

  // Load data
  useEffect(() => {
    if (!groupId || groupId === 'loading' || !userId) return
    const load = async () => {
      setLoading(true)
      try {
        const { data: groupData } = await supabase
          .from('groups')
          .select(
            'id, name, name_en, description, description_en, avatar_url, rules_json, role_names, member_count, is_premium_only, created_by, created_at'
          )
          .eq('id', groupId)
          .single()
        if (groupData) {
          setGroup(groupData as Group)
          setEditName(groupData.name || '')
          setEditNameEn(groupData.name_en || '')
          setEditDescription(groupData.description || '')
          setEditDescriptionEn(groupData.description_en || '')
          setEditRules(groupData.rules_json || [])
          setEditAvatarUrl(groupData.avatar_url || '')
          const defaultRN = {
            admin: { zh: '管理员', en: 'Admin' },
            member: { zh: '成员', en: 'Member' },
          }
          const loadedRN = (groupData.role_names || {}) as {
            admin?: { zh?: string; en?: string }
            member?: { zh?: string; en?: string }
          }
          setEditRoleNames({
            admin: {
              zh: loadedRN.admin?.zh || defaultRN.admin.zh,
              en: loadedRN.admin?.en || defaultRN.admin.en,
            },
            member: {
              zh: loadedRN.member?.zh || defaultRN.member.zh,
              en: loadedRN.member?.en || defaultRN.member.en,
            },
          })
          setIsPremiumOnly(groupData.is_premium_only || false)
          if (groupData.name_en || groupData.description_en) setShowMultiLang(true)
        }
        const { data: memberData } = await supabase
          .from('own_group_memberships')
          .select('role')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .maybeSingle()
        if (memberData) setUserRole(memberData.role as 'owner' | 'admin' | 'member')
        const { data: membersData } = await supabase
          .from('group_member_moderation_directory')
          .select('user_id, role, joined_at, muted_until, mute_reason')
          .eq('group_id', groupId)
          .order('role', { ascending: true })
        if (membersData && membersData.length > 0) {
          const userIds = membersData.map((m) => m.user_id)
          const { data: profilesData } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url')
            .in('id', userIds)
          const profileMap = new Map()
          profilesData?.forEach((p) =>
            profileMap.set(p.id, { handle: p.handle, avatar_url: p.avatar_url })
          )
          setMembers(
            membersData
              .map((m) => ({
                ...m,
                handle: profileMap.get(m.user_id)?.handle,
                avatar_url: profileMap.get(m.user_id)?.avatar_url,
              }))
              .sort((a, b) => {
                const o: Record<string, number> = { owner: 0, admin: 1, member: 2 }
                return (o[a.role] || 2) - (o[b.role] || 2)
              }) as GroupMember[]
          )
        } else if (groupData?.created_by) {
          const { data: ownerProfile } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url')
            .eq('id', groupData.created_by)
            .maybeSingle()
          if (ownerProfile)
            setMembers([
              {
                user_id: groupData.created_by,
                role: 'owner',
                handle: ownerProfile.handle,
                avatar_url: ownerProfile.avatar_url,
                joined_at: groupData.created_at || null,
              },
            ])
        }
        const { data: postsData } = await supabase
          .from('posts')
          .select('id, title, content, author_handle, created_at, is_pinned')
          .eq('group_id', groupId)
          .order('is_pinned', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(POSTS_PER_PAGE)
        const loadedPosts = (postsData || []).map((p) => ({ ...p, deleted_at: null })) as Post[]
        setPosts(loadedPosts)
        setHasMorePosts(loadedPosts.length === POSTS_PER_PAGE)
        const postIds = (postsData || []).map((p) => p.id)
        if (postIds.length > 0) {
          const { data: commentsData } = await supabase
            .from('comments')
            .select('id, content, author_handle, created_at, post_id')
            .in('post_id', postIds)
            .order('created_at', { ascending: false })
            .limit(100)
          setComments((commentsData || []).map((c) => ({ ...c, deleted_at: null })) as Comment[])
        }
      } catch (err) {
        logger.error('Error loading data:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [groupId, userId])

  const canManage = userRole === 'owner' || userRole === 'admin'
  const isOwner = userRole === 'owner' || (userRole === 'admin' && group?.created_by === userId)

  const reconcileMemberModeration = useCallback(
    async (targetUserId: string, expectedScope: GroupMemberModerationViewerScope) => {
      const scopedGroupId = expectedScope.groupId
      if (!scopedGroupId || !isModerationViewerScopeCurrent(expectedScope)) return
      const { data, error } = await supabase
        .from('group_member_moderation_directory')
        .select('user_id, muted_until, mute_reason')
        .eq('group_id', scopedGroupId)
        .eq('user_id', targetUserId)
        .maybeSingle()
      if (error) throw error
      if (!isModerationViewerScopeCurrent(expectedScope)) return

      setMembers((previous) => {
        if (!isModerationViewerScopeCurrent(expectedScope)) return previous
        if (!data) return previous.filter((member) => member.user_id !== targetUserId)
        return previous.map((member) =>
          member.user_id === targetUserId
            ? {
                ...member,
                muted_until: data.muted_until,
                mute_reason: data.mute_reason,
              }
            : member
        )
      })
    },
    [isModerationViewerScopeCurrent]
  )

  // Handlers
  const handleMute = async (targetUserId: string) => {
    if (!accessToken || !userId || !canManage) return
    const requestScope: GroupMemberModerationViewerScope = {
      actorId: userId,
      viewerKey,
      sessionGeneration,
      ...moderationResourceScopeRef.current,
    }
    const requestGroupId = groupId.trim().toLowerCase()
    if (
      !requestGroupId ||
      requestScope.groupId !== requestGroupId ||
      !isModerationViewerScopeCurrent(requestScope)
    )
      return
    let operation: GroupMemberModerationOperation | null = null
    try {
      const requestedOperation = moderationOperationsRef.current.acquire({
        actorId: userId,
        viewerKey,
        sessionGeneration,
        resourceGeneration: requestScope.resourceGeneration,
        action: 'mute',
        groupId: requestGroupId,
        targetUserId,
        durationMs: MUTE_DURATION_MS[muteDuration],
        reason: muteReason,
        nowMs: Date.now(),
      })
      operation = requestedOperation
      const request = moderationRequestsRef.current.run(requestedOperation.operationId, () =>
        runGroupMemberModerationRequest({
          operation: requestedOperation,
          ledger: moderationOperationsRef.current,
          accessToken,
          csrfHeaders: getCsrfHeaders(),
          isViewerCurrent: () => isModerationViewerScopeCurrent(requestScope),
          onAcknowledged: () => {
            setShowMuteModal(null)
            setMuteReason('')
          },
          reconcileTarget: (target) => reconcileMemberModeration(target, requestScope),
          onReconcileError: (error) => logger.error('Mute reconciliation error:', error),
        })
      )
      const result = await request.promise
      if (!request.started) return
      if (result.ok) {
        if (result.completedCurrentIntent && isModerationViewerScopeCurrent(requestScope)) {
          showToast(t('mutedSuccessfully'), 'success')
        }
      } else if (
        isModerationViewerScopeCurrent(requestScope) &&
        moderationOperationsRef.current.isCurrent(operation)
      ) {
        if (result.kind === 'network') {
          logger.error('Mute error:', result.error)
          showToast(t('networkErrorRetry'), 'error')
        } else {
          showToast((result.kind === 'http' && result.error) || t('operationFailed'), 'error')
        }
      }
    } catch (err) {
      logger.error('Mute error:', err)
      if (
        isModerationViewerScopeCurrent(requestScope) &&
        (!operation || moderationOperationsRef.current.isCurrent(operation))
      ) {
        showToast(t('networkErrorRetry'), 'error')
      }
    }
  }

  const handleUnmute = async (targetUserId: string) => {
    if (!accessToken || !userId || !canManage) return
    const requestScope: GroupMemberModerationViewerScope = {
      actorId: userId,
      viewerKey,
      sessionGeneration,
      ...moderationResourceScopeRef.current,
    }
    const requestGroupId = groupId.trim().toLowerCase()
    if (
      !requestGroupId ||
      requestScope.groupId !== requestGroupId ||
      !isModerationViewerScopeCurrent(requestScope)
    )
      return
    let operation: GroupMemberModerationOperation | null = null
    try {
      const requestedOperation = moderationOperationsRef.current.acquire({
        actorId: userId,
        viewerKey,
        sessionGeneration,
        resourceGeneration: requestScope.resourceGeneration,
        action: 'unmute',
        groupId: requestGroupId,
        targetUserId,
      })
      operation = requestedOperation
      const request = moderationRequestsRef.current.run(requestedOperation.operationId, () =>
        runGroupMemberModerationRequest({
          operation: requestedOperation,
          ledger: moderationOperationsRef.current,
          accessToken,
          csrfHeaders: getCsrfHeaders(),
          isViewerCurrent: () => isModerationViewerScopeCurrent(requestScope),
          reconcileTarget: (target) => reconcileMemberModeration(target, requestScope),
          onReconcileError: (error) => logger.error('Unmute reconciliation error:', error),
        })
      )
      const result = await request.promise
      if (!request.started) return
      if (result.ok) {
        if (result.completedCurrentIntent && isModerationViewerScopeCurrent(requestScope)) {
          showToast(t('unmutedSuccessfully'), 'success')
        }
      } else if (
        isModerationViewerScopeCurrent(requestScope) &&
        moderationOperationsRef.current.isCurrent(operation)
      ) {
        if (result.kind === 'network') {
          logger.error('Unmute error:', result.error)
          showToast(t('networkErrorRetry'), 'error')
        } else {
          showToast((result.kind === 'http' && result.error) || t('operationFailed'), 'error')
        }
      }
    } catch (err) {
      logger.error('Unmute error:', err)
      if (
        isModerationViewerScopeCurrent(requestScope) &&
        (!operation || moderationOperationsRef.current.isCurrent(operation))
      ) {
        showToast(t('networkErrorRetry'), 'error')
      }
    }
  }

  const handleNotify = async () => {
    if (!accessToken || !canManage || !notifyMessage.trim()) return
    setNotifySending(true)
    try {
      const res = await fetch(`/api/groups/${groupId}/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          title: notifyTitle.trim() || undefined,
          message: notifyMessage.trim(),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setShowNotifyModal(false)
        setNotifyTitle('')
        setNotifyMessage('')
        showToast(
          t('notificationSentToMembers').replace('{count}', String(data.notified)),
          'success'
        )
      } else {
        const data = res.headers.get('content-type')?.includes('application/json')
          ? await res.json()
          : null
        showToast(data?.error || t('sendFailed'), 'error')
      }
    } catch (err) {
      logger.error('Notify error:', err)
      showToast(t('networkErrorRetry'), 'error')
    } finally {
      setNotifySending(false)
    }
  }

  const handleSetRole = async (targetUserId: string, newRole: 'admin' | 'member') => {
    if (!accessToken || !isOwner) return
    try {
      const res = await fetch(`/api/groups/${groupId}/members/${targetUserId}/role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ role: newRole }),
      })
      if (res.ok) {
        setMembers((prev) =>
          prev.map((m) => (m.user_id === targetUserId ? { ...m, role: newRole } : m))
        )
        showToast(t('roleUpdatedSuccessfully'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || t('operationFailed'), 'error')
      }
    } catch (err) {
      logger.error('Set role error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  const handleDeletePost = async (postId: string) => {
    if (!accessToken || !canManage) return
    if (!(await showDangerConfirm(t('deletePost'), t('confirmDeletePost')))) return
    try {
      const res = await fetch(`/api/groups/${groupId}/posts/${postId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      if (res.ok) {
        setPosts((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, deleted_at: new Date().toISOString() } : p))
        )
        showToast(t('postDeleted'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || t('deleteFailed'), 'error')
      }
    } catch (err) {
      logger.error('Delete post error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  const handleDeleteComment = async (commentId: string) => {
    if (!accessToken || !canManage) return
    if (!(await showDangerConfirm(t('deleteComment'), t('confirmDeleteComment')))) return
    try {
      const res = await fetch(`/api/groups/${groupId}/comments/${commentId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      if (res.ok) {
        setComments((prev) =>
          prev.map((c) => (c.id === commentId ? { ...c, deleted_at: new Date().toISOString() } : c))
        )
        showToast(t('commentDeleted'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || t('deleteFailed'), 'error')
      }
    } catch (err) {
      logger.error('Delete comment error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  const handlePinPost = async (postId: string) => {
    if (!accessToken || !canManage || pinningPost) return
    setPinningPost(postId)
    try {
      const res = await fetch(`/api/posts/${postId}/pin`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      if (res.ok) {
        const data = await res.json()
        const np = data.data?.is_pinned ?? data.is_pinned
        setPosts((prev) =>
          prev.map((p) => {
            if (p.id === postId) return { ...p, is_pinned: np }
            if (np) return { ...p, is_pinned: false }
            return p
          })
        )
        showToast(np ? t('pinned') : t('unpinned'), 'success')
      } else {
        const data = res.headers.get('content-type')?.includes('application/json')
          ? await res.json()
          : null
        showToast(data?.error || t('operationFailed'), 'error')
      }
    } catch (err) {
      logger.error('Pin post error:', err)
      showToast(t('networkErrorRetry'), 'error')
    } finally {
      setPinningPost(null)
    }
  }

  const loadMorePosts = async () => {
    if (loadingMorePosts || !hasMorePosts || posts.length === 0) return
    setLoadingMorePosts(true)
    try {
      const { data } = await supabase
        .from('posts')
        .select('id, title, content, author_handle, created_at, is_pinned')
        .eq('group_id', groupId)
        .lt('created_at', posts[posts.length - 1].created_at)
        .order('created_at', { ascending: false })
        .limit(POSTS_PER_PAGE)
      if (data && data.length > 0) {
        setPosts((prev) => [...prev, ...(data.map((p) => ({ ...p, deleted_at: null })) as Post[])])
        setHasMorePosts(data.length === POSTS_PER_PAGE)
      } else {
        setHasMorePosts(false)
      }
    } catch (err) {
      logger.error('Load more posts error:', err)
    } finally {
      setLoadingMorePosts(false)
    }
  }

  const handleSubmitEdit = async () => {
    const requestScope: ViewerScope = { viewerKey, sessionGeneration, userId }
    const requestToken = accessToken
    if (
      !requestToken ||
      !userId ||
      !isOwner ||
      jwtSubject(requestToken) !== userId ||
      requestScope.viewerKey !== `user:${userId}` ||
      !isViewerScopeCurrent(requestScope)
    )
      return
    if (!editName.trim() && !editNameEn.trim()) {
      showToast(t('pleaseEnterGroupName'), 'warning')
      return
    }

    const requestGroupId = groupId
    const requestOwnerKey = `${requestScope.viewerKey}:${requestScope.sessionGeneration}:${requestGroupId}`
    const requestIsCurrent = () => {
      const current = profileEditContextRef.current
      return (
        current.userId === userId &&
        current.viewerKey === requestScope.viewerKey &&
        current.sessionGeneration === requestScope.sessionGeneration &&
        current.groupId === requestGroupId &&
        jwtSubject(current.accessToken) === userId &&
        isViewerScopeCurrent(requestScope)
      )
    }
    const payload = canonicalizeGroupProfileEditPayload({
      name: editName.trim() || group?.name || '',
      name_en: editNameEn,
      description: editDescription,
      description_en: editDescriptionEn,
      avatar_url: editAvatarUrl,
      role_names: editRoleNames,
      rules_json: editRules,
      // A lapsed Pro owner may still edit ordinary fields on an existing
      // premium group; preserve that flag instead of silently downgrading it.
      is_premium_only: isPro ? isPremiumOnly : Boolean(group?.is_premium_only),
    })

    let operation: GroupApplicationOperation | null = null
    let ownsPhysicalRequest = false
    try {
      operation = await acquireGroupApplicationOperation(
        groupProfileEditSubmitScope(userId, requestGroupId),
        userId,
        { group_id: requestGroupId, ...payload }
      )
      if (!requestIsCurrent()) return

      const flight = startGroupApplicationSingleFlight(operation, () =>
        authedFetch<unknown>(
          `/api/groups/${requestGroupId}/edit-apply`,
          'POST',
          requestToken,
          { ...payload, operation_id: operation!.operationId },
          15_000,
          {
            expectedUserId: userId,
            expectedSessionGeneration: requestScope.sessionGeneration,
          }
        )
      )
      if (!flight.started) {
        await flight.promise.catch(() => undefined)
        return
      }

      ownsPhysicalRequest = true
      profileEditSubmitOperationIdRef.current[requestOwnerKey] = operation.operationId
      setSubmitting(true)

      const result = await flight.promise
      if (result.stale || !requestIsCurrent()) return
      const ownsActiveIntent =
        profileEditSubmitOperationIdRef.current[requestOwnerKey] === operation.operationId &&
        isCurrentGroupApplicationOperation(operation)
      if (!ownsActiveIntent) return

      if (
        result.ok &&
        isExactSubmitGroupProfileEditAck(result.data, operation, requestGroupId, payload)
      ) {
        if (!completeGroupApplicationOperation(operation)) return
        showToast(t('editRequestSubmitted'), 'success')
        setEditMode(false)
        return
      }

      if (!result.ok && result.status >= 400 && result.status < 500) {
        if (!completeGroupApplicationOperation(operation)) return
      }
      const data = result.data
      const errorMessage =
        typeof data === 'object' &&
        data !== null &&
        'error' in data &&
        typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : t('submissionFailed')
      showToast(errorMessage, 'error')
    } catch (err) {
      if (
        !requestIsCurrent() ||
        (operation &&
          profileEditSubmitOperationIdRef.current[requestOwnerKey] !== operation.operationId)
      )
        return
      logger.error('Submit edit error:', err)
      showToast(t('networkErrorRetry'), 'error')
    } finally {
      const completedOperation = operation
      if (ownsPhysicalRequest && completedOperation)
        queueMicrotask(() => {
          if (
            profileEditSubmitOperationIdRef.current[requestOwnerKey] ===
            completedOperation.operationId
          ) {
            delete profileEditSubmitOperationIdRef.current[requestOwnerKey]
            if (requestIsCurrent()) setSubmitting(false)
          }
        })
    }
  }

  const handleKick = async (targetUserId: string, handle: string) => {
    if (
      !(await showDangerConfirm(
        t('kickMember'),
        t('confirmKickMember').replace('{handle}', handle)
      ))
    )
      return
    try {
      const res = await fetch(`/api/groups/${groupId}/members/${targetUserId}/kick`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.user_id !== targetUserId))
        showToast(t('kicked'), 'success')
      } else {
        const data = res.headers.get('content-type')?.includes('application/json')
          ? await res.json()
          : null
        showToast(data?.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    }
  }

  const handleCancelEdit = () => {
    setEditMode(false)
    if (group) {
      setEditName(group.name || '')
      setEditNameEn(group.name_en || '')
      setEditDescription(group.description || '')
      setEditDescriptionEn(group.description_en || '')
      setEditRules(group.rules_json || [])
      setEditAvatarUrl(group.avatar_url || '')
      const defaultRN = {
        admin: { zh: '管理员', en: 'Admin' },
        member: { zh: '成员', en: 'Member' },
      }
      const loadedRN = (group.role_names || {}) as {
        admin?: { zh?: string; en?: string }
        member?: { zh?: string; en?: string }
      }
      setEditRoleNames({
        admin: {
          zh: loadedRN.admin?.zh || defaultRN.admin.zh,
          en: loadedRN.admin?.en || defaultRN.admin.en,
        },
        member: {
          zh: loadedRN.member?.zh || defaultRN.member.zh,
          en: loadedRN.member?.en || defaultRN.member.en,
        },
      })
      setIsPremiumOnly(group.is_premium_only || false)
      setShowMultiLang(!!(group.name_en || group.description_en))
      setLangTab('zh')
    }
  }

  // Dissolve group (owner only)
  const [dissolving, setDissolving] = useState(false)
  const handleDissolve = useCallback(async () => {
    if (!isOwner || dissolving) return
    const confirmed = await showDangerConfirm(t('dissolveGroup'), t('dissolveGroupConfirm'))
    if (!confirmed) return
    setDissolving(true)
    try {
      const res = await fetch(`/api/groups/${groupId}/dissolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      if (res.ok) {
        showToast(t('groupDissolved'), 'success')
        router.push('/groups')
      } else {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setDissolving(false)
    }
  }, [isOwner, dissolving, groupId, accessToken, showDangerConfirm, showToast, router, t])

  // Filtering
  const searchLower = contentSearch.toLowerCase()
  const filteredPosts = contentSearch
    ? posts.filter(
        (p) =>
          p.title?.toLowerCase().includes(searchLower) ||
          p.content?.toLowerCase().includes(searchLower) ||
          p.author_handle?.toLowerCase().includes(searchLower)
      )
    : posts
  const filteredComments = contentSearch
    ? comments.filter(
        (c) =>
          c.content?.toLowerCase().includes(searchLower) ||
          c.author_handle?.toLowerCase().includes(searchLower)
      )
    : comments

  // Styles
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.base,
    outline: 'none',
    transition: `border-color ${tokens.transition.base}`,
  }
  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: tokens.spacing[2],
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.semibold,
    color: tokens.colors.text.secondary,
  }
  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    background: isActive ? 'var(--color-accent-primary-20)' : 'transparent',
    color: isActive ? 'var(--color-brand-accent)' : tokens.colors.text.secondary,
    cursor: 'pointer',
    fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
    border: 'none',
    transition: `all ${tokens.transition.base}`,
  })
  const langTabStyle = (isActive: boolean): React.CSSProperties => ({
    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
    borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
    border: `1px solid ${isActive ? tokens.colors.border.primary : 'transparent'}`,
    borderBottom: isActive ? 'none' : `1px solid ${tokens.colors.border.primary}`,
    background: isActive ? tokens.colors.bg.secondary : 'transparent',
    color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
    cursor: 'pointer',
    fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
    transition: `all ${tokens.transition.base}`,
  })

  if (loading)
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box
          style={{
            maxWidth: 900,
            margin: '0 auto',
            padding: tokens.spacing[6],
            textAlign: 'center',
          }}
        >
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      </Box>
    )
  if (!canManage)
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box
          style={{
            maxWidth: 900,
            margin: '0 auto',
            padding: tokens.spacing[6],
            textAlign: 'center',
          }}
        >
          <Text color="tertiary">{t('noManagePermission')}</Text>
          <Link
            href={`/groups/${groupId}`}
            style={{
              color: tokens.colors.accent.brand,
              marginTop: tokens.spacing[4],
              display: 'inline-block',
            }}
          >
            ← {t('backToGroup')}
          </Link>
        </Box>
      </Box>
    )

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Link
          href={`/groups/${groupId}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            color: tokens.colors.text.secondary,
            textDecoration: 'none',
            marginBottom: tokens.spacing[4],
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          ← {t('backToGroup')}
        </Link>
        <Text size="2xl" weight="bold" style={{ marginBottom: tokens.spacing[6] }}>
          {t('groupManagement')} - {group?.name}
        </Text>

        {/* Tabs */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[6] }}>
          <button style={tabStyle(activeTab === 'members')} onClick={() => setActiveTab('members')}>
            {t('memberManagement')}
          </button>
          <button style={tabStyle(activeTab === 'content')} onClick={() => setActiveTab('content')}>
            {t('contentManagement')}
          </button>
          {isOwner && (
            <button
              style={tabStyle(activeTab === 'settings')}
              onClick={() => setActiveTab('settings')}
            >
              {t('groupSettings')}
            </button>
          )}
          <button
            onClick={() => setActiveTab('activity')}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              border: 'none',
              cursor: 'pointer',
              background:
                activeTab === 'activity'
                  ? `${alpha(tokens.colors.accent?.primary || tokens.colors.accent.brand, 13)}`
                  : 'transparent',
              color:
                activeTab === 'activity'
                  ? tokens.colors.accent?.primary || tokens.colors.accent.brand
                  : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight:
                activeTab === 'activity'
                  ? tokens.typography.fontWeight.bold
                  : tokens.typography.fontWeight.normal,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {t('activityLog')}
          </button>
        </Box>

        {activeTab === 'members' && (
          <MemberList
            members={members}
            groupId={groupId}
            userId={userId}
            userRole={userRole}
            isOwner={isOwner}
            canManage={canManage}
            createdBy={group?.created_by}
            accessToken={accessToken}
            memberSearch={memberSearch}
            setMemberSearch={setMemberSearch}
            debouncedMemberSearch={debouncedMemberSearch}
            memberPage={memberPage}
            setMemberPage={setMemberPage}
            memberRoleFilter={memberRoleFilter}
            setMemberRoleFilter={setMemberRoleFilter}
            inviteUrl={inviteUrl}
            setInviteUrl={setInviteUrl}
            generatingInvite={generatingInvite}
            setGeneratingInvite={setGeneratingInvite}
            onMute={(uid) => setShowMuteModal(uid)}
            onUnmute={handleUnmute}
            onSetRole={handleSetRole}
            onKick={handleKick}
            onNotifyOpen={() => setShowNotifyModal(true)}
            setMembers={setMembers}
            showToast={showToast}
            t={t}
          />
        )}
        {activeTab === 'content' && (
          <ContentManagement
            posts={posts}
            comments={comments}
            filteredPosts={filteredPosts}
            filteredComments={filteredComments}
            contentSearch={contentSearch}
            setContentSearch={setContentSearch}
            hasMorePosts={hasMorePosts}
            loadingMorePosts={loadingMorePosts}
            pinningPost={pinningPost}
            onDeletePost={handleDeletePost}
            onDeleteComment={handleDeleteComment}
            onPinPost={handlePinPost}
            onLoadMorePosts={loadMorePosts}
            language={language}
            inputStyle={inputStyle}
            t={t}
          />
        )}
        {activeTab === 'settings' && isOwner && (
          <GroupSettings
            group={group}
            editMode={editMode}
            setEditMode={setEditMode}
            editName={editName}
            setEditName={setEditName}
            editNameEn={editNameEn}
            setEditNameEn={setEditNameEn}
            editDescription={editDescription}
            setEditDescription={setEditDescription}
            editDescriptionEn={editDescriptionEn}
            setEditDescriptionEn={setEditDescriptionEn}
            editRules={editRules}
            setEditRules={setEditRules}
            newRuleZh={newRuleZh}
            setNewRuleZh={setNewRuleZh}
            newRuleEn={newRuleEn}
            setNewRuleEn={setNewRuleEn}
            editAvatarUrl={editAvatarUrl}
            setEditAvatarUrl={setEditAvatarUrl}
            editRoleNames={editRoleNames}
            setEditRoleNames={setEditRoleNames}
            isPremiumOnly={isPremiumOnly}
            setIsPremiumOnly={setIsPremiumOnly}
            isPro={isPro}
            langTab={langTab}
            setLangTab={setLangTab}
            showMultiLang={showMultiLang}
            setShowMultiLang={setShowMultiLang}
            submitting={submitting}
            onSubmitEdit={handleSubmitEdit}
            onCancelEdit={handleCancelEdit}
            inputStyle={inputStyle}
            labelStyle={labelStyle}
            langTabStyle={langTabStyle}
            t={t}
          />
        )}
        {activeTab === 'activity' && (
          <Card title={t('activityLog')}>
            <ActivityLogSection groupId={groupId} />
          </Card>
        )}

        {/* Danger Zone — dissolve group (owner only) */}
        {isOwner && (
          <Box
            style={{
              marginTop: tokens.spacing[8],
              padding: tokens.spacing[5],
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-accent-error)',
              background: 'var(--color-accent-error-04, rgba(239,68,68,0.04))',
            }}
          >
            <Text
              size="sm"
              weight="bold"
              style={{ color: 'var(--color-accent-error)', marginBottom: tokens.spacing[2] }}
            >
              {t('dangerZone')}
            </Text>
            <Text
              size="xs"
              color="tertiary"
              style={{ marginBottom: tokens.spacing[4], lineHeight: 1.5 }}
            >
              {t('dissolveGroupDesc')}
            </Text>
            <button
              onClick={handleDissolve}
              disabled={dissolving}
              style={{
                padding: '8px 20px',
                borderRadius: tokens.radius.md,
                border: '1px solid var(--color-accent-error)',
                background: dissolving ? 'var(--color-accent-error-10)' : 'transparent',
                color: 'var(--color-accent-error)',
                fontSize: 13,
                fontWeight: 600,
                cursor: dissolving ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                if (!dissolving) e.currentTarget.style.background = 'var(--color-accent-error)'
                e.currentTarget.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--color-accent-error)'
              }}
            >
              {dissolving ? '...' : t('dissolveGroupBtn')}
            </button>
          </Box>
        )}

        {showMuteModal && (
          <MuteModal
            targetUserId={showMuteModal}
            muteDuration={muteDuration}
            setMuteDuration={setMuteDuration}
            muteReason={muteReason}
            setMuteReason={setMuteReason}
            onMute={handleMute}
            onClose={() => setShowMuteModal(null)}
            inputStyle={inputStyle}
            t={t}
          />
        )}
        {showNotifyModal && (
          <NotifyModal
            notifyTitle={notifyTitle}
            setNotifyTitle={setNotifyTitle}
            notifyMessage={notifyMessage}
            setNotifyMessage={setNotifyMessage}
            notifySending={notifySending}
            onNotify={handleNotify}
            onClose={() => setShowNotifyModal(false)}
            inputStyle={inputStyle}
            t={t}
          />
        )}
      </Box>
    </Box>
  )
}
