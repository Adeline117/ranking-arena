'use client'

import React, { useState, useEffect, useCallback, useRef, memo } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { LibraryItem } from '@/lib/types/library'
import BookCard from './BookCard'
import BookCover from './BookCover'

const CATEGORIES = [
  { key: 'all', en: 'All', zh: '全部' },
  { key: 'book', en: 'Books', zh: '书籍' },
  { key: 'academic_paper', en: 'Academic Papers', zh: '学术论文' },
  { key: 'research', en: 'Research', zh: '研报' },
  { key: 'finance', en: 'Finance', zh: '金融' },
  { key: 'paper', en: 'Papers', zh: '论文' },
  { key: 'whitepaper', en: 'Whitepapers', zh: '白皮书' },
  { key: 'regulatory', en: 'Regulatory', zh: '监管' },
  { key: 'event', en: 'Events', zh: '事件' },
]

const SORT_OPTIONS = [
  { key: 'recent', en: 'Recently Added', zh: '最新添加' },
  { key: 'popular', en: 'Most Popular', zh: '最受欢迎' },
  { key: 'rating', en: 'Highest Rated', zh: '评分最高' },
  { key: 'date', en: 'Publish Date', zh: '出版日期' },
]

const PAGE_SIZE = 24

export default function LibraryPage() {
  const { language } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [items, setItems] = useState<LibraryItem[]>([])
  const [featured, setFeatured] = useState<LibraryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '')
  const [search, setSearch] = useState(searchParams.get('search') || '')
  const [category, setCategory] = useState(searchParams.get('category') || 'all')
  const [sort, setSort] = useState('recent')
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1'))
  const debounceRef = useRef<NodeJS.Timeout>(undefined)
  const categoryScrollRef = useRef<HTMLDivElement>(null)

  const isZh = language === 'zh'

  // Debounce search input
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 400)
    return () => clearTimeout(debounceRef.current)
  }, [searchInput])

  // Fetch featured books (top rated)
  useEffect(() => {
    fetch(`/api/library?sort=rating&limit=6&language=${language}`)
      .then(r => r.json())
      .then(data => setFeatured((data.items || []).filter((i: LibraryItem) => i.cover_url || i.rating)))
      .catch(console.error)
  }, [language])

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (category !== 'all') params.set('category', category)
      if (search) params.set('search', search)
      if (sort !== 'recent') params.set('sort', sort)
      params.set('page', String(page))
      params.set('limit', String(PAGE_SIZE))
      params.set('language', language)
      
      const res = await fetch(`/api/library?${params}`)
      const data = await res.json()
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (e) {
      console.error('Failed to fetch library:', e)
    } finally {
      setLoading(false)
    }
  }, [category, search, sort, page, language])

  useEffect(() => { fetchItems() }, [fetchItems])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '80px 16px 100px' }}>

        {/* ===== Hero Section ===== */}
        <div style={{
          marginBottom: 32,
          padding: '32px 28px',
          borderRadius: tokens.radius.xl,
          background: tokens.gradient.mesh + ', ' + tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Decorative accent */}
          <div style={{
            position: 'absolute', top: -60, right: -60,
            width: 200, height: 200, borderRadius: '50%',
            background: tokens.gradient.primarySubtle,
            filter: 'blur(60px)', pointerEvents: 'none',
          }} />

          <div style={{ position: 'relative', zIndex: 1 }}>
            <h1 style={{
              fontSize: tokens.typography.fontSize['3xl'],
              fontWeight: tokens.typography.fontWeight.bold,
              color: tokens.colors.text.primary,
              marginBottom: 6,
              lineHeight: tokens.typography.lineHeight.tight,
            }}>
              Crypto Library
            </h1>
            <p style={{
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.md,
              marginBottom: 24,
            }}>
              {isZh
                ? `${total.toLocaleString()} 篇白皮书、研报、书籍与论文`
                : `${total.toLocaleString()} whitepapers, research reports, books & papers`}
            </p>

            {/* Search Bar - prominent */}
            <div style={{ position: 'relative', maxWidth: 560 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder={isZh ? '搜索标题、作者、描述...' : 'Search titles, authors, descriptions...'}
                style={{
                  width: '100%',
                  padding: '12px 16px 12px 42px',
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  outline: 'none',
                  transition: `border-color ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`,
                }}
                onFocus={e => {
                  e.currentTarget.style.borderColor = tokens.colors.accent.brand
                  e.currentTarget.style.boxShadow = tokens.shadow.glow
                }}
                onBlur={e => {
                  e.currentTarget.style.borderColor = tokens.colors.border.primary
                  e.currentTarget.style.boxShadow = 'none'
                }}
              />
            </div>
          </div>
        </div>

        {/* ===== Featured Carousel (only when no search) ===== */}
        {!search && featured.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h2 style={{
              fontSize: tokens.typography.fontSize.lg,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: tokens.colors.text.primary,
              marginBottom: 14,
            }}>
              {isZh ? '精选推荐' : 'Featured'}
            </h2>
            <div style={{
              display: 'flex', gap: 16, overflowX: 'auto',
              paddingBottom: 8,
              scrollbarWidth: 'thin',
              scrollSnapType: 'x mandatory',
            }}>
              {featured.slice(0, 6).map(item => (
                <a
                  key={item.id}
                  href={`/library/${item.id}`}
                  style={{
                    flexShrink: 0, width: 150, textDecoration: 'none',
                    scrollSnapAlign: 'start',
                    transition: `transform ${tokens.transition.base}`,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.04)')}
                  onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
                >
                  <div style={{
                    width: 150, height: 225, borderRadius: tokens.radius.lg,
                    overflow: 'hidden',
                    boxShadow: tokens.shadow.lg,
                    marginBottom: 8,
                  }}>
                    <BookCover
                      title={item.title}
                      author={item.author}
                      category={item.category}
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
                </a>
              ))}
            </div>
          </div>
        )}

        {/* ===== Filters Row ===== */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20,
          flexWrap: 'wrap',
        }}>
          {/* Category pills - horizontally scrollable */}
          <div
            ref={categoryScrollRef}
            style={{
              display: 'flex', gap: 8, flex: 1,
              overflowX: 'auto', scrollbarWidth: 'none',
              paddingBottom: 2,
            }}
          >
            {CATEGORIES.map(cat => {
              const active = category === cat.key
              return (
                <button
                  key={cat.key}
                  onClick={() => { setCategory(cat.key); setPage(1) }}
                  style={{
                    padding: '7px 18px',
                    borderRadius: tokens.radius.full,
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: active ? tokens.typography.fontWeight.semibold : tokens.typography.fontWeight.medium,
                    border: active ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                    background: active ? tokens.gradient.purpleGold : 'transparent',
                    color: active ? '#fff' : tokens.colors.text.secondary,
                    cursor: 'pointer',
                    transition: `all ${tokens.transition.fast}`,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {isZh ? cat.zh : cat.en}
                </button>
              )
            })}
          </div>

          {/* Sort dropdown */}
          <select
            value={sort}
            onChange={e => { setSort(e.target.value); setPage(1) }}
            style={{
              padding: '7px 12px',
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              outline: 'none',
              flexShrink: 0,
            }}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.key} value={opt.key}>
                {isZh ? opt.zh : opt.en}
              </option>
            ))}
          </select>
        </div>

        {/* ===== Grid ===== */}
        {loading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 20,
          }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8, animationDelay: `${i * 50}ms` }}>
                <div className="skeleton" style={{ aspectRatio: '2/3' }} />
                <div className="skeleton" style={{ height: 14, width: '80%' }} />
                <div className="skeleton" style={{ height: 12, width: '50%' }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '80px 20px',
            color: tokens.colors.text.secondary,
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" style={{ marginBottom: 16, opacity: 0.5 }}>
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <p style={{ fontSize: tokens.typography.fontSize.md, fontWeight: 500 }}>
              {search
                ? (isZh ? `未找到与"${search}"相关的内容` : `No results for "${search}"`)
                : (isZh ? '该分类暂无内容' : 'No items in this category yet')}
            </p>
            <p style={{ fontSize: tokens.typography.fontSize.sm, marginTop: 6 }}>
              {search
                ? (isZh ? '试试其他关键词' : 'Try different keywords')
                : ''}
            </p>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 20,
          }}>
            {items.map(item => (
              <BookCard key={item.id} item={item} isZh={isZh} />
            ))}
          </div>
        )}

        {/* ===== Pagination ===== */}
        {totalPages > 1 && (
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            gap: 6, marginTop: 40,
          }}>
            <PaginationButton
              disabled={page <= 1}
              onClick={() => setPage(1)}
              label="<<"
            />
            <PaginationButton
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              label={isZh ? '< 上一页' : '< Prev'}
            />

            {/* Page numbers */}
            {getPageNumbers(page, totalPages).map((p, i) =>
              p === -1 ? (
                <span key={`ellipsis-${i}`} style={{ padding: '0 4px', color: tokens.colors.text.tertiary }}>...</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  style={{
                    width: 36, height: 36, borderRadius: tokens.radius.md,
                    border: p === page ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                    background: p === page ? tokens.gradient.purpleGold : 'transparent',
                    color: p === page ? '#fff' : tokens.colors.text.primary,
                    cursor: 'pointer', fontSize: 13, fontWeight: p === page ? 600 : 400,
                    transition: `all ${tokens.transition.fast}`,
                  }}
                >
                  {p}
                </button>
              )
            )}

            <PaginationButton
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              label={isZh ? '下一页 >' : 'Next >'}
            />
            <PaginationButton
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
              label=">>"
            />
          </div>
        )}

      </main>
      <MobileBottomNav />
    </div>
  )
}

function PaginationButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: 'transparent', color: tokens.colors.text.primary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        fontSize: 13, fontWeight: 500,
        transition: `all ${tokens.transition.fast}`,
      }}
    >
      {label}
    </button>
  )
}

function getPageNumbers(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: number[] = [1]
  if (current > 3) pages.push(-1)
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
    pages.push(i)
  }
  if (current < total - 2) pages.push(-1)
  pages.push(total)
  return pages
}
