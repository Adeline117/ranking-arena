'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { tokens, newsCategories, newsImportance } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'
import { formatTimeAgo } from '@/lib/utils/date'

type NewsItem = {
  id: string
  title: string
  title_zh: string | null
  title_en: string | null
  source: string
  published_at: string
  category?: 'crypto' | 'macro' | 'defi' | 'regulation' | 'market'
  importance?: 'breaking' | 'important' | 'normal'
}

const IMPORTANCE_CONFIG: Record<string, { color: string; label: string; label_en: string }> = {
  breaking: { color: newsImportance.breaking.color, label: '突发', label_en: 'Breaking' },
  important: { color: newsImportance.important.color, label: '重要', label_en: 'Important' },
}

const CATEGORY_CONFIG: Record<string, { color: string; label: string; label_en: string }> = {
  crypto: { color: newsCategories.crypto.color, label: '加密货币', label_en: 'Crypto' },
  macro: { color: newsCategories.macro.color, label: '宏观经济', label_en: 'Macro' },
  defi: { color: newsCategories.defi.color, label: 'DeFi', label_en: 'DeFi' },
  regulation: { color: newsCategories.regulation.color, label: '监管政策', label_en: 'Regulation' },
  market: { color: newsCategories.market.color, label: '市场动态', label_en: 'Market' },
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

export default function NewsFlash() {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const { data, isLoading } = useSWR(
    '/api/flash-news?limit=5&sort=published_at',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
      refreshInterval: 120000, // Refresh every 2 minutes
    }
  )

  const news: NewsItem[] = data?.data?.news || data?.news || []
  const loading = isLoading

  const getTitle = (item: NewsItem) => {
    if (isZh) return item.title_zh || item.title
    return item.title_en || item.title
  }

  const getLangBadge = (item: NewsItem): string | null => {
    const title = getTitle(item)
    if (!title) return null
    const cjkChars = (title.match(/[\u4e00-\u9fff]/g) || []).length
    const latinChars = (title.match(/[a-zA-Z]/g) || []).length
    const total = cjkChars + latinChars
    if (total < 4) return null
    const cjkRatio = cjkChars / total
    if (isZh && cjkRatio < 0.3) return 'EN'
    if (!isZh && cjkRatio > 0.7) return '\u4E2D'
    return null
  }

  return (
    <SidebarCard title={isZh ? '快讯' : 'News Flash'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {loading ? (
          [1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 48, marginBottom: 4, borderRadius: 6 }} />
          ))
        ) : news.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.colors.text.tertiary, textAlign: 'center', padding: '12px 0' }}>
            {isZh ? '暂无快讯' : 'No news yet'}
          </p>
        ) : (
          news.map((item, idx) => {
            const impConfig = item.importance && item.importance !== 'normal' ? IMPORTANCE_CONFIG[item.importance] : null
            const catConfig = item.category ? CATEGORY_CONFIG[item.category] : null

            return (
              <div
                key={item.id}
                style={{
                  padding: '10px 4px',
                  borderBottom: idx < news.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                }}
              >
                <div style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  {impConfig && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: '#fff',
                      background: impConfig.color, padding: '1px 6px',
                      borderRadius: 4, lineHeight: '16px',
                    }}>
                      {isZh ? impConfig.label : impConfig.label_en}
                    </span>
                  )}
                  {catConfig && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: catConfig.color,
                      background: `${catConfig.color}15`, padding: '1px 6px',
                      borderRadius: 4, lineHeight: '16px',
                    }}>
                      {isZh ? catConfig.label : catConfig.label_en}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.4, marginBottom: 4 }}>
                  {getTitle(item)}
                  {(() => {
                    const badge = getLangBadge(item)
                    if (!badge) return null
                    return (
                      <span style={{
                        fontSize: 9, fontWeight: 700, color: tokens.colors.text.tertiary,
                        background: 'rgba(136,136,160,0.15)', padding: '1px 4px',
                        borderRadius: 3, marginLeft: 4, verticalAlign: 'middle',
                        lineHeight: '14px', display: 'inline-block',
                      }}>
                        {badge}
                      </span>
                    )
                  })()}
                </p>
                <div style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.text.secondary }}>
                  <span>{item.source}</span>
                  <span>{formatTimeAgo(item.published_at, language)}</span>
                </div>
              </div>
            )
          })
        )}
      </div>
      <Link
        href="/flash-news"
        style={{
          display: 'block', textAlign: 'center', marginTop: tokens.spacing[2],
          fontSize: 12, color: tokens.colors.accent.primary, textDecoration: 'none',
          padding: `${tokens.spacing[1]} 0`,
        }}
      >
        {isZh ? '查看全部' : 'View All'}
      </Link>
    </SidebarCard>
  )
}
