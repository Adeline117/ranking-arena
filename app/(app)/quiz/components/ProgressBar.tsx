'use client'

interface ProgressBarProps {
  answered: number
  total: number
}

export default function ProgressBar({ answered, total }: ProgressBarProps) {
  const percent = (answered / total) * 100

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--color-text-tertiary)',
          opacity: 0.85,
        }}
        aria-hidden="true"
      >
        {answered} / {total}
      </span>
      <div
        role="progressbar"
        aria-valuenow={answered}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${answered} of ${total} answered`}
        style={{
          width: '100%',
          height: 5,
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
