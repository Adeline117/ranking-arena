'use client'

import Link from 'next/link'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import Card from '@/app/components/UI/Card'
import { Box, Text, Button } from '@/app/components/Base'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import { LikeIcon, CommentIcon } from '@/app/components/Icons'

type Group = {
  id: string
  name: string
  avatar_url?: string | null
  member_count?: number | null
}

type Post = {
  id: string
  group_id: string
  title: string
  content?: string | null
  created_at: string
  author_handle?: string | null
  like_count?: number | null
  comment_count?: number | null
  user_liked?: boolean // 当前用户是否点赞
}

export default function GroupDetailPage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
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
  
  const { t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [group, setGroup] = useState<Group | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [sortedPosts, setSortedPosts] = useState<Post[]>([])
  const [isMember, setIsMember] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [sortMode, setSortMode] = useState<'latest' | 'hot'>('latest')
  const [likeLoading, setLikeLoading] = useState<Record<string, boolean>>({})
  // 评论相关状态
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<Record<string, any[]>>({})
  const [newComment, setNewComment] = useState<Record<string, string>>({})
  const [commentLoading, setCommentLoading] = useState<Record<string, boolean>>({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setUserId(data.session?.user?.id ?? null)
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  // 获取用户点赞状态
  const fetchUserLikes = useCallback(async (postIds: string[], uid: string) => {
    if (!uid || postIds.length === 0) return {}
    
    const { data } = await supabase
      .from('post_likes')
      .select('post_id')
      .eq('user_id', uid)
      .in('post_id', postIds)
    
    const likeMap: Record<string, boolean> = {}
    data?.forEach(item => {
      likeMap[item.post_id] = true
    })
    return likeMap
  }, [])

  useEffect(() => {
    if (groupId === 'loading') return

    const load = async () => {
      setLoading(true)
      setError(null)

      try {
        // 读取小组信息
        const { data: groupData, error: groupErr } = await supabase
          .from('groups')
          .select('id, name, avatar_url, member_count')
          .eq('id', groupId)
          .maybeSingle()

        if (groupErr) {
          setError(groupErr.message)
          setLoading(false)
          return
        }

        setGroup(groupData as Group | null)

        // 读取帖子
        const { data: postsData, error: postsErr } = await supabase
          .from('posts')
          .select('id, group_id, title, content, created_at, author_handle, like_count, comment_count')
          .eq('group_id', groupId)
          .order('created_at', { ascending: false })
          .limit(50)

        if (postsErr) {
          setError(postsErr.message)
        } else {
          const postsList = (postsData || []) as Post[]
          
          // 获取用户点赞状态
          if (userId) {
            const postIds = postsList.map(p => p.id)
            const likeMap = await fetchUserLikes(postIds, userId)
            postsList.forEach(post => {
              post.user_liked = likeMap[post.id] || false
            })
          }
          
          setPosts(postsList)
        }

        // 检查用户是否是成员
        if (userId) {
          const { data: membership } = await supabase
            .from('group_members')
            .select('*')
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .maybeSingle()
          setIsMember(!!membership)
        }
      } catch (err: any) {
        setError(err?.message || '加载失败')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [groupId, userId, fetchUserLikes])

  // 计算帖子排序
  useEffect(() => {
    if (posts.length === 0) {
      setSortedPosts([])
      return
    }

    if (sortMode === 'latest') {
      // 最新：按时间降序
      setSortedPosts([...posts].sort((a, b) => 
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ))
    } else {
      // 热门：按综合分数排序
      const now = Date.now()
      const sorted = [...posts].sort((a, b) => {
        const hoursA = (now - new Date(a.created_at).getTime()) / (1000 * 60 * 60)
        const hoursB = (now - new Date(b.created_at).getTime()) / (1000 * 60 * 60)
        
        const scoreA = ((a.like_count || 0) * 2 + (a.comment_count || 0) * 1) / (1 + hoursA / 24)
        const scoreB = ((b.like_count || 0) * 2 + (b.comment_count || 0) * 1) / (1 + hoursB / 24)
        
        return scoreB - scoreA
      })
      setSortedPosts(sorted)
    }
  }, [posts, sortMode])

  // 点赞功能
  const handleLike = async (postId: string) => {
    if (!accessToken) {
      alert('请先登录')
      return
    }

    setLikeLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ reaction_type: 'up' }),
      })

      const result = await response.json()
      
      if (response.ok) {
        // 更新本地状态
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            const wasLiked = p.user_liked
            return {
              ...p,
              user_liked: !wasLiked,
              like_count: wasLiked 
                ? Math.max(0, (p.like_count || 0) - 1)
                : (p.like_count || 0) + 1,
            }
          }
          return p
        }))
      } else {
        alert(result.error || '操作失败')
      }
    } catch (err: any) {
      alert('网络错误: ' + err.message)
    } finally {
      setLikeLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  // 加载评论
  const loadComments = async (postId: string) => {
    setCommentLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/comments`)
      const result = await response.json()
      
      if (response.ok) {
        setComments(prev => ({ ...prev, [postId]: result.comments || [] }))
      }
    } catch (err) {
      console.error('加载评论失败:', err)
    } finally {
      setCommentLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  // 展开/收起评论
  const toggleComments = (postId: string) => {
    const isExpanded = expandedComments[postId]
    setExpandedComments(prev => ({ ...prev, [postId]: !isExpanded }))
    
    if (!isExpanded && !comments[postId]) {
      loadComments(postId)
    }
  }

  // 提交评论
  const submitComment = async (postId: string) => {
    if (!accessToken) {
      alert('请先登录')
      return
    }
    
    const content = newComment[postId]?.trim()
    if (!content) return

    setCommentLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ content }),
      })

      const result = await response.json()
      
      if (response.ok) {
        setNewComment(prev => ({ ...prev, [postId]: '' }))
        // 重新加载评论
        loadComments(postId)
        // 更新评论数
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comment_count: (p.comment_count || 0) + 1 }
          }
          return p
        }))
      } else {
        alert(result.error || '评论失败')
      }
    } catch (err: any) {
      alert('网络错误: ' + err.message)
    } finally {
      setCommentLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="sm" color="tertiary" style={{ textAlign: 'center' }}>{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  if (error || !group) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2], color: '#ff7c7c' }}>
            错误: {error || '小组不存在'}
          </Text>
          <Link href="/groups" style={{ color: tokens.colors.accent?.primary || tokens.colors.text.secondary, textDecoration: 'none', marginTop: tokens.spacing[3], display: 'inline-block' }}>
            ← 返回小组列表
          </Link>
        </Box>
      </Box>
    )
  }

  const handleJoin = async () => {
    if (!userId) {
      alert('请先登录')
      return
    }
    setJoining(true)
    try {
      const { error } = await supabase
        .from('group_members')
        .insert({ group_id: groupId, user_id: userId })
      if (error) throw error
      setIsMember(true)
    } catch (err: any) {
      alert('加入失败: ' + err.message)
    } finally {
      setJoining(false)
    }
  }

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
    } catch (err: any) {
      alert('退出失败: ' + err.message)
    } finally {
      setJoining(false)
    }
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}` }}>
        {/* Group Header */}
        <Box
          style={{
            marginBottom: tokens.spacing[6],
            padding: tokens.spacing[6],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Box style={{ display: 'flex', gap: tokens.spacing[4], alignItems: 'flex-start' }}>
            {/* Avatar */}
            <Box
              style={{
                width: 80,
                height: 80,
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.tertiary || tokens.colors.bg.primary,
                border: `2px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              {group.avatar_url ? (
                <img
                  src={group.avatar_url}
                  alt={group.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <Text size="2xl" weight="bold" color="tertiary">
                  {group.name.charAt(0).toUpperCase()}
                </Text>
              )}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                <Box>
                  <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[1] }}>
                    {group.name}
                  </Text>
                  {group.member_count !== null && group.member_count !== undefined && (
                    <Text size="sm" color="tertiary">
                      {group.member_count} 位成员
                    </Text>
                  )}
                </Box>
                <Link 
                  href="/groups" 
                  style={{ 
                    color: tokens.colors.accent?.primary || tokens.colors.text.secondary, 
                    textDecoration: 'none',
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: tokens.typography.fontWeight.semibold,
                  }}
                >
                  ← 返回
                </Link>
              </Box>


              {/* Join/Leave Button */}
              <Box style={{ marginTop: tokens.spacing[4] }}>
                {userId ? (
                  isMember ? (
                    <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => window.location.href = `/groups/${groupId}/new`}
                      >
                        + 发新帖
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleLeave}
                        disabled={joining}
                      >
                        {joining ? '退出中...' : '退出小组'}
                      </Button>
                    </Box>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleJoin}
                      disabled={joining}
                    >
                      {joining ? '加入中...' : '+ 加入小组'}
                    </Button>
                  )
                ) : (
                  <Link href="/login">
                    <Button variant="primary" size="sm">
                      登录后加入
                    </Button>
                  </Link>
                )}
              </Box>
            </Box>
          </Box>
        </Box>

        {/* Posts Section */}
        <Box style={{ position: 'relative' }}>
          {/* Sort Tabs */}
          <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
            <Button
              variant={sortMode === 'latest' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setSortMode('latest')}
            >
              最新
            </Button>
            <Button
              variant={sortMode === 'hot' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setSortMode('hot')}
            >
              热门
            </Button>
          </Box>

          <Card title={`帖子 (${sortedPosts.length})`}>
            {sortedPosts.length === 0 ? (
              <Box style={{ 
                color: tokens.colors.text.tertiary, 
                padding: `${tokens.spacing[10]} ${tokens.spacing[5]}`,
                textAlign: 'center',
              }}>
                <Text size="sm" color="tertiary">
                  还没有帖子，成为第一个发帖的人吧！
                </Text>
              </Box>
            ) : (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                {sortedPosts.map((post) => (
                  <Box
                    key={post.id}
                    style={{
                      padding: tokens.spacing[4],
                      borderRadius: tokens.radius.xl,
                      background: tokens.colors.bg.secondary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      transition: `all ${tokens.transition.base}`,
                    }}
                  >
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                      <Text size="lg" weight="bold">{post.title}</Text>
                      <Text size="xs" color="tertiary">
                        {new Date(post.created_at).toLocaleString('zh-CN')}
                      </Text>
                    </Box>

                    {post.author_handle && (
                      <Box style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2], display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                        <Text size="xs" color="secondary">
                          作者: <Link href={`/u/${encodeURIComponent(post.author_handle)}`} style={{ color: tokens.colors.accent?.primary || tokens.colors.text.secondary, textDecoration: 'none' }}>@{post.author_handle}</Link>
                        </Text>
                      </Box>
                    )}

                    {post.content && (
                      <Text size="sm" color="secondary" style={{ 
                        marginTop: tokens.spacing[3], 
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                      }}>
                        {post.content}
                      </Text>
                    )}

                    <Box style={{ 
                      marginTop: tokens.spacing[3], 
                      display: 'flex', 
                      gap: tokens.spacing[4],
                      paddingTop: tokens.spacing[3],
                      borderTop: `1px solid ${tokens.colors.border.primary}`,
                    }}>
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => handleLike(post.id)}
                        disabled={likeLoading[post.id]}
                        style={{ 
                          padding: 0, 
                          minWidth: 'auto',
                          color: post.user_liked ? tokens.colors.accent?.success : undefined,
                        }}
                      >
                        <LikeIcon size={14} />
                        <Text 
                          size="xs" 
                          style={{ 
                            marginLeft: tokens.spacing[1],
                            color: post.user_liked ? tokens.colors.accent?.success : tokens.colors.text.secondary,
                          }}
                        >
                          {post.like_count || 0}
                        </Text>
                      </Button>
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => toggleComments(post.id)}
                        style={{ padding: 0, minWidth: 'auto' }}
                      >
                        <CommentIcon size={14} />
                        <Text size="xs" color="secondary" style={{ marginLeft: tokens.spacing[1] }}>
                          {post.comment_count || 0}
                        </Text>
                      </Button>
                    </Box>

                    {/* 评论区 */}
                    {expandedComments[post.id] && (
                      <Box style={{ 
                        marginTop: tokens.spacing[3], 
                        paddingTop: tokens.spacing[3],
                        borderTop: `1px solid ${tokens.colors.border.primary}`,
                      }}>
                        {/* 评论输入框 */}
                        {accessToken && (
                          <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                            <input
                              type="text"
                              placeholder="写评论..."
                              value={newComment[post.id] || ''}
                              onChange={(e) => setNewComment(prev => ({ ...prev, [post.id]: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && submitComment(post.id)}
                              style={{
                                flex: 1,
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                borderRadius: tokens.radius.md,
                                border: `1px solid ${tokens.colors.border.primary}`,
                                background: tokens.colors.bg.primary,
                                color: tokens.colors.text.primary,
                                fontSize: tokens.typography.fontSize.sm,
                              }}
                            />
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => submitComment(post.id)}
                              disabled={commentLoading[post.id] || !newComment[post.id]?.trim()}
                            >
                              发送
                            </Button>
                          </Box>
                        )}

                        {/* 评论列表 */}
                        {commentLoading[post.id] ? (
                          <Text size="xs" color="tertiary">加载中...</Text>
                        ) : comments[post.id]?.length > 0 ? (
                          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                            {comments[post.id].map((comment: any) => (
                              <Box 
                                key={comment.id}
                                style={{ 
                                  padding: tokens.spacing[2],
                                  background: tokens.colors.bg.primary,
                                  borderRadius: tokens.radius.md,
                                }}
                              >
                                <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[1] }}>
                                  <Text size="xs" weight="bold" color="secondary">
                                    @{comment.author_handle || '匿名'}
                                  </Text>
                                  <Text size="xs" color="tertiary">
                                    {new Date(comment.created_at).toLocaleString('zh-CN')}
                                  </Text>
                                </Box>
                                <Text size="sm">{comment.content}</Text>
                              </Box>
                            ))}
                          </Box>
                        ) : (
                          <Text size="xs" color="tertiary">暂无评论</Text>
                        )}
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Card>
        </Box>

        {/* Floating Post Button (右下角固定) */}
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
              zIndex: 1000,
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
    </Box>
  )
}
