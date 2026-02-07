'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
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
}

export default function NewsFlash() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [news, setNews] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchNews() {
      try {
        const res = await fetch('/api/flash-news?limit=5&sort=published_at')
        if (!res.ok) return
        const json = await res.json()
        const newsData = json?.data?.news || json?.news || []
        setNews(newsData)
      } catch {
        // silent fail
      } finally {
        setLoading(false)
      }
    }
    fetchNews()
  }, [])

  const getTitle = (item: NewsItem) => {
    if (isZh) return item.title_zh || item.title
    return item.title_en || item.title
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
          news.map((item, idx) => (
            <div
              key={item.id}
              style={{
                padding: '10px 4px',
                borderBottom: idx < news.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
              }}
            >
              <p style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.4, marginBottom: 4 }}>
                {getTitle(item)}
              </p>
              <div style={{ display: 'flex', gap: 8, fontSize: 11, color: tokens.colors.text.secondary }}>
                <span>{item.source}</span>
                <span>{formatTimeAgo(item.published_at, language)}</span>
              </div>
            </div>
          ))
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
