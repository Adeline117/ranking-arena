'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

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

type Rule = {
  zh: string
  en: string
}

function ActivityLogSection({ groupId }: { groupId: string }) {
  const { language, t } = useLanguage()
  const [activities, setActivities] = useState<Array<{ id: string; type: string; title: string; message: string; created_at: string; actor_id?: string }>>([])
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

  if (loading) return <Text size="sm" color="tertiary">{t('loading')}</Text>
  if (activities.length === 0) return <Text size="sm" color="tertiary">{t('noActivity')}</Text>

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {activities.map(activity => (
        <Box key={activity.id} style={{ padding: tokens.spacing[2], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.md, borderLeft: `3px solid ${tokens.colors.accent?.primary || tokens.colors.accent.brand}` }}>
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text size="sm" weight="bold">{activity.title}</Text>
            <Text size="xs" color="tertiary">{new Date(activity.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</Text>
          </Box>
          <Text size="xs" color="secondary" style={{ marginTop: 2 }}>{activity.message}</Text>
        </Box>
      ))}
    </Box>
  )
}

export default function GroupManagePage({ params }: { params: Promise<{ id: string }> }) {
  const [groupId, setGroupId] = useState<string>('')
  
  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      (params as Promise<{ id: string }>).then(resolved => {
        setGroupId(resolved.id)
      })
    } else {
      setGroupId(String((params as { id: string })?.id ?? ''))
    }
  }, [params])

  const { language, t } = useLanguage()
  const { isPro } = useSubscription()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const { accessToken, email, userId } = useAuthSession()
  const [group, setGroup] = useState<Group | null>(null)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [posts, setPosts] = useState<Post[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member' | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'members' | 'content' | 'settings' | 'activity'>('members')
  
  // 编辑小组信息状态
  const [editMode, setEditMode] = useState(false)
  const [editName, setEditName] = useState('')
  const [editNameEn, setEditNameEn] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editDescriptionEn, setEditDescriptionEn] = useState('')
  const [editRules, setEditRules] = useState<Rule[]>([])
  const [newRuleZh, setNewRuleZh] = useState('')
  const [newRuleEn, setNewRuleEn] = useState('')
  const [submitting, setSubmitting] = useState(false)
  
  // 语言标签页状态
  const [langTab, setLangTab] = useState<'zh' | 'en'>('zh')
  const [showMultiLang, setShowMultiLang] = useState(false)
  
  // 头像和角色称呼
  const [editAvatarUrl, setEditAvatarUrl] = useState('')
  const [editRoleNames, setEditRoleNames] = useState<{ admin: { zh: string; en: string }; member: { zh: string; en: string } }>({
    admin: { zh: '管理员', en: 'Admin' },
    member: { zh: '成员', en: 'Member' }
  })
  
  // Pro 专属小组选项
  const [isPremiumOnly, setIsPremiumOnly] = useState(false)

  // 内容搜索
  const [contentSearch, setContentSearch] = useState('')

  // Member search + pagination
  const [memberSearch, setMemberSearch] = useState('')
  const [debouncedMemberSearch, setDebouncedMemberSearch] = useState('')
  const [memberPage, setMemberPage] = useState(0)
  const [memberRoleFilter, setMemberRoleFilter] = useState<'all' | 'owner' | 'admin' | 'member'>('all')
  const [_memberTotal, _setMemberTotal] = useState(0)
  const MEMBERS_PER_PAGE = 20

  // Post pagination
  const [_postsPage, _setPostsPage] = useState(0)
  const [hasMorePosts, setHasMorePosts] = useState(false)
  const [loadingMorePosts, setLoadingMorePosts] = useState(false)
  const POSTS_PER_PAGE = 20

  // Pin loading state
  const [pinningPost, setPinningPost] = useState<string | null>(null)

  // Invite link
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [generatingInvite, setGeneratingInvite] = useState(false)

  // 禁言弹窗状态
  const [showMuteModal, setShowMuteModal] = useState<string | null>(null)
  const [muteDuration, setMuteDuration] = useState<'3h' | '1d' | '7d' | 'permanent'>('1d')
  const [muteReason, setMuteReason] = useState('')

  // 通知弹窗状态
  const [showNotifyModal, setShowNotifyModal] = useState(false)
  const [notifyTitle, setNotifyTitle] = useState('')
  const [notifyMessage, setNotifyMessage] = useState('')
  const [notifySending, setNotifySending] = useState(false)


  // Debounce member search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedMemberSearch(memberSearch)
      setMemberPage(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [memberSearch])

  // Reset member page when role filter changes
  useEffect(() => {
    setMemberPage(0)
  }, [memberRoleFilter])

  // 加载数据
  useEffect(() => {
    if (!groupId || groupId === 'loading' || !userId) return

    const load = async () => {
      setLoading(true)
      try {
        // 获取小组信息
        const { data: groupData } = await supabase
          .from('groups')
          .select('*')
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
          // 安全地合并 role_names，确保所有字段都存在
          const defaultRoleNames = {
            admin: { zh: '管理员', en: 'Admin' },
            member: { zh: '成员', en: 'Member' }
          }
          const loadedRoleNames = (groupData.role_names || {}) as { admin?: { zh?: string; en?: string }; member?: { zh?: string; en?: string } }
          setEditRoleNames({
            admin: {
              zh: loadedRoleNames.admin?.zh || defaultRoleNames.admin.zh,
              en: loadedRoleNames.admin?.en || defaultRoleNames.admin.en,
            },
            member: {
              zh: loadedRoleNames.member?.zh || defaultRoleNames.member.zh,
              en: loadedRoleNames.member?.en || defaultRoleNames.member.en,
            }
          })
          setIsPremiumOnly(groupData.is_premium_only || false)
          // 如果有英文内容，显示多语言选项
          if (groupData.name_en || groupData.description_en) {
            setShowMultiLang(true)
          }
        }

        // 获取当前用户的角色
        const { data: memberData } = await supabase
          .from('group_members')
          .select('role')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .single()

        if (memberData) {
          setUserRole(memberData.role as 'owner' | 'admin' | 'member')
        }

        // 获取成员列表
        const { data: membersData, error: membersError } = await supabase
          .from('group_members')
          .select('user_id, role, joined_at, muted_until, mute_reason')
          .eq('group_id', groupId)
          .order('role', { ascending: true })

        if (membersError) {
          console.error('Error loading members:', membersError)
        }

        if (membersData && membersData.length > 0) {
          const userIds = membersData.map(m => m.user_id)
          const { data: profilesData } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url')
            .in('id', userIds)

          const profileMap = new Map()
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

          setMembers(sortedMembers as GroupMember[])
        } else if (groupData?.created_by) {
          // 如果没有成员数据但有创建者，添加创建者作为组长
          const { data: ownerProfile } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url')
            .eq('id', groupData.created_by)
            .single()

          if (ownerProfile) {
            setMembers([{
              user_id: groupData.created_by,
              role: 'owner',
              handle: ownerProfile.handle,
              avatar_url: ownerProfile.avatar_url,
              joined_at: groupData.created_at || null,
            }])
          }
        }

        // 获取帖子 (paginated)
        const { data: postsData, error: postsError } = await supabase
          .from('posts')
          .select('id, title, content, author_handle, created_at, is_pinned')
          .eq('group_id', groupId)
          .order('is_pinned', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(POSTS_PER_PAGE)

        if (postsError) {
          console.error('Error loading posts:', postsError)
        }

        const loadedPosts = (postsData || []).map(p => ({ ...p, deleted_at: null })) as Post[]
        setPosts(loadedPosts)
        setHasMorePosts(loadedPosts.length === POSTS_PER_PAGE)

        // 获取评论
        const postIds = (postsData || []).map(p => p.id)
        if (postIds.length > 0) {
          const { data: commentsData } = await supabase
            .from('comments')
            .select('id, content, author_handle, created_at, post_id')
            .in('post_id', postIds)
            .order('created_at', { ascending: false })
            .limit(100)

          setComments((commentsData || []).map(c => ({ ...c, deleted_at: null })) as Comment[])
        }
      } catch (err) {
        console.error('Error loading data:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [groupId, userId])

  // 检查权限（兼容旧数据：admin 在旧系统中可能就是组长）
  const canManage = userRole === 'owner' || userRole === 'admin'
  // 如果小组是当前用户创建的，或者角色是 owner，则是组长
  const isOwner = userRole === 'owner' || (userRole === 'admin' && group?.created_by === userId)

  // 禁言成员
  const handleMute = async (targetUserId: string) => {
    if (!accessToken || !canManage) return

    try {
      let muteUntil: string | null = null
      const now = new Date()

      switch (muteDuration) {
        case '3h':
          muteUntil = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString()
          break
        case '1d':
          muteUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
          break
        case '7d':
          muteUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
          break
        case 'permanent':
          muteUntil = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
          break
      }

      const res = await fetch(`/api/groups/${groupId}/members/${targetUserId}/mute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ muted_until: muteUntil, reason: muteReason })
      })

      if (res.ok) {
        // 更新本地状态
        setMembers(prev => prev.map(m =>
          m.user_id === targetUserId
            ? { ...m, muted_until: muteUntil, mute_reason: muteReason }
            : m
        ))
        setShowMuteModal(null)
        setMuteReason('')
        showToast(t('mutedSuccessfully'), 'success')
      } else {
        const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
        showToast(data?.error || (t('operationFailed')), 'error')
      }
    } catch (err) {
      console.error('Mute error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  // 解除禁言
  const handleUnmute = async (targetUserId: string) => {
    if (!accessToken || !canManage) return

    try {
      const res = await fetch(`/api/groups/${groupId}/members/${targetUserId}/mute`, {
        method: 'DELETE',
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        }
      })

      if (res.ok) {
        setMembers(prev => prev.map(m =>
          m.user_id === targetUserId
            ? { ...m, muted_until: null, mute_reason: null }
            : m
        ))
        showToast(t('unmutedSuccessfully'), 'success')
      } else {
        const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
        showToast(data?.error || (t('operationFailed')), 'error')
      }
    } catch (err) {
      console.error('Unmute error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  // 发送通知给成员
  const handleNotify = async () => {
    if (!accessToken || !canManage || !notifyMessage.trim()) return

    setNotifySending(true)
    try {
      const res = await fetch(`/api/groups/${groupId}/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          title: notifyTitle.trim() || undefined,
          message: notifyMessage.trim()
        })
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
        const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
        showToast(data?.error || t('sendFailed'), 'error')
      }
    } catch (err) {
      console.error('Notify error:', err)
      showToast(t('networkErrorRetry'), 'error')
    } finally {
      setNotifySending(false)
    }
  }

  // 设置/撤销管理员
  const handleSetRole = async (targetUserId: string, newRole: 'admin' | 'member') => {
    if (!accessToken || !isOwner) return

    try {
      const res = await fetch(`/api/groups/${groupId}/members/${targetUserId}/role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ role: newRole })
      })

      if (res.ok) {
        setMembers(prev => prev.map(m => 
          m.user_id === targetUserId ? { ...m, role: newRole } : m
        ))
        showToast(t('roleUpdatedSuccessfully'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || (t('operationFailed')), 'error')
      }
    } catch (err) {
      console.error('Set role error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  // 删除帖子
  const handleDeletePost = async (postId: string) => {
    if (!accessToken || !canManage) return
    const confirmed = await showDangerConfirm(
      t('deletePost'),
      t('confirmDeletePost')
    )
    if (!confirmed) return

    try {
      const res = await fetch(`/api/groups/${groupId}/posts/${postId}/delete`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        }
      })

      if (res.ok) {
        setPosts(prev => prev.map(p => 
          p.id === postId ? { ...p, deleted_at: new Date().toISOString() } : p
        ))
        showToast(t('postDeleted'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || (t('deleteFailed')), 'error')
      }
    } catch (err) {
      console.error('Delete post error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  // 删除评论
  const handleDeleteComment = async (commentId: string) => {
    if (!accessToken || !canManage) return
    const confirmed = await showDangerConfirm(
      t('deleteComment'),
      t('confirmDeleteComment')
    )
    if (!confirmed) return

    try {
      const res = await fetch(`/api/groups/${groupId}/comments/${commentId}/delete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        }
      })

      if (res.ok) {
        setComments(prev => prev.map(c =>
          c.id === commentId ? { ...c, deleted_at: new Date().toISOString() } : c
        ))
        showToast(t('commentDeleted'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || (t('deleteFailed')), 'error')
      }
    } catch (err) {
      console.error('Delete comment error:', err)
      showToast(t('networkErrorRetry'), 'error')
    }
  }

  // 置顶/取消置顶帖子
  const handlePinPost = async (postId: string) => {
    if (!accessToken || !canManage || pinningPost) return

    setPinningPost(postId)
    try {
      const res = await fetch(`/api/posts/${postId}/pin`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        }
      })

      if (res.ok) {
        const data = await res.json()
        const newPinnedState = data.data?.is_pinned ?? data.is_pinned
        setPosts(prev => prev.map(p => {
          if (p.id === postId) return { ...p, is_pinned: newPinnedState }
          // 如果新状态是置顶，取消其他帖子的置顶状态
          if (newPinnedState) return { ...p, is_pinned: false }
          return p
        }))
        showToast(newPinnedState ? t('pinned') : t('unpinned'), 'success')
      } else {
        const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
        showToast(data?.error || t('operationFailed'), 'error')
      }
    } catch (err) {
      console.error('Pin post error:', err)
      showToast(t('networkErrorRetry'), 'error')
    } finally {
      setPinningPost(null)
    }
  }

  // 加载更多帖子
  const loadMorePosts = async () => {
    if (loadingMorePosts || !hasMorePosts || posts.length === 0) return
    setLoadingMorePosts(true)
    try {
      const lastPost = posts[posts.length - 1]
      const { data } = await supabase
        .from('posts')
        .select('id, title, content, author_handle, created_at, is_pinned')
        .eq('group_id', groupId)
        .lt('created_at', lastPost.created_at)
        .order('created_at', { ascending: false })
        .limit(POSTS_PER_PAGE)

      if (data && data.length > 0) {
        const newPosts = data.map(p => ({ ...p, deleted_at: null })) as Post[]
        setPosts(prev => [...prev, ...newPosts])
        setHasMorePosts(data.length === POSTS_PER_PAGE)
      } else {
        setHasMorePosts(false)
      }
    } catch (err) {
      console.error('Load more posts error:', err)
    } finally {
      setLoadingMorePosts(false)
    }
  }

  // 添加规则
  const addRule = () => {
    const zhText = newRuleZh.trim()
    const enText = newRuleEn.trim()
    
    if (!zhText && !enText) return
    
    setEditRules([...editRules, { zh: zhText, en: enText }])
    setNewRuleZh('')
    setNewRuleEn('')
  }

  // 删除规则
  const removeRule = (index: number) => {
    setEditRules(editRules.filter((_, i) => i !== index))
  }

  // 编辑规则
  const updateRule = (index: number, lang: 'zh' | 'en', value: string) => {
    const newRules = [...editRules]
    newRules[index] = { ...newRules[index], [lang]: value }
    setEditRules(newRules)
  }

  // 提交修改申请
  const handleSubmitEdit = async () => {
    if (!accessToken || !isOwner) return

    setSubmitting(true)
    try {
      const res = await fetch(`/api/groups/${groupId}/edit-apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          name: editName.trim() || null,
          name_en: editNameEn.trim() || null,
          description: editDescription.trim() || null,
          description_en: editDescriptionEn.trim() || null,
          avatar_url: editAvatarUrl.trim() || null,
          role_names: editRoleNames,
          rules_json: editRules.length > 0 ? editRules : null,
          rules: editRules.map(r => r.zh).filter(Boolean).join('\n') || null,
          is_premium_only: isPro && isPremiumOnly,
        })
      })

      const data = await res.json()

      if (res.ok) {
        showToast(t('editRequestSubmitted'), 'success')
        setEditMode(false)
      } else {
        showToast(data.error || t('submissionFailed'), 'error')
      }
    } catch (err) {
      console.error('Submit edit error:', err)
      showToast(t('networkErrorRetry'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // 根据关键词过滤帖子和评论
  const searchLower = contentSearch.toLowerCase()
  const filteredPosts = contentSearch
    ? posts.filter(p =>
        (p.title && p.title.toLowerCase().includes(searchLower)) ||
        (p.content && p.content.toLowerCase().includes(searchLower)) ||
        (p.author_handle && p.author_handle.toLowerCase().includes(searchLower))
      )
    : posts
  const filteredComments = contentSearch
    ? comments.filter(c =>
        (c.content && c.content.toLowerCase().includes(searchLower)) ||
        (c.author_handle && c.author_handle.toLowerCase().includes(searchLower))
      )
    : comments

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
    background: isActive ? 'rgba(139, 111, 168, 0.2)' : 'transparent',
    color: isActive ? '#c9b8db' : tokens.colors.text.secondary,
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

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  if (!canManage) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text color="tertiary">{t('noManagePermission')}</Text>
          <Link href={`/groups/${groupId}`} style={{ color: tokens.colors.accent.brand, marginTop: tokens.spacing[4], display: 'inline-block' }}>
            ← {t('backToGroup')}
          </Link>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
        {/* 返回链接 */}
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

        {/* 标题 */}
        <Text size="2xl" weight="bold" style={{ marginBottom: tokens.spacing[6] }}>
          {t('groupManagement')} - {group?.name}
        </Text>

        {/* 标签页 */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[6] }}>
          <button style={tabStyle(activeTab === 'members')} onClick={() => setActiveTab('members')}>
            {t('memberManagement')}
          </button>
          <button style={tabStyle(activeTab === 'content')} onClick={() => setActiveTab('content')}>
            {t('contentManagement')}
          </button>
          {isOwner && (
            <button style={tabStyle(activeTab === 'settings')} onClick={() => setActiveTab('settings')}>
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
                background: activeTab === 'activity' ? `${tokens.colors.accent?.primary || tokens.colors.accent.brand}20` : 'transparent',
                color: activeTab === 'activity' ? tokens.colors.accent?.primary || tokens.colors.accent.brand : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeTab === 'activity' ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {t('activityLog')}
            </button>
        </Box>

        {/* 成员管理 */}
        {activeTab === 'members' && (
          <Card title={`${t('memberList')} (${members.length})`}>
            {/* Member search + role filter + actions */}
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginBottom: tokens.spacing[3] }}>
              <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder={t('searchMembers')}
                  style={{
                    flex: 1,
                    minWidth: 120,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                />
                <select
                  value={memberRoleFilter}
                  onChange={(e) => setMemberRoleFilter(e.target.value as 'all' | 'owner' | 'admin' | 'member')}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                  }}
                >
                  <option value="all">{t('allRoles')}</option>
                  <option value="owner">{t('owner')}</option>
                  <option value="admin">{t('admin')}</option>
                  <option value="member">{t('groupMember')}</option>
                </select>
                <Button variant="primary" size="sm" onClick={() => setShowNotifyModal(true)}>
                  {t('notifyMembers')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={generatingInvite}
                  onClick={async () => {
                    setGeneratingInvite(true)
                    try {
                      const res = await fetch(`/api/groups/${groupId}/invite`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() }
                      })
                      if (res.ok) {
                        const data = await res.json()
                        if (data.invite_url) {
                          const fullUrl = `${window.location.origin}${data.invite_url}`
                          setInviteUrl(fullUrl)
                          await navigator.clipboard.writeText(fullUrl)
                          showToast(t('inviteLinkCopied'), 'success')
                        } else {
                          showToast(t('generateFailed'), 'error')
                        }
                      } else {
                        const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
                        showToast(data?.error || (t('generateFailed')), 'error')
                      }
                    } catch {
                      showToast(t('networkError'), 'error')
                    } finally {
                      setGeneratingInvite(false)
                    }
                  }}
                >
                  {generatingInvite ? '...' : t('inviteLink')}
                </Button>
              </Box>
              {inviteUrl && (
                <Box style={{ padding: tokens.spacing[2], background: tokens.colors.bg.primary, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}` }}>
                  <Text size="xs" color="tertiary" style={{ wordBreak: 'break-all' }}>{inviteUrl}</Text>
                </Box>
              )}
            </Box>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              {members.length === 0 && (
                <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                  {t('noMembersData')}
                </Text>
              )}
              {(() => {
                const filtered = members
                  .filter(m => memberRoleFilter === 'all' || m.role === memberRoleFilter)
                  .filter(m => !debouncedMemberSearch || (m.handle || '').toLowerCase().includes(debouncedMemberSearch.toLowerCase()))
                const totalFiltered = filtered.length
                const totalMemberPages = Math.ceil(totalFiltered / MEMBERS_PER_PAGE)
                const paginatedMembers = filtered.slice(memberPage * MEMBERS_PER_PAGE, (memberPage + 1) * MEMBERS_PER_PAGE)

                return (
                  <>
                    {paginatedMembers.length === 0 && members.length > 0 && (
                      <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                        {t('noMatchingMembers')}
                      </Text>
                    )}
                    {paginatedMembers.map((member) => {
                const isMuted = member.muted_until && new Date(member.muted_until) > new Date()
                // 兼容旧数据：在没有 owner 角色的情况下，如果用户是创建者就是组长
                const memberIsOwner = member.role === 'owner' || (member.role === 'admin' && group?.created_by === member.user_id)
                const canManageMember = (isOwner || (userRole === 'admin' && member.role === 'member')) && member.user_id !== userId && !memberIsOwner

                return (
                  <Box
                    key={member.user_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[3],
                      padding: tokens.spacing[3],
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    {/* 头像 */}
                    <Box
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: '50%',
                        background: tokens.colors.bg.primary,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        flexShrink: 0,
                        position: 'relative',
                      }}
                    >
                      {member.avatar_url ? (
                        <Image src={member.avatar_url} alt="" fill style={{ objectFit: 'cover' }} unoptimized />
                      ) : (
                        <Text size="sm" color="tertiary">{(member.handle || 'U').charAt(0).toUpperCase()}</Text>
                      )}
                    </Box>

                    {/* 用户信息 */}
                    <Box style={{ flex: 1 }}>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                        <Text weight="bold">@{member.handle || 'Unknown'}</Text>
                        <span
                          style={{
                            fontSize: tokens.typography.fontSize.xs,
                            padding: `2px ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.full,
                            background: memberIsOwner
                              ? 'linear-gradient(135deg, #FFD700, #FFA500)'
                              : member.role === 'admin'
                                ? 'rgba(139, 111, 168, 0.3)'
                                : tokens.colors.bg.primary,
                            color: memberIsOwner ? '#000' : tokens.colors.text.secondary,
                          }}
                        >
                          {memberIsOwner
                            ? t('owner')
                            : member.role === 'admin'
                              ? t('admin')
                              : t('groupMember')}
                        </span>
                        {isMuted && (
                          <span style={{ 
                            fontSize: tokens.typography.fontSize.xs, 
                            color: '#ff6b6b',
                            background: 'rgba(255, 107, 107, 0.1)',
                            padding: `2px ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.full,
                          }}>
                            {t('memberMutedBadge')}
                          </span>
                        )}
                      </Box>
                      {isMuted && member.mute_reason && (
                        <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>
                          {t('muteReasonLabel')}: {member.mute_reason}
                        </Text>
                      )}
                    </Box>

                    {/* 操作按钮 */}
                    {canManageMember && (
                      <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                        {/* 禁言/解禁 */}
                        {isMuted ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleUnmute(member.user_id)}
                          >
                            {t('unmute')}
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setShowMuteModal(member.user_id)}
                          >
                            {t('mute')}
                          </Button>
                        )}

                        {/* 设置管理员（仅组长可操作） */}
                        {isOwner && !memberIsOwner && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleSetRole(member.user_id, member.role === 'admin' ? 'member' : 'admin')}
                          >
                            {member.role === 'admin' && !memberIsOwner
                              ? t('removeAdmin')
                              : t('makeAdmin')}
                          </Button>
                        )}

                        {/* Kick member */}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={async () => {
                            const confirmed = await showDangerConfirm(
                              t('kickMember'),
                              t('confirmKickMember').replace('{handle}', member.handle || 'Unknown')
                            )
                            if (!confirmed) return
                            try {
                              const res = await fetch(`/api/groups/${groupId}/members/${member.user_id}/kick`, {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() }
                              })
                              if (res.ok) {
                                setMembers(prev => prev.filter(m => m.user_id !== member.user_id))
                                showToast(t('kicked'), 'success')
                              } else {
                                const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null
                                showToast(data?.error || t('operationFailed'), 'error')
                              }
                            } catch {
                              showToast(t('networkError'), 'error')
                            }
                          }}
                          style={{ color: '#ff6b6b' }}
                        >
                          {t('kick')}
                        </Button>
                      </Box>
                    )}
                  </Box>
                )
              })}
                    {/* Member pagination controls */}
                    {totalMemberPages > 1 && (
                      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[3], marginTop: tokens.spacing[4], paddingTop: tokens.spacing[3], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={memberPage === 0}
                          onClick={() => setMemberPage(p => Math.max(0, p - 1))}
                        >
                          {t('prevPage')}
                        </Button>
                        <Text size="sm" color="secondary">
                          {t('pageOf').replace('{current}', String(memberPage + 1)).replace('{total}', String(totalMemberPages))}
                        </Text>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={memberPage >= totalMemberPages - 1}
                          onClick={() => setMemberPage(p => Math.min(totalMemberPages - 1, p + 1))}
                        >
                          {t('nextPage')}
                        </Button>
                      </Box>
                    )}
                  </>
                )
              })()}
            </Box>
          </Card>
        )}

        {/* 内容管理 */}
        {activeTab === 'content' && (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            {/* 搜索栏 */}
            <Box style={{ position: 'relative' }}>
              <input
                type="text"
                value={contentSearch}
                onChange={(e) => setContentSearch(e.target.value)}
                placeholder={t('searchPostsCommentsAuthors')}
                style={{
                  ...inputStyle,
                  paddingLeft: tokens.spacing[10],
                }}
              />
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke={tokens.colors.text.tertiary}
                strokeWidth="2"
                style={{
                  position: 'absolute',
                  left: tokens.spacing[4],
                  top: '50%',
                  transform: 'translateY(-50%)',
                }}
              >
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              {contentSearch && (
                <button
                  onClick={() => setContentSearch('')}
                  style={{
                    position: 'absolute',
                    right: tokens.spacing[4],
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: tokens.colors.text.tertiary,
                    fontSize: tokens.typography.fontSize.lg,
                    lineHeight: 1,
                    padding: tokens.spacing[1],
                  }}
                >
                  ×
                </button>
              )}
            </Box>

            {/* 帖子 */}
            <Card title={`${t('posts')} (${filteredPosts.length}${contentSearch ? `/${posts.length}` : ''})`}>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {filteredPosts.map((post) => (
                  <Box
                    key={post.id}
                    style={{
                      padding: tokens.spacing[3],
                      background: post.deleted_at
                        ? 'rgba(255, 107, 107, 0.1)'
                        : post.is_pinned
                          ? `linear-gradient(135deg, ${tokens.colors.accent?.primary || tokens.colors.accent.brand}15 0%, ${tokens.colors.bg.secondary} 100%)`
                          : tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${
                        post.deleted_at
                          ? 'rgba(255, 107, 107, 0.3)'
                          : post.is_pinned
                            ? `${tokens.colors.accent?.primary || tokens.colors.accent.brand}50`
                            : tokens.colors.border.primary
                      }`,
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <Box style={{ flex: 1, minWidth: 0 }}>
                        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                          {post.is_pinned && (
                            <span
                              style={{
                                fontSize: tokens.typography.fontSize.xs,
                                padding: `2px ${tokens.spacing[2]}`,
                                borderRadius: tokens.radius.full,
                                background: `${tokens.colors.accent?.primary || tokens.colors.accent.brand}20`,
                                color: tokens.colors.accent?.primary || tokens.colors.accent.brand,
                                fontWeight: tokens.typography.fontWeight.bold,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              PIN {t('pinnedLabel')}
                            </span>
                          )}
                          <Text weight="bold" style={{ textDecoration: post.deleted_at ? 'line-through' : 'none' }}>
                            {post.title}
                          </Text>
                        </Box>
                        <Text size="xs" color="tertiary">
                          @{post.author_handle} · {new Date(post.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                        </Text>
                        {post.deleted_at && (
                          <Text size="xs" style={{ color: '#ff6b6b', marginTop: 4 }}>
                            {t('deletedByAdmin')}
                          </Text>
                        )}
                      </Box>
                      {!post.deleted_at && (
                        <Box style={{ display: 'flex', gap: tokens.spacing[2], flexShrink: 0 }}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handlePinPost(post.id)}
                            disabled={pinningPost === post.id}
                            style={{
                              color: post.is_pinned ? tokens.colors.accent?.primary || tokens.colors.accent.brand : tokens.colors.text.secondary,
                            }}
                          >
                            {pinningPost === post.id
                              ? '...'
                              : post.is_pinned
                                ? t('unpin')
                                : t('pin')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleDeletePost(post.id)}
                            style={{ color: '#ff6b6b' }}
                          >
                            {t('delete')}
                          </Button>
                        </Box>
                      )}
                    </Box>
                  </Box>
                ))}
                {filteredPosts.length === 0 && (
                  <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                    {contentSearch
                      ? t('noMatchingPosts')
                      : t('noPostsYet')}
                  </Text>
                )}
                {/* Load More button */}
                {hasMorePosts && !contentSearch && (
                  <Box style={{ textAlign: 'center', marginTop: tokens.spacing[3] }}>
                    <Button
                      variant="secondary"
                      onClick={loadMorePosts}
                      disabled={loadingMorePosts}
                    >
                      {loadingMorePosts
                        ? t('loading')
                        : t('loadMore')}
                    </Button>
                  </Box>
                )}
              </Box>
            </Card>

            {/* 评论 */}
            <Card title={`${t('comments')} (${filteredComments.length}${contentSearch ? `/${comments.length}` : ''})`}>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {filteredComments.slice(0, 50).map((comment) => (
                  <Box
                    key={comment.id}
                    style={{
                      padding: tokens.spacing[3],
                      background: comment.deleted_at ? 'rgba(255, 107, 107, 0.1)' : tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${comment.deleted_at ? 'rgba(255, 107, 107, 0.3)' : tokens.colors.border.primary}`,
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <Box>
                        <Text size="sm" style={{ textDecoration: comment.deleted_at ? 'line-through' : 'none' }}>
                          {comment.content.slice(0, 100)}{comment.content.length > 100 ? '...' : ''}
                        </Text>
                        <Text size="xs" color="tertiary">
                          @{comment.author_handle} · {new Date(comment.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                        </Text>
                        {comment.deleted_at && (
                          <Text size="xs" style={{ color: '#ff6b6b', marginTop: 4 }}>
                            {t('deletedByAdmin')}
                          </Text>
                        )}
                      </Box>
                      {!comment.deleted_at && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDeleteComment(comment.id)}
                          style={{ color: '#ff6b6b' }}
                        >
                          {t('delete')}
                        </Button>
                      )}
                    </Box>
                  </Box>
                ))}
                {filteredComments.length === 0 && (
                  <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                    {contentSearch
                      ? t('noMatchingComments')
                      : t('noCommentsYet')}
                  </Text>
                )}
              </Box>
            </Card>
          </Box>
        )}

        {/* 小组设置（仅组长） */}
        {activeTab === 'settings' && isOwner && (
          <Card title={t('groupSettings')}>
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('editRequiresApproval')}
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
              {/* 语言标签页 */}
              <Box>
                <Box style={{ display: 'flex', borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
                  <button
                    type="button"
                    style={langTabStyle(langTab === 'zh')}
                    onClick={() => setLangTab('zh')}
                    disabled={!editMode}
                  >
                    中文
                  </button>
                  {showMultiLang && (
                    <button
                      type="button"
                      style={langTabStyle(langTab === 'en')}
                      onClick={() => setLangTab('en')}
                      disabled={!editMode}
                    >
                      English
                    </button>
                  )}
                  {!showMultiLang && editMode && (
                    <button
                      type="button"
                      style={{
                        ...langTabStyle(false),
                        color: tokens.colors.accent?.primary || tokens.colors.accent.brand,
                        border: 'none',
                      }}
                      onClick={() => {
                        setShowMultiLang(true)
                        setLangTab('en')
                      }}
                    >
                      + {t('addLanguage')}
                    </button>
                  )}
                </Box>

                {/* 中文表单 */}
                <Box 
                  style={{ 
                    display: langTab === 'zh' ? 'flex' : 'none',
                    flexDirection: 'column',
                    gap: tokens.spacing[4],
                    padding: tokens.spacing[4],
                    background: tokens.colors.bg.secondary,
                    borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    borderTop: 'none',
                  }}
                >
                  {/* 小组名称（中文） */}
                  <Box>
                    <label style={labelStyle}>
                      {t('groupName')} *
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder={t('groupNamePlaceholder')}
                      style={inputStyle}
                      disabled={!editMode}
                      maxLength={50}
                    />
                  </Box>

                  {/* 小组简介（中文） */}
                  <Box>
                    <label style={labelStyle}>
                      {t('groupDescription')}
                    </label>
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder={t('groupDescriptionPlaceholder')}
                      style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
                      disabled={!editMode}
                      maxLength={500}
                    />
                  </Box>
                </Box>

                {/* 英文表单 */}
                {showMultiLang && (
                  <Box 
                    style={{ 
                      display: langTab === 'en' ? 'flex' : 'none',
                      flexDirection: 'column',
                      gap: tokens.spacing[4],
                      padding: tokens.spacing[4],
                      background: tokens.colors.bg.secondary,
                      borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      borderTop: 'none',
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text size="sm" color="tertiary">{t('englishVersion')}</Text>
                      {editMode && (
                        <Button
                          type="button"
                          variant="text"
                          size="sm"
                          onClick={() => {
                            setShowMultiLang(false)
                            setLangTab('zh')
                            setEditNameEn('')
                            setEditDescriptionEn('')
                          }}
                          style={{ padding: 0, color: tokens.colors.text.tertiary }}
                        >
                          {t('removeEnglish')}
                        </Button>
                      )}
                    </Box>

                    {/* 小组名称（英文） */}
                    <Box>
                      <label style={labelStyle}>
                        {t('groupNameEn')}
                      </label>
                      <input
                        type="text"
                        value={editNameEn}
                        onChange={(e) => setEditNameEn(e.target.value)}
                        placeholder={t('groupNameEnPlaceholder')}
                        style={inputStyle}
                        disabled={!editMode}
                        maxLength={50}
                      />
                    </Box>

                    {/* 小组简介（英文） */}
                    <Box>
                      <label style={labelStyle}>
                        {t('groupDescriptionEn')}
                      </label>
                      <textarea
                        value={editDescriptionEn}
                        onChange={(e) => setEditDescriptionEn(e.target.value)}
                        placeholder={t('groupDescriptionEnPlaceholder')}
                        style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
                        disabled={!editMode}
                        maxLength={500}
                      />
                    </Box>
                  </Box>
                )}
              </Box>

              {/* 小组规则 */}
              <Box>
                <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                  {t('groupRules')}
                </Text>
                <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {t('groupRulesDescription')}
                </Text>

                {/* 已添加的规则列表 */}
                {editRules.length > 0 && (
                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                    {editRules.map((rule, index) => (
                      <Box
                        key={index}
                        style={{
                          padding: tokens.spacing[3],
                          background: tokens.colors.bg.secondary,
                          borderRadius: tokens.radius.lg,
                          border: `1px solid ${tokens.colors.border.primary}`,
                        }}
                      >
                        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                          <Text size="sm" weight="bold" color="secondary">
                            {t('ruleNumber').replace('{n}', String(index + 1))}
                          </Text>
                          {editMode && (
                            <Button
                              type="button"
                              variant="text"
                              size="sm"
                              onClick={() => removeRule(index)}
                              style={{ padding: 0, color: '#ff6b6b', fontSize: tokens.typography.fontSize.xs }}
                            >
                              {t('delete')}
                            </Button>
                          )}
                        </Box>
                        
                        {editMode ? (
                          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                            <Box>
                              <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>中文</Text>
                              <input
                                type="text"
                                value={rule.zh}
                                onChange={(e) => updateRule(index, 'zh', e.target.value)}
                                style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                                placeholder={t('ruleContentZhPlaceholder')}
                              />
                            </Box>
                            {showMultiLang && (
                              <Box>
                                <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>English</Text>
                                <input
                                  type="text"
                                  value={rule.en}
                                  onChange={(e) => updateRule(index, 'en', e.target.value)}
                                  style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                                  placeholder={t('ruleContentEnPlaceholder')}
                                />
                              </Box>
                            )}
                          </Box>
                        ) : (
                          <Box>
                            <Text size="sm">{rule.zh || rule.en}</Text>
                            {rule.en && rule.zh && <Text size="xs" color="tertiary">{rule.en}</Text>}
                          </Box>
                        )}
                      </Box>
                    ))}
                  </Box>
                )}

                {/* 添加新规则 */}
                {editMode && (
                  <Box
                    style={{
                      padding: tokens.spacing[3],
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.lg,
                      border: `1px dashed ${tokens.colors.border.primary}`,
                    }}
                  >
                    <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                      {t('addNewRule')}
                    </Text>
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                      <input
                        type="text"
                        value={newRuleZh}
                        onChange={(e) => setNewRuleZh(e.target.value)}
                        style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                        placeholder={t('enterRuleZh')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addRule()
                          }
                        }}
                      />
                      {showMultiLang && (
                        <input
                          type="text"
                          value={newRuleEn}
                          onChange={(e) => setNewRuleEn(e.target.value)}
                          style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                          placeholder={t('enterRuleEn')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addRule()
                            }
                          }}
                        />
                      )}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={addRule}
                        disabled={!newRuleZh.trim() && !newRuleEn.trim()}
                        style={{ alignSelf: 'flex-start' }}
                      >
                        + {t('addRule')}
                      </Button>
                    </Box>
                  </Box>
                )}
              </Box>

              {/* 小组头像 URL */}
              {editMode && (
                <Box>
                  <label style={labelStyle}>
                    {t('groupAvatarUrl')}
                  </label>
                  <input
                    type="url"
                    value={editAvatarUrl}
                    onChange={(e) => setEditAvatarUrl(e.target.value)}
                    placeholder="https://example.com/avatar.png"
                    style={inputStyle}
                  />
                  {editAvatarUrl && (
                    <Box style={{ marginTop: tokens.spacing[2] }}>
                      <img
                        src={editAvatarUrl}
                        alt="Preview"
                        style={{
                          width: 60,
                          height: 60,
                          borderRadius: tokens.radius.lg,
                          objectFit: 'cover',
                          border: `1px solid ${tokens.colors.border.primary}`,
                        }}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    </Box>
                  )}
                </Box>
              )}

              {/* Pro 专属小组选项 */}
              {editMode && isPro && (
                <Box
                  style={{
                    padding: tokens.spacing[4],
                    background: 'var(--color-pro-glow)',
                    borderRadius: tokens.radius.lg,
                    border: '1px solid var(--color-pro-gradient-start)',
                  }}
                >
                  <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}>
                    <Box
                      onClick={() => setIsPremiumOnly(!isPremiumOnly)}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: tokens.radius.sm,
                        border: isPremiumOnly 
                          ? '2px solid var(--color-pro-gradient-start)' 
                          : '2px solid var(--color-border-secondary)',
                        background: isPremiumOnly ? 'var(--color-pro-gradient-start)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        flexShrink: 0,
                        marginTop: 2,
                        transition: 'all 0.2s',
                      }}
                    >
                      {isPremiumOnly && (
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </Box>
                    <Box style={{ flex: 1 }}>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: 4 }}>
                        <Text weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
                          {t('proExclusiveGroup')}
                        </Text>
                        <Box
                          style={{
                            padding: '2px 6px',
                            borderRadius: tokens.radius.full,
                            background: 'var(--color-pro-badge-bg)',
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#fff',
                          }}
                        >
                          Pro
                        </Box>
                      </Box>
                      <Text size="sm" color="secondary" style={{ lineHeight: 1.5 }}>
                        {t('proExclusiveGroupDesc')}
                      </Text>
                    </Box>
                  </Box>
                </Box>
              )}

              {/* 角色称呼设置 */}
              {editMode && (
                <Box>
                  <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                    {t('roleNamesSettings')}
                  </Text>
                  <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                    {t('roleNamesSettingsDesc')}
                  </Text>

                  <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                    {/* 管理员 */}
                    <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
                      <Text size="sm" color="secondary">
                        {t('admin')}
                      </Text>
                      <input
                        type="text"
                        value={editRoleNames?.admin?.zh || ''}
                        onChange={(e) => setEditRoleNames({
                          ...editRoleNames,
                          admin: {
                            ...(editRoleNames?.admin || { zh: '', en: '' }),
                            zh: e.target.value
                          }
                        })}
                        placeholder={t('adminRolePlaceholderZh')}
                        style={{ ...inputStyle, padding: tokens.spacing[2] }}
                        maxLength={20}
                      />
                      <input
                        type="text"
                        value={editRoleNames?.admin?.en || ''}
                        onChange={(e) => setEditRoleNames({ 
                          ...editRoleNames, 
                          admin: { 
                            ...(editRoleNames?.admin || { zh: '', en: '' }), 
                            en: e.target.value 
                          } 
                        })}
                        placeholder={t('adminRolePlaceholderEn')}
                        style={{ ...inputStyle, padding: tokens.spacing[2] }}
                        maxLength={20}
                      />
                    </Box>

                    {/* 成员 */}
                    <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
                      <Text size="sm" color="secondary">
                        {t('groupMember')}
                      </Text>
                      <input
                        type="text"
                        value={editRoleNames?.member?.zh || ''}
                        onChange={(e) => setEditRoleNames({
                          ...editRoleNames,
                          member: {
                            ...(editRoleNames?.member || { zh: '', en: '' }),
                            zh: e.target.value
                          }
                        })}
                        placeholder={t('memberRolePlaceholderZh')}
                        style={{ ...inputStyle, padding: tokens.spacing[2] }}
                        maxLength={20}
                      />
                      <input
                        type="text"
                        value={editRoleNames?.member?.en || ''}
                        onChange={(e) => setEditRoleNames({ 
                          ...editRoleNames, 
                          member: { 
                            ...(editRoleNames?.member || { zh: '', en: '' }), 
                            en: e.target.value 
                          } 
                        })}
                        placeholder={t('memberRolePlaceholderEn')}
                        style={{ ...inputStyle, padding: tokens.spacing[2] }}
                        maxLength={20}
                      />
                    </Box>
                  </Box>
                </Box>
              )}

              {/* 操作按钮 */}
              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end', marginTop: tokens.spacing[4] }}>
                {editMode ? (
                  <>
                    <Button variant="secondary" onClick={() => {
                      setEditMode(false)
                      // 重置表单到原始值
                      if (group) {
                        setEditName(group.name || '')
                        setEditNameEn(group.name_en || '')
                        setEditDescription(group.description || '')
                        setEditDescriptionEn(group.description_en || '')
                        setEditRules(group.rules_json || [])
                        setEditAvatarUrl(group.avatar_url || '')
                        // 安全地合并 role_names，确保所有字段都存在
                        const defaultRoleNames = {
                          admin: { zh: '管理员', en: 'Admin' },
                          member: { zh: '成员', en: 'Member' }
                        }
                        const loadedRoleNames = (group.role_names || {}) as { admin?: { zh?: string; en?: string }; member?: { zh?: string; en?: string } }
                        setEditRoleNames({
                          admin: {
                            zh: loadedRoleNames.admin?.zh || defaultRoleNames.admin.zh,
                            en: loadedRoleNames.admin?.en || defaultRoleNames.admin.en,
                          },
                          member: {
                            zh: loadedRoleNames.member?.zh || defaultRoleNames.member.zh,
                            en: loadedRoleNames.member?.en || defaultRoleNames.member.en,
                          }
                        })
                        setIsPremiumOnly(group.is_premium_only || false)
                        setShowMultiLang(!!(group.name_en || group.description_en))
                        setLangTab('zh')
                      }
                    }} disabled={submitting}>
                      {t('cancel')}
                    </Button>
                    <Button variant="primary" onClick={handleSubmitEdit} disabled={submitting}>
                      {submitting
                        ? t('submitting')
                        : t('submitChanges')}
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" onClick={() => setEditMode(true)}>
                    {t('editGroupInfo')}
                  </Button>
                )}
              </Box>
            </Box>
          </Card>
        )}

        {/* Activity Log */}
        {activeTab === 'activity' && (
          <Card title={t('activityLog')}>
            <ActivityLogSection groupId={groupId} />
          </Card>
        )}

        {/* 禁言弹窗 */}
        {showMuteModal && (
          <Box
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: tokens.zIndex.modal,
            }}
            onClick={() => setShowMuteModal(null)}
          >
            <Box
              style={{
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.xl,
                padding: tokens.spacing[6],
                width: '90%',
                maxWidth: 400,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
                {t('muteMember')}
              </Text>

              {/* 禁言时长 */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('muteDuration')}
                </Text>
                <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                  {(['3h', '1d', '7d', 'permanent'] as const).map((d) => (
                    <Button
                      key={d}
                      variant={muteDuration === d ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setMuteDuration(d)}
                    >
                      {d === '3h' ? t('duration3h') : d === '1d' ? t('duration1d') : d === '7d' ? t('duration7d') : t('durationPermanent')}
                    </Button>
                  ))}
                </Box>
              </Box>

              {/* 禁言原因 */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('muteReasonOptional')}
                </Text>
                <textarea
                  value={muteReason}
                  onChange={(e) => setMuteReason(e.target.value)}
                  placeholder={t('enterMuteReason')}
                  style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                />
              </Box>

              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
                <Button variant="secondary" onClick={() => setShowMuteModal(null)}>
                  {t('cancel')}
                </Button>
                <Button variant="primary" onClick={() => handleMute(showMuteModal)}>
                  {t('confirmMute')}
                </Button>
              </Box>
            </Box>
          </Box>
        )}

        {/* 通知弹窗 */}
        {showNotifyModal && (
          <Box
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: tokens.zIndex.modal,
            }}
            onClick={() => setShowNotifyModal(false)}
          >
            <Box
              style={{
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.xl,
                padding: tokens.spacing[6],
                width: '90%',
                maxWidth: 450,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
                {t('notifyAllMembers')}
              </Text>

              {/* 通知标题 */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('notifyTitleOptional')}
                </Text>
                <input
                  type="text"
                  value={notifyTitle}
                  onChange={(e) => setNotifyTitle(e.target.value)}
                  placeholder={t('notifyTitlePlaceholder')}
                  style={inputStyle}
                  maxLength={50}
                />
              </Box>

              {/* 通知内容 */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('notifyContent')} *
                </Text>
                <textarea
                  value={notifyMessage}
                  onChange={(e) => setNotifyMessage(e.target.value)}
                  placeholder={t('notifyContentPlaceholder')}
                  style={{ ...inputStyle, minHeight: 120, resize: 'vertical' }}
                  maxLength={500}
                />
                <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], textAlign: 'right' }}>
                  {notifyMessage.length}/500
                </Text>
              </Box>

              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
                {t('notifyDeliveryNote')}
              </Text>

              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
                <Button variant="secondary" onClick={() => setShowNotifyModal(false)} disabled={notifySending}>
                  {t('cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleNotify}
                  disabled={notifySending || !notifyMessage.trim()}
                >
                  {notifySending
                    ? t('sending')
                    : t('sendNotification')}
                </Button>
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  )
}
