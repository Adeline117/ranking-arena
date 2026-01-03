'use client'

import { useEffect, useState } from 'react'
import { SkeletonLine } from './Skeleton'
import EmptyState from './EmptyState'
import ErrorMessage from './ErrorMessage'
import { ChartIcon } from './Icons'

type MarketRow = {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

export default function MarketPanel() {
  const [market, setMarket] = useState<MarketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await fetch('/api/market', { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return
        
        if (json.error) {
          setError(json.error)
          setMarket([])
        } else {
          setMarket(json.rows ?? [])
          setLastUpdate(new Date())
        }
      } catch (err: any) {
        if (!alive) return
        setError(err?.message || '加载失败')
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

  const formatTime = (date: Date) => {
    const now = new Date()
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
    if (diff < 60) return `${diff}秒前`
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div style={{ 
      border: '1px solid rgba(255,255,255,0.08)', 
      borderRadius: '16px', 
      background: 'rgba(255,255,255,0.03)',
      padding: '16px',
      boxShadow: '0 4px 6px rgba(0,0,0,0.2)',
    }}>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 950, fontSize: '16px', color: '#f2f2f2' }}>
            <MarketIcon size={18} />
            <span>市场行情</span>
          </div>
        {lastUpdate && !loading && !error && (
          <div style={{ 
            fontSize: '11px', 
            color: '#777',
            padding: '4px 8px',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '6px',
          }}>
            {formatTime(lastUpdate)}
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <SkeletonLine width="80px" height="16px" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' }}>
                <SkeletonLine width="60px" height="14px" />
                <SkeletonLine width="50px" height="12px" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <ErrorMessage message={error} onRetry={() => window.location.reload()} />
      ) : market.length === 0 ? (
        <EmptyState 
          icon="📊"
          title="暂无行情数据"
          description="API可能暂时不可用，请稍后再试"
        />
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {market.map((m) => (
              <div
                key={m.symbol}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px',
                  borderRadius: '10px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.04)',
                  transition: 'all 150ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.02)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.04)'
                }}
              >
                <div style={{ fontWeight: 950, fontSize: '14px', color: '#eaeaea' }}>
                  {m.symbol.replace('-USD', '')}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#eaeaea', fontSize: '14px', fontWeight: 700, marginBottom: '2px' }}>
                    ${m.price}
                  </div>
                  <div style={{ 
                    color: m.direction === 'up' ? '#2fe57d' : '#ff4d4d', 
                    fontSize: '12px',
                    fontWeight: 700,
                  }}>
                    {m.changePct}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ 
            marginTop: '12px', 
            fontSize: '11px', 
            color: '#777',
            textAlign: 'center',
            padding: '8px',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '8px',
          }}>
            每3秒自动刷新
          </div>
        </>
      )}
    </div>
  )
}
