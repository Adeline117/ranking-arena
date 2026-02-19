'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import StarRating from '@/app/components/ui/StarRating'

type Review = {
  id: string
  rating: number | null
  review: string | null
  created_at: string
  user_id: string
  users: { id: string; nickname: string | null; avatar_url: string | null } | null
}

function formatRelativeTime(dateStr: string, isZh: boolean): string {
  const now = Date.now()
  const diff = now - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return isZh ? '刚刚' : 'just now'
  if (mins < 60) return isZh ? `${mins}分钟前` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return isZh ? `${hours}小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return isZh ? `${days}天前` : `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return isZh ? `${months}个月前` : `${months}mo ago`
  return new Date(dateStr).toLocaleDateString(isZh ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

interface BookReviewsProps {
  reviews: Review[]
  bookId: string
  bookTitle: string
  isZh: boolean
  hasSession: boolean
  hasMoreReviews: boolean
  onLoadMore: () => void
}

export default function BookReviews({ reviews, bookId, bookTitle, isZh, hasSession, hasMoreReviews, onLoadMore }: BookReviewsProps) {
  if (reviews.length === 0) return null

  return (
    <>
      {hasSession && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <Link
            href={`/community/new?category=book_review&book_id=${bookId}&book_title=${encodeURIComponent(bookTitle)}`}
            style={{
              fontSize: 13, fontWeight: 500, color: tokens.colors.accent.brand,
              textDecoration: 'none', padding: '4px 12px',
              borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.accent.brand}`,
            }}
          >
            Write Review
          </Link>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {reviews.map(r => (
          <div key={r.id} style={{
            padding: '18px 20px', borderRadius: tokens.radius.lg,
            background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              {r.users?.avatar_url ? (
                <img
                  src={r.users.avatar_url}
                  alt={`${(r.users as Record<string, unknown> | null)?.nickname || 'User'} avatar`}
                  style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  background: tokens.gradient.primarySubtle,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, color: tokens.colors.accent.brand, fontWeight: 700,
                }}>
                  {(r.users?.nickname || 'U')[0].toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary }}>
                    {(r.users as Record<string, unknown> | null)?.nickname as string || 'Anonymous'}
                  </span>
                  {r.rating && <StarRating rating={r.rating} size={13} readonly showCount={false} />}
                </div>
                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginTop: 2, display: 'block' }}>
                  {formatRelativeTime(r.created_at, isZh)}
                </span>
              </div>
            </div>
            {r.review && (
              <p style={{ fontSize: 14, lineHeight: 1.7, color: tokens.colors.text.secondary, margin: 0 }}>
                {r.review}
              </p>
            )}
          </div>
        ))}
      </div>
      {hasMoreReviews && (
        <button
          onClick={onLoadMore}
          style={{
            marginTop: 14, padding: '10px 24px', borderRadius: tokens.radius.lg,
            background: 'transparent', border: `1px solid ${tokens.colors.border.primary}`,
            color: tokens.colors.text.primary, cursor: 'pointer', fontSize: 13, fontWeight: 500,
            transition: `all ${tokens.transition.fast}`,
          }}
        >
          Load more
        </button>
      )}
    </>
  )
}
