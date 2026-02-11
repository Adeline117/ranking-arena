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
import dynamic from 'next/dynamic'
import { logger } from '@/lib/logger'

const MobileBottomNav = dynamic(() => import('@/app/components/layout/MobileBottomNav'), { ssr: false })

const CATEGORIES = [
  { key: 'all', en: 'All', zh: '全部' },
  { key: 'paper', en: 'Papers', zh: '论文' },
  { key: 'book', en: 'Books', zh: '书籍' },
  { key: 'whitepaper', en: 'Whitepapers', zh: '白皮书' },
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
}

export default function ResourcesClient({ initialItems, initialFeatured, initialTotal }: ResourcesClientProps) {
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

        {/* Search */}
        <div style={{ position: 'relative', maxWidth: 560, marginBottom: 24 }}>
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="var(--color-text-tertiary)" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
          >
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={e => handleSearchInput(e.target.value)}
            placeholder={isZh ? '搜索书名、作者或关键词...' : 'Search by title, author, or keyword...'}
            style={{
              width: '100%',
              padding: '12px 40px 12px 44px',
              borderRadius: tokens.radius.lg,
              border: `1px solid var(--color-border-primary)`,
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              outline: 'none',
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
                  borderRadius: tokens.radius.lg,
                  fontSize: 14,
                  fontWeight: active ? 700 : 500,
                  border: active ? 'none' : '1px solid var(--color-border-primary)',
                  background: active ? tokens.gradient.purpleGold : 'var(--color-bg-secondary)',
                  color: active ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
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
              padding: '8px 14px',
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-primary)',
              fontSize: 13,
              cursor: 'pointer',
              outline: 'none',
              marginLeft: 'auto',
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
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 20 }}>
              {isZh ? '精选推荐' : 'Featured'}
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(160px, 45%), 1fr))', gap: 20 }}>
              {featured.slice(0, 6).map(item => (
                <Link key={item.id} href={`/library/${item.id}`} style={{ textDecoration: 'none' }}>
                  <div>
                    <div style={{ width: '100%', aspectRatio: '2/3', borderRadius: tokens.radius.lg, overflow: 'hidden', marginBottom: 12, boxShadow: '0 8px 24px var(--color-overlay-medium)' }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 24 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="skeleton" style={{ aspectRatio: '2/3', borderRadius: tokens.radius.lg }} />
                <div className="skeleton" style={{ height: 14, width: '80%', borderRadius: 6 }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
              {isZh ? '暂无内容' : 'No items found'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
              {search ? (isZh ? '换个关键词试试' : 'Try different keywords') : (isZh ? '试试其他分类' : 'Try a different category')}
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 24 }}>
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
              style={{ padding: '8px 14px', borderRadius: tokens.radius.lg, border: '1px solid var(--color-border-primary)', background: 'transparent', color: 'var(--color-text-primary)', cursor: page <= 1 ? 'default' : 'pointer', opacity: page <= 1 ? 0.35 : 1, fontSize: 13 }}
            >
              {isZh ? '上一页' : 'Prev'}
            </button>
            <span style={{ padding: '8px 14px', fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {page} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              style={{ padding: '8px 14px', borderRadius: tokens.radius.lg, border: '1px solid var(--color-border-primary)', background: 'transparent', color: 'var(--color-text-primary)', cursor: page >= totalPages ? 'default' : 'pointer', opacity: page >= totalPages ? 0.35 : 1, fontSize: 13 }}
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
