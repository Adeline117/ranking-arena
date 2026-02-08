'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
import dynamic from 'next/dynamic'
const MobileBottomNav = dynamic(() => import('@/app/components/layout/MobileBottomNav'), { ssr: false })
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
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1'))
  const categoryScrollRef = useRef<HTMLDivElement>(null)
  const isInitialRender = useRef(true)

  const isZh = language === 'zh'

  // Fetch featured books when language changes (skip initial -- we have server data)
  useEffect(() => {
    if (isInitialRender.current) return
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
  }, [category, sort, page, language])

  // Fetch when filters change, but skip initial render (we have server data)
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false
      return
    }
    fetchItems()
  }, [fetchItems])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '80px 20px 100px' }}>

        {/* ===== Hero Section ===== */}
        <div style={{
          marginBottom: 40,
          padding: '40px 32px',
          borderRadius: 16,
          background: tokens.gradient.mesh + ', ' + tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: -80, right: -80,
            width: 240, height: 240, borderRadius: '50%',
            background: tokens.gradient.primarySubtle,
            filter: 'blur(80px)', pointerEvents: 'none',
          }} />
          <div style={{
            position: 'absolute', bottom: -60, left: -40,
            width: 180, height: 180, borderRadius: '50%',
            background: 'rgba(139, 111, 168, 0.08)',
            filter: 'blur(60px)', pointerEvents: 'none',
          }} />

          <div style={{ position: 'relative', zIndex: 1 }}>
            <h1 style={{
              fontSize: 28,
              fontWeight: 700,
              color: tokens.colors.text.primary,
              marginBottom: 8,
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
            }}>
              {isZh ? '加密书库' : 'Crypto Library'}
            </h1>
            <p style={{
              color: tokens.colors.text.secondary,
              fontSize: 15,
              lineHeight: 1.5,
              maxWidth: 480,
            }}>
              {isZh
                ? `收录 ${total.toLocaleString()} 篇白皮书、研报、书籍与论文`
                : `${total.toLocaleString()} whitepapers, research reports, books & papers`}
            </p>
          </div>
        </div>

        {/* ===== Featured Carousel ===== */}
        {featured.length > 0 && (
          <section style={{ marginBottom: 40 }}>
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 16,
            }}>
              <h2 style={{
                fontSize: 18,
                fontWeight: 600,
                color: tokens.colors.text.primary,
                letterSpacing: '-0.01em',
              }}>
                {isZh ? '精选推荐' : 'Featured'}
              </h2>
            </div>
            <div style={{
              display: 'flex', gap: 20, overflowX: 'auto',
              paddingBottom: 12,
              scrollbarWidth: 'thin',
              scrollSnapType: 'x mandatory',
            }}>
              {featured.slice(0, 6).map(item => (
                <a
                  key={item.id}
                  href={`/library/${item.id}`}
                  style={{
                    flexShrink: 0, width: 160, textDecoration: 'none',
                    scrollSnapAlign: 'start',
                    transition: 'transform 0.2s ease',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-4px)')}
                  onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
                >
                  <div style={{
                    width: 160, height: 240, borderRadius: 12,
                    overflow: 'hidden',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.15)',
                    marginBottom: 10,
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
                      margin: '3px 0 0', overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {item.author}
                    </p>
                  )}
                </a>
              ))}
            </div>
          </section>
        )}

        {/* ===== Filters Row ===== */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24,
          flexWrap: 'wrap',
        }}>
          <div
            ref={categoryScrollRef}
            role="tablist"
            aria-label={isZh ? '书城分类' : 'Library categories'}
            style={{
              display: 'flex', gap: 6, flex: 1,
              overflowX: 'auto', scrollbarWidth: 'none',
              paddingBottom: 2,
            }}
          >
            {CATEGORIES.map(cat => {
              const active = category === cat.key
              return (
                <button
                  key={cat.key}
                  role="tab"
                  aria-selected={active}
                  aria-label={isZh ? cat.zh : cat.en}
                  tabIndex={active ? 0 : -1}
                  onClick={() => { setCategory(cat.key); setPage(1) }}
                  onKeyDown={(e) => {
                    const cats = CATEGORIES
                    const idx = cats.findIndex(c => c.key === cat.key)
                    let nextIdx = -1
                    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % cats.length
                    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + cats.length) % cats.length
                    if (nextIdx >= 0) {
                      e.preventDefault()
                      setCategory(cats[nextIdx].key)
                      setPage(1)
                      const container = categoryScrollRef.current
                      if (container) {
                        const buttons = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                        buttons[nextIdx]?.focus()
                        buttons[nextIdx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
                      }
                    }
                  }}
                  style={{
                    padding: '8px 20px',
                    borderRadius: 999,
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    border: active ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                    background: active ? tokens.gradient.purpleGold : 'transparent',
                    color: active ? '#fff' : tokens.colors.text.secondary,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    lineHeight: '20px',
                  }}
                >
                  {isZh ? cat.zh : cat.en}
                </button>
              )
            })}
          </div>

          <select
            value={sort}
            onChange={e => { setSort(e.target.value); setPage(1) }}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: 13,
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
            gap: 24,
          }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10, animationDelay: `${i * 40}ms` }}>
                <div className="skeleton" style={{ aspectRatio: '2/3', borderRadius: 12 }} />
                <div className="skeleton" style={{ height: 14, width: '80%', borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 12, width: '50%', borderRadius: 6 }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: '80px 24px',
          }}>
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
            <p style={{
              fontSize: 16, fontWeight: 600,
              color: tokens.colors.text.primary, marginBottom: 6,
            }}>
              {isZh ? '该分类暂无内容' : 'No items in this category yet'}
            </p>
            <p style={{
              fontSize: 13, color: tokens.colors.text.tertiary,
            }}>
              {isZh ? '试试其他分类' : 'Try a different category'}
            </p>
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
            gap: 6, marginTop: 48,
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
                    width: 36, height: 36, borderRadius: 10,
                    border: p === page ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                    background: p === page ? tokens.gradient.purpleGold : 'transparent',
                    color: p === page ? '#fff' : tokens.colors.text.primary,
                    cursor: 'pointer', fontSize: 13, fontWeight: p === page ? 600 : 400,
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
    </div>
  )
}

function PaginationButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: 10,
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
