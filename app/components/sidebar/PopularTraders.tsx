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
  followers: number | null
  roi: number | null
}

export default function PopularTraders() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [traders, setTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      const { data } = await supabase
        .from('trader_sources')
        .select('source, source_trader_id, handle, followers, roi')
        .order('followers', { ascending: false })
        .limit(10)
      setTraders((data as Trader[]) || [])
      setLoading(false)
    }
    fetch()
  }, [])

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 12 }}>
        {isZh ? '热门交易员' : 'Popular Traders'}
      </h3>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton" style={{ height: 36, borderRadius: 6 }} />
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
                padding: '6px 4px', textDecoration: 'none', borderRadius: 6,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.secondary)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{
                fontSize: 11, fontWeight: 700, minWidth: 16, textAlign: 'right',
                color: idx < 3 ? tokens.colors.accent.brand : tokens.colors.text.secondary,
              }}>
                {idx + 1}
              </span>
              <span style={{ fontSize: 13, color: tokens.colors.text.primary, flex: 1 }}>
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
    </div>
  )
}
