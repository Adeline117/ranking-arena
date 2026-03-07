'use client'

import { tokens } from '@/lib/design-tokens'
import { getPasswordStrength } from './password-utils'
import { Spinner } from './Spinner'

interface SetNewPasswordFormProps {
  newPassword: string
  setNewPassword: (password: string) => void
  confirmPassword: string
  setConfirmPassword: (password: string) => void
  showPassword: boolean
  setShowPassword: (show: boolean) => void
  showConfirmPassword: boolean
  setShowConfirmPassword: (show: boolean) => void
  loading: boolean
  onSubmit: () => void
  t: (key: string) => string
}

export function SetNewPasswordForm({
  newPassword,
  setNewPassword,
  confirmPassword,
  setConfirmPassword,
  showPassword,
  setShowPassword,
  showConfirmPassword,
  setShowConfirmPassword,
  loading,
  onSubmit,
  t,
}: SetNewPasswordFormProps) {
  const passwordStrength = getPasswordStrength(newPassword)

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary }}>
          {t('resetPasswordNewPassword')}
        </label>
        <div style={{ position: 'relative' }}>
          <input
            type={showPassword ? 'text' : 'password'}
            className="reset-input"
            style={{
              width: '100%',
              padding: '14px 16px',
              paddingRight: 50,
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--glass-border-light)',
              background: 'var(--color-bg-tertiary)',
              color: tokens.colors.text.primary,
              fontSize: 16,
              outline: 'none',
            }}
            placeholder="••••••"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
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
              color: tokens.colors.text.tertiary,
              fontSize: 12,
            }}
            tabIndex={-1}
          >
            {showPassword ? t('loginHide') : t('loginShow')}
          </button>
        </div>

        {/* Password strength indicator */}
        {newPassword && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              {[1, 2, 3, 4].map((level) => (
                <div
                  key={level}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 2,
                    background: level <= passwordStrength.level ? passwordStrength.color : 'var(--glass-border-light)',
                    transition: `all ${tokens.transition.slow}`,
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: passwordStrength.color, fontWeight: 500 }}>
                {t('loginPasswordStrength').replace('{label}', t(passwordStrength.labelKey))}
              </span>
              <span style={{ fontSize: 11, color: newPassword.length >= 6 ? 'var(--color-text-secondary)' : 'var(--color-accent-error)' }}>
                {newPassword.length}/6
              </span>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary }}>
          {t('resetPasswordConfirm')}
        </label>
        <div style={{ position: 'relative' }}>
          <input
            type={showConfirmPassword ? 'text' : 'password'}
            className="reset-input"
            style={{
              width: '100%',
              padding: '14px 16px',
              paddingRight: 50,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${confirmPassword && confirmPassword !== newPassword ? 'var(--color-accent-error)' : 'var(--glass-border-light)'}`,
              background: 'var(--color-bg-tertiary)',
              color: tokens.colors.text.primary,
              fontSize: 16,
              outline: 'none',
            }}
            placeholder="••••••"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !loading && newPassword && confirmPassword) {
                onSubmit()
              }
            }}
          />
          <button
            type="button"
            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
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
              color: tokens.colors.text.tertiary,
              fontSize: 12,
            }}
            tabIndex={-1}
          >
            {showConfirmPassword ? t('loginHide') : t('loginShow')}
          </button>
        </div>
        {confirmPassword && confirmPassword === newPassword && (
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <span style={{ color: tokens.colors.accent.success }}>OK - {t('loginPasswordsMatch')}</span>
          </div>
        )}
      </div>

      <button
        onClick={onSubmit}
        disabled={loading || !newPassword || !confirmPassword}
        className="reset-button"
        style={{
          width: '100%',
          padding: '14px 16px',
          borderRadius: tokens.radius.lg,
          border: 'none',
          background: loading || !newPassword || !confirmPassword
            ? 'var(--color-accent-primary-20)'
            : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          color: tokens.colors.white,
          fontWeight: 700,
          fontSize: 16,
          cursor: loading || !newPassword || !confirmPassword ? 'not-allowed' : 'pointer',
          marginBottom: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {loading && <Spinner />}
        {loading ? t('resetPasswordResetting') : t('resetPasswordButton')}
      </button>
    </>
  )
}
