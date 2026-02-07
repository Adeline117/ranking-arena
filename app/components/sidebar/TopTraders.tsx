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
  roi: number | null
  win_rate: number | null
}

export default function TopTraders() {
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
          .select('source, source_trader_id, handle, roi, win_rate')
          .order('roi', { ascending: false })
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
    <SidebarCard title={`Top 10 ${isZh ? '交易员' : 'Traders'}`}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 40, borderRadius: tokens.radius.md }} />
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
                padding: '8px 6px', textDecoration: 'none', borderRadius: tokens.radius.md,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{
                fontSize: 14, fontWeight: 800, minWidth: 20, textAlign: 'right',
                color: idx === 0 ? '#ffd700' : idx === 1 ? '#c0c0c0' : idx === 2 ? '#cd7f32' : tokens.colors.text.secondary,
              }}>
                {idx + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {t.handle || t.source_trader_id.slice(0, 10)}
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: tokens.colors.text.secondary }}>
                  {t.roi != null && (
                    <span style={{ color: t.roi >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                      ROI {t.roi >= 0 ? '+' : ''}{t.roi.toFixed(1)}%
                    </span>
                  )}
                  {t.win_rate != null && (
                    <span>{isZh ? '胜率' : 'WR'} {t.win_rate.toFixed(0)}%</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </SidebarCard>
  )
}
