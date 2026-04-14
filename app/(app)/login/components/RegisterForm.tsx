'use client'

import { tokens } from '@/lib/design-tokens'
import { getPasswordStrength, validatePassword, validateHandle, Spinner } from './loginHelpers'
import OTPVerification from './OTPVerification'

interface RegisterFormProps {
  email: string
  password: string
  setPassword: (v: string) => void
  handle: string
  setHandle: (v: string) => void
  code: string
  setCode: (v: string) => void
  codeSent: boolean
  codeVerified: boolean
  loading: boolean
  sendingCode: boolean
  countdown: number
  showPassword: boolean
  setShowPassword: (v: boolean) => void
  touchedFields: { email: boolean; password: boolean; handle: boolean }
  markTouched: (field: 'email' | 'password' | 'handle') => void
  onSendCode: () => void
  onVerifyCode: () => void
  onResendCode: () => void
  onSetPassword: () => void
  t: (key: string) => string
}

export default function RegisterForm({
  email,
  password,
  setPassword,
  handle,
  setHandle,
  code,
  setCode,
  codeSent,
  codeVerified,
  loading,
  sendingCode,
  countdown,
  showPassword,
  setShowPassword,
  touchedFields,
  markTouched,
  onSendCode,
  onVerifyCode,
  onResendCode,
  onSetPassword,
  t,
}: RegisterFormProps) {
  const passwordStrength = getPasswordStrength(password)
  const passwordValidation = validatePassword(password)
  const handleValidation = validateHandle(handle)

  if (!codeSent) {
    return (
      <button
        onClick={onSendCode}
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

  if (!codeVerified) {
    return (
      <OTPVerification
        code={code}
        setCode={setCode}
        countdown={countdown}
        loading={loading}
        sendingCode={sendingCode}
        email={email}
        onVerify={onVerifyCode}
        onResend={onResendCode}
        t={t}
      />
    )
  }

  // Code verified - show handle + password setup
  return (
    <>
      {/* Username input */}
      <div style={{ marginBottom: 20 }}>
        <label htmlFor="register-handle" style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          {t('loginHandle')}
        </label>
        <input
          id="register-handle"
          type="text"
          className="login-input"
          style={{
            width: '100%',
            padding: '14px 16px',
            borderRadius: tokens.radius.lg,
            border: `1px solid ${touchedFields.handle && !handleValidation.valid ? 'var(--color-accent-error)' : 'var(--glass-border-light)'}`,
            background: 'var(--color-bg-tertiary)',
            color: tokens.colors.text.primary,
            fontSize: 16,
            outline: 'none',
          }}
          placeholder={t('loginUsernamePlaceholder')}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          onBlur={() => markTouched('handle')}
          autoComplete="username"
          aria-invalid={touchedFields.handle && handle ? !handleValidation.valid : undefined}
          aria-describedby={touchedFields.handle && handle && !handleValidation.valid ? 'register-handle-error' : undefined}
        />
        {touchedFields.handle && handle && !handleValidation.valid && (
          <div id="register-handle-error" style={{ marginTop: 6, fontSize: 12 }}>
            <span style={{ color: 'var(--color-accent-error)' }}>X - {t(handleValidation.messageKey)}</span>
          </div>
        )}
      </div>
      
      {/* Password input */}
      <div style={{ marginBottom: 20 }}>
        <label htmlFor="register-password" style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          {t('loginPassword')}
        </label>
        <div style={{ position: 'relative' }}>
          <input
            id="register-password"
            type={showPassword ? 'text' : 'password'}
            className="login-input"
            style={{
              width: '100%',
              padding: '14px 16px',
              paddingRight: 50,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${touchedFields.password && !passwordValidation.valid ? 'var(--color-accent-error)' : 'var(--glass-border-light)'}`,
              background: 'var(--color-bg-tertiary)',
              color: tokens.colors.text.primary,
              fontSize: 16,
              outline: 'none',
            }}
            placeholder={t('loginSetPasswordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => markTouched('password')}
            autoComplete="new-password"
            aria-invalid={touchedFields.password ? !passwordValidation.valid : undefined}
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
              padding: 4,
              cursor: 'pointer',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
            }}
            tabIndex={-1}
          >
            {showPassword ? t('loginHide') : t('loginShow')}
          </button>
        </div>
        
        {/* Password strength indicator */}
        {password && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              {[1, 2, 3, 4].map((level) => (
                <div
                  key={level}
                  className="strength-segment"
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 2,
                    background: level <= passwordStrength.level ? passwordStrength.color : 'var(--glass-border-light)',
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: passwordStrength.color, fontWeight: 500 }}>
                {t('loginPasswordStrength').replace('{label}', t(passwordStrength.labelKey))}
              </span>
              <span style={{ fontSize: 11, color: password.length >= 6 ? 'var(--color-text-secondary)' : 'var(--color-accent-error)' }}>
                {password.length}/6
              </span>
            </div>
          </div>
        )}
      </div>
      
      <button
        onClick={onSetPassword}
        disabled={loading || !password || password.length < 6 || !handle || handle.length < 1}
        className="login-button"
        style={{ 
          width: '100%',
          padding: '14px 16px', 
          borderRadius: tokens.radius.lg,
          border: 'none',
          background: loading || !password || password.length < 6 || !handle || handle.length < 1 
            ? 'var(--color-accent-primary-20)' 
            : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          color: tokens.colors.white,
          fontWeight: 700,
          fontSize: 16,
          cursor: loading || !password || password.length < 6 || !handle || handle.length < 1 ? 'not-allowed' : 'pointer',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {loading && <Spinner />}
        {loading ? t('loginRegistering') : t('loginSetPassword')}
      </button>
    </>
  )
}
