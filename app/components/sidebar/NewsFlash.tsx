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
  category?: 'crypto' | 'macro' | 'defi' | 'regulation' | 'market' | 'btc_eth' | 'altcoin' | 'exchange'
  importance?: 'breaking' | 'important' | 'normal'
}

const IMPORTANCE_CONFIG: Record<string, { color: string; label: string; label_en: string }> = {
  breaking: { color: newsImportance.breaking.color, label: '突发', label_en: 'Breaking' },
  important: { color: newsImportance.important.color, label: '重要', label_en: 'Important' },
}

const CATEGORY_CONFIG: Record<string, { color: string; label: string; label_en: string }> = {
  btc_eth: { color: newsCategories.btcEth.color, label: 'BTC/ETH', label_en: 'BTC/ETH' },
  altcoin: { color: newsCategories.market.color, label: '山寨币', label_en: 'Altcoins' },
  defi: { color: newsCategories.defi.color, label: 'DeFi', label_en: 'DeFi' },
  macro: { color: newsCategories.macro.color, label: '宏观/监管', label_en: 'Macro/Regulation' },
  exchange: { color: newsCategories.exchange.color, label: '交易所', label_en: 'Exchanges' },
  // Legacy mappings for old data
  crypto: { color: newsCategories.btcEth.color, label: 'BTC/ETH', label_en: 'BTC/ETH' },
  regulation: { color: newsCategories.regulation.color, label: '宏观/监管', label_en: 'Macro/Regulation' },
  market: { color: newsCategories.market.color, label: '山寨币', label_en: 'Altcoins' },
}

const fetcher = async (url: string) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export default function NewsFlash() {
  const { language, t } = useLanguage()
  const isZh = language === 'zh'

  const { data, error, isLoading } = useSWR(
    '/api/flash-news?limit=5&sort=published_at',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
      refreshInterval: 120000, // Refresh every 2 minutes
      errorRetryCount: 2,
    }
  )

  const rawNews: NewsItem[] = data?.data?.news || data?.news || []
  // 去重：按标题去重（防止重复抓取的新闻）
  const news = rawNews.filter((item, idx, arr) => {
    const title = item.title_zh || item.title_en || item.title
    return arr.findIndex(n => (n.title_zh || n.title_en || n.title) === title) === idx
  })
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
    <SidebarCard title={t('sidebarNewsFlash')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {loading ? (
          [1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 52, marginBottom: 4, borderRadius: tokens.radius.md }} />
          ))
        ) : error ? (
          <p style={{ fontSize: 13, color: tokens.colors.text.tertiary, textAlign: 'center', padding: '12px 0' }}>
            {t('sidebarLoadFailed')}
          </p>
        ) : news.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.colors.text.tertiary, textAlign: 'center', padding: '12px 0' }}>
            {t('sidebarNoNews')}
          </p>
        ) : (
          news.map((item, idx) => {
            const impConfig = item.importance && item.importance !== 'normal' ? IMPORTANCE_CONFIG[item.importance] : null
            const catConfig = item.category ? CATEGORY_CONFIG[item.category] : null

            return (
              <div
                key={item.id}
                style={{
                  padding: '10px 6px',
                  borderBottom: idx < news.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                }}
              >
                <div style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  {impConfig && (
                    <span style={{
                      fontSize: 12, fontWeight: 700, color: tokens.colors.white,
                      background: impConfig.color, padding: '1px 6px',
                      borderRadius: tokens.radius.sm, lineHeight: '16px',
                    }}>
                      {isZh ? impConfig.label : impConfig.label_en}
                    </span>
                  )}
                  {catConfig && (
                    <span style={{
                      fontSize: 12, fontWeight: 600, color: catConfig.color,
                      background: `${catConfig.color}15`, padding: '1px 6px',
                      borderRadius: tokens.radius.sm, lineHeight: '16px',
                    }}>
                      {isZh ? catConfig.label : catConfig.label_en}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.4, marginBottom: 4, userSelect: 'text' }}>
                  {getTitle(item)}
                  {(() => {
                    const badge = getLangBadge(item)
                    if (!badge) return null
                    return (
                      <span style={{
                        fontSize: 9, fontWeight: 700, color: tokens.colors.text.tertiary,
                        background: 'var(--glass-bg-medium)', padding: '1px 4px',
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
      <Link prefetch={false}
        href="/flash-news"
        style={{
          display: 'block', textAlign: 'center', marginTop: tokens.spacing[2],
          fontSize: 12, color: tokens.colors.accent.primary, textDecoration: 'none',
          padding: `${tokens.spacing[1]} 0`,
        }}
      >
        {t('viewAll')}
      </Link>
    </SidebarCard>
  )
}
