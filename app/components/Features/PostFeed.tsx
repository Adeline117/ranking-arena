'use client'

import Link from 'next/link'
import { useEffect, useState, useRef, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../Icons'
import { useLanguage } from '../Utils/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { formatTimeAgo } from '@/lib/utils/date'
import { type PollChoice, type PostWithUserState, getPollWinner } from '@/lib/types'

// 本地类型（扩展后端类型）
type Post = PostWithUserState

type Comment = {
  id: string
  content: string
  author_handle?: string
  author_avatar_url?: string
  created_at: string
  replies?: Comment[]
}

const ARENA_PURPLE = '#8b6fa8'

function pollLabel(choice: PollChoice | 'tie', t: (key: keyof typeof import('@/lib/i18n').translations.zh) => string) {
  if (choice === 'bull') return t('bullish')
  if (choice === 'bear') return t('bearish')
  return t('wait')
}

function pollColor(choice: PollChoice | 'tie') {
  if (choice === 'bull') return '#7CFFB2'
  if (choice === 'bear') return '#FF7C7C'
  return '#A9A9A9'
}

function AvatarLink({ handle, avatarUrl }: { handle?: string | null; avatarUrl?: string | null }) {
  if (!handle) return null
  const href = `/trader/${encodeURIComponent(handle)}`
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        textDecoration: 'none',
        color: tokens.colors.text.primary,
      }}
      title="进入交易者主页"
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: tokens.radius.md,
          display: 'grid',
          placeItems: 'center',
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          fontWeight: tokens.typography.fontWeight.black,
          fontSize: tokens.typography.fontSize.xs,
          transition: `all ${tokens.transition.base}`,
          overflow: 'hidden',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.1)'
          e.currentTarget.style.boxShadow = tokens.shadow.sm
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)'
          e.currentTarget.style.boxShadow = tokens.shadow.none
        }}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt={handle} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          (handle?.[0] || 'U').toUpperCase()
        )}
      </span>
      <span style={{ fontWeight: 850, fontSize: 12, color: tokens.colors.text.secondary }}>{handle}</span>
    </Link>
  )
}

