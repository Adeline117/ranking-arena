'use client'

import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import StarRating from '@/app/components/ui/StarRating'

const BookDetailModal = lazy(() => import('./BookDetailModal'))

type LibraryItem = {
  id: string
  title: string
  author: string | null
  description: string | null
  publisher: string | null
  category: string
  subcategory: string | null
  publish_date: string | null
  isbn: string | null
  page_count: number | null
  source_url: string | null
  pdf_url: string | null
  cover_url: string | null
  tags: string[] | null
  crypto_symbols: string[] | null
  rating: number | null
  rating_count: number | null
  view_count: number
  is_free: boolean
  buy_url: string | null
  language: string | null
  language_group_id: string | null
}

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

  const categoryEmoji = (cat: string) => {
    if (cat === 'whitepaper') return '📄'
    if (cat === 'book') return '📖'
    if (cat === 'paper') return '📝'
    return '📊'
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <p style={{ color: tokens.colors.text.secondary, fontSize: 13 }}>
          {isZh ? `${total.toLocaleString()} 篇白皮书、研报、书籍与论文` : `${total.toLocaleString()} whitepapers, research reports, books & papers`}
        </p>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={isZh ? '搜索标题、作者...' : 'Search titles, authors...'}
          style={{
            width: '100%', maxWidth: 400, padding: '8px 12px',
            borderRadius: 8, border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary, color: tokens.colors.text.primary,
            fontSize: 13, outline: 'none',
          }}
        />
      </div>

      {/* Category pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        {CATEGORIES.map(cat => (
          <button
            key={cat.key}
            onClick={() => setCategory(cat.key)}
            style={{
              padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500,
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

      {/* Language filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {([
          { key: 'all' as const, label: isZh ? '全部语言' : 'All Languages' },
          { key: 'zh' as const, label: '🇨🇳 中文' },
          { key: 'en' as const, label: '🇺🇸 English' },
        ]).map(opt => (
          <button
            key={opt.key}
            onClick={() => setLangFilter(opt.key)}
            style={{
              padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500,
              border: langFilter === opt.key ? 'none' : `1px solid ${tokens.colors.border.primary}`,
              background: langFilter === opt.key ? tokens.colors.accent.brand : 'transparent',
              color: langFilter === opt.key ? '#fff' : tokens.colors.text.secondary,
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 260, borderRadius: 12 }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: tokens.colors.text.secondary }}>
          {isZh ? '暂无内容' : 'No items found'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {items.map(item => (
            <div
              key={item.id}
              onClick={() => setSelectedBook(item)}
              style={{
                borderRadius: 12, overflow: 'hidden',
                background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
                transition: 'transform 0.2s', cursor: 'pointer',
                display: 'flex', flexDirection: 'column',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
            >
              {/* Cover */}
              <div style={{
                height: 130, background: `linear-gradient(135deg, ${tokens.colors.accent.brand}22, ${tokens.colors.accent.brand}44)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
              }}>
                {item.cover_url ? (
                  <img src={item.cover_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: 36 }}>{categoryEmoji(item.category)}</span>
                )}
              </div>

              {/* Info */}
              <div style={{ padding: '10px 12px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{
                    fontSize: 10, padding: '1px 7px', borderRadius: 10,
                    background: tokens.colors.accent.brand + '22', color: tokens.colors.accent.brand,
                    fontWeight: 600, textTransform: 'uppercase',
                  }}>
                    {item.category}
                  </span>
                  {item.language && (
                    <span style={{
                      fontSize: 10, padding: '1px 7px', borderRadius: 10,
                      background: 'rgba(255,255,255,0.08)', color: tokens.colors.text.secondary,
                      fontWeight: 500,
                    }}>
                      {item.language === 'zh' ? '🇨🇳' : item.language === 'en' ? '🇺🇸' : item.language}
                    </span>
                  )}
                  {item.language_group_id && (
                    <span style={{
                      fontSize: 10, padding: '1px 7px', borderRadius: 10,
                      background: 'rgba(59,130,246,0.15)', color: '#60a5fa',
                      fontWeight: 500,
                    }}>
                      {isZh ? '多语言' : 'Multi-lang'}
                    </span>
                  )}
                </div>
                <h3 style={{
                  fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary,
                  lineHeight: 1.3, marginBottom: 4,
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
                }}>
                  {item.title}
                </h3>
                {item.author && (
                  <p style={{ fontSize: 11, color: tokens.colors.text.secondary, marginBottom: 6 }}>
                    {item.author.length > 40 ? item.author.slice(0, 40) + '...' : item.author}
                  </p>
                )}
                <div style={{ marginTop: 'auto' }}>
                  <StarRating
                    rating={item.rating || 0}
                    ratingCount={item.rating_count || 0}
                    size={14}
                    readonly
                  />
                </div>
              </div>
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
