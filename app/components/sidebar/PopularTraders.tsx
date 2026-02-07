'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type Trader = {
  source: string
  source_trader_id: string
  handle: string | null
  followers: number | null
  roi: number | null
}

export default function PopularTraders() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [traders, setTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const { data } = await supabase
          .from('trader_sources')
          .select('source, source_trader_id, handle, followers, roi')
          .order('followers', { ascending: false })
          .limit(10)
        setTraders((data as Trader[]) || [])
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return (
    <SidebarCard title={isZh ? '热门交易员' : 'Popular Traders'}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton" style={{ height: 36, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {isZh ? '加载失败，请刷新重试' : 'Failed to load. Refresh to retry.'}
        </div>
      ) : traders.length === 0 ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {isZh ? '暂无数据' : 'No data available'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {traders.map((t, idx) => (
            <Link
              key={`${t.source}-${t.source_trader_id}`}
              href={`/trader/${t.source}/${t.source_trader_id}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 4px', textDecoration: 'none', borderRadius: tokens.radius.md,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{
                fontSize: 11, fontWeight: 700, minWidth: 16, textAlign: 'right',
                color: idx < 3 ? tokens.colors.accent.brand : tokens.colors.text.secondary,
              }}>
                {idx + 1}
              </span>
              <span style={{
                fontSize: 13, color: tokens.colors.text.primary, flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {t.handle || t.source_trader_id.slice(0, 8)}
              </span>
              {t.roi != null && (
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: t.roi >= 0 ? '#22c55e' : '#ef4444',
                }}>
                  {t.roi >= 0 ? '+' : ''}{t.roi.toFixed(1)}%
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </SidebarCard>
  )
}