export default function PostFeed(props: { variant?: 'compact' | 'full'; groupId?: string; authorHandle?: string } = {}) {
  const { t } = useLanguage()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openPost, setOpenPost] = useState<Post | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const processingRef = useRef<Set<string>>(new Set())

  // 获取用户 token
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAccessToken(session?.access_token || null)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token || null)
    })

    return () => subscription.unsubscribe()
  }, [])

  // 加载帖子
  const loadPosts = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams()
      params.set('limit', '20')
      params.set('sort_by', 'created_at')
      params.set('sort_order', 'desc')
      
      if (props.groupId) params.set('group_id', props.groupId)
      if (props.authorHandle) params.set('author_handle', props.authorHandle)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }

      const response = await fetch(`/api/posts?${params.toString()}`, { headers })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || '获取帖子失败')
      }

      // API 返回格式: { success: true, data: { posts: [...] } }
      setPosts(data.data?.posts || [])
    } catch (err: any) {
      console.error('[PostFeed] 加载失败:', err)
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [props.groupId, props.authorHandle, accessToken])

  useEffect(() => {
    loadPosts()
  }, [loadPosts])

  // 加载评论
  const loadComments = useCallback(async (postId: string) => {
    try {
      setLoadingComments(true)
      const response = await fetch(`/api/posts/${postId}/comments`)
      const data = await response.json()

      if (response.ok) {
        setComments(data.comments || [])
      }
    } catch (err) {
      console.error('[PostFeed] 加载评论失败:', err)
    } finally {
      setLoadingComments(false)
    }
  }, [])

  // 点赞/踩
  const toggleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!accessToken) {
      alert('请先登录')
      return
    }

    const key = `react-${postId}-${reactionType}`
    if (processingRef.current.has(key)) return
    processingRef.current.add(key)

    try {
      const response = await fetch(`/api/posts/${postId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ reaction_type: reactionType }),
      })

      const data = await response.json()

      if (response.ok) {
        // 更新本地状态
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return {
              ...p,
              like_count: data.like_count,
              dislike_count: data.dislike_count,
              user_reaction: data.reaction,
            }
          }
          return p
        }))

        // 如果弹窗打开，也更新弹窗中的帖子
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? {
            ...prev,
            like_count: data.like_count,
            dislike_count: data.dislike_count,
            user_reaction: data.reaction,
          } : null)
        }
      }
    } catch (err) {
      console.error('[PostFeed] 点赞失败:', err)
    } finally {
      setTimeout(() => processingRef.current.delete(key), 300)
    }
  }, [accessToken, openPost?.id])

  // 投票
  const toggleVote = useCallback(async (postId: string, choice: PollChoice) => {
    if (!accessToken) {
      alert('请先登录')
      return
    }

    const key = `vote-${postId}-${choice}`
    if (processingRef.current.has(key)) return
    processingRef.current.add(key)

    try {
      const response = await fetch(`/api/posts/${postId}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ choice }),
      })

      const data = await response.json()

      if (response.ok) {
        // 更新本地状态
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return {
              ...p,
              poll_bull: data.poll.bull,
              poll_bear: data.poll.bear,
              poll_wait: data.poll.wait,
              user_vote: data.vote,
            }
          }
          return p
        }))

        // 如果弹窗打开，也更新
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? {
            ...prev,
            poll_bull: data.poll.bull,
            poll_bear: data.poll.bear,
            poll_wait: data.poll.wait,
            user_vote: data.vote,
          } : null)
        }
      }
    } catch (err) {
      console.error('[PostFeed] 投票失败:', err)
    } finally {
      setTimeout(() => processingRef.current.delete(key), 300)
    }
  }, [accessToken, openPost?.id])

  // 提交评论
  const submitComment = useCallback(async (postId: string) => {
    if (!accessToken) {
      alert('请先登录')
      return
    }

    if (!newComment.trim()) return

    setSubmittingComment(true)
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ content: newComment.trim() }),
      })

      const data = await response.json()

      if (response.ok) {
        setComments(prev => [...prev, data.comment])
        setNewComment('')
        
        // 更新评论计数
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comment_count: p.comment_count + 1 }
          }
          return p
        }))
        
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, comment_count: prev.comment_count + 1 } : null)
        }
      } else {
        alert(data.error || '发表评论失败')
      }
    } catch (err) {
      console.error('[PostFeed] 发表评论失败:', err)
      alert('发表评论失败')
    } finally {
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, openPost?.id])

  // 打开帖子详情
  const handleOpenPost = useCallback((post: Post) => {
    setOpenPost(post)
    setComments([])
    loadComments(post.id)
  }, [loadComments])

  if (loading) {
    return (
      <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary }}>
        加载中...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary }}>
        {error}
        <button
          onClick={loadPosts}
          style={{
            marginLeft: tokens.spacing[2],
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            background: tokens.colors.accent.primary,
            color: '#fff',
            border: 'none',
            borderRadius: tokens.radius.sm,
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </div>
    )
  }

  if (posts.length === 0) {
    return (
      <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary }}>
        暂无帖子
      </div>
    )
  }

  return (
    <>
      <div>
        {posts.map((p) => {
          const poll = { bull: p.poll_bull, bear: p.poll_bear, wait: p.poll_wait }
          const winner = p.poll_enabled ? getPollWinner(poll) : 'tie'
          const label = pollLabel(winner, t)
          const color = pollColor(winner)

          return (
            <div
              key={p.id}
              onClick={() => handleOpenPost(p)}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                padding: `${tokens.spacing[3]} 0`,
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
                color: tokens.colors.text.primary,
                transition: `background-color ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.secondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                {p.group_id ? (
                  <Link
                    href={`/groups/${p.group_id}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      fontSize: 12,
                      color: ARENA_PURPLE,
                      textDecoration: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {p.group_name || '小组'}
                  </Link>
                ) : (
                  <div style={{ fontSize: 12, color: ARENA_PURPLE }}>
                    讨论
                  </div>
                )}
                <AvatarLink handle={p.author_handle} avatarUrl={p.author_avatar_url} />
              </div>

              <div style={{ marginTop: 6, fontWeight: 950, lineHeight: 1.25 }}>
                {p.title}{' '}
                {p.poll_enabled && (
                  <span
                    style={{
                      fontSize: 11,
                      color,
                      fontWeight: 950,
                      border: '1px solid #1f1f1f',
                      padding: '2px 6px',
                      borderRadius: 999,
                      marginLeft: 6,
                    }}
                  >
                    {label}
                  </span>
                )}
              </div>

              <div style={{ marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap', color: tokens.colors.text.secondary, fontSize: 12, alignItems: 'center' }}>
                <ReactButton
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleReaction(p.id, 'up')
                  }}
                  active={p.user_reaction === 'up'}
                  icon={<ThumbsUpIcon size={14} />}
                  count={p.like_count}
                  showCount={true}
                />
                <ReactButton
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleReaction(p.id, 'down')
                  }}
                  active={p.user_reaction === 'down'}
                  icon={<ThumbsDownIcon size={14} />}
                  count={p.dislike_count}
                  showCount={false}
                />
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CommentIcon size={14} /> {p.comment_count}
                </span>
                <span style={{ color: tokens.colors.text.tertiary }}>
                  {formatTimeAgo(p.created_at)}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {openPost && (
        <Modal onClose={() => setOpenPost(null)}>
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>
            {openPost.group_name || '讨论'}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 950, lineHeight: 1.25 }}>{openPost.title}</div>
            <AvatarLink handle={openPost.author_handle} avatarUrl={openPost.author_avatar_url} />
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 6 }}>
            {openPost.author_handle} · {formatTimeAgo(openPost.created_at)} · <CommentIcon size={12} /> {openPost.comment_count}
          </div>

          <div style={{ marginTop: 12, fontSize: 14, color: tokens.colors.text.primary, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
            {openPost.content}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #141414', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Action
              icon={<ThumbsUpIcon size={14} />}
              text={t('upvote')}
              onClick={(e) => {
                if (e) {
                  e.preventDefault()
                  e.stopPropagation()
                }
                toggleReaction(openPost.id, 'up')
              }}
              active={openPost.user_reaction === 'up'}
              count={openPost.like_count}
              showCount={true}
            />
            <Action
              icon={<ThumbsDownIcon size={14} />}
              text={t('downvote')}
              onClick={(e) => {
                if (e) {
                  e.preventDefault()
                  e.stopPropagation()
                }
                toggleReaction(openPost.id, 'down')
              }}
              active={openPost.user_reaction === 'down'}
              count={openPost.dislike_count}
              showCount={false}
            />
            {openPost.poll_enabled && (
              <>
                <Action
                  text={`📈 ${t('bullish')}`}
                  onClick={() => toggleVote(openPost.id, 'bull')}
                  active={openPost.user_vote === 'bull'}
                  count={openPost.poll_bull}
                  showCount={true}
                />
                <Action
                  text={`📉 ${t('bearish')}`}
                  onClick={() => toggleVote(openPost.id, 'bear')}
                  active={openPost.user_vote === 'bear'}
                  count={openPost.poll_bear}
                  showCount={true}
                />
                <Action
                  text={`⏸ ${t('wait')}`}
                  onClick={() => toggleVote(openPost.id, 'wait')}
                  active={openPost.user_vote === 'wait'}
                  count={openPost.poll_wait}
                  showCount={true}
                />
              </>
            )}
          </div>

          {/* 评论区 */}
          <div style={{ marginTop: 16, borderTop: '1px solid #141414', paddingTop: 16 }}>
            <div style={{ fontWeight: 950, marginBottom: 12 }}>
              {t('comments')} ({openPost.comment_count})
            </div>

            {/* 评论输入框 */}
            <div style={{ marginBottom: 16 }}>
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={accessToken ? t('writeComment') : '请先登录后发表评论'}
                disabled={!accessToken || submittingComment}
                style={{
                  width: '100%',
                  minHeight: 80,
                  resize: 'vertical',
                  padding: 12,
                  borderRadius: 12,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  outline: 'none',
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              />
              {accessToken && (
                <button
                  onClick={() => submitComment(openPost.id)}
                  disabled={!newComment.trim() || submittingComment}
                  style={{
                    marginTop: 8,
                    padding: '8px 16px',
                    background: newComment.trim() && !submittingComment ? ARENA_PURPLE : 'rgba(139, 111, 168, 0.3)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: newComment.trim() && !submittingComment ? 'pointer' : 'not-allowed',
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {submittingComment ? '发送中...' : '发表评论'}
                </button>
              )}
            </div>

            {/* 评论列表 */}
            {loadingComments ? (
              <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>加载评论中...</div>
            ) : comments.length === 0 ? (
              <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>暂无评论，来发表第一条评论吧</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {comments.map((comment) => (
                  <div
                    key={comment.id}
                    style={{
                      padding: 12,
                      background: tokens.colors.bg.secondary,
                      borderRadius: 8,
                      border: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <AvatarLink handle={comment.author_handle || '匿名'} avatarUrl={comment.author_avatar_url} />
                      <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                        {formatTimeAgo(comment.created_at)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}>
                      {comment.content}
                    </div>
                    {/* 嵌套回复 */}
                    {comment.replies && comment.replies.length > 0 && (
                      <div style={{ marginTop: 12, marginLeft: 16, borderLeft: `2px solid ${tokens.colors.border.primary}`, paddingLeft: 12 }}>
                        {comment.replies.map((reply) => (
                          <div key={reply.id} style={{ marginBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary }}>
                                {reply.author_handle || '匿名'}
                              </span>
                              <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                                {formatTimeAgo(reply.created_at)}
                              </span>
                            </div>
                            <div style={{ fontSize: 13, color: tokens.colors.text.primary }}>
                              {reply.content}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

function ReactButton({ onClick, active, icon, count, showCount = true }: { onClick: (e: React.MouseEvent) => void; active: boolean; icon: React.ReactNode; count: number; showCount?: boolean }) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const processingRef = useRef(false)

  const handleClick = (e: React.MouseEvent) => {
    if (processingRef.current) return
    processingRef.current = true

    e.preventDefault()
    e.stopPropagation()

    setIsAnimating(true)
    setTimeout(() => {
      setIsAnimating(false)
      processingRef.current = false
    }, 300)

    onClick(e)
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      style={{
        background: active ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
        border: 'none',
        color: active ? tokens.colors.accent.primary : tokens.colors.text.secondary,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 6,
        transition: 'all 0.2s ease',
        transform: isPressed ? 'scale(0.9)' : 'scale(1)',
        fontWeight: active ? 900 : 400,
        boxShadow: active ? '0 0 0 1px rgba(139, 111, 168, 0.2)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
          e.currentTarget.style.color = '#d6d6d6'
        }
      }}
      onMouseLeave={(e) => {
        setIsPressed(false)
        if (!active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = '#a9a9a9'
        }
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          transition: 'transform 0.2s ease',
          transform: active ? 'scale(1.15)' : isAnimating ? 'scale(1.3)' : 'scale(1)',
        }}
      >
        {icon}
      </span>
      {showCount && count}
    </button>
  )
}

function Action(props: { icon?: React.ReactNode; text: string; onClick: (e?: React.MouseEvent) => void; active?: boolean; count?: number; showCount?: boolean }) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsAnimating(true)
    setTimeout(() => setIsAnimating(false), 300)
    props.onClick(e)
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      style={{
        border: 'none',
        background: props.active ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
        color: props.active ? '#8b6fa8' : '#a9a9a9',
        cursor: 'pointer',
        padding: '6px 12px',
        fontSize: 13,
        fontWeight: props.active ? 950 : 700,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 8,
        transition: 'all 0.2s ease',
        transform: isPressed ? 'scale(0.95)' : 'scale(1)',
        boxShadow: props.active ? '0 0 0 1px rgba(139, 111, 168, 0.3)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!props.active) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
          e.currentTarget.style.color = '#d6d6d6'
        }
      }}
      onMouseLeave={(e) => {
        setIsPressed(false)
        if (!props.active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = '#a9a9a9'
        }
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          transition: 'transform 0.2s ease',
          transform: props.active ? 'scale(1.1)' : isAnimating ? 'scale(1.2)' : 'scale(1)',
        }}
      >
        {props.icon}
      </span>
      {props.text}
      {props.showCount && props.count !== undefined && ` ${props.count}`}
    </button>
  )
}

function Modal(props: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: 60,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: '1px solid #1f1f1f',
          borderRadius: 16,
          background: '#0b0b0b',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={props.onClose} style={{ border: 'none', background: 'transparent', color: tokens.colors.text.secondary, cursor: 'pointer', fontSize: 20 }}>
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}
