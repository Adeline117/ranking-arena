'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import StarRating from '@/app/components/ui/StarRating'
import BookCover from '../BookCover'

type BookDetail = {
  id: string
  title: string
  author: string | null
  description: string | null
  category: string
  subcategory: string | null
  source: string | null
  source_url: string | null
  pdf_url: string | null
  cover_url: string | null
  tags: string[] | null
  publish_date: string | null
  download_count: number
  is_free: boolean
  buy_url: string | null
  publisher: string | null
  isbn: string | null
  page_count: number | null
  language: string | null
  rating: number | null
  rating_count: number | null
}

type RatingOverview = {
  average: number
  count: number
  distribution: Record<number, number>
}

type Review = {
  id: string
  rating: number | null
  review: string | null
  created_at: string
  user_id: string
  users: { id: string; nickname: string | null } | null
}

type SimilarItem = {
  id: string
  title: string
  author: string | null
  cover_url: string | null
  category: string
  rating: number | null
  rating_count: number | null
}

export default function BookDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const [book, setBook] = useState<BookDetail | null>(null)
  const [overview, setOverview] = useState<RatingOverview | null>(null)
  const [userStatus, setUserStatus] = useState<string | null>(null)
  const [userRating, setUserRating] = useState<number | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewPage, setReviewPage] = useState(1)
  const [hasMoreReviews, setHasMoreReviews] = useState(false)
  const [similar, setSimilar] = useState<SimilarItem[]>([])
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<any>(null)
  const [descExpanded, setDescExpanded] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
  }, [])

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (!session?.access_token) return {}
    return { Authorization: `Bearer ${session.access_token}` }
  }, [session])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    fetch(`/api/library/${id}`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(data => {
        setBook(data.item)
        setOverview(data.ratingOverview)
        setUserStatus(data.userStatus)
        setUserRating(data.userRating)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [id, getAuthHeaders])

  const fetchReviews = useCallback((page: number) => {
    fetch(`/api/library/${id}/ratings`)
      .then(r => r.json())
      .then(data => {
        const allReviews = (data.ratings || []).filter((r: Review) => r.review)
        const perPage = 10
        const paginated = allReviews.slice(0, page * perPage)
        setReviews(paginated)
        setHasMoreReviews(paginated.length < allReviews.length)
      })
  }, [id])

  useEffect(() => { if (id) fetchReviews(reviewPage) }, [id, reviewPage, fetchReviews])

  useEffect(() => {
    if (!id) return
    fetch(`/api/library/${id}/similar`)
      .then(r => r.json())
      .then(data => setSimilar(data.items || []))
      .catch(console.error)
  }, [id])

  const handleStatus = async (status: 'want_to_read' | 'read') => {
    if (!session) {
      alert(isZh ? '请先登录' : 'Please login first')
      return
    }
    const res = await fetch(`/api/library/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      setUserStatus(status)
      if (status === 'want_to_read') setUserRating(null)
    }
  }

  const handleRate = async (rating: number) => {
    if (!session) return
    const res = await fetch(`/api/library/${id}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ rating }),
    })
    if (res.ok) {
      setUserRating(rating)
      const data = await fetch(`/api/library/${id}`, { headers: getAuthHeaders() }).then(r => r.json())
      setOverview(data.ratingOverview)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav />
        <main style={{ maxWidth: 960, margin: '0 auto', padding: '80px 16px 100px' }}>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <div style={{ width: 220, aspectRatio: '2/3', borderRadius: tokens.radius.xl, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
            <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ height: 28, width: '70%', borderRadius: 6, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ height: 18, width: '40%', borderRadius: 6, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ height: 40, width: '50%', borderRadius: 8, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
            </div>
          </div>
        </main>
        <MobileBottomNav />
      </div>
    )
  }

  if (!book) {
    return (
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav />
        <main style={{ maxWidth: 960, margin: '0 auto', padding: '80px 16px 100px', textAlign: 'center' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" style={{ marginBottom: 16, opacity: 0.5 }}>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <p style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.md }}>
            {isZh ? '未找到该书籍' : 'Book not found'}
          </p>
          <Link href="/library" style={{ color: tokens.colors.accent.brand, fontSize: 14, marginTop: 12, display: 'inline-block' }}>
            {isZh ? '返回书架' : 'Back to Library'}
          </Link>
        </main>
        <MobileBottomNav />
      </div>
    )
  }

  const avg = overview?.average || 0
  const count = overview?.count || 0
  const dist = overview?.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const maxDist = Math.max(...Object.values(dist), 1)
  const hasReadableContent = !!book.pdf_url || !!book.source_url
  const descLong = (book.description?.length || 0) > 300

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav />
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '80px 16px 100px' }}>

        {/* Back link */}
        <Link href="/library" style={{
          color: tokens.colors.text.secondary, fontSize: 13, textDecoration: 'none',
          marginBottom: 20, display: 'inline-flex', alignItems: 'center', gap: 6,
          transition: `color ${tokens.transition.fast}`,
        }}
          onMouseEnter={e => (e.currentTarget.style.color = tokens.colors.accent.brand)}
          onMouseLeave={e => (e.currentTarget.style.color = tokens.colors.text.secondary)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {isZh ? '返回书架' : 'Back to Library'}
        </Link>

        {/* ===== Top Section: Cover + Info ===== */}
        <div className="book-detail-top" style={{ display: 'flex', gap: 28, marginBottom: 36, flexWrap: 'wrap' }}>
          {/* Cover with shadow */}
          <div className="book-detail-cover" style={{
            width: 180, flexShrink: 0,
          }}>
            <div style={{
              width: '100%', aspectRatio: '2/3',
              borderRadius: tokens.radius.xl,
              overflow: 'hidden',
              boxShadow: '4px 4px 12px rgba(0,0,0,0.3), 8px 8px 24px rgba(0,0,0,0.15), -1px 0 2px rgba(0,0,0,0.1), 0 0 0 1px var(--glass-border-light)',
            }}>
              <BookCover
                title={book.title}
                author={book.author}
                category={book.category}
                coverUrl={book.cover_url}
                fontSize="lg"
              />
            </div>
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column' }}>
            <h1 style={{
              fontSize: tokens.typography.fontSize['2xl'],
              fontWeight: tokens.typography.fontWeight.bold,
              color: tokens.colors.text.primary,
              marginBottom: 6, lineHeight: tokens.typography.lineHeight.tight,
            }}>
              {book.title}
            </h1>

            {book.author && (
              <p style={{
                fontSize: tokens.typography.fontSize.md,
                color: tokens.colors.text.secondary,
                marginBottom: 16,
              }}>
                {book.author}
              </p>
            )}

            {/* Rating */}
            {count > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span style={{
                  fontSize: tokens.typography.fontSize['2xl'],
                  fontWeight: tokens.typography.fontWeight.bold,
                  color: '#f5c518',
                }}>
                  {avg.toFixed(1)}
                </span>
                <div>
                  <StarRating rating={avg} ratingCount={count} size={18} readonly />
                  <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                    {count} {isZh ? '人评价' : 'ratings'}
                  </span>
                </div>
              </div>
            )}

            {/* Metadata pills */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
              {book.category && <MetaPill label={book.category} />}
              {book.publisher && <MetaPill label={book.publisher} />}
              {book.publish_date && <MetaPill label={book.publish_date} />}
              {book.language && <MetaPill label={book.language === 'zh' ? 'Chinese' : book.language === 'en' ? 'English' : book.language} />}
              {book.page_count && <MetaPill label={`${book.page_count} ${isZh ? '页' : 'pages'}`} />}
              {book.isbn && <MetaPill label={`ISBN: ${book.isbn}`} />}
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {/* Read - always in-app, never external */}
              {hasReadableContent ? (
                <Link
                  href={`/library/${book.id}/read`}
                  style={{
                    padding: '10px 24px', borderRadius: tokens.radius.lg,
                    fontSize: tokens.typography.fontSize.base, fontWeight: tokens.typography.fontWeight.semibold,
                    background: tokens.gradient.primary, color: '#fff',
                    textDecoration: 'none',
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    transition: `all ${tokens.transition.fast}`,
                    boxShadow: tokens.shadow.glow,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                  {isZh ? '阅读' : 'Read'}
                </Link>
              ) : (
                <span style={{
                  padding: '10px 24px', borderRadius: tokens.radius.lg,
                  fontSize: tokens.typography.fontSize.base, fontWeight: tokens.typography.fontWeight.semibold,
                  background: tokens.colors.bg.tertiary, color: tokens.colors.text.tertiary,
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                  {isZh ? '暂无在线阅读资源' : 'No online reading available'}
                </span>
              )}

              {/* Want to Read */}
              <button
                onClick={() => handleStatus('want_to_read')}
                style={{
                  padding: '10px 20px', borderRadius: tokens.radius.lg,
                  fontSize: tokens.typography.fontSize.base, fontWeight: tokens.typography.fontWeight.semibold,
                  cursor: 'pointer',
                  border: userStatus === 'want_to_read' ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                  background: userStatus === 'want_to_read' ? tokens.colors.accent.brand : 'transparent',
                  color: userStatus === 'want_to_read' ? '#fff' : tokens.colors.text.primary,
                  transition: `all ${tokens.transition.fast}`,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill={userStatus === 'want_to_read' ? '#fff' : 'none'} stroke="currentColor" strokeWidth="2">
                  <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
                </svg>
                {isZh ? '想读' : 'Want to Read'}
              </button>

              {/* Mark as Read */}
              <button
                onClick={() => handleStatus('read')}
                style={{
                  padding: '10px 20px', borderRadius: tokens.radius.lg,
                  fontSize: tokens.typography.fontSize.base, fontWeight: tokens.typography.fontWeight.semibold,
                  cursor: 'pointer',
                  border: userStatus === 'read' ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                  background: userStatus === 'read' ? '#10b981' : 'transparent',
                  color: userStatus === 'read' ? '#fff' : tokens.colors.text.primary,
                  transition: `all ${tokens.transition.fast}`,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {isZh ? '已读' : 'Read'}
              </button>

              {/* Buy - kept as internal reference only, no external navigation */}
            </div>

            {/* User rating when marked as read */}
            {userStatus === 'read' && (
              <div style={{
                marginTop: 16, padding: '14px 18px', borderRadius: tokens.radius.lg,
                background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
              }}>
                <p style={{ fontSize: 13, color: tokens.colors.text.secondary, marginBottom: 8 }}>
                  {isZh ? '你的评分：' : 'Your rating:'}
                </p>
                <StarRating rating={0} userRating={userRating || 0} onRate={handleRate} size={28} showCount={false} />
              </div>
            )}
          </div>
        </div>

        {/* ===== Tags ===== */}
        {book.tags && book.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 28 }}>
            {book.tags.map(tag => (
              <span key={tag} style={{
                fontSize: 12, padding: '4px 12px', borderRadius: tokens.radius.full,
                background: tokens.colors.accent.brandMuted, color: tokens.colors.accent.brand,
                fontWeight: 500,
              }}>
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* ===== Description ===== */}
        {book.description && (
          <Section title={isZh ? '简介' : 'Description'}>
            <p style={{
              fontSize: tokens.typography.fontSize.base,
              lineHeight: tokens.typography.lineHeight.relaxed,
              color: tokens.colors.text.secondary,
              whiteSpace: 'pre-wrap', margin: 0,
              maxHeight: descExpanded || !descLong ? undefined : 120,
              overflow: descExpanded || !descLong ? undefined : 'hidden',
            }}>
              {book.description}
            </p>
            {descLong && (
              <button
                onClick={() => setDescExpanded(!descExpanded)}
                style={{
                  background: 'none', border: 'none', padding: '8px 0',
                  color: tokens.colors.accent.brand, cursor: 'pointer',
                  fontSize: 13, fontWeight: 500,
                }}
              >
                {descExpanded ? (isZh ? '收起' : 'Show less') : (isZh ? '展开全文' : 'Show more')}
              </button>
            )}
          </Section>
        )}

        {/* ===== Rating Overview ===== */}
        {count > 0 && (
          <Section title={isZh ? '评分概览' : 'Rating Overview'}>
            <div style={{
              display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center',
            }}>
              {/* Left: big number */}
              <div style={{ textAlign: 'center', minWidth: 80 }}>
                <div style={{ fontSize: 48, fontWeight: 800, color: '#f5c518', lineHeight: 1 }}>
                  {avg.toFixed(1)}
                </div>
                <StarRating rating={avg} size={16} readonly showCount={false} />
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary, marginTop: 4 }}>
                  {count} {isZh ? '人评价' : 'ratings'}
                </div>
              </div>

              {/* Right: distribution bars */}
              <div style={{ flex: 1, minWidth: 200 }}>
                {[5, 4, 3, 2, 1].map(star => (
                  <div key={star} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: tokens.colors.text.secondary, width: 16, textAlign: 'right' }}>{star}</span>
                    <span style={{ fontSize: 13, color: '#f5c518' }}>*</span>
                    <div style={{ flex: 1, height: 10, borderRadius: 5, background: tokens.colors.bg.primary, overflow: 'hidden' }}>
                      <div style={{
                        width: `${(dist[star as keyof typeof dist] / maxDist) * 100}%`,
                        height: '100%', borderRadius: 5,
                        background: 'linear-gradient(90deg, #f5c518, #f7d94e)',
                        transition: `width ${tokens.transition.slow}`,
                      }} />
                    </div>
                    <span style={{ fontSize: 12, color: tokens.colors.text.tertiary, width: 28, textAlign: 'right' }}>
                      {dist[star as keyof typeof dist]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        )}

        {/* ===== Reviews ===== */}
        {reviews.length > 0 && (
          <Section title={isZh ? '书评' : 'Reviews'}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {reviews.map(r => (
                <div key={r.id} style={{
                  padding: '16px 20px', borderRadius: tokens.radius.lg,
                  background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%',
                      background: tokens.gradient.primarySubtle,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, color: tokens.colors.accent.brand, fontWeight: 700,
                    }}>
                      {((r.users as any)?.nickname || 'U')[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary }}>
                        {(r.users as any)?.nickname || (isZh ? '匿名用户' : 'Anonymous')}
                      </span>
                      <span style={{ fontSize: 12, color: tokens.colors.text.tertiary, marginLeft: 8 }}>
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    {r.rating && <StarRating rating={r.rating} size={14} readonly showCount={false} />}
                  </div>
                  {r.review && (
                    <p style={{ fontSize: 14, lineHeight: 1.65, color: tokens.colors.text.secondary, margin: 0 }}>
                      {r.review}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {hasMoreReviews && (
              <button
                onClick={() => setReviewPage(p => p + 1)}
                style={{
                  marginTop: 14, padding: '10px 24px', borderRadius: tokens.radius.lg,
                  background: 'transparent', border: `1px solid ${tokens.colors.border.primary}`,
                  color: tokens.colors.text.primary, cursor: 'pointer', fontSize: 13, fontWeight: 500,
                  transition: `all ${tokens.transition.fast}`,
                }}
              >
                {isZh ? '加载更多' : 'Load more'}
              </button>
            )}
          </Section>
        )}

        {/* ===== Similar Books ===== */}
        {similar.length > 0 && (
          <Section title={isZh ? '相似推荐' : 'You might also like'}>
            <div style={{
              display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8,
              scrollbarWidth: 'thin', scrollSnapType: 'x mandatory',
            }}>
              {similar.map(item => (
                <Link key={item.id} href={`/library/${item.id}`} style={{ textDecoration: 'none', flexShrink: 0, scrollSnapAlign: 'start' }}>
                  <div
                    style={{ width: 140, transition: `transform ${tokens.transition.base}` }}
                    onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-4px)')}
                    onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
                  >
                    <div style={{
                      width: 140, height: 210, borderRadius: tokens.radius.lg,
                      overflow: 'hidden', boxShadow: tokens.shadow.md, marginBottom: 8,
                    }}>
                      <BookCover
                        title={item.title}
                        author={item.author}
                        category={item.category || 'book'}
                        coverUrl={item.cover_url}
                        fontSize="sm"
                      />
                    </div>
                    <p style={{
                      fontSize: 12, fontWeight: 600, color: tokens.colors.text.primary,
                      lineHeight: 1.3, margin: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
                    }}>
                      {item.title}
                    </p>
                    {item.rating != null && item.rating > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <StarRating rating={item.rating} ratingCount={item.rating_count || 0} size={12} readonly />
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </Section>
        )}

      </main>
      <MobileBottomNav />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 32, padding: '20px 24px',
      borderRadius: tokens.radius.xl,
      background: tokens.colors.bg.secondary,
      border: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <h2 style={{
        fontSize: tokens.typography.fontSize.lg,
        fontWeight: tokens.typography.fontWeight.semibold,
        color: tokens.colors.text.primary,
        marginBottom: 16, marginTop: 0,
      }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

function MetaPill({ label }: { label: string }) {
  return (
    <span style={{
      fontSize: 12, padding: '4px 12px', borderRadius: tokens.radius.full,
      background: tokens.colors.bg.tertiary, color: tokens.colors.text.secondary,
      fontWeight: 500, textTransform: 'capitalize',
    }}>
      {label}
    </span>
  )
}
