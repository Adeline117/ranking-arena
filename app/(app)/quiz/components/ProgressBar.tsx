'use client'

interface ProgressBarProps {
  current: number // 1-15
  total: number // 15
}

export default function ProgressBar({ current, total }: ProgressBarProps) {
  const percent = (current / total) * 100

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--color-text-tertiary)',
          opacity: 0.7,
        }}
        aria-hidden="true"
      >
        {current} / {total}
      </span>
      <div
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label={`Question ${current} of ${total}`}
        style={{
          width: '100%',
          height: 3,
          borderRadius: 2,
          background: 'var(--color-bg-tertiary)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 2,
            background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-deep))',
            transition: 'width 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
      </div>
    </div>
  )
}
