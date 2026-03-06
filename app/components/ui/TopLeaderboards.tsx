'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'

export interface LeaderboardEntry {
  id: string
  name: string
  rating: number | null
  logoUrl?: string | null
  href?: string | null
}

export interface LeaderboardColumn {
  title: string
  icon: React.ReactNode
  entries: LeaderboardEntry[]
  ratingLabel?: string
  loading?: boolean
  emptyText?: string
}

interface TopLeaderboardsProps {
  columns: LeaderboardColumn[]
}

function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3
  const colors = ['var(--color-rank-gold, #D4AF37)', 'var(--color-rank-silver, #A0AEC0)', 'var(--color-rank-bronze, #CD7F32)']
  const bg = isTop3 ? colors[rank - 1] : 'var(--color-bg-tertiary)'
  const color = isTop3 ? 'var(--color-on-accent, #fff)' : 'var(--color-text-tertiary)'

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: isTop3 ? 26 : 24, height: isTop3 ? 26 : 24, borderRadius: '50%',
      background: bg, color, fontSize: isTop3 ? 12 : 11, fontWeight: 700,
      flexShrink: 0,
      boxShadow: isTop3 ? `0 2px 8px ${colors[rank - 1]}40` : 'none',
    }}>
      {rank}
    </span>
  )
}

function LogoPlaceholder({ name }: { name: string }) {
  return (
    <div style={{
      width: 32, height: 32, borderRadius: tokens.radius.md,
      background: 'var(--color-accent-primary-12)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 700, color: 'var(--color-brand)',
      flexShrink: 0,
      border: '1px solid var(--color-border-primary)',
    }}>
      {name?.[0] || '?'}
    </div>
  )
}

function StarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--color-accent-warning)" stroke="none">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  )
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 8px',
        }}>
          <div className="skeleton" style={{
            width: 24, height: 24, borderRadius: '50%',
            animation: 'pulse 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            animationDelay: `${i * 100}ms`,
          }} />
          <div className="skeleton" style={{
            width: 32, height: 32, borderRadius: tokens.radius.md,
            animation: 'pulse 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            animationDelay: `${i * 100 + 50}ms`,
          }} />
          <div className="skeleton" style={{
            flex: 1, height: 14, borderRadius: 6,
            animation: 'pulse 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            animationDelay: `${i * 100 + 100}ms`,
          }} />
          <div className="skeleton" style={{
            width: 40, height: 14, borderRadius: 6,
            animation: 'pulse 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            animationDelay: `${i * 100 + 150}ms`,
          }} />
        </div>
      ))}
    </>
  )
}

function LeaderboardCard({ column }: { column: LeaderboardColumn }) {
  const isEmpty = !column.loading && column.entries.length === 0

  return (
    <div style={{
      borderRadius: tokens.radius.xl,
      border: tokens.glass.border.light,
      background: tokens.glass.bg.primary,
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      padding: '20px 16px',
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      boxShadow: tokens.shadow.sm,
      transition: `box-shadow ${tokens.transition.base}`,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 16, paddingBottom: 12,
        borderBottom: '2px solid var(--color-border-primary)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--color-brand)' }}>
          {column.icon}
        </span>
        <span style={{
          fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)',
          letterSpacing: '0.01em',
        }}>
          {column.title}
        </span>
      </div>

      {/* Body */}
      {column.loading ? (
        <SkeletonRows />
      ) : isEmpty ? (
        <div style={{
          textAlign: 'center', padding: '40px 12px',
          color: 'var(--color-text-tertiary)', fontSize: 14,
        }}>
          {column.emptyText || 'Coming soon'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {column.entries.slice(0, 10).map((entry, idx) => {
            const isTop3 = idx < 3
            return (
              <div
                key={entry.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: isTop3 ? '9px 8px' : '7px 8px',
                  borderRadius: tokens.radius.md,
                  transition: `background ${tokens.transition.fast}`,
                  cursor: entry.href ? 'pointer' : 'default',
                  background: isTop3 ? 'var(--color-bg-hover)' : 'transparent',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-hover)'; if (isTop3) e.currentTarget.style.background = 'var(--color-bg-tertiary)' }}
                onMouseLeave={e => { e.currentTarget.style.background = isTop3 ? 'var(--color-bg-hover)' : 'transparent' }}
                onClick={() => { if (entry.href) window.open(entry.href, '_blank') }}
              >
                <RankBadge rank={idx + 1} />
                {entry.logoUrl ? (
                  <img
                    src={entry.logoUrl}
                    alt={`${entry.name} logo`}
                    width={32} height={32}
                    style={{
                      borderRadius: tokens.radius.md, objectFit: 'cover', flexShrink: 0,
                      border: '1px solid var(--color-border-primary)',
                    }}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <LogoPlaceholder name={entry.name} />
                )}
                <span style={{
                  flex: 1, fontSize: isTop3 ? 14 : 13, fontWeight: isTop3 ? 600 : 500,
                  color: 'var(--color-text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {entry.name}
                </span>
                {entry.rating != null && entry.rating > 0 && (
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    fontSize: 12, fontWeight: 600,
                    color: 'var(--color-text-secondary)', flexShrink: 0,
                    background: 'var(--color-bg-tertiary)',
                    padding: '2px 7px',
                    borderRadius: tokens.radius.full,
                  }}>
                    <StarIcon />
                    {entry.rating.toFixed(1)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function TopLeaderboards({ columns }: TopLeaderboardsProps) {
  // Don't render if all columns are empty and not loading
  const allEmpty = columns.every(col => !col.loading && col.entries.length === 0)
  if (allEmpty) return null

  return (
    <>
      <style>{`
        .top-leaderboards-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-bottom: 40px;
        }
        @media (max-width: 900px) {
          .top-leaderboards-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 600px) {
          .top-leaderboards-grid { grid-template-columns: 1fr; }
        }
      `}</style>
      <div className="top-leaderboards-grid">
        {columns.map((col, i) => (
          <LeaderboardCard key={i} column={col} />
        ))}
      </div>
    </>
  )
}
