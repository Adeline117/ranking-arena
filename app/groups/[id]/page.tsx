'use client'

import Link from 'next/link'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { getCsrfHeaders } from '@/lib/api/client'
import { GroupCardSkeleton, PostSkeleton, SkeletonAvatar, Skeleton } from '@/app/components/ui/Skeleton'
import { SectionErrorBoundary } from '@/app/components/Utils/ErrorBoundary'
import GroupHeader from './ui/GroupHeader'
import GroupPostList from './ui/GroupPostList'
import { GroupInfoModal, MembersListModal } from './ui/GroupMembersSection'
import { useGroupPosts } from './hooks/useGroupPosts'
import PullToRefreshWrapper from '@/app/components/ui/PullToRefreshWrapper'

type Group = {
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
  owner_handle?: string | null
  is_premium_only?: boolean | null
}

type GroupMember = {
  user_id: string
  role: string
  handle?: string | null
  avatar_url?: string | null
  joined_at?: string | null
}

export default function GroupDetailPage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
  const [groupId, setGroupId] = useState<string>('')
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      (params as Promise<{ id: string }>).then(resolved => {
        setGroupId(resolved.id)
      })
    } else {
      setGroupId(String((params as { id: string })?.id ?? ''))
    }
  }, [params])

  const { language } = useLanguage()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const { isPro } = useSubscription()
  const searchParams = useSearchParams()

  // Auth state
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)

  // Group state
  const [group, setGroup] = useState<Group | null>(null)
  const [isMember, setIsMember] = useState(false)
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member' | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)

  // Modals
  const [showGroupInfo, setShowGroupInfo] = useState(false)
  const [showMembersList, setShowMembersList] = useState(false)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)

  // Translation
  const [translatedPosts, setTranslatedPosts] = useState<Record<string, { title?: string; content?: string }>>({})
  const [translatingPosts, setTranslatingPosts] = useState(false)

  // Related groups
  const [relatedGroups, setRelatedGroups] = useState<Array<{id: string; name: string; name_en?: string | null; avatar_url?: string | null; member_count?: number | null}>>([])
  const [loadingRelatedGroups, setLoadingRelatedGroups] = useState(true)

  // Posts hook
  const postsHook = useGroupPosts({
    groupId,
    userId,
    accessToken,
    isMember,
    language,
    showToast,
    showDangerConfirm,
  })

  // Auth session
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setUserId(data.session?.user?.id ?? null)
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  // Chinese text detection
  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
    return chineseRatio > 0.1
  }, [])

  // Batch translate posts
  const translatePosts = useCallback(async (postsToTranslate: Array<{id: string; title: string; content?: string | null}>, targetLang: 'zh' | 'en') => {
    if (translatingPosts) return
    setTranslatingPosts(true)

    const needsTranslation = postsToTranslate.filter(p => {
      if (translatedPosts[p.id]?.title) return false
      if (!p.title) return false
      const titleIsChinese = isChineseText(p.title)
      return targetLang === 'en' ? titleIsChinese : !titleIsChinese
    })

    if (needsTranslation.length === 0) {
      setTranslatingPosts(false)
      return
    }

    try {
      const items: Array<{id: string; text: string; contentType: 'post_title' | 'post_content'; contentId: string}> = []
      needsTranslation.slice(0, 10).forEach(post => {
        if (post.title) {
          items.push({ id: `${post.id}-title`, text: post.title, contentType: 'post_title', contentId: post.id })
        }
        if (post.content) {
          items.push({ id: `${post.id}-content`, text: post.content, contentType: 'post_content', contentId: post.id })
        }
      })

      if (items.length === 0) {
        setTranslatingPosts(false)
        return
      }

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ items, targetLang }),
      })

      if (!response.ok) {
        console.warn('Translation API failed:', response.status)
        setTranslatingPosts(false)
        return
      }

      const data = await response.json()
      if (data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>
        setTranslatedPosts(prev => {
          const updated = { ...prev }
          needsTranslation.forEach(post => {
            const titleResult = results[`${post.id}-title`]
            const contentResult = results[`${post.id}-content`]
            updated[post.id] = {
              title: titleResult?.translatedText || post.title || '',
              content: contentResult?.translatedText || post.content || '',
            }
          })
          return updated
        })
      }
    } catch (error) {
      console.warn('Translation failed:', error)
    } finally {
      setTranslatingPosts(false)
    }
  }, [isChineseText, translatingPosts, translatedPosts])

  // Trigger translation when posts change
  useEffect(() => {
    if (postsHook.posts.length > 0 && !translatingPosts) {
      translatePosts(postsHook.posts, language as 'zh' | 'en')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postsHook.posts, language])

  // Related groups
  useEffect(() => {
    if (!groupId || groupId === 'loading') return

    const fetchRelatedGroups = async () => {
      setLoadingRelatedGroups(true)
      try {
        const { data: memberData } = await supabase
          .from('group_members')
          .select('user_id')
          .eq('group_id', groupId)
          .limit(50)

        if (!memberData || memberData.length === 0) {
          const { data: hotGroups } = await supabase
            .from('groups')
            .select('id, name, name_en, avatar_url, member_count')
            .neq('id', groupId)
            .order('member_count', { ascending: false, nullsFirst: false })
            .limit(5)
          setRelatedGroups(hotGroups || [])
          setLoadingRelatedGroups(false)
          return
        }

        const memberIds = memberData.map(m => m.user_id)
        const { data: otherMemberships } = await supabase
          .from('group_members')
          .select('group_id')
          .in('user_id', memberIds)
          .neq('group_id', groupId)

        if (!otherMemberships || otherMemberships.length === 0) {
          const { data: hotGroups } = await supabase
            .from('groups')
            .select('id, name, name_en, avatar_url, member_count')
            .neq('id', groupId)
            .order('member_count', { ascending: false, nullsFirst: false })
            .limit(5)
          setRelatedGroups(hotGroups || [])
          setLoadingRelatedGroups(false)
          return
        }

        const groupCounts: Record<string, number> = {}
        otherMemberships.forEach(m => { groupCounts[m.group_id] = (groupCounts[m.group_id] || 0) + 1 })
        const sortedGroupIds = Object.entries(groupCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([id]) => id)

        if (sortedGroupIds.length === 0) {
          setRelatedGroups([])
          setLoadingRelatedGroups(false)
          return
        }

        const { data: groupsData } = await supabase
          .from('groups')
          .select('id, name, name_en, avatar_url, member_count')
          .in('id', sortedGroupIds)

        const sortedGroups = (groupsData || []).sort((a, b) => {
          return sortedGroupIds.indexOf(a.id) - sortedGroupIds.indexOf(b.id)
        })
        setRelatedGroups(sortedGroups)
      } catch (err) {
        console.error('Error fetching related groups:', err)
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
        const { data: groupData, error: groupErr } = await supabase
          .from('groups')
          .select('id, name, name_en, description, description_en, avatar_url, member_count, created_at, created_by, rules, is_premium_only')
          .eq('id', groupId)
          .maybeSingle()

        let ownerHandle = null
        if (groupData?.created_by) {
          const { data: ownerData } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('id', groupData.created_by)
            .maybeSingle()
          ownerHandle = ownerData?.handle
        }

        if (groupErr) {
          setError(groupErr.message)
          setLoading(false)
          return
        }

        setGroup(groupData ? { ...groupData, owner_handle: ownerHandle } as Group : null)

        let membershipConfirmed = false
        if (userId) {
          const { data: membership } = await supabase
            .from('group_members')
            .select('role')
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .maybeSingle()
          setIsMember(!!membership)
          setUserRole(membership?.role as 'owner' | 'admin' | 'member' | null)
          membershipConfirmed = !!membership
        }

        if (membershipConfirmed) {
          // Posts will be loaded by the hook after isMember updates
        }
      } catch (err) {
        if (controller.signal.aborted) return
        const errorMsg = err instanceof Error ? err.message : (language === 'zh' ? '加载失败' : 'Failed to load')
        setError(errorMsg)
        showToast(errorMsg, 'error')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    load()
    return () => {
      if (controller && !controller.signal.aborted) {
        controller.abort()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, userId])

  // Load posts when membership is confirmed
  useEffect(() => {
    if (isMember && groupId && !loading) {
      postsHook.loadPosts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMember, groupId, loading])

  // Invite auto-join
  useEffect(() => {
    const inviteToken = searchParams.get('invite')
    if (!inviteToken || !userId || !groupId || isMember || loading) return

    const handleInvite = async () => {
      try {
        const res = await fetch(`/api/groups/${groupId}/invite?verify=${encodeURIComponent(inviteToken)}`)
        if (res.ok) {
          await handleJoin(true)
        } else {
          showToast(language === 'zh' ? '邀请链接无效或已过期' : 'Invite link is invalid or expired', 'error')
        }
      } catch {
        // Invite verification failed
      }
    }
    handleInvite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, userId, groupId, isMember, loading])

  // Join group
  const handleJoin = async (bypassPro = false) => {
    if (!userId) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'warning')
      return
    }
    if (!bypassPro && group?.is_premium_only && !isPro) {
      showToast(language === 'zh' ? '此小组仅限 Pro 会员加入' : 'This group is Pro members only', 'warning')
      return
    }

    setJoining(true)
    try {
      const { error } = await supabase
        .from('group_members')
        .insert({ group_id: groupId, user_id: userId })
      if (error) throw error
      setIsMember(true)
      setUserRole('member')
      showToast(language === 'zh' ? '加入成功' : 'Joined successfully', 'success')

      // Notify group owner
      if (group?.created_by && group.created_by !== userId) {
        await supabase.from('notifications').insert({
          user_id: group.created_by,
          type: 'system' as const,
          title: language === 'zh' ? '新成员加入' : 'New Member Joined',
          message: language === 'zh' ? '有新成员加入了您的小组' : 'A new member joined your group',
          link: `/groups/${groupId}`,
          actor_id: userId,
          reference_id: groupId,
        })
      }

      // Posts will auto-load via the isMember effect
    } catch (err) {
      console.error('Join error:', err)
      const errorMsg = err instanceof Error ? err.message : (language === 'zh' ? '加入失败' : 'Failed to join')
      showToast(errorMsg, 'error')
    } finally {
      setJoining(false)
    }
  }

  // Leave group
  const handleLeave = async () => {
    if (!userId) return
    setJoining(true)
    try {
      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', userId)
      if (error) throw error
      setIsMember(false)
      showToast(language === 'zh' ? '已退出小组' : 'Left group successfully', 'success')
    } catch (err) {
      console.error('Leave error:', err)
      const errorMsg = err instanceof Error ? err.message : (language === 'zh' ? '退出失败' : 'Failed to leave')
      showToast(errorMsg, 'error')
    } finally {
      setJoining(false)
    }
  }

  // Load members
  const loadMembers = async () => {
    if (loadingMembers || !groupId) return
    setLoadingMembers(true)
    try {
      const { data: membersData } = await supabase
        .from('group_members')
        .select('user_id, role, joined_at')
        .eq('group_id', groupId)
        .order('role', { ascending: true })
        .order('joined_at', { ascending: true })

      if (membersData && membersData.length > 0) {
        const userIds = membersData.map(m => m.user_id)
        const { data: profilesData } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .in('id', userIds)

        const profileMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
        profilesData?.forEach(p => {
          profileMap.set(p.id, { handle: p.handle, avatar_url: p.avatar_url })
        })

        const sortedMembers = membersData
          .map(m => ({
            ...m,
            handle: profileMap.get(m.user_id)?.handle,
            avatar_url: profileMap.get(m.user_id)?.avatar_url,
          }))
          .sort((a, b) => {
            const roleOrder: Record<string, number> = { owner: 0, admin: 1, member: 2 }
            return (roleOrder[a.role] || 2) - (roleOrder[b.role] || 2)
          })

        setMembers(sortedMembers)
      }
    } catch (err) {
      console.error('Load members error:', err)
      showToast(language === 'zh' ? '加载成员列表失败' : 'Failed to load members', 'error')
    } finally {
      setLoadingMembers(false)
    }
  }

  // Loading state
  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Box style={{ marginBottom: tokens.spacing[6] }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[4] }}>
              <SkeletonAvatar size={80} />
              <Box style={{ flex: 1 }}>
                <Skeleton width="200px" height="24px" />
                <Skeleton width="120px" height="14px" />
              </Box>
            </Box>
            <Skeleton width="100%" height="60px" />
          </Box>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {[1, 2, 3].map((i) => (<PostSkeleton key={i} />))}
          </Box>
        </Box>
      </Box>
    )
  }

  // Error state
  if (error || !group) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2], color: '#ff7c7c' }}>
            {language === 'zh' ? '错误' : 'Error'}: {error || (language === 'zh' ? '小组不存在' : 'Group not found')}
          </Text>
          <Link href="/groups" style={{ color: tokens.colors.accent?.primary || tokens.colors.text.secondary, textDecoration: 'none', marginTop: tokens.spacing[3], display: 'inline-block' }}>
            ← {language === 'zh' ? '返回小组列表' : 'Back to Groups'}
          </Link>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box
        as="main"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
          display: 'grid',
          gridTemplateColumns: '1fr 280px',
          gap: tokens.spacing[6],
        }}
      >
        {/* Main Content */}
        <PullToRefreshWrapper
          onRefresh={async () => { await postsHook.loadPosts() }}
          disabled={!isMember}
        >
        <Box>
          <GroupHeader
            group={group}
            groupId={groupId}
            language={language}
            userId={userId}
            isMember={isMember}
            userRole={userRole}
            joining={joining}
            onJoin={() => handleJoin()}
            onLeave={handleLeave}
            onShowGroupInfo={() => setShowGroupInfo(true)}
            onShowMembers={() => { setShowMembersList(true); loadMembers() }}
          />

          <SectionErrorBoundary fallbackMessage={language === 'zh' ? '帖子区域加载失败' : 'Failed to load posts section'}>
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
          {isMember && (
            <Link
              href={`/groups/${groupId}/new`}
              style={{
                position: 'fixed',
                bottom: tokens.spacing[6],
                right: tokens.spacing[6],
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: tokens.colors.accent?.primary || tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '24px',
                fontWeight: 'bold',
                textDecoration: 'none',
                boxShadow: tokens.shadow.lg,
                zIndex: tokens.zIndex.sticky,
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.1)'
                e.currentTarget.style.boxShadow = tokens.shadow.xl
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)'
                e.currentTarget.style.boxShadow = tokens.shadow.lg
              }}
            >
              +
            </Link>
          )}
        </Box>
        </PullToRefreshWrapper>

        {/* Right Sidebar */}
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
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
            onShowMembers={() => { setShowMembersList(true); loadMembers() }}
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
      </Box>
    </Box>
  )
}

