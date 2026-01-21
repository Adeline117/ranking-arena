'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../UI/Toast'
import { supabase } from '@/lib/supabase/client'

interface Comment {
  id: string
  user_id: string
  user_handle: string
  user_avatar?: string
  content: string
  created_at: string
  like_count: number
  liked_by_me: boolean
}

interface TraderDiscussionProps {
  traderId: string
  traderHandle: string
}

/**
 * 交易员讨论区组件
 * 让用户可以在交易员详情页讨论该交易员
 *
 * 核心功能：
 * - 查看关于该交易员的评论/讨论
 * - 登录用户可以发表评论
 * - 点赞功能
 */
export default function TraderDiscussion({
  traderId,
  traderHandle,
}: TraderDiscussionProps) {
  const { language, t } = useLanguage()
  const { showToast } = useToast()
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [user, setUser] = useState<{ id: string; handle: string; avatar?: string } | null>(null)
  const [sortBy, setSortBy] = useState<'newest' | 'popular'>('newest')

  // 获取当前用户
  useEffect(() => {
    const getUser = async () => {
      const { data: { user: authUser } } = await supabase.auth.getUser()
      if (authUser) {
        // 获取用户 profile
        const { data: profile } = await supabase
          .from('profiles')
          .select('handle, avatar_url')
          .eq('id', authUser.id)
          .single()

        if (profile) {
          setUser({
            id: authUser.id,
            handle: profile.handle || authUser.email?.split('@')[0] || 'User',
            avatar: profile.avatar_url,
          })
        }
      }
    }
    getUser()
  }, [])

  // 获取讨论列表
  const fetchComments = useCallback(async () => {
    try {
      const response = await fetch(`/api/traders/${encodeURIComponent(traderId)}/discussions?sort=${sortBy}`)
      if (response.ok) {
        const data = await response.json()
        setComments(data.comments || [])
      }
    } catch (error) {
      console.error('Error fetching comments:', error)
    } finally {
      setLoading(false)
    }
  }, [traderId, sortBy])

  useEffect(() => {
    fetchComments()
  }, [fetchComments])

  // 发表评论
  const handleSubmit = async () => {
    if (!newComment.trim() || !user || submitting) return

    setSubmitting(true)
    try {
      const response = await fetch(`/api/traders/${encodeURIComponent(traderId)}/discussions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newComment.trim() }),
      })

      if (response.ok) {
        setNewComment('')
        fetchComments()
        showToast(language === 'zh' ? '评论发送成功' : 'Comment posted', 'success')
      } else {
        // 显示错误提示
        const errorText = language === 'zh' ? '发送失败，请重试' : 'Failed to post, please try again'
        showToast(errorText, 'error')
      }
    } catch (error) {
      console.error('Error posting comment:', error)
      const errorText = language === 'zh' ? '网络错误，请稍后重试' : 'Network error, please try again'
      showToast(errorText, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // 点赞
  const handleLike = async (commentId: string) => {
    if (!user) return

    // 乐观更新：立即更新 UI
    setComments(prev => prev.map(c =>
      c.id === commentId
        ? { ...c, like_count: c.liked_by_me ? c.like_count - 1 : c.like_count + 1, liked_by_me: !c.liked_by_me }
        : c
    ))

    try {
      const response = await fetch(`/api/traders/${encodeURIComponent(traderId)}/discussions/${commentId}/like`, {
        method: 'POST',
      })
      if (!response.ok) {
        // 如果失败，回滚乐观更新
        fetchComments()
      }
    } catch (error) {
      console.error('Error liking comment:', error)
      // 网络错误，回滚乐观更新
      fetchComments()
    }
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHours / 24)

    if (diffHours < 1) return language === 'zh' ? '刚刚' : 'Just now'
    if (diffHours < 24) return language === 'zh' ? `${diffHours}小时前` : `${diffHours}h ago`
    if (diffDays < 7) return language === 'zh' ? `${diffDays}天前` : `${diffDays}d ago`
    return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <Box
      className="trader-discussion glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: tokens.spacing[5],
          borderBottom: `1px solid ${tokens.colors.border.primary}40`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">
            {language === 'zh' ? '社区讨论' : 'Community Discussion'}
          </Text>
          <Box
            style={{
              background: `${tokens.colors.accent.primary}20`,
              padding: `2px ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.full,
            }}
          >
            <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary }}>
              {comments.length}
            </Text>
          </Box>
        </Box>

        {/* Sort Toggle */}
        <Box
          style={{
            display: 'flex',
            gap: 2,
            background: tokens.colors.bg.tertiary,
            padding: 2,
            borderRadius: tokens.radius.md,
          }}
        >
          {(['newest', 'popular'] as const).map((type) => (
            <button
              key={type}
              onClick={() => setSortBy(type)}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.sm,
                border: 'none',
                background: sortBy === type ? tokens.colors.bg.primary : 'transparent',
                color: sortBy === type ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: sortBy === type ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {type === 'newest'
                ? (language === 'zh' ? '最新' : 'Newest')
                : (language === 'zh' ? '热门' : 'Popular')
              }
            </button>
          ))}
        </Box>
      </Box>

      {/* Comment Input */}
      <Box
        style={{
          padding: tokens.spacing[4],
          borderBottom: `1px solid ${tokens.colors.border.primary}30`,
          background: `${tokens.colors.bg.secondary}50`,
        }}
      >
        {user ? (
          <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
            {/* Avatar */}
            <Box
              style={{
                width: 40,
                height: 40,
                borderRadius: tokens.radius.full,
                background: user.avatar
                  ? `url(${user.avatar}) center/cover no-repeat`
                  : `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {!user.avatar && (
                <Text size="sm" weight="bold" style={{ color: '#fff' }}>
                  {user.handle.charAt(0).toUpperCase()}
                </Text>
              )}
            </Box>

            {/* Input */}
            <Box style={{ flex: 1 }}>
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={language === 'zh'
                  ? `分享你对 ${traderHandle} 的看法...`
                  : `Share your thoughts about ${traderHandle}...`
                }
                style={{
                  width: '100%',
                  minHeight: 80,
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  resize: 'vertical',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = tokens.colors.accent.primary
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = tokens.colors.border.primary
                }}
              />
              <Box style={{ display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacing[2] }}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSubmit}
                  disabled={!newComment.trim() || submitting}
                  style={{
                    opacity: !newComment.trim() || submitting ? 0.5 : 1,
                    cursor: !newComment.trim() || submitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {submitting
                    ? (language === 'zh' ? '发送中...' : 'Posting...')
                    : (language === 'zh' ? '发表评论' : 'Post Comment')
                  }
                </Button>
              </Box>
            </Box>
          </Box>
        ) : (
          <Box
            style={{
              textAlign: 'center',
              padding: tokens.spacing[4],
            }}
          >
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              {language === 'zh' ? '登录后参与讨论' : 'Sign in to join the discussion'}
            </Text>
            <Link href="/login">
              <Button variant="outline" size="sm">
                {language === 'zh' ? '登录' : 'Sign In'}
              </Button>
            </Link>
          </Box>
        )}
      </Box>

      {/* Comments List */}
      <Box style={{ maxHeight: 600, overflowY: 'auto' }}>
        {loading ? (
          <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
            <Text size="sm" color="tertiary">
              {language === 'zh' ? '加载中...' : 'Loading...'}
            </Text>
          </Box>
        ) : comments.length === 0 ? (
          <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
            <Text size="lg" style={{ marginBottom: tokens.spacing[2], opacity: 0.3 }}>
              💬
            </Text>
            <Text size="sm" color="tertiary">
              {language === 'zh'
                ? '暂无讨论，成为第一个发言的人吧！'
                : 'No discussions yet. Be the first to comment!'
              }
            </Text>
          </Box>
        ) : (
          comments.map((comment, idx) => (
            <Box
              key={comment.id}
              style={{
                padding: tokens.spacing[4],
                borderBottom: idx < comments.length - 1
                  ? `1px solid ${tokens.colors.border.primary}20`
                  : 'none',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${tokens.colors.bg.secondary}50`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                {/* Avatar */}
                <Link href={`/u/${comment.user_handle}`}>
                  <Box
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: tokens.radius.full,
                      background: comment.user_avatar
                        ? `url(${comment.user_avatar}) center/cover no-repeat`
                        : `linear-gradient(135deg, ${tokens.colors.accent.primary}60, ${tokens.colors.accent.brand}60)`,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      transition: 'transform 0.2s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'scale(1.1)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'scale(1)'
                    }}
                  >
                    {!comment.user_avatar && (
                      <Text size="xs" weight="bold" style={{ color: '#fff' }}>
                        {comment.user_handle.charAt(0).toUpperCase()}
                      </Text>
                    )}
                  </Box>
                </Link>

                {/* Content */}
                <Box style={{ flex: 1 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[1] }}>
                    <Link
                      href={`/u/${comment.user_handle}`}
                      style={{ textDecoration: 'none' }}
                    >
                      <Text size="sm" weight="semibold" style={{ color: tokens.colors.text.primary }}>
                        @{comment.user_handle}
                      </Text>
                    </Link>
                    <Text size="xs" color="tertiary">
                      {formatTime(comment.created_at)}
                    </Text>
                  </Box>
                  <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
                    {comment.content}
                  </Text>

                  {/* Actions */}
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginTop: tokens.spacing[2] }}>
                    <button
                      onClick={() => handleLike(comment.id)}
                      disabled={!user}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[1],
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.md,
                        border: 'none',
                        background: comment.liked_by_me
                          ? `${tokens.colors.accent.error}15`
                          : 'transparent',
                        color: comment.liked_by_me
                          ? tokens.colors.accent.error
                          : tokens.colors.text.tertiary,
                        fontSize: tokens.typography.fontSize.xs,
                        cursor: user ? 'pointer' : 'default',
                        opacity: user ? 1 : 0.5,
                        transition: 'all 0.2s',
                        fontFamily: tokens.typography.fontFamily.sans.join(', '),
                      }}
                    >
                      <span>{comment.liked_by_me ? '❤️' : '🤍'}</span>
                      <span>{comment.like_count || 0}</span>
                    </button>
                  </Box>
                </Box>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  )
}
