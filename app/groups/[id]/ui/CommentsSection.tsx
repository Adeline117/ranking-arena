'use client'

import Link from 'next/link'
import Image from 'next/image'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { getAvatarGradient } from '@/lib/utils/avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { CommentWithAuthor } from '../hooks/useGroupPosts'

export interface CommentsSectionProps {
  postId: string
  language: string
  accessToken: string | null
  comments: CommentWithAuthor[]
  newComment: string
  setNewComment: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  commentLoading: boolean
  replyingTo: string | null
  setReplyingTo: (fn: (prev: Record<string, string | null>) => Record<string, string | null>) => void
  replyContent: Record<string, string>
  setReplyContent: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  expandedReplies: Record<string, boolean>
  setExpandedReplies: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  submitComment: (postId: string) => void
  submitReply: (postId: string, commentId: string) => void
  readOnly?: boolean
}

export default function CommentsSection(props: CommentsSectionProps) {
  const { t } = useLanguage()
  const {
    postId, language, accessToken,
    comments, newComment, setNewComment, commentLoading,
    replyingTo, setReplyingTo, replyContent, setReplyContent,
    expandedReplies, setExpandedReplies,
    submitComment, submitReply,
    readOnly,
  } = props

  return (
    <Box style={{
      marginTop: tokens.spacing[3],
      paddingTop: tokens.spacing[3],
      borderTop: `1px solid ${tokens.colors.border.primary}`,
    }}>
      {/* Comment input or read-only hint */}
      {readOnly && (
        <Text size="xs" color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
          {t('joinGroupToComment') || 'Join this group to comment'}
        </Text>
      )}
      {accessToken && !readOnly && (
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
          <input
            type="text"
            placeholder={t('writeComment')}
            value={newComment}
            onChange={(e) => setNewComment(prev => ({ ...prev, [postId]: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && submitComment(postId)}
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
          <Button variant="primary" size="sm" onClick={() => submitComment(postId)} disabled={commentLoading || !newComment.trim()}>
            {t('send')}
          </Button>
        </Box>
      )}

      {/* Comment list */}
      {commentLoading ? (
        <Text size="xs" color="tertiary">{t('loading')}</Text>
      ) : comments.length > 0 ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {comments.map((comment) => (
            <Box key={comment.id}>
              <Box style={{ padding: tokens.spacing[2], background: tokens.colors.bg.primary, borderRadius: tokens.radius.md }}>
                <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[1] }}>
                  {comment.author_handle ? (
                    <Link
                      href={`/u/${encodeURIComponent(comment.author_handle)}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.accent?.primary || tokens.colors.accent.brand, textDecoration: 'none' }}
                    >
                      <span style={{
                        width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                        background: comment.author_avatar_url ? undefined : getAvatarGradient(comment.user_id || comment.author_handle),
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden', position: 'relative' as const,
                      }}>
                        {comment.author_avatar_url ? (
                          <Image src={comment.author_avatar_url} alt={comment.author_handle || 'User avatar'} fill sizes="24px" style={{ objectFit: 'cover' }} />
                        ) : (
                          <span style={{ color: tokens.colors.white, fontSize: 10, fontWeight: 700 }}>
                            {(comment.author_handle || 'U').charAt(0).toUpperCase()}
                          </span>
                        )}
                      </span>
                      @{comment.author_handle}
                    </Link>
                  ) : (
                    <Text size="xs" weight="bold" color="secondary">
                      @{'user'}
                    </Text>
                  )}
                  <Text size="xs" color="tertiary">
                    {new Date(comment.created_at).toLocaleString(getLocaleFromLanguage(language))}
                  </Text>
                </Box>
                <Text size="sm">{renderContentWithLinks(comment.content)}</Text>
                {accessToken && !comment.parent_id && (
                  <button
                    onClick={() => setReplyingTo(prev => ({
                      ...prev,
                      [postId]: prev[postId] === comment.id ? null : comment.id
                    }))}
                    style={{ background: 'transparent', border: 'none', color: tokens.colors.text.tertiary, cursor: 'pointer', fontSize: 11, marginTop: tokens.spacing[1], padding: 0 }}
                  >
                    {t('reply')}
                  </button>
                )}
              </Box>

              {/* Reply input */}
              {replyingTo === comment.id && (
                <Box style={{ marginLeft: tokens.spacing[4], marginTop: tokens.spacing[1], display: 'flex', gap: tokens.spacing[2] }}>
                  <input
                    type="text"
                    placeholder={`${t('reply')} @${comment.author_handle || 'user'}...`}
                    value={replyContent[comment.id] || ''}
                    onChange={(e) => setReplyContent(prev => ({ ...prev, [comment.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && replyContent[comment.id]?.trim()) submitReply(postId, comment.id) }}
                    style={{
                      flex: 1,
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: tokens.colors.bg.primary,
                      color: tokens.colors.text.primary,
                      fontSize: tokens.typography.fontSize.xs,
                    }}
                  />
                  <Button
                    variant="primary" size="sm"
                    onClick={() => submitReply(postId, comment.id)}
                    style={{ fontSize: 11, padding: `${tokens.spacing[1]} ${tokens.spacing[2]}` }}
                  >
                    {t('send')}
                  </Button>
                </Box>
              )}

              {/* Nested replies */}
              {comment.replies && comment.replies.length > 0 && (
                <Box style={{ marginLeft: tokens.spacing[4], borderLeft: `2px solid ${tokens.colors.border.primary}`, paddingLeft: tokens.spacing[2], marginTop: tokens.spacing[1] }}>
                  {(expandedReplies[comment.id] ? comment.replies : comment.replies.slice(0, 3)).map((reply) => (
                    <Box key={reply.id} style={{ padding: `${tokens.spacing[1]} 0` }}>
                      <Box style={{ display: 'flex', gap: tokens.spacing[1], alignItems: 'center' }}>
                        {reply.author_handle ? (
                          <Link
                            href={`/u/${encodeURIComponent(reply.author_handle)}`}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.accent?.primary || tokens.colors.accent.brand, textDecoration: 'none' }}
                          >
                            <span style={{
                              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                              background: reply.author_avatar_url ? undefined : getAvatarGradient(reply.user_id || reply.author_handle),
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              overflow: 'hidden', position: 'relative' as const,
                            }}>
                              {reply.author_avatar_url ? (
                                <Image src={reply.author_avatar_url} alt={reply.author_handle || 'User avatar'} fill sizes="20px" style={{ objectFit: 'cover' }} />
                              ) : (
                                <span style={{ color: tokens.colors.white, fontSize: 8, fontWeight: 700 }}>
                                  {reply.author_handle.charAt(0).toUpperCase()}
                                </span>
                              )}
                            </span>
                            @{reply.author_handle}
                          </Link>
                        ) : (
                          <Text size="xs" weight="bold" color="secondary">
                            @{'user'}
                          </Text>
                        )}
                        <Text size="xs" color="tertiary">
                          {new Date(reply.created_at).toLocaleString(getLocaleFromLanguage(language))}
                        </Text>
                      </Box>
                      <Text size="xs" style={{ marginLeft: tokens.spacing[1] }}>{reply.content}</Text>
                    </Box>
                  ))}
                  {comment.replies.length > 3 && !expandedReplies[comment.id] && (
                    <button
                      onClick={() => setExpandedReplies(prev => ({ ...prev, [comment.id]: true }))}
                      style={{ background: 'transparent', border: 'none', color: ARENA_PURPLE, cursor: 'pointer', fontSize: 11, padding: 0 }}
                    >
                      {t('showMore')} ({comment.replies.length - 3})
                    </button>
                  )}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      ) : (
        <Text size="xs" color="tertiary">{t('noCommentsYet')}</Text>
      )}
    </Box>
  )
}
