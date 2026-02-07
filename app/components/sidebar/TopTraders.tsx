'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from('trader_sources')
        .select('source, source_trader_id, handle, roi, win_rate')
        .order('roi', { ascending: false })
        .limit(10)
      setTraders((data as Trader[]) || [])
      setLoading(false)
    }
    fetch()
  }, [])

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 12 }}>
        Top 10 {isZh ? '交易员' : 'Traders'}
      </h3>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 40, borderRadius: 6 }} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {traders.map((t, idx) => (
            <Link
              key={`${t.source}-${t.source_trader_id}`}
              href={`/trader/${t.source}/${t.source_trader_id}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 6px', textDecoration: 'none', borderRadius: 8,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.secondary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{
                fontSize: 14, fontWeight: 800, minWidth: 20, textAlign: 'right',
                color: idx === 0 ? '#ffd700' : idx === 1 ? '#c0c0c0' : idx === 2 ? '#cd7f32' : tokens.colors.text.secondary,
              }}>
                {idx + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary }}>
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
    </div>
  )
}
