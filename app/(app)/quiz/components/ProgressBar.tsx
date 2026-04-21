'use client'

import { tokens } from '@/lib/design-tokens'

/** Forced dark-theme palette */
const Q = {
  TRACK: 'rgba(255,255,255,0.08)',
  TEXT: 'rgba(255,255,255,0.5)',
  BRAND: '#8B5CF6',
  BRAND_DEEP: '#6D28D9',
} as const

interface ProgressBarProps {
  current: number // 1-15
  total: number // 15
}

export default function ProgressBar({ current, total }: ProgressBarProps) {
  const percent = (current / total) * 100

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
            color: Q.TEXT,
            letterSpacing: '0.5px',
          }}
        >
          {current} / {total}
        </span>
      </div>
      <div
        style={{
          width: '100%',
          height: 4,
          borderRadius: 2,
          background: Q.TRACK,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 2,
            background: `linear-gradient(90deg, ${Q.BRAND} 0%, ${Q.BRAND_DEEP} 100%)`,
            transition: 'width 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
      </div>
    </div>
  )
}
