'use client'

import Link from 'next/link'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import Card from '@/app/components/UI/Card'
import { Box, Text, Button } from '@/app/components/Base'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

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
  rules_en?: string | null
  rules_json?: Array<{ zh: string; en: string }> | null
  role_names?: { admin: { zh: string; en: string }; member: { zh: string; en: string } } | null
}

type Rule = {
  zh: string
  en: string
}

export default function GroupManagePage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
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

  const { language } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [group, setGroup] = useState<Group | null>(null)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [posts, setPosts] = useState<Post[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member' | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'members' | 'content' | 'settings'>('members')
  
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

  // 禁言弹窗状态
  const [showMuteModal, setShowMuteModal] = useState<string | null>(null)
  const [muteDuration, setMuteDuration] = useState<'3h' | '1d' | '7d' | 'permanent'>('1d')
  const [muteReason, setMuteReason] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setUserId(data.session?.user?.id ?? null)
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

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
        const { data: membersData } = await supabase
          .from('group_members')
          .select('user_id, role, joined_at, muted_until, mute_reason')
          .eq('group_id', groupId)
          .order('role', { ascending: true })

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
        }

        // 获取帖子（包括已删除的）
        const { data: postsData } = await supabase
          .from('posts')
          .select('id, title, content, author_handle, created_at, deleted_at')
          .eq('group_id', groupId)
          .order('created_at', { ascending: false })
          .limit(50)

        setPosts((postsData || []) as Post[])

        // 获取评论
        const postIds = (postsData || []).map(p => p.id)
        if (postIds.length > 0) {
          const { data: commentsData } = await supabase
            .from('comments')
            .select('id, content, author_handle, created_at, deleted_at, post_id')
            .in('post_id', postIds)
            .order('created_at', { ascending: false })
            .limit(100)

          setComments((commentsData || []) as Comment[])
        }
      } catch (err) {
        console.error('Error loading data:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [groupId, userId])

  // 检查权限
  const canManage = userRole === 'owner' || userRole === 'admin'
  const isOwner = userRole === 'owner'

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
          Authorization: `Bearer ${accessToken}`
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
        alert(language === 'zh' ? '禁言成功' : 'Muted successfully')
      } else {
        const data = await res.json()
        alert(data.error || (language === 'zh' ? '操作失败' : 'Operation failed'))
      }
    } catch (err) {
      console.error('Mute error:', err)
      alert(language === 'zh' ? '网络错误' : 'Network error')
    }
  }

  // 解除禁言
  const handleUnmute = async (targetUserId: string) => {
    if (!accessToken || !canManage) return

    try {
      const res = await fetch(`/api/groups/${groupId}/members/${targetUserId}/mute`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` }
      })

      if (res.ok) {
        setMembers(prev => prev.map(m => 
          m.user_id === targetUserId 
            ? { ...m, muted_until: null, mute_reason: null }
            : m
        ))
        alert(language === 'zh' ? '已解除禁言' : 'Unmuted successfully')
      }
    } catch (err) {
      console.error('Unmute error:', err)
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
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ role: newRole })
      })

      if (res.ok) {
        setMembers(prev => prev.map(m => 
          m.user_id === targetUserId ? { ...m, role: newRole } : m
        ))
        alert(language === 'zh' ? '角色更新成功' : 'Role updated successfully')
      } else {
        const data = await res.json()
        alert(data.error || (language === 'zh' ? '操作失败' : 'Operation failed'))
      }
    } catch (err) {
      console.error('Set role error:', err)
    }
  }

  // 删除帖子
  const handleDeletePost = async (postId: string) => {
    if (!accessToken || !canManage) return
    if (!confirm(language === 'zh' ? '确定删除此帖子吗？' : 'Are you sure to delete this post?')) return

    try {
      const res = await fetch(`/api/groups/${groupId}/posts/${postId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` }
      })

      if (res.ok) {
        setPosts(prev => prev.map(p => 
          p.id === postId ? { ...p, deleted_at: new Date().toISOString() } : p
        ))
        alert(language === 'zh' ? '帖子已删除' : 'Post deleted')
      }
    } catch (err) {
      console.error('Delete post error:', err)
    }
  }

  // 删除评论
  const handleDeleteComment = async (commentId: string) => {
    if (!accessToken || !canManage) return
    if (!confirm(language === 'zh' ? '确定删除此评论吗？' : 'Are you sure to delete this comment?')) return

    try {
      const res = await fetch(`/api/groups/${groupId}/comments/${commentId}/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` }
      })

      if (res.ok) {
        setComments(prev => prev.map(c => 
          c.id === commentId ? { ...c, deleted_at: new Date().toISOString() } : c
        ))
        alert(language === 'zh' ? '评论已删除' : 'Comment deleted')
      }
    } catch (err) {
      console.error('Delete comment error:', err)
    }
  }

  // 添加规则
  const addRule = () => {
    if (!newRuleZh.trim() && !newRuleEn.trim()) return
    setEditRules([...editRules, { zh: newRuleZh.trim(), en: newRuleEn.trim() }])
    setNewRuleZh('')
    setNewRuleEn('')
  }

  // 删除规则
  const removeRule = (index: number) => {
    setEditRules(editRules.filter((_, i) => i !== index))
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
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          name: editName.trim() || null,
          name_en: editNameEn.trim() || null,
          description: editDescription.trim() || null,
          description_en: editDescriptionEn.trim() || null,
          rules_json: editRules.length > 0 ? editRules : null,
          rules: editRules.map(r => r.zh).filter(Boolean).join('\n') || null,
          rules_en: editRules.map(r => r.en).filter(Boolean).join('\n') || null,
        })
      })

      const data = await res.json()

      if (res.ok) {
        alert(language === 'zh' ? '修改申请已提交，等待管理员审核' : 'Edit request submitted, pending admin review')
        setEditMode(false)
      } else {
        alert(data.error || (language === 'zh' ? '提交失败' : 'Submission failed'))
      }
    } catch (err) {
      console.error('Submit edit error:', err)
      alert(language === 'zh' ? '网络错误' : 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    borderRadius: tokens.radius.lg,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.sm,
    outline: 'none',
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

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text color="tertiary">{language === 'zh' ? '加载中...' : 'Loading...'}</Text>
        </Box>
      </Box>
    )
  }

  if (!canManage) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text color="tertiary">{language === 'zh' ? '您没有管理权限' : 'You do not have management permissions'}</Text>
          <Link href={`/groups/${groupId}`} style={{ color: '#8b6fa8', marginTop: tokens.spacing[4], display: 'inline-block' }}>
            ← {language === 'zh' ? '返回小组' : 'Back to Group'}
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
          ← {language === 'zh' ? '返回小组' : 'Back to Group'}
        </Link>

        {/* 标题 */}
        <Text size="2xl" weight="bold" style={{ marginBottom: tokens.spacing[6] }}>
          {language === 'zh' ? '小组管理' : 'Group Management'} - {group?.name}
        </Text>

        {/* 标签页 */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[6] }}>
          <button style={tabStyle(activeTab === 'members')} onClick={() => setActiveTab('members')}>
            {language === 'zh' ? '成员管理' : 'Members'}
          </button>
          <button style={tabStyle(activeTab === 'content')} onClick={() => setActiveTab('content')}>
            {language === 'zh' ? '内容管理' : 'Content'}
          </button>
          {isOwner && (
            <button style={tabStyle(activeTab === 'settings')} onClick={() => setActiveTab('settings')}>
              {language === 'zh' ? '小组设置' : 'Settings'}
            </button>
          )}
        </Box>

        {/* 成员管理 */}
        {activeTab === 'members' && (
          <Card title={language === 'zh' ? `成员列表 (${members.length})` : `Members (${members.length})`}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              {members.map((member) => {
                const isMuted = member.muted_until && new Date(member.muted_until) > new Date()
                const canManageMember = (isOwner || (userRole === 'admin' && member.role === 'member')) && member.user_id !== userId

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
                      }}
                    >
                      {member.avatar_url ? (
                        <img src={member.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
                            background: member.role === 'owner' 
                              ? 'linear-gradient(135deg, #FFD700, #FFA500)'
                              : member.role === 'admin'
                                ? 'rgba(139, 111, 168, 0.3)'
                                : tokens.colors.bg.primary,
                            color: member.role === 'owner' ? '#000' : tokens.colors.text.secondary,
                          }}
                        >
                          {member.role === 'owner' 
                            ? (language === 'zh' ? '组长' : 'Owner')
                            : member.role === 'admin'
                              ? (language === 'zh' ? '管理员' : 'Admin')
                              : (language === 'zh' ? '成员' : 'Member')}
                        </span>
                        {isMuted && (
                          <span style={{ 
                            fontSize: tokens.typography.fontSize.xs, 
                            color: '#ff6b6b',
                            background: 'rgba(255, 107, 107, 0.1)',
                            padding: `2px ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.full,
                          }}>
                            {language === 'zh' ? '已禁言' : 'Muted'}
                          </span>
                        )}
                      </Box>
                      {isMuted && member.mute_reason && (
                        <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>
                          {language === 'zh' ? '原因' : 'Reason'}: {member.mute_reason}
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
                            {language === 'zh' ? '解禁' : 'Unmute'}
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setShowMuteModal(member.user_id)}
                          >
                            {language === 'zh' ? '禁言' : 'Mute'}
                          </Button>
                        )}

                        {/* 设置管理员（仅组长可操作） */}
                        {isOwner && member.role !== 'owner' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleSetRole(member.user_id, member.role === 'admin' ? 'member' : 'admin')}
                          >
                            {member.role === 'admin' 
                              ? (language === 'zh' ? '撤销管理员' : 'Remove Admin')
                              : (language === 'zh' ? '设为管理员' : 'Make Admin')}
                          </Button>
                        )}
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          </Card>
        )}

        {/* 内容管理 */}
        {activeTab === 'content' && (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            {/* 帖子 */}
            <Card title={language === 'zh' ? `帖子 (${posts.length})` : `Posts (${posts.length})`}>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {posts.map((post) => (
                  <Box
                    key={post.id}
                    style={{
                      padding: tokens.spacing[3],
                      background: post.deleted_at ? 'rgba(255, 107, 107, 0.1)' : tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.lg,
                      border: `1px solid ${post.deleted_at ? 'rgba(255, 107, 107, 0.3)' : tokens.colors.border.primary}`,
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <Box>
                        <Text weight="bold" style={{ textDecoration: post.deleted_at ? 'line-through' : 'none' }}>
                          {post.title}
                        </Text>
                        <Text size="xs" color="tertiary">
                          @{post.author_handle} · {new Date(post.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                        </Text>
                        {post.deleted_at && (
                          <Text size="xs" style={{ color: '#ff6b6b', marginTop: 4 }}>
                            {language === 'zh' ? '已被管理员删除' : 'Deleted by admin'}
                          </Text>
                        )}
                      </Box>
                      {!post.deleted_at && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDeletePost(post.id)}
                          style={{ color: '#ff6b6b' }}
                        >
                          {language === 'zh' ? '删除' : 'Delete'}
                        </Button>
                      )}
                    </Box>
                  </Box>
                ))}
                {posts.length === 0 && (
                  <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                    {language === 'zh' ? '暂无帖子' : 'No posts'}
                  </Text>
                )}
              </Box>
            </Card>

            {/* 评论 */}
            <Card title={language === 'zh' ? `评论 (${comments.length})` : `Comments (${comments.length})`}>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {comments.slice(0, 50).map((comment) => (
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
                            {language === 'zh' ? '已被管理员删除' : 'Deleted by admin'}
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
                          {language === 'zh' ? '删除' : 'Delete'}
                        </Button>
                      )}
                    </Box>
                  </Box>
                ))}
                {comments.length === 0 && (
                  <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                    {language === 'zh' ? '暂无评论' : 'No comments'}
                  </Text>
                )}
              </Box>
            </Card>
          </Box>
        )}

        {/* 小组设置（仅组长） */}
        {activeTab === 'settings' && isOwner && (
          <Card title={language === 'zh' ? '小组设置' : 'Group Settings'}>
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
              {language === 'zh' 
                ? '修改小组信息需要提交申请，经管理员审核后生效' 
                : 'Changes to group info require admin approval'}
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              {/* 中文名称 */}
              <Box>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[1] }}>
                  {language === 'zh' ? '小组名称（中文）' : 'Group Name (Chinese)'}
                </Text>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={inputStyle}
                  disabled={!editMode}
                />
              </Box>

              {/* 英文名称 */}
              <Box>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[1] }}>
                  {language === 'zh' ? '小组名称（英文）' : 'Group Name (English)'}
                </Text>
                <input
                  type="text"
                  value={editNameEn}
                  onChange={(e) => setEditNameEn(e.target.value)}
                  style={inputStyle}
                  disabled={!editMode}
                />
              </Box>

              {/* 中文简介 */}
              <Box>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[1] }}>
                  {language === 'zh' ? '小组简介（中文）' : 'Description (Chinese)'}
                </Text>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                  disabled={!editMode}
                />
              </Box>

              {/* 英文简介 */}
              <Box>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[1] }}>
                  {language === 'zh' ? '小组简介（英文）' : 'Description (English)'}
                </Text>
                <textarea
                  value={editDescriptionEn}
                  onChange={(e) => setEditDescriptionEn(e.target.value)}
                  style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                  disabled={!editMode}
                />
              </Box>

              {/* 小组规则 */}
              <Box>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {language === 'zh' ? '小组规则' : 'Group Rules'}
                </Text>

                {editRules.map((rule, index) => (
                  <Box
                    key={index}
                    style={{
                      padding: tokens.spacing[3],
                      background: tokens.colors.bg.primary,
                      borderRadius: tokens.radius.lg,
                      marginBottom: tokens.spacing[2],
                      border: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
                      <Text size="xs" color="tertiary">{language === 'zh' ? `规则 ${index + 1}` : `Rule ${index + 1}`}</Text>
                      {editMode && (
                        <button
                          onClick={() => removeRule(index)}
                          style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', fontSize: 12 }}
                        >
                          {language === 'zh' ? '删除' : 'Delete'}
                        </button>
                      )}
                    </Box>
                    <Text size="sm">{rule.zh || rule.en}</Text>
                    {rule.en && rule.zh && <Text size="xs" color="tertiary">{rule.en}</Text>}
                  </Box>
                ))}

                {editMode && (
                  <Box style={{ 
                    padding: tokens.spacing[3], 
                    background: tokens.colors.bg.primary, 
                    borderRadius: tokens.radius.lg,
                    border: `1px dashed ${tokens.colors.border.primary}`,
                  }}>
                    <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                      {language === 'zh' ? '添加新规则' : 'Add New Rule'}
                    </Text>
                    <input
                      type="text"
                      value={newRuleZh}
                      onChange={(e) => setNewRuleZh(e.target.value)}
                      placeholder={language === 'zh' ? '规则内容（中文）' : 'Rule (Chinese)'}
                      style={{ ...inputStyle, marginBottom: tokens.spacing[2] }}
                    />
                    <input
                      type="text"
                      value={newRuleEn}
                      onChange={(e) => setNewRuleEn(e.target.value)}
                      placeholder="Rule (English)"
                      style={{ ...inputStyle, marginBottom: tokens.spacing[2] }}
                    />
                    <Button variant="secondary" size="sm" onClick={addRule}>
                      + {language === 'zh' ? '添加' : 'Add'}
                    </Button>
                  </Box>
                )}
              </Box>

              {/* 操作按钮 */}
              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end', marginTop: tokens.spacing[4] }}>
                {editMode ? (
                  <>
                    <Button variant="secondary" onClick={() => setEditMode(false)} disabled={submitting}>
                      {language === 'zh' ? '取消' : 'Cancel'}
                    </Button>
                    <Button variant="primary" onClick={handleSubmitEdit} disabled={submitting}>
                      {submitting 
                        ? (language === 'zh' ? '提交中...' : 'Submitting...')
                        : (language === 'zh' ? '提交修改申请' : 'Submit Changes')}
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" onClick={() => setEditMode(true)}>
                    {language === 'zh' ? '编辑小组信息' : 'Edit Group Info'}
                  </Button>
                )}
              </Box>
            </Box>
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
              zIndex: 2000,
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
                {language === 'zh' ? '禁言成员' : 'Mute Member'}
              </Text>

              {/* 禁言时长 */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {language === 'zh' ? '禁言时长' : 'Duration'}
                </Text>
                <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                  {(['3h', '1d', '7d', 'permanent'] as const).map((d) => (
                    <Button
                      key={d}
                      variant={muteDuration === d ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setMuteDuration(d)}
                    >
                      {d === '3h' ? '3小时' : d === '1d' ? '1天' : d === '7d' ? '7天' : '永久'}
                    </Button>
                  ))}
                </Box>
              </Box>

              {/* 禁言原因 */}
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {language === 'zh' ? '禁言原因（可选）' : 'Reason (optional)'}
                </Text>
                <textarea
                  value={muteReason}
                  onChange={(e) => setMuteReason(e.target.value)}
                  placeholder={language === 'zh' ? '输入禁言原因...' : 'Enter reason...'}
                  style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                />
              </Box>

              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
                <Button variant="secondary" onClick={() => setShowMuteModal(null)}>
                  {language === 'zh' ? '取消' : 'Cancel'}
                </Button>
                <Button variant="primary" onClick={() => handleMute(showMuteModal)}>
                  {language === 'zh' ? '确认禁言' : 'Confirm Mute'}
                </Button>
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  )
}
