'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { LibraryItem } from '@/lib/types/library'
import BookCard from '@/app/library/BookCard'
import BookCover from '@/app/library/BookCover'
import StarRating from '@/app/components/ui/StarRating'
import TopLeaderboards from '@/app/components/ui/TopLeaderboards'
import dynamic from 'next/dynamic'
import { logger } from '@/lib/logger'

const MobileBottomNav = dynamic(() => import('@/app/components/layout/MobileBottomNav'), { ssr: false })

const CATEGORIES = [
  { key: 'all', en: 'All', zh: '全部' },
  { key: 'paper', en: 'Papers', zh: '论文' },
  { key: 'book', en: 'Books', zh: '书籍' },
  { key: 'whitepaper', en: 'Whitepapers', zh: '白皮书' },
  { key: 'research', en: 'Research', zh: '研报' },
  { key: 'academic_paper', en: 'Academic', zh: '学术论文' },
]

const SORT_OPTIONS = [
  { key: 'recent', en: 'Recently Added', zh: '最新添加' },
  { key: 'popular', en: 'Most Popular', zh: '最受欢迎' },
  { key: 'rating', en: 'Highest Rated', zh: '评分最高' },
]

const PAGE_SIZE = 24

interface ResourcesClientProps {
  initialItems: LibraryItem[]
  initialFeatured: LibraryItem[]
  initialTotal: number
  topBooks: LibraryItem[]
  topPapers: LibraryItem[]
  recentItems: LibraryItem[]
}

const BookIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
)

const PaperIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
  </svg>
)

function libItemToEntry(item: LibraryItem) {
  return {
    id: item.id,
    name: item.title,
    rating: item.rating ?? null,
    logoUrl: item.cover_url,
    href: `/library/${item.id}`,
  }
}

