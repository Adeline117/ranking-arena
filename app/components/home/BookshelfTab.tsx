'use client'

import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import StarRating from '@/app/components/ui/StarRating'
import BookCover from '@/app/library/BookCover'
import type { LibraryItem } from '@/lib/types/library'

const BookDetailModal = lazy(() => import('./BookDetailModal'))

const CATEGORIES = [
  { key: 'all', en: 'All', zh: '全部' },
  { key: 'whitepaper', en: 'Whitepapers', zh: '白皮书' },
  { key: 'research', en: 'Research', zh: '研报' },
  { key: 'book', en: 'Books', zh: '书籍' },
  { key: 'paper', en: 'Papers', zh: '论文' },
]

export default function BookshelfTab() {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const [items, setItems] = useState<LibraryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [langFilter, setLangFilter] = useState<'all' | 'zh' | 'en'>('all')
  const [selectedBook, setSelectedBook] = useState<LibraryItem | null>(null)

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (category !== 'all') params.set('category', category)
      if (search) params.set('search', search)
      if (langFilter !== 'all') params.set('language', langFilter)
      params.set('limit', '24')
      const res = await fetch(`/api/library?${params}`)
      const data = await res.json()
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (e) {
      console.error('Failed to fetch library:', e)
    } finally {
      setLoading(false)
    }
  }, [category, search, langFilter])

  useEffect(() => { fetchItems() }, [fetchItems])

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <p style={{ color: tokens.colors.text.secondary, fontSize: 13, margin: 0 }}>
          {isZh ? `${total.toLocaleString()} 篇文献` : `${total.toLocaleString()} items`}
        </p>
        <Link href="/library" style={{
          fontSize: 13, color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 500,
        }}>
          {isZh ? '查看全部' : 'View All'}
        </Link>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={isZh ? '搜索标题、作者...' : 'Search titles, authors...'}
          style={{
            width: '100%', maxWidth: 400, padding: '8px 12px 8px 32px',
            borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary, color: tokens.colors.text.primary,
            fontSize: 13, outline: 'none',
          }}
        />
      </div>

      {/* Category pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 2 }}>
        {CATEGORIES.map(cat => {
          const active = category === cat.key
          return (
            <button
              key={cat.key}
              onClick={() => setCategory(cat.key)}
              style={{
                padding: '5px 14px', borderRadius: tokens.radius.full, fontSize: 12, fontWeight: active ? 600 : 500,
                border: active ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                background: active ? tokens.colors.accent.brand : 'transparent',
                color: active ? '#fff' : tokens.colors.text.secondary,
                cursor: 'pointer', transition: `all ${tokens.transition.fast}`,
                whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              {isZh ? cat.zh : cat.en}
            </button>
          )
        })}
      </div>

      {/* Language filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {([
          { key: 'all' as const, label: isZh ? '全部语言' : 'All Languages' },
          { key: 'zh' as const, label: isZh ? '中文' : 'Chinese' },
          { key: 'en' as const, label: 'English' },
        ]).map(opt => (
          <button
            key={opt.key}
            onClick={() => setLangFilter(opt.key)}
            style={{
              padding: '5px 14px', borderRadius: tokens.radius.full, fontSize: 12, fontWeight: langFilter === opt.key ? 600 : 500,
              border: langFilter === opt.key ? 'none' : `1px solid ${tokens.colors.border.primary}`,
              background: langFilter === opt.key ? tokens.colors.accent.brand : 'transparent',
              color: langFilter === opt.key ? '#fff' : tokens.colors.text.secondary,
              cursor: 'pointer', transition: `all ${tokens.transition.fast}`,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ aspectRatio: '2/3', borderRadius: tokens.radius.lg, background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ height: 12, borderRadius: 4, width: '75%', background: tokens.colors.bg.secondary, animation: 'pulse 1.5s ease-in-out infinite' }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: tokens.colors.text.secondary }}>
          {isZh ? '暂无内容' : 'No items found'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16 }}>
          {items.map(item => (
            <div
              key={item.id}
              onClick={() => setSelectedBook(item)}
              style={{
                cursor: 'pointer',
                transition: `transform ${tokens.transition.base}`,
              }}
              onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-4px)')}
              onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
            >
              {/* Cover */}
              <div style={{
                aspectRatio: '2/3', borderRadius: tokens.radius.lg,
                overflow: 'hidden', boxShadow: tokens.shadow.md, marginBottom: 8,
              }}>
                <BookCover
                  title={item.title}
                  author={item.author}
                  category={item.category}
                  coverUrl={item.cover_url}
                  fontSize="sm"
                />
              </div>

              {/* Info */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                <span style={{
                  fontSize: 10, padding: '1px 7px', borderRadius: tokens.radius.full,
                  background: tokens.colors.accent.brandMuted, color: tokens.colors.accent.brand,
                  fontWeight: 600, textTransform: 'uppercase',
                }}>
                  {item.category}
                </span>
              </div>
              <h3 style={{
                fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary,
                lineHeight: 1.3, margin: '0 0 2px',
                overflow: 'hidden', textOverflow: 'ellipsis',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
              }}>
                {item.title}
              </h3>
              {item.author && (
                <p style={{ fontSize: 11, color: tokens.colors.text.secondary, margin: '0 0 4px' }}>
                  {item.author.length > 30 ? item.author.slice(0, 30) + '...' : item.author}
                </p>
              )}
              <StarRating rating={item.rating || 0} ratingCount={item.rating_count || 0} size={13} readonly />
            </div>
          ))}
        </div>
      )}

      {/* Book detail modal */}
      {selectedBook && (
        <Suspense fallback={null}>
          <BookDetailModal item={selectedBook} onClose={() => setSelectedBook(null)} />
        </Suspense>
      )}
    </div>
  )
}
