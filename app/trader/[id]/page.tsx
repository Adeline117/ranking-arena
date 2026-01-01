'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'

type Trader = {
  id: string
  handle: string
  bio: string | null
  roi: number
  win_rate: number
  followers: number
}

type TraderSeason = {
  id: string
  trader_id: string
  season: string
  roi: number
  max_drawdown: number
  arena_score: number
}

type PageProps = {
  params: { id: string }
}

export default function TraderPage({ params }: PageProps) {
  const [trader, setTrader] = useState<Trader | null>(null)
  const [seasons, setSeasons] = useState<TraderSeason[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setErr(null)

      const { data: traderData, error: traderError } = await supabase
        .from('traders')
        .select('*')
        .eq('id', params.id)
        .single()

      if (traderError || !traderData) {
        setTrader(null)
        setErr(traderError?.message || 'Trader not found')
        setLoading(false)
        return
      }

      setTrader(traderData as Trader)

      const { data: seasonsData, error: seasonsError } = await supabase
        .from('trader_seasons')
        .select('*')
        .eq('trader_id', params.id)
        .order('season', { ascending: false })

      if (!seasonsError && seasonsData) setSeasons(seasonsData as TraderSeason[])
      else setSeasons([])

      setLoading(false)
    }

    load()
  }, [params.id])

  if (loading) {
    return (
      <main style={{ padding: 40, color: '#f2f2f2', background: '#060606', minHeight: '100vh' }}>
        <p><Link href="/">← Back to ranking</Link></p>
        <p style={{ marginTop: 18, color: 'rgba(255,255,255,0.65)' }}>Loading…</p>
      </main>
    )
  }

  if (!trader) {
    return (
      <main style={{ padding: 40, color: '#f2f2f2', background: '#060606', minHeight: '100vh' }}>
        <h1>Trader not found</h1>
        <p style={{ color: 'rgba(255,255,255,0.65)' }}>{err || "We couldn't find this trader."}</p>
        <p style={{ marginTop: 12 }}><Link href="/">← Back to ranking</Link></p>
      </main>
    )
  }

  return (
    <main style={{ padding: 24, color: '#f2f2f2', background: '#060606', minHeight: '100vh' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <p style={{ marginBottom: 12 }}>
          <Link href="/">← Back to ranking</Link>
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            paddingBottom: 14,
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div>
            <h1 style={{ margin: 0 }}>{trader.handle}</h1>
            <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.7)' }}>
              当前 ROI: {trader.roi.toFixed(1)}% · Win {trader.win_rate.toFixed(1)}% · 粉丝 {trader.followers}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={{
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(255,255,255,0.05)',
                color: 'rgba(255,255,255,0.86)',
                fontWeight: 900,
                padding: '10px 14px',
                borderRadius: 12,
                cursor: 'pointer',
              }}
              onClick={() => alert('Follow (mock)')}
            >
              Follow
            </button>
            <button
              style={{
                border: 'none',
                background: '#2fe57d',
                color: '#04120a',
                fontWeight: 900,
                padding: '10px 14px',
                borderRadius: 12,
                cursor: 'pointer',
              }}
              onClick={() => alert('Copy (mock)')}
            >
              Copy
            </button>
          </div>
        </div>

        {/* About */}
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 16,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 8 }}>About</div>
          <div style={{ color: 'rgba(255,255,255,0.72)', lineHeight: 1.6 }}>
            {trader.bio || '这个 Trader 还没有写个人简介。'}
          </div>
        </div>

        {/* Seasons */}
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 16,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Season history</div>

          {seasons.length > 0 ? (
            <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr 1fr',
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.04)',
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.6)',
                  fontWeight: 900,
                }}
              >
                <div>Season</div>
                <div>ROI %</div>
                <div>Max DD %</div>
                <div>Arena score</div>
              </div>

              {seasons.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr 1fr',
                    padding: '12px 12px',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ fontWeight: 900 }}>{s.season}</div>
                  <div style={{ color: s.roi >= 0 ? '#2fe57d' : '#ff4d4d', fontWeight: 900 }}>{s.roi}</div>
                  <div style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 800 }}>{s.max_drawdown}</div>
                  <div style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 800 }}>{s.arena_score}</div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ marginTop: 8, color: 'rgba(255,255,255,0.6)' }}>No season history yet.</p>
          )}
        </div>
      </div>
    </main>
  )
}
