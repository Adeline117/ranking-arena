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
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import dynamic from 'next/dynamic'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { requireProvisionedProfile } from '@/lib/auth/profile-provisioning'
import {
  assertVerifiedSessionSnapshotCurrent,
  isVerifiedSessionSnapshotCurrent,
  StaleVerifiedSessionError,
  verifySessionSnapshot,
  type VerifiedSessionSnapshot,
} from '@/lib/auth/verified-session'

const OneClickWalletButton = dynamic(
  () => import('@/lib/web3/wallet-components').then((m) => ({ default: m.OneClickWalletButton })),
  { ssr: false }
)
const LazyWeb3Boundary = dynamic(
  () => import('@/lib/web3/wallet-components').then((m) => ({ default: m.Web3Boundary })),
  { ssr: false }
)

type LoginStep = 'choose' | 'email-otp' | 'email-sent'

function TermsAgreement({ t }: { t: (key: string) => string }) {
  return (
    <div
      style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--glass-border-light)' }}
    >
      <div
        style={{
          fontSize: tokens.typography.fontSize.sm,
          color: 'var(--color-text-secondary)',
          lineHeight: 1.5,
        }}
      >
        {t('loginTermsNote')}{' '}
        <a
          href="/terms"
          target="_blank"
          rel="noopener"
          style={{
            color: 'var(--color-text-primary)',
            fontWeight: tokens.typography.fontWeight.semibold,
            textDecoration: 'underline',
            textDecorationThickness: '1px',
            textUnderlineOffset: 3,
          }}
        >
          {t('termsOfService')}
        </a>{' '}
        {t('loginTermsAnd')}{' '}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener"
          style={{
            color: 'var(--color-text-primary)',
            fontWeight: tokens.typography.fontWeight.semibold,
            textDecoration: 'underline',
            textDecorationThickness: '1px',
            textUnderlineOffset: 3,
          }}
        >
          {t('privacyPolicy')}
        </a>
        .
      </div>
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
  const [resendCooldown, setResendCooldown] = useState(0)
  const emailRef = useRef<HTMLInputElement>(null)
  const otpRef = useRef<HTMLInputElement>(null)
  const authAttemptGenerationRef = useRef(0)

  // Reset state when modal opens/closes
  useEffect(() => {
    authAttemptGenerationRef.current += 1
    if (open) {
      setStep('choose')
      setEmail('')
      setOtp('')
      setError('')
      setLoading(false)
      setResendCooldown(0)
    }
    return () => {
      authAttemptGenerationRef.current += 1
    }
  }, [open])

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCooldown])

  // Focus inputs
  useEffect(() => {
    if (step === 'email-otp' && emailRef.current) emailRef.current.focus()
    if (step === 'email-sent' && otpRef.current) otpRef.current.focus()
  }, [step])

  // scroll lock + escape + focus handled by ModalOverlay

  const handleGoogle = useCallback(async () => {
    setError('')
    setLoading(true)

    // Detect in-app browsers
    const ua = navigator.userAgent || ''
    if (/Telegram|FBAN|FBAV|Instagram|Line\/|WeChat|MicroMessenger/i.test(ua)) {
      try {
        await navigator.clipboard.writeText(window.location.href)
      } catch {
        /* clipboard unavailable */
      }
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
      const msg = otpError.message.toLowerCase()
      if (msg.includes('rate') || msg.includes('limit') || msg.includes('too many')) {
        setError(t('loginTimeout'))
      } else {
        setError(t('loginSendFailed'))
      }
    } else {
      setStep('email-sent')
    }
  }, [email, loading, t])

  const handleVerifyOTP = useCallback(async () => {
    if (!otp.trim() || loading) return
    const generation = ++authAttemptGenerationRef.current
    let authenticatedUserId: string | null = null
    let authenticatedAccessToken: string | null = null
    let snapshot: VerifiedSessionSnapshot | null = null
    setError('')
    setLoading(true)

    const rollbackOwnedSession = async (): Promise<boolean> => {
      if (!authenticatedUserId || !authenticatedAccessToken) return false
      return tokenRefreshCoordinator.signOutIfCurrent(authenticatedUserId, authenticatedAccessToken)
    }

    try {
      const { data, error: verifyError } = await tokenRefreshCoordinator.verifyOtp({
        email: email.trim(),
        token: otp.trim(),
        type: 'email',
      })

      if (verifyError || !data.session) {
        if (generation !== authAttemptGenerationRef.current) return
        const message = verifyError?.message.toLowerCase() ?? ''
        if (message.includes('expired') || message.includes('过期')) {
          setError(t('authCodeExpired'))
        } else {
          setError(t('authCodeInvalid'))
        }
        return
      }

      authenticatedUserId = data.session.user.id
      authenticatedAccessToken = data.session.access_token
      snapshot = await verifySessionSnapshot(supabase, data.session)
      if (generation !== authAttemptGenerationRef.current) {
        await rollbackOwnedSession()
        return
      }

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', snapshot.user.id)
        .maybeSingle()
      requireProvisionedProfile(profile, profileError)
      assertVerifiedSessionSnapshotCurrent(snapshot)
      if (generation !== authAttemptGenerationRef.current) {
        await rollbackOwnedSession()
        return
      }

      onClose()
    } catch (loginError) {
      const attemptStillOwnedFailure = snapshot ? isVerifiedSessionSnapshotCurrent(snapshot) : true
      const rolledBack = await rollbackOwnedSession()
      if (
        generation !== authAttemptGenerationRef.current ||
        loginError instanceof StaleVerifiedSessionError ||
        !attemptStillOwnedFailure ||
        !rolledBack
      ) {
        return
      }
      setError(t('loadUserDataFailed'))
    } finally {
      if (generation === authAttemptGenerationRef.current) setLoading(false)
    }
  }, [email, otp, loading, onClose, t])

  return (
    <ModalOverlay open={open} onClose={onClose} label={t('login')} maxWidth={400} backdrop="heavy">
      <div style={{ padding: '32px 24px', position: 'relative' }}>
        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: 'var(--color-text-tertiary)',
            cursor: 'pointer',
            padding: 8,
            display: 'flex',
            minWidth: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Step: Choose login method */}
        {step === 'choose' && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div
                style={{
                  fontSize: tokens.typography.fontSize.xl,
                  fontWeight: tokens.typography.fontWeight.extrabold,
                  color: 'var(--color-text-primary)',
                  marginBottom: 6,
                }}
              >
                {t('authLoginTitle')}
              </div>
              {message && (
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.sm,
                    color: 'var(--color-text-tertiary)',
                  }}
                >
                  {message}
                </div>
              )}
            </div>

            {/* Google - Primary */}
            <button
              onClick={handleGoogle}
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--glass-border-medium)',
                background: 'var(--glass-bg-light)',
                color: 'var(--color-text-primary)',
                fontWeight: tokens.typography.fontWeight.bold,
                fontSize: tokens.typography.fontSize.base,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                marginBottom: 10,
                opacity: loading ? 0.6 : 1,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              {t('authGoogleLogin')}
            </button>

            {/* Email OTP */}
            <button
              onClick={() => setStep('email-otp')}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--glass-border-light)',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                fontWeight: tokens.typography.fontWeight.semibold,
                fontSize: tokens.typography.fontSize.base,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                marginBottom: 10,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
              {t('authEmailCode')}
            </button>

            {/* Wallet */}
            <div style={{ marginTop: 4 }}>
              <LazyWeb3Boundary>
                <OneClickWalletButton fullWidth size="md" onSuccess={() => onClose()} />
              </LazyWeb3Boundary>
            </div>

            <TermsAgreement t={t} />

            {error && (
              <div
                style={{
                  marginTop: 12,
                  color: 'var(--color-accent-error)',
                  fontSize: tokens.typography.fontSize.sm,
                  textAlign: 'center',
                }}
              >
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
                background: 'none',
                border: 'none',
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                padding: '0 0 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
              {t('authBack')}
            </button>

            <div
              style={{
                fontSize: tokens.typography.fontSize.md,
                fontWeight: tokens.typography.fontWeight.bold,
                color: 'var(--color-text-primary)',
                marginBottom: 16,
              }}
            >
              {t('authEnterEmail')}
            </div>

            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendOTP()}
              placeholder="you@email.com"
              aria-required="true"
              aria-label={t('authEnterEmail')}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: tokens.radius.lg,
                background: 'var(--glass-bg-light)',
                border: '1px solid var(--glass-border-medium)',
                color: 'var(--color-text-primary)',
                fontSize: tokens.typography.fontSize.md,
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 12,
              }}
            />

            <button
              onClick={handleSendOTP}
              disabled={loading || !email.trim()}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: tokens.radius.lg,
                background: tokens.gradient.primary,
                border: 'none',
                color: 'var(--color-on-accent)',
                fontWeight: tokens.typography.fontWeight.bold,
                fontSize: tokens.typography.fontSize.base,
                cursor: loading || !email.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !email.trim() ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {loading && (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  style={{ animation: 'spin 1s linear infinite' }}
                >
                  <circle cx="12" cy="12" r="10" opacity={0.25} />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
              )}
              {loading ? t('authSending') : t('authSendCode')}
            </button>

            {error && (
              <div
                style={{
                  marginTop: 12,
                  color: 'var(--color-accent-error)',
                  fontSize: tokens.typography.fontSize.sm,
                  textAlign: 'center',
                }}
              >
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
                background: 'none',
                border: 'none',
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                padding: '0 0 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
              {t('authBack')}
            </button>

            <div
              style={{
                fontSize: tokens.typography.fontSize.md,
                fontWeight: tokens.typography.fontWeight.bold,
                color: 'var(--color-text-primary)',
                marginBottom: 4,
              }}
            >
              {t('authEnterCode')}
            </div>
            <div
              style={{
                fontSize: tokens.typography.fontSize.sm,
                color: 'var(--color-text-tertiary)',
                marginBottom: 16,
              }}
            >
              {t('authCodeSentTo').replace('{email}', email)}
            </div>

            <input
              ref={otpRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && handleVerifyOTP()}
              placeholder="000000"
              maxLength={6}
              aria-required="true"
              aria-label={t('authEnterCode')}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: tokens.radius.lg,
                background: 'var(--glass-bg-light)',
                border: '1px solid var(--glass-border-medium)',
                color: 'var(--color-text-primary)',
                fontSize: tokens.typography.fontSize.xl,
                fontWeight: tokens.typography.fontWeight.bold,
                letterSpacing: 8,
                textAlign: 'center',
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 12,
              }}
            />

            <button
              onClick={handleVerifyOTP}
              disabled={loading || otp.length < 6}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: tokens.radius.lg,
                background: tokens.gradient.primary,
                border: 'none',
                color: 'var(--color-on-accent)',
                fontWeight: tokens.typography.fontWeight.bold,
                fontSize: tokens.typography.fontSize.base,
                cursor: loading || otp.length < 6 ? 'not-allowed' : 'pointer',
                opacity: loading || otp.length < 6 ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {loading && (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  style={{ animation: 'spin 1s linear infinite' }}
                >
                  <circle cx="12" cy="12" r="10" opacity={0.25} />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
              )}
              {loading ? t('authVerifying') : t('authVerify')}
            </button>

            <button
              onClick={() => {
                setResendCooldown(30)
                setOtp('')
                setError('')
                handleSendOTP()
              }}
              disabled={resendCooldown > 0 || loading}
              style={{
                width: '100%',
                padding: '8px 16px',
                borderRadius: tokens.radius.lg,
                background: 'none',
                border: '1px solid var(--glass-border-medium)',
                color:
                  resendCooldown > 0 ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
                fontWeight: tokens.typography.fontWeight.medium,
                fontSize: tokens.typography.fontSize.sm,
                cursor: resendCooldown > 0 || loading ? 'not-allowed' : 'pointer',
                marginTop: 8,
              }}
            >
              {resendCooldown > 0
                ? `${t('authResendCode')} (${resendCooldown}s)`
                : t('authResendCode')}
            </button>

            {error && (
              <div
                style={{
                  marginTop: 12,
                  color: 'var(--color-accent-error)',
                  fontSize: tokens.typography.fontSize.sm,
                  textAlign: 'center',
                }}
              >
                {error}
              </div>
            )}
          </>
        )}
      </div>
    </ModalOverlay>
  )
}
