'use client'

import { tokens } from '@/lib/design-tokens'
import { Spinner } from './Spinner'

interface ResetEmailFormProps {
  email: string
  setEmail: (email: string) => void
  loading: boolean
  countdown: number
  onSubmit: () => void
  t: (key: string) => string
}

export function ResetEmailForm({ email, setEmail, loading, countdown, onSubmit, t }: ResetEmailFormProps) {
  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary }}>
          {t('resetPasswordEmail')}
        </label>
        <input
          type="email"
          className="reset-input"
          style={{
            width: '100%',
            padding: '14px 16px',
            borderRadius: tokens.radius.lg,
            border: '1px solid var(--glass-border-light)',
            background: 'var(--color-bg-tertiary)',
            color: tokens.colors.text.primary,
            fontSize: 16,
            outline: 'none',
          }}
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading && email && countdown === 0) {
              onSubmit()
            }
          }}
        />
      </div>

      <button
        onClick={onSubmit}
        disabled={loading || !email || countdown > 0}
        className="reset-button"
        style={{
          width: '100%',
          padding: '14px 16px',
          borderRadius: tokens.radius.lg,
          border: 'none',
          background: loading || !email || countdown > 0
            ? 'var(--color-accent-primary-20)'
            : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          color: tokens.colors.white,
          fontWeight: 700,
          fontSize: 16,
          cursor: loading || !email || countdown > 0 ? 'not-allowed' : 'pointer',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {loading && <Spinner />}
        {loading ? t('resetPasswordSending') : countdown > 0 ? `${countdown} ${t('resetPasswordCountdown')}` : t('resetPasswordSendLink')}
      </button>
    </>
  )
}