// ─────────────────────────────────────────────
// Related Groups Sidebar
// ─────────────────────────────────────────────

function RelatedGroupsSidebar({ groups, loading, language }: {
  groups: Array<{id: string; name: string; name_en?: string | null; avatar_url?: string | null; member_count?: number | null}>
  loading: boolean
  language: string
}) {
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
        {language === 'zh' ? '常来这里的人也爱去' : 'People Here Also Visit'}
      </Text>

      {loading ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {[1, 2, 3].map((i) => (<GroupCardSkeleton key={i} />))}
        </Box>
      ) : groups.length === 0 ? (
        <Text size="sm" color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
          {language === 'zh' ? '暂无推荐' : 'No recommendations'}
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
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${tokens.colors.accent?.primary || '#8b6fa8'}1a`
                e.currentTarget.style.borderColor = `${tokens.colors.accent?.primary || '#8b6fa8'}33`
                e.currentTarget.style.transform = 'translateX(4px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.borderColor = 'transparent'
                e.currentTarget.style.transform = 'translateX(0)'
              }}
            >
              <Box
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: tokens.radius.md,
                  background: 'linear-gradient(135deg, rgba(139, 111, 168, 0.2) 0%, rgba(139, 111, 168, 0.1) 100%)',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  flexShrink: 0,
                }}
              >
                {relGroup.avatar_url ? (
                  <img
                    src={relGroup.avatar_url}
                    alt={relGroup.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Text size="sm" weight="bold" style={{ color: '#c9b8db' }}>
                    {relGroup.name.charAt(0).toUpperCase()}
                  </Text>
                )}
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" weight="medium" style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginBottom: 2,
                }}>
                  {language === 'en' && relGroup.name_en ? relGroup.name_en : relGroup.name}
                </Text>
                {relGroup.member_count != null && (
                  <Text size="xs" color="tertiary">
                    {relGroup.member_count} {language === 'zh' ? '位成员' : 'members'}
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
