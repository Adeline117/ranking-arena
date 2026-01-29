'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { supabase } from '@/lib/supabase/client'
import { authedFetch, getHttpErrorMessage } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { formatTimeAgo } from '@/lib/utils/date'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import type { Review, ReviewSummary } from '@/lib/data/reviews'

// ============ Types ============

interface TraderReviewsProps {
  traderId: string
  traderHandle: string
}

type SortMode = 'newest' | 'top'

// ============ Sub-components ============

function StarIcon({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? '#FFD700' : 'none'}
      stroke={filled ? '#FFD700' : tokens.colors.text.tertiary}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function StarRating({
  rating,
  interactive = false,
  size = 16,
  onChange,
}: {
  rating: number
  interactive?: boolean
  size?: number
  onChange?: (rating: number) => void
}) {
  const [hoverRating, setHoverRating] = useState(0)
  const displayRating = interactive && hoverRating > 0 ? hoverRating : rating

  return (
    <Box style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => interactive && onChange?.(star)}
          onMouseEnter={() => interactive && setHoverRating(star)}
          onMouseLeave={() => interactive && setHoverRating(0)}
          disabled={!interactive}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: interactive ? 'pointer' : 'default',
            display: 'flex',
            transition: 'transform 0.15s',
            transform: interactive && hoverRating === star ? 'scale(1.2)' : 'scale(1)',
          }}
        >
          <StarIcon filled={star <= displayRating} size={size} />
        </button>
      ))}
    </Box>
  )
}

function RatingDistributionBar({ stars, count, total }: { stars: number; count: number; total: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0
  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Text size="xs" style={{ width: 16, textAlign: 'right', color: tokens.colors.text.tertiary }}>{stars}</Text>
      <Box style={{
        flex: 1,
        height: 6,
        borderRadius: 3,
        background: tokens.colors.bg.tertiary,
        overflow: 'hidden',
      }}>
        <Box style={{
          width: `${pct}%`,
          height: '100%',
          borderRadius: 3,
          background: '#FFD700',
          transition: 'width 0.5s ease',
        }} />
      </Box>
      <Text size="xs" style={{ width: 24, color: tokens.colors.text.tertiary }}>{count}</Text>
    </Box>
  )
}

function ReviewSummaryCard({
  summary,
  t,
}: {
  summary: ReviewSummary
  t: (key: string) => string
}) {
  return (
    <Box style={{
      padding: tokens.spacing[5],
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.xl,
      border: `1px solid ${tokens.colors.border.primary}`,
      display: 'flex',
      gap: tokens.spacing[6],
      alignItems: 'center',
      flexWrap: 'wrap',
    }}>
      {/* Big average */}
      <Box style={{ textAlign: 'center', minWidth: 100 }}>
        <Text size="3xl" weight="black" style={{ color: tokens.colors.text.primary, lineHeight: 1 }}>
          {summary.review_count > 0 ? summary.avg_rating.toFixed(1) : '—'}
        </Text>
        <Box style={{ margin: '6px 0 4px' }}>
          <StarRating rating={Math.round(summary.avg_rating)} size={18} />
        </Box>
        <Text size="xs" color="tertiary">
          {summary.review_count} {t('reviewCount')}
        </Text>
      </Box>

      {/* Distribution */}
      <Box style={{ flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[5, 4, 3, 2, 1].map((star) => (
          <RatingDistributionBar
            key={star}
            stars={star}
            count={summary.rating_distribution[star] || 0}
            total={summary.review_count}
          />
        ))}
      </Box>
    </Box>
  )
}

function ReviewAvatar({ handle, avatarUrl }: { handle?: string; avatarUrl?: string }) {
  const size = 36
  return (
    <Link href={handle ? `/u/${encodeURIComponent(handle)}` : '#'} style={{ textDecoration: 'none', flexShrink: 0 }}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />
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
          color: '#fff',
        }}>
          {getAvatarInitial(handle || 'A')}
        </Box>
      )}
    </Link>
  )
}

function TranslateButton({ reviewId, content, onTranslated }: {
  reviewId: string
  content: string
  onTranslated: (id: string, text: string | null) => void
}) {
  const { language } = useLanguage()
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
      // ignore
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleTranslate}
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
      {loading ? '...' : translated ? (language === 'zh' ? '原文' : 'Original') : (language === 'zh' ? '翻译' : 'Translate')}
    </button>
  )
}