export default function ResourcesClient({ initialItems, initialFeatured, initialTotal, topBooks, topPapers, recentItems }: ResourcesClientProps) {
  const { language } = useLanguage()
  const searchParams = useSearchParams()

  const [items, setItems] = useState<LibraryItem[]>(initialItems)
  const [featured] = useState<LibraryItem[]>(initialFeatured)
  const [total, setTotal] = useState(initialTotal)
  const [loading, setLoading] = useState(false)
  const [category, setCategory] = useState(searchParams.get('category') || 'all')
  const [sort, setSort] = useState('recent')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(1)
  const isInitialRender = useRef(true)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isZh = language === 'zh'

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (category !== 'all') params.set('category', category)
      if (sort !== 'recent') params.set('sort', sort)
      if (search) params.set('search', search)
      params.set('page', String(page))
      params.set('limit', String(PAGE_SIZE))
      params.set('language', language)

      const res = await fetch(`/api/library?${params}`)
      const data = await res.json()
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (e) {
      logger.error('Failed to fetch resources:', e)
    } finally {
      setLoading(false)
    }
  }, [category, sort, search, page, language])

  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false
      return
    }
    fetchItems()
  }, [fetchItems])

  const handleSearchInput = useCallback((value: string) => {
    setSearchInput(value)
    clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(() => {
      setSearch(value.trim())
      setPage(1)
    }, 400)
  }, [])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 100px' }}>

        {/* Top Leaderboards */}
        <TopLeaderboards columns={[
          {
            title: isZh ? '热门书籍 Top 10' : 'Top 10 Books',
            icon: <BookIcon />,
            entries: topBooks.map(libItemToEntry),
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
          {
            title: isZh ? '热门论文 Top 10' : 'Top 10 Papers',
            icon: <PaperIcon />,
            entries: topPapers.map(libItemToEntry),
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
          {
            title: isZh ? '热门白皮书 Top 10' : 'Top 10 Whitepapers',
            icon: <PaperIcon />,
            entries: recentItems.map(libItemToEntry),
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
        ]} />

        {/* Section separator */}
        <div style={{ height: 1, background: 'linear-gradient(90deg, transparent, var(--color-border-primary), transparent)', margin: '8px 0 32px' }} />

        {/* Search */}
        <div style={{ position: 'relative', maxWidth: 560, marginBottom: 24 }}>
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="var(--color-text-tertiary)" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', transition: `color ${tokens.transition.fast}` }}
          >
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={e => handleSearchInput(e.target.value)}
            placeholder={isZh ? '搜索书名、作者或关键词...' : 'Search by title, author, or keyword...'}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-accent-primary)'; e.currentTarget.style.boxShadow = `0 0 0 ${tokens.focusRing.width} ${tokens.focusRing.color}` }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--color-border-secondary)'; e.currentTarget.style.boxShadow = 'none' }}
            style={{
              width: '100%',
              padding: '12px 40px 12px 44px',
              borderRadius: tokens.radius.lg,
              border: `1px solid var(--color-border-secondary)`,
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              outline: 'none',
              transition: `border-color ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`,
            }}
          />
          {searchInput && (
            <button
              onClick={() => { setSearchInput(''); setSearch(''); setPage(1) }}
              style={{
                position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--color-text-tertiary)', padding: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Category + Sort */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          {CATEGORIES.map(cat => {
            const active = category === cat.key
            return (
              <button
                key={cat.key}
                onClick={() => { setCategory(cat.key); setPage(1) }}
                style={{
                  padding: '8px 18px',
                  borderRadius: tokens.radius.full,
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  letterSpacing: active ? '0.01em' : undefined,
                  border: active ? '1px solid transparent' : '1px solid var(--color-border-secondary)',
                  background: active ? tokens.gradient.purpleGold : 'var(--color-bg-secondary)',
                  color: active ? '#fff' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  boxShadow: active ? '0 2px 8px rgba(139, 92, 246, 0.3)' : 'none',
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {isZh ? cat.zh : cat.en}
              </button>
            )
          })}
          <select
            value={sort}
            onChange={e => { setSort(e.target.value); setPage(1) }}
            style={{
              padding: '8px 28px 8px 14px',
              borderRadius: tokens.radius.full,
              border: '1px solid var(--color-border-secondary)',
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-secondary)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              outline: 'none',
              marginLeft: 'auto',
              appearance: 'none' as const,
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%239CA3AF' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 10px center',
              transition: `border-color ${tokens.transition.fast}`,
            }}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.key} value={opt.key}>{isZh ? opt.zh : opt.en}</option>
            ))}
          </select>
        </div>

        {/* Featured */}
        {featured.length > 0 && !search && category === 'all' && (
          <section style={{ marginBottom: 40 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 20, letterSpacing: '-0.01em' }}>
              {isZh ? '精选推荐' : 'Featured'}
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(160px, 45%), 1fr))', gap: 20 }}>
              {featured.slice(0, 6).map(item => (
                <Link key={item.id} href={`/library/${item.id}`} style={{ textDecoration: 'none' }}>
                  <div>
                    <div style={{ width: '100%', aspectRatio: '2/3', borderRadius: tokens.radius.lg, overflow: 'hidden', marginBottom: 12, boxShadow: tokens.shadow.md, transition: `transform ${tokens.transition.base}, box-shadow ${tokens.transition.base}` }}>
                      <BookCover title={item.title} author={item.author} category={item.category} coverUrl={item.cover_url} fontSize="sm" />
                    </div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.35, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
                      {item.title}
                    </p>
                    {item.author && <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: '4px 0 0' }}>{item.author}</p>}
                    {(item.rating != null && item.rating > 0) && (
                      <div style={{ marginTop: 4 }}>
                        <StarRating rating={item.rating} ratingCount={item.rating_count || 0} size={12} readonly />
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Results count */}
        {(search || category !== 'all') && (
          <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
            {isZh ? `${total.toLocaleString()} 个结果` : `${total.toLocaleString()} results`}
          </p>
        )}

        {/* Grid */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(180px, 45%), 1fr))', gap: 20 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="skeleton" style={{ aspectRatio: '2/3', borderRadius: tokens.radius.lg }} />
                <div className="skeleton" style={{ height: 14, width: '80%', borderRadius: 6 }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px', borderRadius: tokens.radius.xl, background: 'var(--color-bg-secondary)', border: '1px dashed var(--color-border-secondary)' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round" style={{ marginBottom: 16, opacity: 0.5 }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
              {isZh ? '暂无内容' : 'No items found'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)', margin: 0 }}>
              {search ? (isZh ? '换个关键词试试' : 'Try different keywords') : (isZh ? '试试其他分类' : 'Try a different category')}
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(180px, 45%), 1fr))', gap: 20 }}>
            {items.map((item, idx) => (
              <BookCard key={item.id} item={item} isZh={isZh} priority={idx < 6} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 48, flexWrap: 'wrap' }}>
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              style={{ padding: '8px 18px', borderRadius: tokens.radius.full, border: '1px solid var(--color-border-secondary)', background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', cursor: page <= 1 ? 'default' : 'pointer', opacity: page <= 1 ? 0.35 : 1, fontSize: 13, fontWeight: 500, transition: `all ${tokens.transition.fast}` }}
            >
              {isZh ? '上一页' : 'Prev'}
            </button>
            <span style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, color: 'var(--color-text-tertiary)' }}>
              {page} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              style={{ padding: '8px 18px', borderRadius: tokens.radius.full, border: '1px solid var(--color-border-secondary)', background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)', cursor: page >= totalPages ? 'default' : 'pointer', opacity: page >= totalPages ? 0.35 : 1, fontSize: 13, fontWeight: 500, transition: `all ${tokens.transition.fast}` }}
            >
              {isZh ? '下一页' : 'Next'}
            </button>
          </div>
        )}
      </main>
      <MobileBottomNav />
    </div>
  )
}
