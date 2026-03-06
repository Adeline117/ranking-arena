'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { StarRating } from './ReviewStars'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { formatTimeAgo } from '@/lib/utils/date'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import type { Review } from '@/lib/data/reviews'

// ============ Review Avatar ============

export function ReviewAvatar({ handle, avatarUrl }: { handle?: string; avatarUrl?: string }) {
  const size = 36
  return (
    <Link href={handle ? `/u/${encodeURIComponent(handle)}` : '#'} style={{ textDecoration: 'none', flexShrink: 0 }}>
      {avatarUrl ? (
        <Image src={avatarUrl.startsWith("/") ? avatarUrl : `/api/avatar?url=${encodeURIComponent(avatarUrl)}`} alt={`${handle || 'User'} avatar`} width={size} height={size} sizes={`${size}px`} loading="lazy" style={{ borderRadius: '50%', objectFit: 'cover' }} />
      ) : (
        <Box style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: getAvatarGradient(handle || 'A'),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 700,
          color: tokens.colors.white,
        }}>
          {getAvatarInitial(handle || 'A')}
        </Box>
      )}
    </Link>
  )
}

// ============ Translate Button ============

export function TranslateButton({ reviewId, content, onTranslated }: {
  reviewId: string
  content: string
  onTranslated: (id: string, text: string | null) => void
}) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(false)
  const [translated, setTranslated] = useState(false)

  const handleTranslate = async () => {
    if (translated) {
      onTranslated(reviewId, null) // toggle back
      setTranslated(false)
      return
    }

    setLoading(true)
    try {
      const targetLang = language === 'zh' ? 'en' : 'zh'
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: content,
          targetLang,
          contentType: 'comment',
          contentId: reviewId,
        }),
      })
      const data = await res.json()
      if (data.success && data.data?.translatedText) {
        onTranslated(reviewId, data.data.translatedText)
        setTranslated(true)
      }
    } catch {
      showToast(t('translateFailed') || 'Translation failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleTranslate}
            aria-label="Translate review"
      disabled={loading}
      style={{
        background: 'none',
        border: 'none',
        cursor: loading ? 'wait' : 'pointer',
        fontSize: 12,
        color: tokens.colors.text.tertiary,
        padding: '2px 4px',
        display: 'flex',
        alignItems: 'center',
        gap: 3,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m5 8 6 6" />
        <path d="m4 14 6-6 2-3" />
        <path d="M2 5h12" />
        <path d="M7 2h1" />
        <path d="m22 22-5-10-5 10" />
        <path d="M14 18h6" />
      </svg>
      {loading ? '...' : translated ? t('originalText') : t('translateText')}
    </button>
  )
}

// ============ Review Card ============

export function ReviewCard({
  review,
  currentUserId,
  accessToken,
  traderHandle: _traderHandle,
  translations,
  onTranslated,
  onLike,
  onDelete,
  likeLoading,
  t,
  language,
}: {
  review: Review
  currentUserId: string | null
  accessToken: string | null
  traderHandle: string
  translations: Record<string, string>
  onTranslated: (id: string, text: string | null) => void
  onLike: (reviewId: string) => void
  onDelete: (reviewId: string) => void
  likeLoading: Record<string, boolean>
  t: (key: string) => string
  language: string
}) {
  const isOwn = currentUserId === review.user_id
  const displayContent = translations[review.id] || review.content
  const showProBadge = review.author_is_pro && review.author_show_pro_badge !== false

  return (
    <Box style={{
      padding: tokens.spacing[4],
      borderBottom: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Box style={{ display: 'flex', gap: 12 }}>
        <ReviewAvatar handle={review.author_handle} avatarUrl={review.author_avatar_url} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          {/* Author + rating */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <Link
              href={review.author_handle ? `/u/${encodeURIComponent(review.author_handle)}` : '#'}
              style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.text.primary, textDecoration: 'none' }}
            >
              {review.author_handle || 'user'}
            </Link>
            {showProBadge && (
              <Box style={{
                width: 14, height: 14, borderRadius: '50%',
                background: 'var(--color-pro-badge-bg, #8B5CF6)',
                boxShadow: '0 0 3px var(--color-pro-badge-shadow, var(--color-accent-primary-60))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="var(--color-on-accent)">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
              </Box>
            )}
            <StarRating rating={review.rating} size={14} />
            <Text size="xs" color="tertiary">{formatTimeAgo(review.created_at, language as 'zh' | 'en')}</Text>
          </Box>

          {/* Content */}
          <Box style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6, marginBottom: 6 }}>
            {renderContentWithLinks(displayContent)}
          </Box>

          {/* Actions */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button
              onClick={() => onLike(review.id)}
              disabled={likeLoading[review.id] || !accessToken}
              style={{
                background: 'none',
                border: 'none',
                cursor: accessToken ? 'pointer' : 'default',
                fontSize: 12,
                padding: '6px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: review.user_liked ? ARENA_PURPLE : tokens.colors.text.tertiary,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={review.user_liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
              </svg>
              {(review.like_count || 0) > 0 && <span>{review.like_count}</span>}
            </button>

            <TranslateButton
              reviewId={review.id}
              content={review.content}
              onTranslated={onTranslated}
            />

            {isOwn && (
              <button
                onClick={() => onDelete(review.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: tokens.colors.text.tertiary,
                  padding: '6px 8px',
                }}
              >
                {t('deleteReview')}
              </button>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
