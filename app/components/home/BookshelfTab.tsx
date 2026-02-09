'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import StarRating from '@/app/components/ui/StarRating'
import BookCover from '@/app/library/BookCover'
import { supabase } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'

type ShelfBook = {
  id: string
  title: string
  author: string | null
  cover_url: string | null
  category: string
  rating: number | null
  rating_count: number | null
  status: 'want_to_read' | 'read'
}

export default function BookshelfTab() {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const [books, setBooks] = useState<ShelfBook[]>([])
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'want_to_read' | 'read'>('all')

  useEffect(() => {
    // Use getSession() — reads from local storage, no network request
    supabase.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user?.id ?? null)
      if (!data.session?.user) setLoading(false)
    })
  }, [])

  const fetchBookshelf = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    try {
      let query = supabase
        .from('book_ratings')
        .select('status, library_item_id, library_items(id, title, author, cover_url, category, rating, rating_count)')
        .eq('user_id', userId)
        .in('status', ['want_to_read', 'read'])

      if (filter !== 'all') {
        query = query.eq('status', filter)
      }

      const { data, error } = await query.order('updated_at', { ascending: false })

      if (error) {
        setBooks([])
        return
      }

      const mapped: ShelfBook[] = (data || [])
        .filter((d: Record<string, unknown>) => d.library_items)
        .map((d: Record<string, unknown>) => ({
          ...(d.library_items as Omit<ShelfBook, 'status'>),
          status: d.status as ShelfBook['status'],
        }))

      setBooks(mapped)
    } catch (e) {
      logger.error('Failed to fetch bookshelf:', e)
      setBooks([])
    } finally {
      setLoading(false)
    }
  }, [userId, filter])

  useEffect(() => {
    if (userId) fetchBookshelf()
  }, [userId, fetchBookshelf])

  // Not logged in
  if (!loading && !userId) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: tokens.colors.text.secondary }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" style={{ marginBottom: 16, opacity: 0.5 }}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
        <p style={{ fontSize: 16, marginBottom: 12 }}>
          {isZh ? '登录后查看你的书架' : 'Login to see your bookshelf'}
        </p>
        <a href="/login" style={{
          display: 'inline-block', padding: '8px 24px', borderRadius: tokens.radius.md,
          background: tokens.colors.accent.brand, color: tokens.colors.white,
          textDecoration: 'none', fontWeight: 600, fontSize: 14,
        }}>
          {isZh ? '去登录' : 'Login'}
        </a>
      </div>
    )
  }

  return (
    <div>
      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto', scrollbarWidth: 'none' }}>
        {([
          { key: 'all' as const, label: isZh ? '全部' : 'All' },
          { key: 'want_to_read' as const, label: isZh ? '想读' : 'Want to Read' },
          { key: 'read' as const, label: isZh ? '已读' : 'Read' },
        ]).map(opt => (
          <button
            key={opt.key}
            onClick={() => setFilter(opt.key)}
            style={{
              padding: '10px 14px', borderRadius: tokens.radius.full, fontSize: 12, fontWeight: filter === opt.key ? 600 : 500, minHeight: 44,
              border: filter === opt.key ? 'none' : `1px solid ${tokens.colors.border.primary}`,
              background: filter === opt.key ? tokens.colors.accent.brand : 'transparent',
              color: filter === opt.key ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              cursor: 'pointer', transition: `all ${tokens.transition.fast}`,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ aspectRatio: '2/3', borderRadius: tokens.radius.lg, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ height: 12, borderRadius: tokens.radius.sm, width: '75%', background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
            </div>
          ))}
        </div>
      ) : books.length === 0 ? (
        /* Empty state - attractive library entrance */
        <Link href="/library" style={{ textDecoration: 'none', display: 'block' }}>
          <div style={{
            padding: '40px 24px',
            borderRadius: tokens.radius.xl,
            background: `linear-gradient(135deg, var(--color-accent-brand) 0%, var(--color-brand-deep, #6b4f88) 100%)`,
            color: 'white',
            textAlign: 'center',
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
            boxShadow: tokens.shadow.glow,
            position: 'relative',
            overflow: 'hidden',
          }}>
            {/* Background decoration */}
            <div style={{
              position: 'absolute', top: -20, right: -20, width: 120, height: 120,
              borderRadius: '50%', background: 'var(--glass-bg-light)',
            }} />
            <div style={{
              position: 'absolute', bottom: -30, left: -10, width: 80, height: 80,
              borderRadius: '50%', background: 'var(--glass-bg-light)',
            }} />

            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" style={{ marginBottom: 16, opacity: 0.9 }}>
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
            <p style={{ fontSize: 20, fontWeight: 800, marginBottom: 6, letterSpacing: '0.5px' }}>
              {isZh ? '探索书城' : 'Explore Library'}
            </p>
            <p style={{ fontSize: 14, opacity: 0.85, marginBottom: 20 }}>
              {isZh ? '60,000+ 本书籍、论文、白皮书等你发现' : '60,000+ books, papers & whitepapers await'}
            </p>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '12px 32px', borderRadius: tokens.radius.lg,
              background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(8px)',
              fontWeight: 700, fontSize: 15, letterSpacing: '0.3px',
            }}>
              {isZh ? '立即探索' : 'Browse Now'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </div>
          </div>
        </Link>
      ) : (
        /* Book grid */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16 }}>
          {books.map(book => (
            <Link
              key={book.id}
              href={`/library/${book.id}`}
              style={{
                textDecoration: 'none',
                transition: `transform ${tokens.transition.base}`,
                display: 'block',
              }}
            >
              {/* Cover */}
              <div style={{
                aspectRatio: '2/3', borderRadius: tokens.radius.lg,
                overflow: 'hidden', boxShadow: tokens.shadow.md, marginBottom: 8,
              }}>
                <BookCover
                  title={book.title}
                  author={book.author}
                  category={book.category}
                  coverUrl={book.cover_url}
                  fontSize="sm"
                />
              </div>

              {/* Status badge */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                <span style={{
                  fontSize: 10, padding: '1px 7px', borderRadius: tokens.radius.full,
                  background: book.status === 'read' ? tokens.colors.accent.brandMuted : tokens.colors.accent.brandMuted,
                  color: book.status === 'read' ? tokens.colors.accent.success : tokens.colors.accent.brand,
                  fontWeight: 600,
                }}>
                  {book.status === 'read' ? (isZh ? '已读' : 'Read') : (isZh ? '想读' : 'Want to Read')}
                </span>
              </div>

              <h3 style={{
                fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary,
                lineHeight: 1.3, margin: '0 0 2px',
                overflow: 'hidden', textOverflow: 'ellipsis',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
              }}>
                {book.title}
              </h3>
              {book.author && (
                <p style={{ fontSize: 11, color: tokens.colors.text.secondary, margin: '0 0 4px' }}>
                  {book.author.length > 30 ? book.author.slice(0, 30) + '...' : book.author}
                </p>
              )}
              {book.rating != null && book.rating > 0 && (
                <StarRating rating={book.rating} ratingCount={book.rating_count || 0} size={13} readonly />
              )}
            </Link>
          ))}

          {/* Browse more link */}
          <Link href="/library" style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            aspectRatio: '2/3', borderRadius: tokens.radius.lg,
            border: `2px dashed ${tokens.colors.border.primary}`,
            textDecoration: 'none', color: tokens.colors.text.secondary,
            transition: `all ${tokens.transition.fast}`,
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 500, marginTop: 8 }}>
              {isZh ? '去书城' : 'Browse'}
            </span>
          </Link>
        </div>
      )}
    </div>
  )
}
