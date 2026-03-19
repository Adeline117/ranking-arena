'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import useSWR from 'swr'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getAvatarGradient } from '@/lib/utils/avatar'
import { getLocaleFromLanguage } from '@/lib/utils/format'

interface TraderComment {
  id: string
  content: string
  created_at: string
  updated_at: string
  user_id: string
  author_handle: string | null
  author_avatar_url: string | null
}

interface CommentsResponse {
  data: {
    comments: TraderComment[]
  }
  pagination: {
    limit: number
    offset: number
    has_more: boolean
  }
}

interface TraderCommentsProps {
  /** Exchange source (e.g. 'binance_futures') or 'user' for user profile comments */
  traderSource: string
  /** Exchange trader ID or user UUID for user profile comments */
  traderSourceId: string
  /** Handle used in the API route path */
  traderHandle: string
}

const PAGE_SIZE = 20

const fetcher = (url: string) => fetch(url).then(r => r.json())

export default function TraderComments({ traderSource, traderSourceId, traderHandle }: TraderCommentsProps) {
  const { t, language } = useLanguage()
  const { userId, accessToken, requireAuth } = useAuthSession()
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [offset, setOffset] = useState(0)
  const [allComments, setAllComments] = useState<TraderComment[]>([])
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const apiUrl = `/api/traders/${encodeURIComponent(traderHandle)}/comments?source=${encodeURIComponent(traderSource)}&source_id=${encodeURIComponent(traderSourceId)}&limit=${PAGE_SIZE}&offset=${offset}`

  const { data, error, isLoading, mutate } = useSWR<CommentsResponse>(
    apiUrl,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 30_000,
      onSuccess: (resp) => {
        if (offset === 0) {
          setAllComments(resp.data.comments)
        } else {
          setAllComments(prev => {
            const existingIds = new Set(prev.map(c => c.id))
            const newOnes = resp.data.comments.filter(c => !existingIds.has(c.id))
            return [...prev, ...newOnes]
          })
        }
      },
    }
  )

  const handleSubmit = useCallback(async () => {
    if (!content.trim() || submitting) return
    const headers = requireAuth()
    if (!headers) return

    setSubmitting(true)
    try {
      const res = await fetch(`/api/traders/${encodeURIComponent(traderHandle)}/comments`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.trim(),
          trader_source: traderSource,
          trader_source_id: traderSourceId,
        }),
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error || 'Failed to post comment')
      }

      const { data: resData } = await res.json()
      setContent('')

      // Optimistically prepend the new comment
      if (resData?.comment) {
        setAllComments(prev => [resData.comment, ...prev])
      }
      mutate()
    } catch (err) {
      console.error('Failed to post comment:', err)
    } finally {
      setSubmitting(false)
    }
  }, [content, submitting, requireAuth, traderHandle, traderSource, traderSourceId, mutate])

  const handleDelete = useCallback(async (commentId: string) => {
    const headers = requireAuth()
    if (!headers) return

    setDeletingId(commentId)
    try {
      const res = await fetch(`/api/traders/${encodeURIComponent(traderHandle)}/comments`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId }),
      })

      if (!res.ok) throw new Error('Failed to delete comment')

      setAllComments(prev => prev.filter(c => c.id !== commentId))
      mutate()
    } catch (err) {
      console.error('Failed to delete comment:', err)
    } finally {
      setDeletingId(null)
    }
  }, [requireAuth, traderHandle, mutate])

  const handleLoadMore = useCallback(() => {
    setOffset(prev => prev + PAGE_SIZE)
  }, [])

  const hasMore = data?.pagination?.has_more ?? false
  const comments = allComments

  return (
    <Box
      className="glass-card"
      style={{
        padding: tokens.spacing[5],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        marginTop: tokens.spacing[6],
      }}
    >
      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="bold" style={{ color: 'var(--color-text-secondary)' }}>
            {t('traderComments')}
          </Text>
          {comments.length > 0 && (
            <Text size="xs" color="tertiary">({comments.length}{hasMore ? '+' : ''})</Text>
          )}
        </Box>
      </Box>

      {/* Comment form */}
      {accessToken ? (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <textarea
            placeholder={t('writeComment')}
            value={content}
            onChange={e => setContent(e.target.value)}
            maxLength={2000}
            rows={3}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              resize: 'vertical',
              minHeight: 72,
              fontFamily: 'inherit',
            }}
          />
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: tokens.spacing[2] }}>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={submitting || !content.trim()}
            >
              {submitting ? '...' : t('submitComment')}
            </Button>
          </Box>
        </Box>
      ) : (
        <Box style={{
          padding: tokens.spacing[3],
          marginBottom: tokens.spacing[4],
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.md,
          textAlign: 'center',
        }}>
          <Text size="sm" color="tertiary">
            <a
              href={`/login?returnUrl=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}`}
              style={{ color: 'var(--color-brand)', textDecoration: 'none', fontWeight: 600 }}
            >
              {t('loginToComment')}
            </a>
          </Text>
        </Box>
      )}

      {/* Comment list */}
      {isLoading && comments.length === 0 ? (
        <Box style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
          <Text size="sm" color="tertiary">{t('loading')}</Text>
        </Box>
      ) : comments.length === 0 ? (
        <Box style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
          <Text size="sm" color="tertiary">{t('noCommentsYet')}</Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {comments.map(comment => (
            <Box
              key={comment.id}
              style={{
                padding: tokens.spacing[3],
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}30`,
              }}
            >
              {/* Author row */}
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[1] }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  {comment.author_handle ? (
                    <Link
                      href={`/u/${encodeURIComponent(comment.author_handle)}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
                    >
                      <span style={{
                        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                        background: comment.author_avatar_url ? undefined : getAvatarGradient(comment.user_id),
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden', position: 'relative' as const,
                      }}>
                        {comment.author_avatar_url ? (
                          <Image src={comment.author_avatar_url} alt={comment.author_handle} fill sizes="22px" style={{ objectFit: 'cover' }} />
                        ) : (
                          <span style={{ color: '#fff', fontSize: 10, fontWeight: 700 }}>
                            {comment.author_handle.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </span>
                      <Text size="xs" weight="bold" style={{ color: 'var(--color-brand)' }}>
                        @{comment.author_handle}
                      </Text>
                    </Link>
                  ) : (
                    <Text size="xs" weight="bold" color="secondary">@user</Text>
                  )}
                </Box>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <Text size="xs" color="tertiary">
                    {new Date(comment.created_at).toLocaleString(getLocaleFromLanguage(language))}
                  </Text>
                  {userId === comment.user_id && (
                    <button
                      onClick={() => handleDelete(comment.id)}
                      disabled={deletingId === comment.id}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-error, #ef4444)',
                        cursor: 'pointer',
                        fontSize: 11,
                        padding: 0,
                        opacity: deletingId === comment.id ? 0.5 : 0.7,
                      }}
                    >
                      {t('delete')}
                    </button>
                  )}
                </Box>
              </Box>

              {/* Content */}
              <Text size="sm" style={{ lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {comment.content}
              </Text>
            </Box>
          ))}

          {/* Load more */}
          {hasMore && (
            <Box style={{ textAlign: 'center', marginTop: tokens.spacing[2] }}>
              <button
                onClick={handleLoadMore}
                style={{
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 13,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                }}
              >
                {t('loadMore')}
              </button>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
