'use client'

import { tokens } from '@/lib/design-tokens'

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
            color: 'var(--color-text-secondary)',
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
          background: 'var(--color-overlay-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 2,
            background: 'linear-gradient(90deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
            transition: 'width 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
      </div>
    </div>
  )
}
