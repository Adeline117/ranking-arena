'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import StarRating from '@/app/components/ui/StarRating'

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
  view_count: number
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
  }, [])

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (!session?.access_token) return {}
    return { Authorization: `Bearer ${session.access_token}` }
  }, [session])

  // Fetch book details
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

  // Fetch reviews
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

  // Fetch similar
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
      // Refresh overview
      const data = await fetch(`/api/library/${id}`, { headers: getAuthHeaders() }).then(r => r.json())
      setOverview(data.ratingOverview)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '80px 16px 100px' }}>
          <div style={{ height: 400, borderRadius: 12, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
        </main>
        <MobileBottomNav />
      </div>
    )
  }

  if (!book) {
    return (
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <TopNav />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '80px 16px 100px', textAlign: 'center', color: tokens.colors.text.secondary }}>
          {isZh ? '未找到该书籍' : 'Book not found'}
        </main>
        <MobileBottomNav />
      </div>
    )
  }

  const avg = overview?.average || 0
  const count = overview?.count || 0
  const dist = overview?.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const maxDist = Math.max(...Object.values(dist), 1)

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav />
      <main style={{ maxWidth: 900, margin: '0 auto', padding: '80px 16px 100px' }}>

        {/* Back link */}
        <Link href="/library" style={{ color: tokens.colors.accent.brand, fontSize: 13, textDecoration: 'none', marginBottom: 16, display: 'inline-block' }}>
          ← {isZh ? '返回书架' : 'Back to Library'}
        </Link>

        {/* === Top Section === */}
        <div style={{ display: 'flex', gap: 24, marginBottom: 32, flexWrap: 'wrap' }}>
          {/* Cover */}
          <div style={{
            width: 200, minHeight: 280, borderRadius: 12, overflow: 'hidden', flexShrink: 0,
            background: `linear-gradient(135deg, ${tokens.colors.accent.brand}22, ${tokens.colors.accent.brand}44)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' as const,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}>
            {book.cover_url ? (
              <Image src={book.cover_url} alt={book.title} fill style={{ objectFit: 'cover' }} unoptimized />
            ) : (
              <span style={{ fontSize: 64 }}>📖</span>
            )}
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 250 }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 8, lineHeight: 1.3 }}>
              {book.title}
            </h1>
            {book.author && (
              <p style={{ fontSize: 16, color: tokens.colors.text.secondary, marginBottom: 12 }}>
                {book.author}
              </p>
            )}

            {/* Rating display */}
            <div style={{ marginBottom: 16 }}>
              <StarRating rating={avg} ratingCount={count} size={22} readonly />
            </div>

            {/* Status buttons */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <button
                onClick={() => handleStatus('want_to_read')}
                style={{
                  padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  border: userStatus === 'want_to_read' ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                  background: userStatus === 'want_to_read' ? tokens.colors.accent.brand : 'transparent',
                  color: userStatus === 'want_to_read' ? '#fff' : tokens.colors.text.primary,
                  transition: 'all 0.2s',
                }}
              >
                {isZh ? '📌 想看' : '📌 Want to Read'}
              </button>
              <button
                onClick={() => handleStatus('read')}
                style={{
                  padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  border: userStatus === 'read' ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                  background: userStatus === 'read' ? '#10b981' : 'transparent',
                  color: userStatus === 'read' ? '#fff' : tokens.colors.text.primary,
                  transition: 'all 0.2s',
                }}
              >
                {isZh ? '✅ 看过' : '✅ Read'}
              </button>
            </div>

            {/* User rating (only when marked as read) */}
            {userStatus === 'read' && (
              <div style={{ padding: '12px 16px', borderRadius: 10, background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}` }}>
                <p style={{ fontSize: 13, color: tokens.colors.text.secondary, marginBottom: 8 }}>
                  {isZh ? '你的评分：' : 'Your rating:'}
                </p>
                <StarRating rating={0} userRating={userRating || 0} onRate={handleRate} size={28} showCount={false} />
              </div>
            )}
          </div>
        </div>

        {/* === Metadata === */}
        <div style={{
          padding: '16px 20px', borderRadius: 12, marginBottom: 24,
          background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 32px', fontSize: 13 }}>
            {book.publisher && <MetaItem label={isZh ? '出版社' : 'Publisher'} value={book.publisher} />}
            {book.publish_date && <MetaItem label={isZh ? '出版日期' : 'Published'} value={book.publish_date} />}
            {(book as any).isbn && <MetaItem label="ISBN" value={(book as any).isbn} />}
            {(book as any).page_count && <MetaItem label={isZh ? '页数' : 'Pages'} value={String((book as any).page_count)} />}
            {book.language && <MetaItem label={isZh ? '语言' : 'Language'} value={book.language} />}
            {book.category && <MetaItem label={isZh ? '分类' : 'Category'} value={book.category} />}
          </div>

          {/* Tags */}
          {book.tags && book.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
              {book.tags.map(tag => (
                <span key={tag} style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 12,
                  background: tokens.colors.accent.brand + '22', color: tokens.colors.accent.brand,
                  fontWeight: 500,
                }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          {(book.pdf_url || book.buy_url) && (
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              {book.pdf_url && (
                <a href={book.pdf_url} target="_blank" rel="noopener noreferrer" style={{
                  padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: tokens.colors.accent.brand, color: '#fff', textDecoration: 'none',
                }}>
                  {isZh ? '📄 阅读原文' : '📄 Read PDF'}
                </a>
              )}
              {book.buy_url && (
                <a href={book.buy_url} target="_blank" rel="noopener noreferrer" style={{
                  padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  border: `1px solid ${tokens.colors.accent.brand}`, color: tokens.colors.accent.brand,
                  textDecoration: 'none', background: 'transparent',
                }}>
                  {isZh ? '🛒 购买' : '🛒 Buy'}
                </a>
              )}
            </div>
          )}
        </div>

        {/* === Description === */}
        {book.description && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 12 }}>
              {isZh ? '简介' : 'Description'}
            </h2>
            <p style={{
              fontSize: 14, lineHeight: 1.7, color: tokens.colors.text.secondary,
              whiteSpace: 'pre-wrap',
            }}>
              {book.description}
            </p>
          </div>
        )}

        {/* === Rating Overview === */}
        {count > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 16 }}>
              {isZh ? '评分概览' : 'Rating Overview'}
            </h2>
            <div style={{
              display: 'flex', gap: 32, padding: '20px 24px', borderRadius: 12,
              background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
              flexWrap: 'wrap', alignItems: 'center',
            }}>
              {/* Left: big number */}
              <div style={{ textAlign: 'center', minWidth: 80 }}>
                <div style={{ fontSize: 42, fontWeight: 700, color: '#f5c518', lineHeight: 1 }}>
                  {avg.toFixed(1)}
                </div>
                <StarRating rating={avg} size={16} readonly showCount={false} />
                <div style={{ fontSize: 12, color: tokens.colors.text.secondary, marginTop: 4 }}>
                  {count} {isZh ? '人评价' : 'ratings'}
                </div>
              </div>

              {/* Right: distribution bars */}
              <div style={{ flex: 1, minWidth: 200 }}>
                {[5, 4, 3, 2, 1].map(star => (
                  <div key={star} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: tokens.colors.text.secondary, width: 16, textAlign: 'right' }}>{star}</span>
                    <span style={{ fontSize: 12, color: '#f5c518' }}>★</span>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: tokens.colors.bg.primary, overflow: 'hidden' }}>
                      <div style={{
                        width: `${(dist[star as keyof typeof dist] / maxDist) * 100}%`,
                        height: '100%', borderRadius: 4,
                        background: '#f5c518', transition: 'width 0.3s',
                      }} />
                    </div>
                    <span style={{ fontSize: 11, color: tokens.colors.text.secondary, width: 24, textAlign: 'right' }}>
                      {dist[star as keyof typeof dist]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* === Reviews === */}
        {reviews.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 16 }}>
              {isZh ? '书评' : 'Reviews'}
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {reviews.map(r => (
                <div key={r.id} style={{
                  padding: '14px 18px', borderRadius: 10,
                  background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    {/* Avatar */}
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: tokens.colors.accent.brand + '33',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, color: tokens.colors.accent.brand, fontWeight: 600,
                    }}>
                      {((r.users as any)?.nickname || 'U')[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary }}>
                        {(r.users as any)?.nickname || (isZh ? '匿名用户' : 'Anonymous')}
                      </span>
                      <span style={{ fontSize: 11, color: tokens.colors.text.secondary, marginLeft: 8 }}>
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    {r.rating && <StarRating rating={r.rating} size={14} readonly showCount={false} />}
                  </div>
                  {r.review && (
                    <p style={{ fontSize: 13, lineHeight: 1.6, color: tokens.colors.text.secondary, margin: 0 }}>
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
                  marginTop: 12, padding: '8px 20px', borderRadius: 8,
                  background: 'transparent', border: `1px solid ${tokens.colors.border.primary}`,
                  color: tokens.colors.text.primary, cursor: 'pointer', fontSize: 13,
                }}
              >
                {isZh ? '加载更多' : 'Load more'}
              </button>
            )}
          </div>
        )}

        {/* === Similar Recommendations === */}
        {similar.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 16 }}>
              {isZh ? '喜欢这本书的人也喜欢' : 'People who liked this also liked'}
            </h2>
            <div style={{
              display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8,
              scrollbarWidth: 'thin',
            }}>
              {similar.map(item => (
                <Link key={item.id} href={`/library/${item.id}`} style={{ textDecoration: 'none', flexShrink: 0 }}>
                  <div style={{
                    width: 140, borderRadius: 10, overflow: 'hidden',
                    background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
                    transition: 'transform 0.2s',
                  }}
                    onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-2px)')}
                    onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
                  >
                    <div style={{
                      height: 180, background: `linear-gradient(135deg, ${tokens.colors.accent.brand}22, ${tokens.colors.accent.brand}44)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' as const,
                    }}>
                      {item.cover_url ? (
                        <Image src={item.cover_url} alt={item.title || ''} fill style={{ objectFit: 'cover' }} unoptimized />
                      ) : (
                        <span style={{ fontSize: 32 }}>📖</span>
                      )}
                    </div>
                    <div style={{ padding: '8px 10px' }}>
                      <p style={{
                        fontSize: 12, fontWeight: 600, color: tokens.colors.text.primary,
                        lineHeight: 1.3, marginBottom: 4,
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
                      }}>
                        {item.title}
                      </p>
                      {item.rating != null && item.rating > 0 && (
                        <StarRating rating={item.rating} ratingCount={item.rating_count || 0} size={12} readonly />
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

      </main>
      <MobileBottomNav />
    </div>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ color: tokens.colors.text.secondary }}>{label}: </span>
      <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{value}</span>
    </div>
  )
}
