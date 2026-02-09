'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
import dynamic from 'next/dynamic'
const MobileBottomNav = dynamic(() => import('@/app/components/layout/MobileBottomNav'), { ssr: false })
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { LibraryItem } from '@/lib/types/library'
import BookCard from './BookCard'
import BookCover from './BookCover'
import StarRating from '@/app/components/ui/StarRating'
import { logger } from '@/lib/logger'

const CATEGORIES = [
  { key: 'all', en: 'All', zh: '全部', icon: 'M4 6h16M4 12h16M4 18h16' },
  { key: 'book', en: 'Books', zh: '书籍', icon: 'M4 19.5A2.5 2.5 0 016.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z' },
  { key: 'paper', en: 'Papers', zh: '论文', icon: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8' },
  { key: 'finance', en: 'Finance', zh: '金融', icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6' },
  { key: 'whitepaper', en: 'Whitepapers', zh: '白皮书', icon: 'M9 12h6M9 16h6M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9l-7-7zM13 2v7h7' },
  { key: 'event', en: 'Events', zh: '事件', icon: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z' },
]

const SORT_OPTIONS = [
  { key: 'recent', en: 'Recently Added', zh: '最新添加' },
  { key: 'popular', en: 'Most Popular', zh: '最受欢迎' },
  { key: 'rating', en: 'Highest Rated', zh: '评分最高' },
  { key: 'date', en: 'Publish Date', zh: '出版日期' },
]

const PAGE_SIZE = 24

interface LibraryClientProps {
  initialItems: LibraryItem[]
  initialFeatured: LibraryItem[]
  initialTotal: number
}

export default function LibraryClient({ initialItems, initialFeatured, initialTotal }: LibraryClientProps) {
  const { language } = useLanguage()
  const searchParams = useSearchParams()

  const [items, setItems] = useState<LibraryItem[]>(initialItems)
  const [featured, setFeatured] = useState<LibraryItem[]>(initialFeatured)
  const [total, setTotal] = useState(initialTotal)
  const [loading, setLoading] = useState(false)
  const [category, setCategory] = useState(searchParams.get('category') || 'all')
  const [sort, setSort] = useState('recent')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1'))
  const [searchFocused, setSearchFocused] = useState(false)
  const categoryScrollRef = useRef<HTMLDivElement>(null)
  const isInitialRender = useRef(true)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const isZh = language === 'zh'

  useEffect(() => {
    if (isInitialRender.current) return
    fetch(`/api/library?sort=rating&limit=6&language=${language}`)
      .then(r => r.json())
      .then(data => setFeatured((data.items || []).filter((i: LibraryItem) => i.cover_url || i.rating)))
      .catch((e) => logger.error('Unhandled error', e))
  }, [language])

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
      logger.error('Failed to fetch library:', e)
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
      <TopNav />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '80px 20px 100px' }}>

        {/* ===== Hero + Search ===== */}
        <div style={{
          marginBottom: 32,
          padding: '48px 32px 40px',
          borderRadius: tokens.radius['2xl'],
          background: tokens.gradient.mesh + ', ' + tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Decorative orbs */}
          <div style={{
            position: 'absolute', top: -100, right: -60,
            width: 280, height: 280, borderRadius: '50%',
            background: tokens.gradient.primarySubtle,
            filter: 'blur(80px)', pointerEvents: 'none',
          }} />
          <div style={{
            position: 'absolute', bottom: -80, left: -40,
            width: 200, height: 200, borderRadius: '50%',
            background: 'var(--color-accent-primary-08)',
            filter: 'blur(60px)', pointerEvents: 'none',
          }} />

          <div style={{ position: 'relative', zIndex: 1 }}>
            <h1 style={{
              fontSize: tokens.typography.fontSize['3xl'],
              fontWeight: tokens.typography.fontWeight.black,
              color: tokens.colors.text.primary,
              marginBottom: 8,
              lineHeight: 1.15,
              letterSpacing: '-0.03em',
            }}>
              {isZh ? 'Crypto Library' : 'Crypto Library'}
            </h1>
            <p style={{
              color: tokens.colors.text.secondary,
              fontSize: 16,
              lineHeight: 1.5,
              maxWidth: 500,
              marginBottom: 24,
            }}>
              {isZh
                ? `${total.toLocaleString()} 篇白皮书、研报、书籍与论文`
                : `${total.toLocaleString()} whitepapers, research reports, books & papers`}
            </p>

            {/* Search Bar - prominent */}
            <div style={{
              position: 'relative',
              maxWidth: 560,
              transition: 'transform 0.2s ease',
              transform: searchFocused ? 'scale(1.01)' : 'scale(1)',
            }}>
              <svg
                width="20" height="20" viewBox="0 0 24 24" fill="none"
                stroke={searchFocused ? tokens.colors.accent.brand : tokens.colors.text.tertiary}
                strokeWidth="2" strokeLinecap="round"
                style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', transition: 'stroke 0.2s' }}
              >
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={searchInput}
                onChange={e => handleSearchInput(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder={isZh ? '搜索书名、作者或关键词...' : 'Search by title, author, or keyword...'}
                style={{
                  width: '100%',
                  padding: '14px 44px 14px 48px',
                  borderRadius: tokens.radius.xl,
                  border: `2px solid ${searchFocused ? tokens.colors.accent.brand : tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: 15,
                  outline: 'none',
                  transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                  boxSizing: 'border-box',
                  boxShadow: searchFocused ? tokens.shadow.glow : 'none',
                }}
              />
              {searchInput && (
                <button
                  onClick={() => { setSearchInput(''); setSearch(''); setPage(1) }}
                  style={{
                    position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: tokens.colors.text.tertiary, padding: 4,
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ===== Category Navigation ===== */}
        <div style={{ marginBottom: 28 }}>
          <div
            ref={categoryScrollRef}
            role="tablist"
            aria-label={isZh ? '书城分类' : 'Library categories'}
            style={{
              display: 'flex', gap: 8,
              overflowX: 'auto',
              paddingBottom: 4,
              scrollbarWidth: 'none',
            }}
          >
            {CATEGORIES.map(cat => {
              const active = category === cat.key
              return (
                <button
                  key={cat.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => { setCategory(cat.key); setPage(1) }}
                  style={{
                    padding: '10px 20px',
                    borderRadius: tokens.radius.lg,
                    fontSize: 14,
                    fontWeight: active ? 600 : 500,
                    border: active ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                    background: active ? tokens.gradient.purpleGold : tokens.colors.bg.secondary,
                    color: active ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={cat.icon} />
                  </svg>
                  {isZh ? cat.zh : cat.en}
                </button>
              )
            })}

            {/* Sort dropdown */}
            <select
              value={sort}
              onChange={e => { setSort(e.target.value); setPage(1) }}
              style={{
                padding: '10px 16px',
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: 13,
                cursor: 'pointer',
                outline: 'none',
                flexShrink: 0,
                marginLeft: 'auto',
              }}
            >
              {SORT_OPTIONS.map(opt => (
                <option key={opt.key} value={opt.key}>
                  {isZh ? opt.zh : opt.en}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ===== Featured / Top Rated Section ===== */}
        {featured.length > 0 && !search && category === 'all' && (
          <section style={{ marginBottom: 40 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h2 style={{
                fontSize: 20,
                fontWeight: 700,
                color: tokens.colors.text.primary,
                letterSpacing: '-0.02em',
                margin: 0,
              }}>
                {isZh ? '精选推荐' : 'Featured'}
              </h2>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 20,
            }}>
              {featured.slice(0, 6).map(item => (
                <Link
                  key={item.id}
                  href={`/library/${item.id}`}
                  style={{ textDecoration: 'none', display: 'block' }}
                >
                  <div
                    className="card-hover"
                    style={{
                      transition: 'transform 0.25s ease, box-shadow 0.25s ease',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.transform = 'translateY(-6px)'
                      e.currentTarget.style.boxShadow = tokens.shadow.cardHover
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.transform = 'translateY(0)'
                      e.currentTarget.style.boxShadow = 'none'
                    }}
                  >
                    <div style={{
                      width: '100%', aspectRatio: '2/3', borderRadius: tokens.radius.lg,
                      overflow: 'hidden',
                      boxShadow: '0 8px 24px var(--color-overlay-medium), 0 2px 8px var(--color-overlay-light)',
                      marginBottom: 12,
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
                      fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary,
                      lineHeight: 1.35, margin: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                    }}>
                      {item.title}
                    </p>
                    {item.author && (
                      <p style={{
                        fontSize: 11, color: tokens.colors.text.tertiary,
                        margin: '4px 0 0', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {item.author}
                      </p>
                    )}
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

        {/* ===== New Arrivals Section ===== */}
        {!search && category === 'all' && items.length > 6 && (
          <section style={{ marginBottom: 40 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h2 style={{
                fontSize: 20,
                fontWeight: 700,
                color: tokens.colors.text.primary,
                letterSpacing: '-0.02em',
                margin: 0,
              }}>
                {isZh ? '最新上架' : 'New Arrivals'}
              </h2>
            </div>
            <div style={{
              display: 'flex', gap: 16, overflowX: 'auto',
              paddingBottom: 8,
              scrollbarWidth: 'none',
            }}>
              {items.slice(0, 8).map(item => (
                <Link
                  key={item.id}
                  href={`/library/${item.id}`}
                  style={{ textDecoration: 'none', flexShrink: 0, width: 140 }}
                >
                  <div style={{
                    width: 140, aspectRatio: '2/3', borderRadius: tokens.radius.lg,
                    overflow: 'hidden',
                    boxShadow: '0 4px 16px var(--color-overlay-light)',
                    marginBottom: 8,
                    transition: 'transform 0.2s ease',
                  }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.04)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                  >
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
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                  }}>
                    {item.title}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* ===== Results count ===== */}
        {(search || category !== 'all') && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <p style={{ fontSize: 14, color: tokens.colors.text.secondary, margin: 0 }}>
              {isZh
                ? `${total.toLocaleString()} 个结果`
                : `${total.toLocaleString()} results`}
            </p>
          </div>
        )}

        {/* ===== All Books heading (when on "all" tab without search) ===== */}
        {!search && category === 'all' && (
          <h2 style={{
            fontSize: 20, fontWeight: 700,
            color: tokens.colors.text.primary,
            letterSpacing: '-0.02em',
            marginBottom: 20, marginTop: 8,
          }}>
            {isZh ? '全部藏书' : 'All Books'}
          </h2>
        )}

        {/* ===== Grid ===== */}
        {loading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 24,
          }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10, animationDelay: `${i * 40}ms` }}>
                <div className="skeleton" style={{ aspectRatio: '2/3', borderRadius: tokens.radius.lg }} />
                <div className="skeleton" style={{ height: 14, width: '80%', borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 12, width: '50%', borderRadius: 6 }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: tokens.gradient.primarySubtle,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <p style={{ fontSize: 16, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 6 }}>
              {search
                ? (isZh ? '未找到匹配结果' : 'No matching results')
                : (isZh ? '该分类暂无内容' : 'No items in this category yet')}
            </p>
            <p style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
              {search
                ? (isZh ? '换个关键词试试' : 'Try different keywords')
                : (isZh ? '试试其他分类' : 'Try a different category')}
            </p>
          </div>
        ) : category === 'event' ? (
          <div style={{ position: 'relative', paddingLeft: 24 }}>
            <div style={{
              position: 'absolute', left: 8, top: 0, bottom: 0, width: 2,
              background: `linear-gradient(180deg, ${tokens.colors.accent.brand}, ${tokens.colors.border.primary})`,
            }} />
            {[...items].sort((a, b) => {
              const dateA = a.publish_date || a.created_at || ''
              const dateB = b.publish_date || b.created_at || ''
              return dateB.localeCompare(dateA)
            }).map((item) => (
              <Link key={item.id} href={`/library/${item.id}`} style={{ textDecoration: 'none', display: 'block' }}>
                <div style={{
                  position: 'relative', paddingLeft: 20, paddingBottom: 28,
                  transition: 'opacity 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <div style={{
                    position: 'absolute', left: -20, top: 4, width: 14, height: 14,
                    borderRadius: '50%', background: tokens.gradient.purpleGold,
                    border: `3px solid ${tokens.colors.bg.primary}`,
                    boxShadow: tokens.shadow.glow,
                  }} />
                  <div style={{
                    fontSize: 12, color: tokens.colors.text.tertiary, marginBottom: 6, fontWeight: 600,
                    letterSpacing: '0.02em',
                  }}>
                    {item.publish_date || item.created_at?.substring(0, 10) || ''}
                  </div>
                  <div style={{
                    fontSize: 16, fontWeight: 700, color: tokens.colors.text.primary,
                    marginBottom: 4, lineHeight: 1.4,
                  }}>
                    {isZh ? (item.title_zh || item.title) : (item.title_en || item.title)}
                  </div>
                  {item.author && (
                    <div style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
                      {item.author}
                    </div>
                  )}
                  {item.description && (
                    <div style={{
                      fontSize: 13, color: tokens.colors.text.secondary, marginTop: 6,
                      lineHeight: 1.5, maxHeight: 60, overflow: 'hidden',
                    }}>
                      {item.description.substring(0, 150)}{item.description.length > 150 ? '...' : ''}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 24,
          }}>
            {items.map((item, idx) => (
              <BookCard key={item.id} item={item} isZh={isZh} priority={idx < 6} />
            ))}
          </div>
        )}

        {/* ===== Pagination ===== */}
        {totalPages > 1 && (
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            gap: 6, marginTop: 48, flexWrap: 'wrap',
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

            {getPageNumbers(page, totalPages).map((p, i) =>
              p === -1 ? (
                <span key={`ellipsis-${i}`} style={{ padding: '0 4px', color: tokens.colors.text.tertiary }}>...</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  style={{
                    width: 38, height: 38, borderRadius: tokens.radius.lg,
                    border: p === page ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                    background: p === page ? tokens.gradient.purpleGold : 'transparent',
                    color: p === page ? 'var(--color-on-accent)' : tokens.colors.text.primary,
                    cursor: 'pointer', fontSize: 13, fontWeight: p === page ? 700 : 400,
                    transition: 'all 0.15s ease',
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

      <style>{`
        div::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  )
}

function PaginationButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: 'transparent', color: tokens.colors.text.primary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        fontSize: 13, fontWeight: 500,
        transition: 'all 0.15s ease',
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
