'use client'

import { useState, useEffect, Suspense, useRef } from 'react'
import { supabase } from "@/lib/supabase/client"
import { useRouter, useSearchParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// CSS keyframe animations
const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('reset-password-styles')) return
  
  const style = document.createElement('style')
  style.id = 'reset-password-styles'
  style.textContent = `
    @keyframes resetGradient {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    
    @keyframes cardEnter {
      from { 
        opacity: 0; 
        transform: translateY(30px) scale(0.95); 
        filter: blur(10px);
      }
      to { 
        opacity: 1; 
        transform: translateY(0) scale(1); 
        filter: blur(0);
      }
    }
    
    @keyframes inputFocus {
      0% { box-shadow: 0 0 0 0 var(--color-accent-primary-40); }
      100% { box-shadow: 0 0 0 4px var(--color-accent-primary-10); }
    }
    
    @keyframes buttonPulse {
      0%, 100% { box-shadow: 0 4px 20px var(--color-accent-primary-30); }
      50% { box-shadow: 0 4px 30px var(--color-accent-primary-60); }
    }
    
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
      20%, 40%, 60%, 80% { transform: translateX(4px); }
    }
    
    @keyframes spinLoader {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    @keyframes successPop {
      0% { transform: scale(0.8); opacity: 0; }
      50% { transform: scale(1.05); }
      100% { transform: scale(1); opacity: 1; }
    }
    
    @keyframes floatParticle {
      0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.3; }
      50% { transform: translateY(-20px) rotate(180deg); opacity: 0.5; }
    }
    
    .reset-page-bg {
      position: fixed;
      inset: 0;
      background: var(--color-bg-primary);
      z-index: 0;
    }
    
    .reset-page-bg::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at center, var(--color-accent-primary-08) 0%, transparent 50%);
      animation: resetGradient 20s ease infinite;
    }
    
    .reset-card {
      animation: cardEnter 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    
    .reset-input {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .reset-input:focus {
      border-color: var(--color-brand) !important;
      animation: inputFocus 0.3s ease forwards;
      background: var(--color-accent-primary-08) !important;
    }
    
    .reset-button {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .reset-button:not(:disabled):hover {
      transform: translateY(-2px);
      animation: buttonPulse 2s ease infinite;
    }
    
    .reset-button:not(:disabled):active {
      transform: translateY(0) scale(0.98);
    }
    
    .error-shake {
      animation: shake 0.5s ease;
    }
    
    .success-message {
      animation: successPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }
    
    .lang-btn {
      transition: all 0.2s ease;
    }
    
    .lang-btn:hover {
      transform: translateY(-1px);
    }
    
    .floating-particle {
      position: absolute;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--color-accent-primary-30), var(--color-accent-primary-10));
      animation: floatParticle 6s ease-in-out infinite;
    }
    
    .loader-spin {
      animation: spinLoader 1s linear infinite;
    }
    
    .link-hover {
      position: relative;
      transition: all 0.2s ease;
    }
    
    .link-hover::after {
      content: '';
      position: absolute;
      bottom: -2px;
      left: 0;
      width: 0;
      height: 1px;
      background: var(--color-brand);
      transition: width 0.3s ease;
    }
    
    .link-hover:hover::after {
      width: 100%;
    }
    
    .password-toggle {
      transition: all 0.2s ease;
    }
    
    .password-toggle:hover {
      color: var(--color-brand) !important;
    }
  `
  document.head.appendChild(style)
}

// Password strength indicator
function getPasswordStrength(password: string): { level: 0 | 1 | 2 | 3 | 4; labelKey: string; color: string } {
  if (!password) return { level: 0, labelKey: '', color: '' }

  let score = 0
  if (password.length >= 6) score++
  if (password.length >= 8) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++

  if (score <= 1) return { level: 1, labelKey: 'loginPasswordWeak', color: tokens.colors.accent.error }
  if (score === 2) return { level: 2, labelKey: 'loginPasswordFair', color: tokens.colors.accent.warning }
  if (score === 3) return { level: 3, labelKey: 'loginPasswordGood', color: tokens.colors.accent.warning }
  return { level: 4, labelKey: 'loginPasswordStrong', color: tokens.colors.accent.success }
}

