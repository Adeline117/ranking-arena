'use client'

import { tokens } from '@/lib/design-tokens'
import { validatePassword, Spinner } from './loginHelpers'
import OTPVerification from './OTPVerification'

interface LoginFormProps {
  email: string
  password: string
  setPassword: (v: string) => void
  code: string
  setCode: (v: string) => void
  loginWithCode: boolean
  codeSent: boolean
  loading: boolean
  sendingCode: boolean
  countdown: number
  showPassword: boolean
  setShowPassword: (v: boolean) => void
  touchedFields: { password: boolean }
  markTouched: (field: 'password') => void
  onLogin: () => void
  onSendLoginCode: () => void
  onVerifyCode: () => void
  onSwitchToCode: () => void
  onSwitchToPassword: () => void
  t: (key: string) => string
}

export default function LoginForm({
  email,
  password,
  setPassword,
  code,
  setCode,
  loginWithCode,
  codeSent,
  loading,
  sendingCode,
  countdown,
  showPassword,
  setShowPassword,
  touchedFields,
  markTouched,
  onLogin,
  onSendLoginCode,
  onVerifyCode,
  onSwitchToCode,
  onSwitchToPassword,
  t,
}: LoginFormProps) {
  const passwordValidation = validatePassword(password)

  if (!loginWithCode) {
    return (
      <>
        {/* Password login */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            {t('loginPassword')}
          </label>
          <div style={{ position: 'relative' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              className="login-input"
              style={{ 
                width: '100%', 
                padding: '14px 16px', 
                paddingRight: 50,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${touchedFields.password && password && !passwordValidation.valid ? 'var(--color-accent-error)' : 'var(--glass-border-light)'}`,
                background: 'var(--color-bg-tertiary)',
                color: tokens.colors.text.primary,
                fontSize: 16,
                outline: 'none',
              }}
              placeholder={t('loginPasswordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => markTouched('password')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading && email && password) {
                  onLogin()
                }
              }}
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="password-toggle"
              style={{
                position: 'absolute',
                right: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                padding: '10px 8px',
                cursor: 'pointer',
                color: 'var(--color-text-tertiary)',
                fontSize: 12,
                minWidth: 44,
                minHeight: 44,
              }}
              tabIndex={-1}
            >
              {showPassword ? t('loginHide') : t('loginShow')}
            </button>
          </div>
        </div>
        
        <button
          onClick={onLogin}
          disabled={loading || !email || !password}
          className="login-button"
          style={{ 
            width: '100%',
            padding: '14px 16px', 
            borderRadius: tokens.radius.lg,
            border: 'none',
            background: loading || !email || !password 
              ? 'var(--color-accent-primary-20)' 
              : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
            color: tokens.colors.white,
            fontWeight: 700,
            fontSize: 16,
            cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {loading && <Spinner />}
          {loading ? t('loginLoggingIn') : t('loginButton')}
        </button>
        
        {/* Forgot password */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <a
            href="/reset-password"
            className="link-hover"
            style={{
              color: 'var(--color-text-tertiary)',
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            {t('loginForgotPassword')}
          </a>
        </div>
        
        {/* Switch to code login */}
        <button
          onClick={onSwitchToCode}
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
          {t('loginWithCode')}
        </button>
      </>
    )
  }

  // Code login mode
  if (!codeSent) {
    return (
      <button
        onClick={onSendLoginCode}
        disabled={sendingCode || !email || countdown > 0}
        className="login-button"
        style={{ 
          width: '100%',
          padding: '14px 16px', 
          borderRadius: tokens.radius.lg,
          border: 'none',
          background: sendingCode || !email || countdown > 0 
            ? 'var(--color-accent-primary-20)' 
            : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          color: tokens.colors.white,
          fontWeight: 700,
          fontSize: 16,
          cursor: sendingCode || !email || countdown > 0 ? 'not-allowed' : 'pointer',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {sendingCode && <Spinner />}
        {sendingCode ? t('loginSendingCode') : t('loginSendCode')}
      </button>
    )
  }

  return (
    <OTPVerification
      code={code}
      setCode={setCode}
      countdown={countdown}
      loading={loading}
      sendingCode={sendingCode}
      email={email}
      onVerify={onVerifyCode}
      onResend={onSendLoginCode}
      onSwitchToPassword={onSwitchToPassword}
      t={t}
    />
  )
}
