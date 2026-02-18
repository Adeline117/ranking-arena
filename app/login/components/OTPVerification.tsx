'use client'

import { tokens } from '@/lib/design-tokens'
import { Spinner } from './loginHelpers'

interface OTPVerificationProps {
  code: string
  setCode: (code: string) => void
  countdown: number
  loading: boolean
  sendingCode: boolean
  email: string
  onVerify: () => void
  onResend: () => void
  onSwitchToPassword?: () => void
  t: (key: string) => string
}

export default function OTPVerification({
  code,
  setCode,
  countdown,
  loading,
  sendingCode: _sendingCode,
  email,
  onVerify,
  onResend,
  onSwitchToPassword,
  t,
}: OTPVerificationProps) {
  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          {t('loginVerificationCode')}
        </label>
        <input
          type="text"
          className="login-input"
          style={{ 
            width: '100%', 
            padding: '14px 16px', 
            borderRadius: tokens.radius.lg,
            border: '1px solid var(--glass-border-light)',
            background: 'var(--color-bg-tertiary)',
            color: tokens.colors.text.primary,
            fontSize: 16,
            outline: 'none',
            letterSpacing: 4,
            textAlign: 'center',
          }}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading && code) {
              onVerify()
            }
          }}
          maxLength={6}
        />
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {t('loginCodeValidFor')}
        </div>
      </div>
      <button
        onClick={onVerify}
        disabled={loading || !code}
        className="login-button"
        style={{ 
          width: '100%',
          padding: '14px 16px', 
          borderRadius: tokens.radius.lg,
          border: 'none',
          background: loading || !code 
            ? 'var(--color-accent-primary-20)' 
            : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          color: tokens.colors.white,
          fontWeight: 700,
          fontSize: 16,
          cursor: loading || !code ? 'not-allowed' : 'pointer',
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {loading && <Spinner />}
        {loading ? t('loginVerifying') : t('loginVerifyCode')}
      </button>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
        {countdown > 0 ? (
          <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
            {countdown} {t('loginCountdown')}
          </span>
        ) : (
          <button
            onClick={onResend}
            disabled={!email}
            className="link-hover"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-brand)',
              fontSize: 13,
              fontWeight: 600,
              cursor: !email ? 'not-allowed' : 'pointer',
              padding: 0,
            }}
          >
            {t('loginResendCode')}
          </button>
        )}
      </div>
      {onSwitchToPassword && (
        <button
          onClick={onSwitchToPassword}
          className="link-hover"
          style={{
            width: '100%',
            padding: '8px',
            border: 'none',
            background: 'transparent',
            color: 'var(--color-brand)',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
            marginBottom: 12,
          }}
        >
          {t('loginWithPassword')}
        </button>
      )}
    </>
  )
}
