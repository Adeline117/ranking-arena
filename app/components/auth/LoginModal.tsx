'use client'

/**
 * LoginModal - In-place login modal triggered by any protected action.
 *
 * Shows Google (primary), Email OTP, and Wallet login options.
 * Uses Supabase Auth directly (not Privy) so sessions work with useAuthSession.
 * Never redirects to /login — stays on current page.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import dynamic from 'next/dynamic'

const OneClickWalletButton = dynamic(
  () => import('@/lib/web3/wallet-components').then(m => ({ default: m.OneClickWalletButton })),
  { ssr: false }
)
const LazyWeb3Boundary = dynamic(
  () => import('@/lib/web3/wallet-components').then(m => ({ default: m.Web3Boundary })),
  { ssr: false }
)

type LoginStep = 'choose' | 'email-otp' | 'email-sent'

function TermsAgreement() {
  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--glass-border-light)' }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
        <span>
          By continuing, you agree to our{' '}
          <a href="/legal/terms" target="_blank" rel="noopener" style={{ color: 'var(--color-accent-primary)', textDecoration: 'underline' }}>Terms of Service</a>
          {' '}and{' '}
          <a href="/legal/privacy" target="_blank" rel="noopener" style={{ color: 'var(--color-accent-primary)', textDecoration: 'underline' }}>Privacy Policy</a>.
        </span>
      </label>
    </div>
  )
}

interface LoginModalProps {
  open: boolean
  onClose: () => void
  /** Optional message to show (e.g. "Log in to follow traders") */
  message?: string
}

