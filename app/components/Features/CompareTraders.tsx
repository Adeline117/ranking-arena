'use client'

import React from 'react'
import Link from 'next/link'
import { Trader } from './RankingTable'
import { formatNumber, formatPercent } from '@/lib/design-system-helpers'

type CompareTradersProps = {
  traders: Trader[]
  onRemove: (id: string) => void
  onClear: () => void
}

export default function CompareTraders({ traders, onRemove, onClear }: CompareTradersProps) {
  if (traders.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        background: '#0b0b0b',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '16px',
        padding: '16px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 400,
        maxWidth: '600px',
        maxHeight: '400px',
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontWeight: 900, fontSize: '16px' }}>对比交易者 ({traders.length})</div>
        <button
          onClick={onClear}
          style={{
            padding: '4px 8px',
            background: 'transparent',
            border: 'none',
            color: '#9a9a9a',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          清空
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        {traders.map((trader) => (
          <div
            key={trader.id}
            style={{
              padding: '12px',
              borderRadius: '10px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              position: 'relative',
            }}
          >
            <button
              onClick={() => onRemove(trader.id)}
              style={{
                position: 'absolute',
                top: '8px',
                right: '8px',
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                background: 'rgba(255,77,77,0.2)',
                border: 'none',
                color: '#ff4d4d',
                cursor: 'pointer',
                fontSize: '12px',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              ×
            </button>
            <Link href={`/trader/${trader.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div style={{ fontWeight: 900, marginBottom: '8px', fontSize: '14px' }}>{trader.handle}</div>
              <div style={{ fontSize: '12px', color: '#9a9a9a' }}>
                <div>ROI: <span style={{ color: trader.roi >= 0 ? '#2fe57d' : '#ff4d4d' }}>
                  {formatPercent(trader.roi)}
                </span></div>
                <div>胜率: {Math.round(trader.win_rate)}%</div>
                <div>粉丝: {formatNumber(trader.followers)}</div>
              </div>
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}

