'use client'

import React from 'react'

export type Trader = {
  id: string
  handle: string
  roi: number
  win_rate: number
  followers: number
}

export default function RankingTable({
  traders,
  loading,
  loggedIn,
  onSelectTrader,
}: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
  onSelectTrader?: (t: Trader) => void
}) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 18,
        padding: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 900 }}>赛季排行榜（ROI）</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
          {loggedIn ? '已登录：展示前 50' : '未登录：展示前 10'}
        </div>
      </div>

      <div
        style={{
          borderRadius: 14,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {/* header */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '52px 1.2fr 0.7fr 0.7fr 0.8fr 70px',
            gap: 0,
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.04)',
            fontSize: 12,
            color: 'rgba(255,255,255,0.6)',
            fontWeight: 800,
          }}
        >
          <div>#</div>
          <div>Trader</div>
          <div style={{ textAlign: 'right' }}>ROI</div>
          <div style={{ textAlign: 'right' }}>Win</div>
          <div style={{ textAlign: 'right' }}>Followers</div>
          <div />
        </div>

        {/* body */}
        {loading ? (
          <div style={{ padding: 16, color: 'rgba(255,255,255,0.6)' }}>Loading…</div>
        ) : traders.length === 0 ? (
          <div style={{ padding: 16, color: 'rgba(255,255,255,0.6)' }}>
            No traders found.
          </div>
        ) : (
          traders.map((t, idx) => (
            <Row
              key={t.id}
              trader={t}
              rank={idx + 1}
              onClick={() => onSelectTrader?.(t)}
            />
          ))
        )}
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
        点击任意 Trader 查看详情（Overview / Stats / Portfolio / Chart）
      </div>
    </div>
  )
}

function Row({
  trader,
  rank,
  onClick,
}: {
  trader: Trader
  rank: number
  onClick: () => void
}) {
  const roiColor = trader.roi >= 0 ? '#2fe57d' : '#ff4d4d'
  return (
    <div
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '52px 1.2fr 0.7fr 0.7fr 0.8fr 70px',
        padding: '12px 12px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        alignItems: 'center',
        cursor: 'pointer',
        background: 'transparent',
        transition: 'background 120ms ease',
      }}
      onMouseEnter={(e) => ((e.currentTarget.style.background = 'rgba(255,255,255,0.03)'))}
      onMouseLeave={(e) => ((e.currentTarget.style.background = 'transparent'))}
      title="Open trader profile"
    >
      <div style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 800 }}>{rank}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 999,
            background: 'rgba(255,255,255,0.10)',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 900,
          }}
        >
          {trader.handle?.[0]?.toUpperCase() ?? 'T'}
        </div>
        <div style={{ fontWeight: 800 }}>{trader.handle}</div>
      </div>

      <div style={{ textAlign: 'right', color: roiColor, fontWeight: 900 }}>
        {trader.roi.toFixed(1)}%
      </div>
      <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.85)', fontWeight: 800 }}>
        {trader.win_rate.toFixed(1)}%
      </div>
      <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.75)', fontWeight: 800 }}>
        {trader.followers}
      </div>

      <div style={{ textAlign: 'right', color: 'rgba(255,255,255,0.45)', fontWeight: 800 }}>
        View →
      </div>
    </div>
  )
}
