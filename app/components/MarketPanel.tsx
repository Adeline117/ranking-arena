'use client'

import { useEffect, useState } from 'react'

type MarketRow = {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

export default function MarketPanel() {
  const [market, setMarket] = useState<MarketRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        setLoading(true)
        const res = await fetch('/api/market', { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return
        setMarket(json.rows ?? [])
      } catch {
        if (!alive) return
        setMarket([])
      } finally {
        if (!alive) return
        setLoading(false)
      }
    }

    load()
    const t = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  return (
    <div style={{ border: '1px solid #1f1f1f', borderRadius: 16, background: '#0b0b0b', padding: 14 }}>
      <div style={{ fontWeight: 950, marginBottom: 10 }}>市场</div>

      {loading ? (
        <div style={{ fontSize: 13, color: '#a9a9a9' }}>加载实时行情…</div>
      ) : market.length === 0 ? (
        <div style={{ fontSize: 13, color: '#a9a9a9' }}>暂无行情数据（API 失败 / 限流）</div>
      ) : (
        market.map((m) => (
          <div
            key={m.symbol}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 0',
              borderBottom: '1px solid #141414',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 950 }}>{m.symbol}</div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: '#eaeaea' }}>${m.price}</div>
              <div style={{ color: m.direction === 'up' ? '#7CFFB2' : '#FF7C7C', fontSize: 12 }}>{m.changePct}</div>
            </div>
          </div>
        ))
      )}

      <div style={{ marginTop: 10, fontSize: 12, color: '#777' }}>实时市场数据（每 3 秒刷新）</div>
    </div>
  )
}