function ReviewCard({
  review,
  currentUserId,
  accessToken,
  traderHandle,
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
              {review.author_handle || (language === 'zh' ? '匿名' : 'Anonymous')}
            </Link>
            {showProBadge && (
              <Box style={{
                width: 14, height: 14, borderRadius: '50%',
                background: 'var(--color-pro-badge-bg, #8B5CF6)',
                boxShadow: '0 0 3px var(--color-pro-badge-shadow, rgba(139,92,246,0.5))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="#fff">
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
                padding: '2px 4px',
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
                  padding: '2px 4px',
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

// ============ Review Form ============

function ReviewForm({
  traderHandle,
  onSubmitted,
  t,
  language,
}: {
  traderHandle: string
  onSubmitted: () => void
  t: (key: string) => string
  language: string
}) {
  const { showToast } = useToast()
  const [rating, setRating] = useState(0)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  const handleSubmit = async () => {
    if (!accessToken) {
      showToast(language === 'zh' ? '请先登录' : 'Please sign in first', 'warning')
      return
    }
    if (rating === 0) {
      showToast(language === 'zh' ? '请选择评分' : 'Please select a rating', 'warning')
      return
    }
    if (!content.trim()) {
      showToast(language === 'zh' ? '请输入评价内容' : 'Please write your review', 'warning')
      return
    }

    setSubmitting(true)
    try {
      const { ok, status, data } = await authedFetch<{ success: boolean; error?: string }>(
        `/api/trader/${encodeURIComponent(traderHandle)}/reviews`,
        'POST',
        accessToken,
        { rating, content: content.trim() },
      )

      if (ok && data?.success) {
        showToast(language === 'zh' ? '评价已发布' : 'Review posted', 'success')
        setRating(0)
        setContent('')
        onSubmitted()
      } else {
        showToast(getHttpErrorMessage(status, data?.error || (language === 'zh' ? '发布失败' : 'Failed')), 'error')
      }
    } catch {
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Box style={{
      padding: tokens.spacing[5],
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.xl,
      border: `1px solid ${tokens.colors.border.primary}`,
      display: 'flex',
      flexDirection: 'column',
      gap: tokens.spacing[3],
    }}>
      <Text size="sm" weight="bold">{t('writeReview')}</Text>

      {/* Star picker */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text size="xs" color="tertiary">{t('yourRating')}:</Text>
        <StarRating rating={rating} interactive size={24} onChange={setRating} />
        {rating > 0 && (
          <Text size="xs" style={{ color: '#FFD700' }}>{rating}/5</Text>
        )}
      </Box>

      {/* Text input */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={language === 'zh' ? '分享你对这位交易员的看法...' : 'Share your thoughts about this trader...'}
        rows={3}
        maxLength={2000}
        style={{
          width: '100%',
          padding: '10px 14px',
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.tertiary,
          color: tokens.colors.text.primary,
          fontSize: 14,
          resize: 'vertical',
          outline: 'none',
          minHeight: 80,
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
      />

      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text size="xs" color="tertiary">{content.length}/2000</Text>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={submitting || rating === 0 || !content.trim()}
          style={{
            background: ARENA_PURPLE,
            opacity: (submitting || rating === 0 || !content.trim()) ? 0.6 : 1,
          }}
        >
          {submitting ? '...' : t('submitReview')}
        </Button>
      </Box>
    </Box>
  )
}

// ============ Main Component ============

export default function TraderReviews({ traderId, traderHandle }: TraderReviewsProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()

  const [reviews, setReviews] = useState<Review[]>([])
  const [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortMode, setSortMode] = useState<SortMode>('newest')
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [likeLoading, setLikeLoading] = useState<Record<string, boolean>>({})
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const offsetRef = useRef(0)

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null)
    })
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  // Load reviews
  const loadReviews = useCallback(async (reset = true) => {
    if (reset) {
      setLoading(true)
      offsetRef.current = 0
    } else {
      setLoadingMore(true)
    }

    try {
      const offset = reset ? 0 : offsetRef.current
      const { ok, data } = await authedFetch<{
        success: boolean
        data?: { reviews: Review[]; summary: ReviewSummary }
        meta?: { has_more: boolean }
      }>(
        `/api/trader/${encodeURIComponent(traderHandle)}/reviews?limit=20&offset=${offset}&sort=${sortMode}`,
        'GET',
        accessToken,
      )

      if (ok && data?.success && data.data) {
        if (reset) {
          setReviews(data.data.reviews)
        } else {
          setReviews(prev => [...prev, ...data.data!.reviews])
        }
        setSummary(data.data.summary)
        setHasMore(data.meta?.has_more ?? false)
        offsetRef.current = offset + data.data.reviews.length
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [traderHandle, sortMode, accessToken])

  useEffect(() => {
    loadReviews(true)
  }, [loadReviews])

  // Like toggle
  const handleLike = async (reviewId: string) => {
    if (!accessToken) {
      showToast(language === 'zh' ? '请先登录' : 'Please sign in first', 'warning')
      return
    }
    if (likeLoading[reviewId]) return

    setLikeLoading(prev => ({ ...prev, [reviewId]: true }))
    try {
      const { ok, data } = await authedFetch<{
        success: boolean
        data?: { liked: boolean; like_count: number }
      }>(
        `/api/trader/${encodeURIComponent(traderHandle)}/reviews/like`,
        'POST',
        accessToken,
        { review_id: reviewId },
      )

      if (ok && data?.success && data.data) {
        setReviews(prev => prev.map(r =>
          r.id === reviewId
            ? { ...r, user_liked: data.data!.liked, like_count: data.data!.like_count }
            : r
        ))
      }
    } catch {
      // ignore
    } finally {
      setLikeLoading(prev => ({ ...prev, [reviewId]: false }))
    }
  }

  // Delete
  const handleDelete = async (reviewId: string) => {
    if (!accessToken) return
    if (!confirm(language === 'zh' ? '确定删除这条评价？' : 'Delete this review?')) return

    try {
      const { ok } = await authedFetch(
        `/api/trader/${encodeURIComponent(traderHandle)}/reviews`,
        'DELETE',
        accessToken,
        { review_id: reviewId },
      )

      if (ok) {
        setReviews(prev => prev.filter(r => r.id !== reviewId))
        showToast(language === 'zh' ? '已删除' : 'Deleted', 'success')
        // Refresh summary
        loadReviews(true)
      }
    } catch {
      showToast(language === 'zh' ? '删除失败' : 'Delete failed', 'error')
    }
  }

  // Translation handler
  const handleTranslated = (id: string, text: string | null) => {
    setTranslations(prev => {
      if (text === null) {
        const { [id]: _, ...rest } = prev
        return rest
      }
      return { ...prev, [id]: text }
    })
  }

  // Check if user already reviewed
  const userAlreadyReviewed = currentUserId
    ? reviews.some(r => r.user_id === currentUserId)
    : false

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
      {/* Summary */}
      {summary && summary.review_count > 0 && (
        <ReviewSummaryCard summary={summary} t={t} />
      )}

      {/* Write review form (only if user hasn't reviewed yet) */}
      {!userAlreadyReviewed && (
        <ReviewForm
          traderHandle={traderHandle}
          onSubmitted={() => loadReviews(true)}
          t={t}
          language={language}
        />
      )}

      {/* Sort tabs */}
      {reviews.length > 1 && (
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {(['newest', 'top'] as SortMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setSortMode(mode)}
              style={{
                background: sortMode === mode ? `${ARENA_PURPLE}15` : 'transparent',
                border: sortMode === mode ? `1px solid ${ARENA_PURPLE}30` : '1px solid transparent',
                borderRadius: tokens.radius.md,
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: sortMode === mode ? 700 : 400,
                color: sortMode === mode ? tokens.colors.text.primary : tokens.colors.text.secondary,
              }}
            >
              {mode === 'newest' ? t('sortNewest') : t('sortTop')}
            </button>
          ))}
        </Box>
      )}

      {/* Reviews list */}
      <Box style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
      }}>
        {loading ? (
          <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
            <Text size="sm" color="tertiary">{language === 'zh' ? '加载中...' : 'Loading...'}</Text>
          </Box>
        ) : reviews.length === 0 ? (
          <Box style={{ padding: '40px 16px', textAlign: 'center' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" style={{ margin: '0 auto 8px' }}>
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <Text size="sm" weight="bold" color="tertiary">
              {t('noReviews')}
            </Text>
            <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>
              {t('beFirstReview')}
            </Text>
          </Box>
        ) : (
          <>
            {reviews.map(review => (
              <ReviewCard
                key={review.id}
                review={review}
                currentUserId={currentUserId}
                accessToken={accessToken}
                traderHandle={traderHandle}
                translations={translations}
                onTranslated={handleTranslated}
                onLike={handleLike}
                onDelete={handleDelete}
                likeLoading={likeLoading}
                t={t}
                language={language}
              />
            ))}

            {hasMore && (
              <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadReviews(false)}
                  disabled={loadingMore}
                  style={{ color: ARENA_PURPLE }}
                >
                  {loadingMore
                    ? '...'
                    : language === 'zh' ? '加载更多' : 'Load more'}
                </Button>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  )
}