function ResetPasswordContent() {
  const { language: lang, setLanguage: setLang, t } = useLanguage()
  const [email, setEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [isResetMode, setIsResetMode] = useState(false)
  const [mounted, setMounted] = useState(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const _searchParams = useSearchParams()

  const passwordStrength = getPasswordStrength(newPassword)

  useEffect(() => {
    injectStyles()
    setMounted(true)
    // Language persistence is handled by LanguageProvider
  }, [])

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.substring(1))
    const accessToken = hashParams.get('access_token')
    const type = hashParams.get('type')
    
    if (accessToken && type === 'recovery') {
      setIsResetMode(true)
    }

     
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, _session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsResetMode(true)
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // Shake error box when error changes
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.classList.remove('error-shake')
      void errorRef.current.offsetWidth
      errorRef.current.classList.add('error-shake')
    }
  }, [error])

  const handleSendResetEmail = async () => {
    if (!email) {
      setError(t('resetPasswordEmailRequired'))
      return
    }

    setError(null)
    setSuccess(null)
    setLoading(true)

    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })

      if (resetError) {
        setError(resetError.message)
        return
      }

      setSuccess(t('resetPasswordEmailSent'))
      setCountdown(60)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loginSendFailedShort'))
    } finally {
      setLoading(false)
    }
  }

  const handleResetPassword = async () => {
    if (!newPassword) {
      setError(t('resetPasswordPasswordRequired'))
      return
    }

    if (newPassword.length < 6) {
      setError(t('resetPasswordPasswordMinLength'))
      return
    }

    if (newPassword !== confirmPassword) {
      setError(t('resetPasswordMismatch'))
      return
    }

    setError(null)
    setSuccess(null)
    setLoading(true)

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      })

      if (updateError) {
        setError(updateError.message)
        return
      }

      setSuccess(t('resetPasswordSuccess'))

      setTimeout(() => {
        router.push('/login')
      }, 3000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loginResetFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Loading spinner component
  const Spinner = () => (
    <svg className="loader-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  )

  if (!mounted) return null

  return (
    <div style={{ 
      minHeight: '100vh', 
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Animated background */}
      <div className="reset-page-bg" />
      
      {/* Floating particles */}
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="floating-particle"
          style={{
            width: 6 + i * 3,
            height: 6 + i * 3,
            left: `${15 + i * 18}%`,
            top: `${25 + (i % 3) * 20}%`,
            animationDelay: `${i * 0.6}s`,
            animationDuration: `${5 + i}s`,
          }}
        />
      ))}
      
      <div 
        className="reset-card"
        style={{ 
          maxWidth: 440, 
          width: '100%',
          background: 'var(--color-backdrop-heavy)',
          border: '1px solid var(--color-accent-primary-15)',
          borderRadius: tokens.radius['3xl'],
          padding: '40px 36px',
          position: 'relative',
          zIndex: 1,
          boxShadow: '0 25px 50px -12px var(--color-overlay-dark), 0 0 80px var(--color-accent-primary-08)',
        }}
      >
        {/* Language selector */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'flex-end', 
          marginBottom: 28,
          gap: 8,
        }}>
          <button
            className="lang-btn"
            onClick={() => setLang('zh')}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: lang === 'zh' ? '1px solid var(--color-accent-primary-60)' : '1px solid var(--glass-border-light)',
              background: lang === 'zh' ? 'var(--color-accent-primary-15)' : 'transparent',
              color: lang === 'zh' ? 'var(--color-brand-accent)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontWeight: lang === 'zh' ? 700 : 500,
              fontSize: 13,
            }}
          >
            {t('chinese')}
          </button>
          <button
            className="lang-btn"
            onClick={() => setLang('en')}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: lang === 'en' ? '1px solid var(--color-accent-primary-60)' : '1px solid var(--glass-border-light)',
              background: lang === 'en' ? 'var(--color-accent-primary-15)' : 'transparent',
              color: lang === 'en' ? 'var(--color-brand-accent)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontWeight: lang === 'en' ? 700 : 500,
              fontSize: 13,
            }}
          >
            EN
          </button>
        </div>

        {/* Icon */}
        <div style={{ 
          textAlign: 'center', 
          marginBottom: 24,
        }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-primary-20) 0%, var(--color-accent-primary-10) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto',
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isResetMode ? (
                <>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </>
              ) : (
                <>
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                  <polyline points="22,6 12,13 2,6"></polyline>
                </>
              )}
            </svg>
          </div>
        </div>

        {/* Title */}
        <h1 style={{ 
          fontSize: tokens.typography.fontSize['2xl'], 
          marginBottom: 8, 
          fontWeight: tokens.typography.fontWeight.extrabold,
          textAlign: 'center',
          background: 'linear-gradient(135deg, var(--color-text-primary) 0%, var(--color-brand-accent) 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          {isResetMode ? t('resetPasswordSetNew') : t('resetPasswordTitle')}
        </h1>

        <p style={{
          fontSize: 14,
          color: tokens.colors.text.secondary,
          marginBottom: 28,
          textAlign: 'center',
        }}>
          {isResetMode ? t('resetPasswordSetNewDesc') : t('resetPasswordDescription')}
        </p>

        {!isResetMode ? (
          // Send reset email form
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
                    handleSendResetEmail()
                  }
                }}
              />
            </div>

            <button
              onClick={handleSendResetEmail}
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
        ) : (
          // Set new password form
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
                      handleResetPassword()
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
              onClick={handleResetPassword}
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
        )}

        {/* Back to login */}
        <Link
          href="/login"
          className="link-hover"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: 'var(--color-brand)',
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"></line>
            <polyline points="12 19 5 12 12 5"></polyline>
          </svg>
          {t('resetPasswordBackToLogin')}
        </Link>

        {/* Error message */}
        {error && (
          <div 
            ref={errorRef}
            style={{ 
              marginTop: 20,
              padding: 14,
              borderRadius: tokens.radius.lg,
              background: 'var(--color-accent-error-10)',
              border: '1px solid var(--color-accent-error-20)',
              color: tokens.colors.accent.error,
              fontSize: 13,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        {/* Success message */}
        {success && (
          <div 
            className="success-message"
            style={{ 
              marginTop: 20,
              padding: 14,
              borderRadius: tokens.radius.lg,
              background: 'var(--color-accent-success-10)',
              border: '1px solid var(--color-accent-success-20)',
              color: tokens.colors.accent.success,
              fontSize: 13,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            {success}
          </div>
        )}
      </div>
    </div>
  )
}

// Wrap with Suspense
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div style={{ 
        minHeight: '100vh', 
        background: tokens.colors.bg.primary, 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          width: 40,
          height: 40,
          border: '3px solid var(--color-accent-primary-20)',
          borderTopColor: 'var(--color-brand)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    }>
      <ResetPasswordContent />
    </Suspense>
  )
}
