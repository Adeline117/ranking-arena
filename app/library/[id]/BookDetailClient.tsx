'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { usePremium } from '@/lib/premium/hooks'
import StarRating from '@/app/components/ui/StarRating'
import BookCover from '../BookCover'
import ShareButton from '@/app/components/common/ShareButton'
import AddToCollectionButton from '@/app/components/features/AddToCollectionButton'
import { logger } from '@/lib/logger'
import BookRatingOverview from './components/BookRatingOverview'
import BookReviews from './components/BookReviews'
import SimilarBooks from './components/SimilarBooks'

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

export type BookDetail = {
  id: string
  title: string
  title_en: string | null
  title_zh: string | null
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
  content_url: string | null
  publisher: string | null
  isbn: string | null
  page_count: number | null
  language: string | null
  language_group_id: string | null
  rating: number | null
  rating_count: number | null
  file_key: string | null
  epub_url: string | null
}

export type LanguageVersion = {
  id: string
  title: string
  language: string | null
}

export type RatingOverview = {
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
  users: { id: string; nickname: string | null; avatar_url: string | null } | null
}

export type SimilarItem = {
  id: string
  title: string
  author: string | null
  cover_url: string | null
  category: string
  rating: number | null
  rating_count: number | null
}

interface BookDetailClientProps {
  book: BookDetail
  initialOverview: RatingOverview | null
  initialSimilar: SimilarItem[]
  initialLangVersions: LanguageVersion[]
  canonicalUrl: string
}