export default function LoginModal({ open, onClose, message }: LoginModalProps) {
  const { t, language: _language } = useLanguage()
  const [step, setStep] = useState<LoginStep>('choose')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const emailRef = useRef<HTMLInputElement>(null)
  const otpRef = useRef<HTMLInputElement>(null)

  // Reset state when modal opens/closes
  useEffect(() => {
    if (open) {
      setStep('choose')
      setEmail('')
      setOtp('')
      setError('')
      setLoading(false)
    }
  }, [open])

  // Focus inputs
  useEffect(() => {
    if (step === 'email-otp' && emailRef.current) emailRef.current.focus()
    if (step === 'email-sent' && otpRef.current) otpRef.current.focus()
  }, [step])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleGoogle = useCallback(async () => {
    setError('')
    setLoading(true)

    // Detect in-app browsers
    const ua = navigator.userAgent || ''
    if (/Telegram|FBAN|FBAV|Instagram|Line\/|WeChat|MicroMessenger/i.test(ua)) {
      try { await navigator.clipboard.writeText(window.location.href) } catch { /* clipboard unavailable */ }
      setError(t('authInAppBrowserError'))
      setLoading(false)
      return
    }

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?returnUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      },
    })
    if (oauthError) {
      setError(oauthError.message)
      setLoading(false)
    }
  }, [t])

  const handleSendOTP = useCallback(async () => {
    if (!email.trim() || loading) return
    setError('')
    setLoading(true)

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    })

    setLoading(false)
    if (otpError) {
      setError(otpError.message)
    } else {
      setStep('email-sent')
    }
  }, [email, loading])

  const handleVerifyOTP = useCallback(async () => {
    if (!otp.trim() || loading) return
    setError('')
    setLoading(true)

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: otp.trim(),
      type: 'email',
    })

    setLoading(false)
    if (verifyError) {
      setError(verifyError.message)
    } else {
      // Auth state change will be picked up by useAuthSession
      onClose()
    }
  }, [email, otp, loading, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('login')}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: tokens.zIndex.modal,
        background: 'var(--color-backdrop-heavy, rgba(0,0,0,0.75))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        backdropFilter: tokens.glass.blur.xs,
        WebkitBackdropFilter: tokens.glass.blur.xs,
      }}
    >
      <div
        style={{
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--glass-border-medium)',
          borderRadius: tokens.radius.xl,
          padding: '32px 24px',
          width: '100%',
          maxWidth: 400,
          boxShadow: '0 24px 64px var(--color-overlay-dark, rgba(0,0,0,0.6))',
          position: 'relative',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 12, right: 12,
            background: 'none', border: 'none',
            color: 'var(--color-text-tertiary)', cursor: 'pointer',
            padding: 8, display: 'flex', minWidth: 44, minHeight: 44,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Step: Choose login method */}
        {step === 'choose' && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)', marginBottom: 6 }}>
                {t('authLoginTitle')}
              </div>
              {message && (
                <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                  {message}
                </div>
              )}
            </div>

            {/* Google - Primary */}
            <button
              onClick={handleGoogle}
              disabled={loading}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: tokens.radius.lg,
                border: '1px solid var(--glass-border-medium)',
                background: 'var(--glass-bg-light)',
                color: 'var(--color-text-primary)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                marginBottom: 10,
                opacity: loading ? 0.6 : 1,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {t('authGoogleLogin')}
            </button>

            {/* Email OTP */}
            <button
              onClick={() => setStep('email-otp')}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: tokens.radius.lg,
                border: '1px solid var(--glass-border-light)',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                fontWeight: 600, fontSize: 14, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                marginBottom: 10,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
              {t('authEmailCode')}
            </button>

            {/* Wallet */}
            <div style={{ marginTop: 4 }}>
              <LazyWeb3Boundary>
                <OneClickWalletButton
                  fullWidth
                  size="md"
                  onSuccess={() => onClose()}
                />
              </LazyWeb3Boundary>
            </div>

            <TermsAgreement />

            {error && (
              <div style={{ marginTop: 12, color: 'var(--color-accent-error)', fontSize: 13, textAlign: 'center' }}>
                {error}
              </div>
            )}
          </>
        )}

        {/* Step: Email input */}
        {step === 'email-otp' && (
          <>
            <button
              onClick={() => setStep('choose')}
              style={{
                background: 'none', border: 'none', color: 'var(--color-text-tertiary)',
                cursor: 'pointer', fontSize: 13, padding: '0 0 16px',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 18-6-6 6-6"/></svg>
              {t('authBack')}
            </button>

            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 16 }}>
              {t('authEnterEmail')}
            </div>

            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendOTP()}
              placeholder="you@email.com"
              style={{
                width: '100%', padding: '12px 14px', borderRadius: tokens.radius.lg,
                background: 'var(--glass-bg-light)',
                border: '1px solid var(--glass-border-medium)',
                color: 'var(--color-text-primary)', fontSize: 14,
                outline: 'none', boxSizing: 'border-box', marginBottom: 12,
              }}
            />

            <button
              onClick={handleSendOTP}
              disabled={loading || !email.trim()}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: tokens.radius.lg,
                background: tokens.gradient.primary,
                border: 'none', color: '#fff',
                fontWeight: 700, fontSize: 14,
                cursor: loading || !email.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !email.trim() ? 0.6 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              {loading && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" opacity={0.25} />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
              )}
              {loading
                ? t('authSending')
                : t('authSendCode')}
            </button>

            {error && (
              <div style={{ marginTop: 12, color: 'var(--color-accent-error)', fontSize: 13, textAlign: 'center' }}>
                {error}
              </div>
            )}
          </>
        )}

        {/* Step: Enter OTP */}
        {step === 'email-sent' && (
          <>
            <button
              onClick={() => setStep('email-otp')}
              style={{
                background: 'none', border: 'none', color: 'var(--color-text-tertiary)',
                cursor: 'pointer', fontSize: 13, padding: '0 0 16px',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m15 18-6-6 6-6"/></svg>
              {t('authBack')}
            </button>

            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>
              {t('authEnterCode')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 16 }}>
              {t('authCodeSentTo').replace('{email}', email)}
            </div>

            <input
              ref={otpRef}
              type="text"
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && handleVerifyOTP()}
              placeholder="000000"
              maxLength={6}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: tokens.radius.lg,
                background: 'var(--glass-bg-light)',
                border: '1px solid var(--glass-border-medium)',
                color: 'var(--color-text-primary)', fontSize: 20,
                fontWeight: 700, letterSpacing: 8, textAlign: 'center',
                outline: 'none', boxSizing: 'border-box', marginBottom: 12,
              }}
            />

            <button
              onClick={handleVerifyOTP}
              disabled={loading || otp.length < 6}
              style={{
                width: '100%', padding: '12px 16px', borderRadius: tokens.radius.lg,
                background: tokens.gradient.primary,
                border: 'none', color: '#fff',
                fontWeight: 700, fontSize: 14,
                cursor: loading || otp.length < 6 ? 'not-allowed' : 'pointer',
                opacity: loading || otp.length < 6 ? 0.6 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              {loading && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><circle cx="12" cy="12" r="10" opacity={0.25} /><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" /></svg>}
              {loading ? t('authVerifying') : t('authVerify')}
            </button>

            {error && (
              <div style={{ marginTop: 12, color: 'var(--color-accent-error)', fontSize: 13, textAlign: 'center' }}>
                {error}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
