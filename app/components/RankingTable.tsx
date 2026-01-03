'use client'

import Link from 'next/link'
import { useState } from 'react'
import { getRankingColor, formatNumber } from '@/lib/design-system-helpers'
import { RankingSkeleton } from './Skeleton'
import { TrophyIcon, RankingBadge } from './Icons'

export type Trader = {
  id: string
  handle: string
  roi: number
  win_rate: number
  followers: number
  rank_change?: number // 排名变化：正数=上升，负数=下降
}

type TimePeriod = '90D' | '30D' | '7D' | '1Y'

export default function RankingTable(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
  onSelectTrader?: (t: Trader) => void
}) {
  const { traders, loading, loggedIn } = props
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('1Y')
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  // 只按ROI排序
  const sortedTraders = [...traders].sort((a, b) => b.roi - a.roi)

  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '18px',
        background: 'rgba(255,255,255,0.03)',
        padding: '16px',
        boxShadow: '0 4px 6px rgba(0,0,0,0.2)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <TrophyIcon size={20} />
          <div style={{ fontWeight: 950, fontSize: '18px', color: '#f2f2f2' }}>交易者排行榜</div>
        </div>
        <div style={{ fontSize: '12px', color: '#9a9a9a', padding: '4px 10px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
          {loggedIn ? '已登录' : '游客模式'}
        </div>
      </div>

      {/* 时间筛选 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {(['90D', '30D', '7D', '1Y'] as const).map((period) => (
          <button
            key={period}
            onClick={() => setTimePeriod(period)}
            style={{
              padding: '6px 12px',
              borderRadius: '8px',
              border: timePeriod === period ? '1px solid #8b6fa8' : '1px solid rgba(255,255,255,0.1)',
              background: timePeriod === period ? 'rgba(139,111,168,0.15)' : 'rgba(255,255,255,0.05)',
              color: timePeriod === period ? '#8b6fa8' : '#bdbdbd',
              fontWeight: timePeriod === period ? 900 : 700,
              fontSize: '12px',
              cursor: 'pointer',
              transition: 'all 150ms ease',
            }}
          >
            {period}
          </button>
        ))}
      </div>

      {loading ? (
        <RankingSkeleton />
      ) : sortedTraders.length === 0 ? (
        <div style={{ 
          color: '#9a9a9a', 
          padding: '40px 12px', 
          textAlign: 'center',
          fontSize: '14px',
        }}>
          暂无交易者数据
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {sortedTraders.map((t, idx) => {
            const rank = idx + 1
            const rankColors = getRankingColor(rank)
            const href = `/trader/${encodeURIComponent(t.id)}`
            const isHovered = hoveredIndex === idx
            
            return (
              <div
                key={t.id}
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
                className="ranking-table-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '60px 1fr 90px 80px 100px',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px',
                  borderRadius: '14px',
                  background: isHovered ? rankColors.bg : (rank <= 3 ? rankColors.bg : '#0b0b0b'),
                  border: `1px solid ${isHovered ? rankColors.border : (rank <= 3 ? rankColors.border : '#141414')}`,
                  cursor: 'pointer',
                  transition: 'all 200ms ease',
                  transform: isHovered ? 'translateX(4px)' : 'translateX(0)',
                  boxShadow: isHovered ? '0 4px 12px rgba(0,0,0,0.3)' : 'none',
                }}
                onClick={(e) => {
                  e.preventDefault()
                  window.location.href = href
                }}
              >
                {/* 排名 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {rank <= 3 && <RankingBadge rank={rank} />}
                  <span style={{ 
                    color: rank <= 3 ? rankColors.text : '#8b8b8b', 
                    fontWeight: 950,
                    fontSize: '14px',
                  }}>
                    #{rank}
                  </span>
                  {t.rank_change && t.rank_change !== 0 && (
                    <span style={{ 
                      fontSize: '12px',
                      color: t.rank_change > 0 ? '#2fe57d' : '#ff4d4d',
                    }}>
                      {t.rank_change > 0 ? '↑' : '↓'} {Math.abs(t.rank_change)}
                    </span>
                  )}
                </div>

                {/* 头像 + handle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  <Link href={href} style={{ textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                    <div
                      style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '999px',
                        background: rank <= 3 ? rankColors.bg : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${rank <= 3 ? rankColors.border : '#1f1f1f'}`,
                        display: 'grid',
                        placeItems: 'center',
                        fontWeight: 950,
                        color: rank <= 3 ? rankColors.text : '#eaeaea',
                        cursor: 'pointer',
                        transition: 'all 200ms ease',
                        fontSize: '14px',
                      }}
                    >
                      {(t.handle?.[0] ?? 'T').toUpperCase()}
                    </div>
                  </Link>

                  <Link
                    href={href}
                    style={{
                      color: '#eaeaea',
                      fontWeight: 950,
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: '14px',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t.handle}
                  </Link>
                </div>

                {/* ROI */}
                <div style={{ 
                  color: t.roi >= 0 ? '#2fe57d' : '#ff4d4d', 
                  fontWeight: 950,
                  fontSize: '14px',
                }}>
                  {t.roi >= 0 ? '+' : ''}{t.roi.toFixed(2)}%
                </div>
                
                {/* Win Rate */}
                <div style={{ color: '#bdbdbd', fontSize: '13px', fontWeight: 700 }}>
                  {Math.round(t.win_rate)}%
                </div>
                
                {/* Followers */}
                <div style={{ color: '#bdbdbd', fontSize: '13px', fontWeight: 700 }}>
                  {formatNumber(t.followers)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