export default function BookDetailClient({
  book,
  initialOverview,
  initialSimilar,
  initialLangVersions,
  canonicalUrl,
}: BookDetailClientProps) {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const id = book.id

  const [overview, setOverview] = useState<RatingOverview | null>(initialOverview)
  const [userStatus, setUserStatus] = useState<string | null>(null)
  const [userRating, setUserRating] = useState<number | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewPage, setReviewPage] = useState(1)
  const [hasMoreReviews, setHasMoreReviews] = useState(false)
  const similar = initialSimilar
  const langVersions = initialLangVersions
  const [session, setSession] = useState<any>(null)
  const [descExpanded, setDescExpanded] = useState(false)
  const { isPremium } = usePremium()

  // Load session and user-specific data client-side
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session?.access_token) {
        fetch(`/api/library/${id}`, {
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        })
          .then(r => r.json())
          .then(d => {
            setUserStatus(d.userStatus)
            setUserRating(d.userRating)
            setUserReview(d.userReview || null)
            if (d.userReview) setShortReview(d.userReview)
          })
          .catch(() => {})
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (!session?.access_token) return {}
    return { Authorization: `Bearer ${session.access_token}` }
  }, [session])

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
      .catch(() => {})
  }, [id])

  // Fetch reviews on mount and when page changes
  useEffect(() => { fetchReviews(reviewPage) }, [fetchReviews, reviewPage])

  const [showRatingPrompt, setShowRatingPrompt] = useState(false)
  const [shortReview, setShortReview] = useState('')
  const [userReview, setUserReview] = useState<string | null>(null)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const ratingRef = useRef<HTMLDivElement>(null)

  const [statusLoading, setStatusLoading] = useState(false)
  const handleStatus = async (status: 'want_to_read' | 'reading' | 'read') => {
    if (!session) {
      alert(isZh ? '请先登录' : 'Please login first')
      return
    }
    if (statusLoading) return
    setStatusLoading(true)
    try {
      const res = await fetch(`/api/library/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ status }),
      })
      if (res.ok) {
        setUserStatus(status)
        if (status === 'want_to_read') {
          setUserRating(null)
          setShowRatingPrompt(false)
        }
        if (status === 'read') {
          setShowRatingPrompt(true)
          setTimeout(() => ratingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200)
        }
      } else {
        const data = await res.json().catch(() => ({}))
        logger.error('Status update failed', data)
      }
    } catch (e) {
      logger.error('Status update error', e)
    } finally {
      setStatusLoading(false)
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

  const handleSubmitReview = async () => {
    if (!session || !shortReview.trim() || reviewSubmitting) return
    setReviewSubmitting(true)
    try {
      const res = await fetch(`/api/library/${id}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ rating: userRating, review: shortReview.trim().slice(0, 280) }),
      })
      if (res.ok) {
        setUserReview(shortReview.trim())
        fetchReviews(1)
        setReviewPage(1)
      }
    } catch (e) {
      logger.error('Review submit error', e)
    } finally {
      setReviewSubmitting(false)
    }
  }

  const avg = overview?.average || 0
  const count = overview?.count || 0
  const dist = overview?.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const maxDist = Math.max(...Object.values(dist), 1)
  const hasReadableContent = !!book.file_key || !!book.pdf_url || !!book.epub_url || (!!book.content_url && (book.content_url.endsWith('.pdf') || book.content_url.includes('cdn.arenafi.org/papers/')))
  const descLong = (book.description?.length || 0) > 300

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav />
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '80px 16px 100px' }}>

        {/* Breadcrumb */}
        <Breadcrumb items={[
          { label: isZh ? '书库' : 'Library', href: '/library' },
          { label: book.title },
        ]} />

        {/* ===== Top Section: Cover + Info ===== */}
        <div className="book-detail-top" style={{ display: 'flex', gap: 36, marginBottom: 36, flexWrap: 'wrap' }}>
          {/* Cover with shadow */}
          <div className="book-detail-cover" style={{
            width: 280, flexShrink: 0,
          }}>
            <div style={{
              width: '100%', aspectRatio: '2/3',
              borderRadius: tokens.radius.xl,
              overflow: 'hidden',
              boxShadow: '0 8px 30px var(--color-overlay-medium), 0 20px 60px var(--color-overlay-light), 0 0 0 1px var(--glass-border-light)',
              transition: 'transform 0.3s ease, box-shadow 0.3s ease',
            }}>
              <BookCover
                title={book.title}
                author={book.author}
                category={book.category}
                coverUrl={book.cover_url}
                fontSize="lg"
                priority
              />
            </div>
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column' }}>
            <h1 style={{
              fontSize: 28,
              fontWeight: tokens.typography.fontWeight.bold,
              color: tokens.colors.text.primary,
              marginBottom: 8, lineHeight: 1.25,
              letterSpacing: '-0.02em',
            }}>
              {isZh ? (book.title_zh || book.title) : (book.title_en || book.title)}
            </h1>

            {book.author && (
              <p style={{
                fontSize: 16,
                color: tokens.colors.text.secondary,
                marginBottom: 20,
                fontWeight: 500,
              }}>
                {book.author}
              </p>
            )}

            {/* Rating - Douban style */}
            {count > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16,
                padding: '12px 16px', borderRadius: tokens.radius.lg,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}>
                <span style={{
                  fontSize: 42,
                  fontWeight: 800,
                  letterSpacing: '-0.03em',
                  color: tokens.colors.rating.filled,
                  lineHeight: 1,
                }}>
                  {avg.toFixed(1)}
                </span>
                <div>
                  <StarRating rating={avg} ratingCount={count} size={22} readonly showCount={false} />
                  <span style={{ fontSize: 13, color: tokens.colors.text.tertiary, display: 'block', marginTop: 2 }}>
                    {count} {isZh ? '人评价' : 'ratings'}
                  </span>
                </div>
              </div>
            )}

            {/* Metadata pills */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
              {book.category && <MetaPill label={isZh ? ({
                book: '书籍', paper: '论文', whitepaper: '白皮书', event: '事件',
                research: '研报', academic_paper: '学术论文', finance: '金融', regulatory: '监管',
              } as Record<string, string>)[book.category] || book.category : book.category} />}
              {book.publisher && <MetaPill label={book.publisher} />}
              {book.publish_date && <MetaPill label={book.publish_date} />}
              {book.language && <MetaPill label={book.language === 'zh' ? 'Chinese' : book.language === 'en' ? 'English' : book.language} />}
              {book.page_count && <MetaPill label={`${book.page_count} ${isZh ? '页' : 'pages'}`} />}
              {book.isbn && <MetaPill label={`ISBN: ${book.isbn}`} />}
            </div>

            {/* Language Versions */}
            {langVersions.length > 0 && (
              <div style={{
                display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16,
                padding: '10px 14px', borderRadius: tokens.radius.lg,
                background: tokens.colors.bg.tertiary,
                border: `1px solid ${tokens.colors.border.primary}`,
                alignItems: 'center',
              }}>
                <span style={{ fontSize: 12, color: tokens.colors.text.tertiary, fontWeight: 600 }}>
                  {isZh ? '其他语言版本' : 'Other Languages'}:
                </span>
                {langVersions.map(v => (
                  <Link
                    key={v.id}
                    href={`/library/${v.id}`}
                    style={{
                      fontSize: 12, fontWeight: 600, padding: '4px 12px',
                      borderRadius: tokens.radius.full,
                      background: tokens.colors.accent.brandMuted,
                      color: tokens.colors.accent.brand,
                      textDecoration: 'none',
                      transition: `all ${tokens.transition.fast}`,
                    }}
                  >
                    {v.language === 'zh' ? '中文' : v.language === 'en' ? 'English' : v.language === 'de' ? 'Deutsch' : v.language === 'fr' ? 'Français' : v.language === 'es' ? 'Español' : v.language === 'ja' ? '日本語' : v.language || 'Other'}
                  </Link>
                ))}
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {/* Read - always in-app, never external */}
              {hasReadableContent ? (
                book.is_free || isPremium ? (
                  <Link
                    href={`/library/${book.id}/read`}
                    style={{
                      padding: '14px 36px', borderRadius: tokens.radius.xl,
                      fontSize: 16, fontWeight: 700,
                      background: tokens.gradient.primary, color: 'var(--foreground)',
                      textDecoration: 'none',
                      display: 'inline-flex', alignItems: 'center', gap: 10,
                      transition: 'all 0.2s ease',
                      boxShadow: '0 4px 16px var(--color-accent-primary-30, rgba(99,102,241,0.3))',
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                    {isZh ? '开始阅读' : 'Start Reading'}
                  </Link>
                ) : !session ? (
                  <Link
                    href="/login"
                    style={{
                      padding: '10px 24px', borderRadius: tokens.radius.lg,
                      fontSize: tokens.typography.fontSize.base, fontWeight: tokens.typography.fontWeight.semibold,
                      background: tokens.gradient.primary, color: 'var(--foreground)',
                      textDecoration: 'none',
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      transition: `all ${tokens.transition.fast}`,
                      boxShadow: tokens.shadow.glow,
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    {isZh ? '登录后阅读' : 'Login to Read'}
                  </Link>
                ) : (
                  <Link
                    href="/pricing"
                    style={{
                      padding: '10px 24px', borderRadius: tokens.radius.lg,
                      fontSize: tokens.typography.fontSize.base, fontWeight: tokens.typography.fontWeight.semibold,
                      background: tokens.gradient.primary, color: 'var(--foreground)',
                      textDecoration: 'none',
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      transition: `all ${tokens.transition.fast}`,
                      boxShadow: tokens.shadow.glow,
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    {isZh ? '升级 Pro 解锁' : 'Upgrade to Pro'}
                  </Link>
                )
              ) : (
                <span style={{
                  padding: '14px 36px', borderRadius: tokens.radius.xl,
                  fontSize: 16, fontWeight: 600,
                  background: tokens.colors.bg.tertiary, color: tokens.colors.text.tertiary,
                  display: 'inline-flex', alignItems: 'center', gap: 10,
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                  {isZh ? '暂无电子版' : 'No digital version'}
                </span>
              )}

              {/* External source link when no in-app reader */}
              {!hasReadableContent && book.source_url && (
                <a
                  href={book.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    padding: '14px 24px', borderRadius: tokens.radius.xl,
                    fontSize: 14, fontWeight: 600,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: 'transparent', color: tokens.colors.text.primary,
                    textDecoration: 'none',
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  {isZh ? '查看来源' : 'View Source'}
                </a>
              )}

              {/* Want to Read */}
              <StatusButton
                active={userStatus === 'want_to_read'}
                onClick={() => handleStatus('want_to_read')}
                activeColor={tokens.colors.accent.brand}
                icon={<svg width="14" height="14" viewBox="0 0 24 24" fill={userStatus === 'want_to_read' ? 'var(--color-on-accent)' : 'none'} stroke="currentColor" strokeWidth="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" /></svg>}
                label={isZh ? '想读' : 'Want to Read'}
              />

              {/* Reading */}
              <StatusButton
                active={userStatus === 'reading'}
                onClick={() => handleStatus('reading')}
                activeColor="var(--color-accent-warning, #FFB800)"
                icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>}
                label={isZh ? '在读' : 'Reading'}
              />

              {/* Mark as Read */}
              <StatusButton
                active={userStatus === 'read'}
                onClick={() => handleStatus('read')}
                activeColor={tokens.colors.accent.success}
                icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>}
                label={isZh ? '读过' : 'Read'}
              />

              {/* Share */}
              <ShareButton
                data={{
                  type: 'library',
                  url: canonicalUrl,
                  title: book.title,
                  author: book.author || '',
                }}
                variant="outline"
              />

              {/* Add to Collection */}
              {session && (
                <AddToCollectionButton itemType="book" itemId={book.id} />
              )}
            </div>

            {/* User rating - show for all logged in users */}
            {session && (
              <div ref={ratingRef} style={{
                marginTop: 16, padding: '16px 20px', borderRadius: tokens.radius.lg,
                background: showRatingPrompt ? 'var(--color-accent-brand-08, rgba(139,111,168,0.08))' : tokens.colors.bg.secondary,
                border: showRatingPrompt ? `2px solid ${tokens.colors.accent.brand}` : `1px solid ${tokens.colors.border.primary}`,
                transition: 'all 0.3s ease',
              }}>
                <p style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 10 }}>
                  {userRating ? (isZh ? '你的评分' : 'Your Rating') : (isZh ? '给这本书评分' : 'Rate this book')}
                </p>
                <StarRating rating={0} userRating={userRating || 0} onRate={handleRate} size={36} showCount={false} />
                {showRatingPrompt && !userRating && (
                  <p style={{ fontSize: 12, color: tokens.colors.accent.brand, marginTop: 8 }}>
                    {isZh ? '点击星星评分吧' : 'Tap a star to rate'}
                  </p>
                )}
                {/* Short review textarea - show after rating */}
                {userRating && (
                  <div style={{ marginTop: 14 }}>
                    {userReview ? (
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <p style={{ fontSize: 14, color: tokens.colors.text.secondary, margin: 0, flex: 1, lineHeight: 1.6 }}>
                          {userReview}
                        </p>
                        <button
                          onClick={() => { setUserReview(null); setShortReview(userReview || '') }}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            fontSize: 12, color: tokens.colors.accent.brand, flexShrink: 0, padding: '2px 0',
                          }}
                        >
                          {isZh ? '编辑' : 'Edit'}
                        </button>
                      </div>
                    ) : (
                      <>
                        <textarea
                          value={shortReview}
                          onChange={e => setShortReview(e.target.value.slice(0, 280))}
                          placeholder={isZh ? '写一句短评吧' : 'Write a short review...'}
                          style={{
                            width: '100%', minHeight: 60, padding: '10px 12px',
                            borderRadius: tokens.radius.md, fontSize: 14,
                            background: tokens.colors.bg.primary, color: tokens.colors.text.primary,
                            border: `1px solid ${tokens.colors.border.primary}`,
                            resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6,
                            outline: 'none',
                          }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                          <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                            {shortReview.length}/280
                          </span>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <Link
                              href={`/community/new?category=book_review&book_id=${id}&book_title=${encodeURIComponent(book?.title || '')}`}
                              style={{
                                fontSize: 13, color: tokens.colors.accent.brand,
                                textDecoration: 'none', fontWeight: 500,
                              }}
                            >
                              {isZh ? '写长评 →' : 'Write long review →'}
                            </Link>
                            <button
                              onClick={handleSubmitReview}
                              disabled={!shortReview.trim() || reviewSubmitting}
                              style={{
                                padding: '6px 16px', borderRadius: tokens.radius.md,
                                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                                border: 'none',
                                background: shortReview.trim() ? tokens.colors.accent.brand : tokens.colors.bg.tertiary,
                                color: shortReview.trim() ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
                                opacity: reviewSubmitting ? 0.6 : 1,
                                transition: `all ${tokens.transition.fast}`,
                              }}
                            >
                              {reviewSubmitting ? '...' : (isZh ? '发布' : 'Post')}
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
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
          <Section title="">
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
                {descExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </Section>
        )}

        {/* ===== Rating Overview ===== */}
        {count > 0 && (
          <Section title="">
            <BookRatingOverview average={avg} count={count} distribution={dist} />
          </Section>
        )}

        {/* ===== Reviews ===== */}
        {reviews.length > 0 && (
          <Section title="">
            <BookReviews
              reviews={reviews}
              bookId={id}
              bookTitle={book.title}
              isZh={isZh}
              hasSession={!!session}
              hasMoreReviews={hasMoreReviews}
              onLoadMore={() => setReviewPage(p => p + 1)}
            />
          </Section>
        )}

        {/* ===== Similar Books ===== */}
        {similar.length > 0 && (
          <Section title="">
            <SimilarBooks items={similar} />
          </Section>
        )}

      </main>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @media (max-width: 767px) {
          .book-detail-top { flex-direction: column !important; align-items: center !important; text-align: center; gap: 20px !important; }
          .book-detail-cover { width: 200px !important; margin: 0 auto; }
        }
        @media (max-width: 480px) {
          .book-detail-cover { width: 160px !important; }
        }
      `}</style>
      <MobileBottomNav />
    </div>
  )
}

function Section({ title, children, extra }: { title: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 32, padding: '20px 24px',
      borderRadius: tokens.radius.xl,
      background: tokens.colors.bg.secondary,
      border: `1px solid ${tokens.colors.border.primary}`,
    }}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: tokens.typography.fontWeight.semibold,
            color: tokens.colors.text.primary,
            margin: 0,
          }}>
            {title}
          </h2>
          {extra}
        </div>
      )}
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

function StatusButton({ active, onClick, activeColor, icon, label }: {
  active: boolean; onClick: () => void; activeColor: string; icon: React.ReactNode; label: string
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '10px 18px', borderRadius: tokens.radius.lg,
        fontSize: 14, fontWeight: 600,
        cursor: 'pointer',
        border: active ? `2px solid ${activeColor}` : `1px solid ${tokens.colors.border.primary}`,
        background: active ? activeColor : 'transparent',
        color: active ? 'var(--color-on-accent)' : tokens.colors.text.primary,
        transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        minWidth: 90, justifyContent: 'center',
        boxShadow: active ? `0 2px 8px ${activeColor}40` : 'none',
      }}
      onMouseEnter={e => {
        if (!active) {
          e.currentTarget.style.borderColor = activeColor
          e.currentTarget.style.color = activeColor
        }
      }}
      onMouseLeave={e => {
        if (!active) {
          e.currentTarget.style.borderColor = tokens.colors.border.primary
          e.currentTarget.style.color = tokens.colors.text.primary
        }
      }}
    >
      {icon}
      {label}
    </button>
  )
}
