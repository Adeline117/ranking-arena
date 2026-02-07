'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

type LibraryItem = {
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
  crypto_symbols: string[] | null
  publish_date: string | null
  view_count: number
  download_count: number
  is_free: boolean
  buy_url: string | null
}

const CATEGORIES = [
  { key: 'all', en: 'All', zh: '全部' },
  { key: 'whitepaper', en: 'Whitepapers', zh: '白皮书' },
  { key: 'research', en: 'Research', zh: '研报' },
  { key: 'book', en: 'Books', zh: '书籍' },
  { key: 'paper', en: 'Papers', zh: '论文' },
]

export default function LibraryPage() {
  const { language } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [items, setItems] = useState<LibraryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(searchParams.get('search') || '')
  const [category, setCategory] = useState(searchParams.get('category') || 'all')
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1'))

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (category !== 'all') params.set('category', category)
      if (search) params.set('search', search)
      params.set('page', String(page))
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
  }, [category, search, page])

  useEffect(() => { fetchItems() }, [fetchItems])

  const isZh = language === 'zh'

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '80px 16px 100px' }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 4 }}>
            {isZh ? '📚 加密研究库' : '📚 Crypto Library'}
          </h1>
          <p style={{ color: tokens.colors.text.secondary, fontSize: 14 }}>
            {isZh ? `${total.toLocaleString()} 篇白皮书、研报、书籍与论文` : `${total.toLocaleString()} whitepapers, research reports, books & papers`}
          </p>
        </div>

        {/* Search */}
        <div style={{ marginBottom: 16 }}>
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder={isZh ? '搜索标题、作者、描述...' : 'Search titles, authors, descriptions...'}
            style={{
              width: '100%', maxWidth: 500, padding: '10px 14px',
              borderRadius: 8, border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary, color: tokens.colors.text.primary,
              fontSize: 14, outline: 'none',
            }}
          />
        </div>

        {/* Category Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
          {CATEGORIES.map(cat => (
            <button
              key={cat.key}
              onClick={() => { setCategory(cat.key); setPage(1) }}
              style={{
                padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 500,
                border: category === cat.key ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                background: category === cat.key ? tokens.colors.accent.brand : 'transparent',
                color: category === cat.key ? '#fff' : tokens.colors.text.secondary,
                cursor: 'pointer', transition: 'all 0.2s',
              }}
            >
              {isZh ? cat.zh : cat.en}
            </button>
          ))}
        </div>

        {/* Grid */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{
                height: 280, borderRadius: 12, background: tokens.colors.bg.secondary,
                animation: 'pulse 1.5s ease-in-out infinite',
              }} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 60, color: tokens.colors.text.secondary }}>
            {isZh ? '暂无内容，请先运行收集脚本' : 'No items yet. Run collection scripts first.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {items.map(item => (
              <a
                key={item.id}
                href={`/library/${item.id}`}
                style={{
                  borderRadius: 12, overflow: 'hidden', textDecoration: 'none',
                  background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
                  transition: 'transform 0.2s, box-shadow 0.2s', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
              >
                {/* Cover */}
                <div style={{
                  height: 140, background: `linear-gradient(135deg, ${tokens.colors.accent.brand}22, ${tokens.colors.accent.brand}44)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                }}>
                  {item.cover_url ? (
                    <img src={item.cover_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: 40 }}>
                      {item.category === 'whitepaper' ? '📄' : item.category === 'book' ? '📖' : item.category === 'paper' ? '📝' : '📊'}
                    </span>
                  )}
                </div>

                {/* Info */}
                <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{
                      fontSize: 10, padding: '2px 8px', borderRadius: 10,
                      background: tokens.colors.accent.brand + '22', color: tokens.colors.accent.brand,
                      fontWeight: 600, textTransform: 'uppercase',
                    }}>
                      {item.category}
                    </span>
                    {!item.is_free && (
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#f59e0b22', color: '#f59e0b', fontWeight: 600 }}>
                        💰 Paid
                      </span>
                    )}
                  </div>
                  <h3 style={{
                    fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary,
                    lineHeight: 1.3, marginBottom: 4,
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
                  }}>
                    {item.title}
                  </h3>
                  {item.author && (
                    <p style={{ fontSize: 12, color: tokens.colors.text.secondary, marginBottom: 4 }}>
                      {item.author.length > 50 ? item.author.slice(0, 50) + '...' : item.author}
                    </p>
                  )}
                  <div style={{ marginTop: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                    {item.crypto_symbols?.slice(0, 3).map(s => (
                      <span key={s} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, background: tokens.colors.border.primary, color: tokens.colors.text.secondary }}>
                        {s}
                      </span>
                    ))}
                    {item.pdf_url && (
                      <span style={{ fontSize: 10, color: tokens.colors.accent.brand, marginLeft: 'auto' }}>PDF ↗</span>
                    )}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}

        {/* Pagination */}
        {total > 24 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 32 }}>
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent', color: tokens.colors.text.primary, cursor: page <= 1 ? 'default' : 'pointer',
                opacity: page <= 1 ? 0.4 : 1,
              }}
            >
              ← {isZh ? '上一页' : 'Prev'}
            </button>
            <span style={{ padding: '8px 12px', color: tokens.colors.text.secondary, fontSize: 14 }}>
              {page} / {Math.ceil(total / 24)}
            </span>
            <button
              disabled={page >= Math.ceil(total / 24)}
              onClick={() => setPage(p => p + 1)}
              style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent', color: tokens.colors.text.primary, cursor: 'pointer',
                opacity: page >= Math.ceil(total / 24) ? 0.4 : 1,
              }}
            >
              {isZh ? '下一页' : 'Next'} →
            </button>
          </div>
        )}
      </main>
      <MobileBottomNav />
    </div>
  )
}
