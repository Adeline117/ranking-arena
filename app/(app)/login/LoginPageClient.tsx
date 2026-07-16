'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { useRouter, useSearchParams } from 'next/navigation'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { logger } from '@/lib/logger'
import { useMultiAccountStore } from '@/lib/stores/multiAccountStore'
import { injectStyles, validateEmail, getPasswordStrength } from './components/loginHelpers'
import { trackEvent } from '@/lib/analytics/track'
import { authedFetch } from '@/lib/api/client'
import { peekPendingReferral } from '@/lib/referral/pending'
import SocialLogin from './components/SocialLogin'
import RegisterForm from './components/RegisterForm'
import LoginForm from './components/LoginForm'
import { formatRankedTraderCount } from '@/lib/config/product-facts'
import { useProductFacts } from '@/lib/hooks/useProductFacts'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'

export default function LoginPageClient() {
  const { language: lang, t } = useLanguage()
  const { signOut } = useAuthSession()
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [handle, setHandle] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [codeVerified, setCodeVerified] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [countdown, setCountdown] = useState(() => {
    if (typeof window === 'undefined') return 0
    const savedEnd = Number(sessionStorage.getItem('otp_countdown_end') || 0)
    const remaining = Math.max(0, Math.ceil((savedEnd - Date.now()) / 1000))
    return remaining > 0 ? remaining : 0
  })
  const [loginWithCode, setLoginWithCode] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [accountRecoveryToken, setAccountRecoveryToken] = useState<string | null>(null)
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0)

  const [touchedFields, setTouchedFields] = useState<{
    email: boolean
    password: boolean
    handle: boolean
  }>({ email: false, password: false, handle: false })

  const errorRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)
  const verifyingOtpRef = useRef(false)
  const otpAttemptsRef = useRef(0)
  const [otpLocked, setOtpLocked] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const productFacts = useProductFacts()

  const isAddAccount = searchParams.get('addAccount') === 'true'

  const saveNewAccountToStore = useCallback(async () => {
    if (!isAddAccount && !localStorage.getItem('arena_adding_account')) return
    localStorage.removeItem('arena_adding_account')

    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) return

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle, avatar_url')
      .eq('id', user.id)
      .maybeSingle()

    const store = useMultiAccountStore.getState()
    store.accounts.forEach((a) => {
      if (a.isActive) {
        store.addAccount({ ...a, isActive: false })
      }
    })
    store.addAccount({
      userId: user.id,
      email: user.email || '',
      handle: profile?.handle || null,
      avatarUrl: profile?.avatar_url || null,
      refreshToken: session.refresh_token,
      lastActiveAt: new Date().toISOString(),
      isActive: true,
    })
  }, [isAddAccount])

  const getRedirectUrl = useCallback(
    (_userHandle?: string | null, _userEmail?: string | null): string => {
      if (isAddAccount || localStorage.getItem('arena_adding_account')) {
        return '/'
      }
      const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect')
      if (returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
        return returnUrl
      }
      // Default to homepage — the ranking table is the main content on /
      return '/'
    },
    [searchParams, isAddAccount]
  )

  const emailValidation = validateEmail(email)

  const markTouched = (field: 'email' | 'password' | 'handle') => {
    setTouchedFields((prev) => ({ ...prev, [field]: true }))
  }

  useEffect(() => {
    injectStyles()
    setMounted(true)
    // Show error from auth callback redirect or OAuth provider errors
    const errorParam = searchParams.get('error')
    if (errorParam === 'auth_failed') {
      setError(t('loginAuthFailed'))
    } else if (errorParam === 'no_session') {
      setError(t('loginNoSession'))
    } else if (errorParam) {
      // Generic error from OAuth callback or other redirects (e.g. provider cancelled)
      setError(decodeURIComponent(errorParam))
    }
    const storedRecoveryToken = localStorage.getItem('arena_account_recovery_token')
    if (searchParams.get('recover') === '1' && storedRecoveryToken) {
      setAccountRecoveryToken(storedRecoveryToken)
      setError(t('loginAccountPendingDeletion'))
      setShowRecoveryPrompt(true)
    }
    // If user is already logged in, redirect them away from the login page
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session && !isAddAccount) {
        router.replace(getRedirectUrl())
      }
    })
  }, [router, searchParams, t, isAddAccount, getRedirectUrl])

  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.classList.remove('error-shake')
      void errorRef.current.offsetWidth
      errorRef.current.classList.add('error-shake')
    }
  }, [error])

  useEffect(() => {
    let redirected = false
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (
        event === 'SIGNED_IN' &&
        session &&
        !isRegister &&
        !codeVerified &&
        !redirected &&
        !verifyingOtpRef.current &&
        !submittingRef.current
      ) {
        redirected = true
        saveNewAccountToStore()
          .then(() => {
            supabase.auth
              .getUser()
              .then(({ data: { user } }) => {
                if (user) {
                  Promise.resolve(
                    supabase.from('user_profiles').select('handle').eq('id', user.id).maybeSingle()
                  ).then(
                    ({ data: userProfile }) => {
                      router.push(getRedirectUrl(userProfile?.handle, user.email))
                    },
                    () => {
                      router.push(getRedirectUrl())
                    }
                  )
                } else {
                  router.push(getRedirectUrl())
                }
              })
              .catch(() => {
                router.push(getRedirectUrl())
              })
          })
          .catch(() => {
            router.push(getRedirectUrl())
          })
      }
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [router, isRegister, codeVerified, getRedirectUrl, saveNewAccountToStore])

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  useEffect(() => {
    if (rateLimitCountdown > 0) {
      const timer = setTimeout(() => setRateLimitCountdown(rateLimitCountdown - 1), 1000)
      return () => clearTimeout(timer)
    } else if (rateLimitCountdown === 0) {
      // Clear rate limit error when countdown reaches 0
      setError((prev) =>
        prev &&
        (prev.includes('Too many attempts') ||
          prev.includes('操作过于频繁') ||
          prev.includes('Try again in') ||
          prev.includes('秒后重试'))
          ? null
          : prev
      )
    }
  }, [rateLimitCountdown])

  // Auth handlers
  const handleSendCode = async () => {
    if (submittingRef.current || sendingCode) return
    if (!email) {
      setError(t('loginPleaseEnterEmail'))
      return
    }
    submittingRef.current = true
    setError(null)
    setSendingCode(true)

    // 15-second timeout — Supabase OTP delivery can hang on slow networks
    const timeoutId = setTimeout(() => {
      setError(t('loginTimeout'))
      setSendingCode(false)
      submittingRef.current = false
    }, 15_000)

    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      })
      clearTimeout(timeoutId)
      if (otpError) {
        setError(
          otpError.message.includes('redirect') || otpError.message.includes('link')
            ? t('loginConfigError')
            : t('loginSendFailed')
        )
        setSendingCode(false)
        return
      }
      if (data) {
        setCodeSent(true)
        setCountdown(60)
        sessionStorage.setItem('otp_countdown_end', String(Date.now() + 60000))
        otpAttemptsRef.current = 0
        setOtpLocked(false)
        showToast(t('loginCodeSent'), 'success')
      } else {
        setError(t('loginSendFailed'))
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      logger.error('Login OTP error:', err)
      setError(t('loginSendFailedNetwork'))
    } finally {
      clearTimeout(timeoutId)
      setSendingCode(false)
      submittingRef.current = false
    }
  }

  const handleSendLoginCode = async () => {
    if (submittingRef.current || sendingCode) return
    if (!email) {
      setError(t('loginPleaseEnterEmail'))
      return
    }
    submittingRef.current = true
    setError(null)
    setSendingCode(true)

    // 15-second timeout — matches handleSendCode pattern
    const timeoutId = setTimeout(() => {
      setError(t('loginTimeout'))
      setSendingCode(false)
      submittingRef.current = false
    }, 15_000)

    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      })
      clearTimeout(timeoutId)
      if (otpError) {
        const msg = otpError.message.toLowerCase()
        // Account-enumeration safety: never reveal whether an email is registered.
        // "signup disabled / not found" is treated the same as success (neutral
        // "code sent"), matching the reset-password flow. Real failures (rate
        // limit, network) still surface so the user can react.
        if (msg.includes('signup') || msg.includes('not allowed') || msg.includes('not found')) {
          setCodeSent(true)
          setCountdown(60)
          sessionStorage.setItem('otp_countdown_end', String(Date.now() + 60000))
          otpAttemptsRef.current = 0
          setOtpLocked(false)
          showToast(t('loginCodeSent'), 'success')
        } else {
          setError(t('loginSendFailedShort'))
        }
        setSendingCode(false)
        return
      }
      if (data) {
        setCodeSent(true)
        setCountdown(60)
        sessionStorage.setItem('otp_countdown_end', String(Date.now() + 60000))
        otpAttemptsRef.current = 0
        setOtpLocked(false)
        showToast(t('loginCodeSent'), 'success')
      } else {
        setError(t('loginSendFailedShort'))
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      logger.error('Login OTP error:', err)
      setError(t('loginSendFailedSimple'))
    } finally {
      clearTimeout(timeoutId)
      setSendingCode(false)
      submittingRef.current = false
    }
  }

  const handleVerifyCode = async () => {
    if (submittingRef.current || loading) return
    if (otpLocked) {
      setError(t('loginTooManyAttemptsCode'))
      return
    }
    if (!code) {
      setError(t('loginPleaseEnterCode'))
      return
    }
    submittingRef.current = true
    verifyingOtpRef.current = true
    setError(null)
    setLoading(true)

    // 15-second timeout — OTP verification can hang on poor connections
    const timeoutId = setTimeout(() => {
      setError(t('loginTimeout'))
      setLoading(false)
      submittingRef.current = false
      verifyingOtpRef.current = false
    }, 15_000)

    try {
      const { data, error: verifyError } = await tokenRefreshCoordinator.verifyOtp({
        email,
        token: code,
        type: 'email',
      })
      clearTimeout(timeoutId)
      if (verifyError) {
        otpAttemptsRef.current++
        if (otpAttemptsRef.current >= 5) {
          setOtpLocked(true)
          setError(t('loginTooManyAttemptsCode'))
        } else if (
          verifyError.message.includes('expired') ||
          verifyError.message.includes('过期')
        ) {
          setError(t('loginCodeExpired'))
        } else {
          setError(t('loginVerificationFailed'))
        }
        setLoading(false)
        return
      }
      if (data.user) {
        if (isRegister) {
          setCodeVerified(true)
          await createUserProfile(data.user.id, email)
          showToast(t('loginCodeVerified'), 'success')
        } else {
          trackEvent('login')
          await saveNewAccountToStore()
          const { data: userProfile } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('id', data.user.id)
            .maybeSingle()
          router.push(getRedirectUrl(userProfile?.handle, data.user.email))
        }
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      const errMsg = err instanceof Error ? err.message : undefined
      setError(
        errMsg?.includes('expired') || errMsg?.includes('过期')
          ? t('loginCodeExpired')
          : errMsg || t('loginVerificationFailed')
      )
    } finally {
      clearTimeout(timeoutId)
      setLoading(false)
      submittingRef.current = false
      verifyingOtpRef.current = false
    }
  }

  const createUserProfile = async (userId: string, userEmail: string, userHandle?: string) => {
    try {
      const finalHandle = userHandle || userEmail.split('@')[0]
      const updateData: Record<string, string> = { id: userId, email: userEmail }
      if (userHandle) {
        updateData.handle = finalHandle
      } else {
        const { data: existingProfile } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', userId)
          .maybeSingle()
        if (!existingProfile || !existingProfile.handle) updateData.handle = finalHandle
      }
      // Sync OAuth avatar if available and not already set
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()
        const meta = user?.user_metadata
        const oauthAvatar = meta?.avatar_url || meta?.picture || null
        if (oauthAvatar) {
          const { data: existing } = await supabase
            .from('user_profiles')
            .select('avatar_url')
            .eq('id', userId)
            .maybeSingle()
          if (!existing?.avatar_url) {
            updateData.avatar_url = oauthAvatar
          }
        }
      } catch {
        /* avatar sync is best-effort */
      }
      // Capture UTM parameters for attribution
      const utmSource = searchParams.get('utm_source')
      const utmMedium = searchParams.get('utm_medium')
      const utmCampaign = searchParams.get('utm_campaign')
      if (utmSource) updateData.utm_source = utmSource
      if (utmMedium) updateData.utm_medium = utmMedium
      if (utmCampaign) updateData.utm_campaign = utmCampaign
      await supabase.from('user_profiles').upsert(updateData, { onConflict: 'id' })

      // Referral attribution + reward are handled server-side by
      // /api/referral/apply (sets referred_by, counts toward the threshold,
      // grants the friend trial + the advocate's Pro at the threshold). We do
      // NOT set referred_by directly here so the apply route stays the single,
      // idempotent source of truth — it rejects a second apply once referred_by
      // is set, which is what prevents double-counting / double-granting.
      // Best-effort: never block signup on referral attribution.
      // Fall back to a pending ref captured on a prior (Provider-less) page —
      // e.g. the homepage — so the same-page email signup path still applies it.
      // The apply route is idempotent, so overlap with ReferralAutoApply is safe.
      const refCode = searchParams.get('ref') || peekPendingReferral()
      if (refCode) {
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession()
          if (session?.access_token) {
            await authedFetch('/api/referral/apply', 'POST', session.access_token, {
              code: refCode,
            })
          }
        } catch (refErr) {
          logger.error('Referral apply failed (non-fatal):', refErr)
        }
      }
    } catch (err) {
      logger.error('Error creating profile:', err)
    }
  }

  const handleSetPassword = async () => {
    if (submittingRef.current || loading) return
    // Password floor: minimum 8 chars AND strength at least "fair" (level >= 2).
    // The strength meter is the real gate — block weak passwords, not just short ones.
    if (!password || password.length < 8 || getPasswordStrength(password).level < 2) {
      setError(t('loginPasswordMinLength'))
      return
    }
    if (!handle || handle.length < 1) {
      setError(t('loginHandleMinLength'))
      return
    }
    submittingRef.current = true
    setError(null)
    setLoading(true)
    try {
      const {
        data: { user },
        error: updateError,
      } = await tokenRefreshCoordinator.updateUser({ password })
      if (updateError) {
        setError(t('loginVerificationFailed'))
        setLoading(false)
        return
      }
      if (user) {
        const { data: existingProfile } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', user.id)
          .maybeSingle()
        if (existingProfile && existingProfile.handle !== handle) {
          const { error: updateError } = await supabase
            .from('user_profiles')
            .update({ handle })
            .eq('id', user.id)
          if (updateError) logger.error('Error updating handle:', updateError)
        }
        await createUserProfile(user.id, email, handle)
        // Count signup only after the profile/handle step is complete. OTP
        // verification alone can still be abandoned before onboarding.
        trackEvent('signup')
        // 欢迎邮件(2026-07-11 上线审计):OTP 主注册路径不经 auth/callback,
        // 此前 /api/email/welcome 从不触发 → 精心写的首触邮件白做。这里是
        // 无歧义的新用户点,fire-and-forget 补发(端点自身按 created_at<2min
        // replay 窗口兜底;OAuth 走 callback、OTP 走这里,路径不相交不重复)。
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (session?.access_token) {
            fetch('/api/email/welcome', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
              },
              // eslint-disable-next-line no-restricted-syntax
            }).catch(() => {
              /* intentional: fire-and-forget */
            })
          }
        })
        // Brand-new email signup → route through the full /onboarding activation
        // flow (onboarding_completed is still false). The original destination is
        // preserved as returnUrl so onboarding (or Skip) lands them back there.
        const dest = getRedirectUrl(handle, email)
        router.push(`/onboarding?returnUrl=${encodeURIComponent(dest)}`)
      } else {
        router.push(getRedirectUrl())
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : undefined) || t('loginSetupFailed'))
    } finally {
      setLoading(false)
      submittingRef.current = false
    }
  }

  const handleLogin = async () => {
    if (submittingRef.current || loading) return
    submittingRef.current = true
    setError(null)
    setLoading(true)

    // 10-second timeout — allows retry without page refresh
    const timeoutId = setTimeout(() => {
      setError(t('loginTimeout'))
      setLoading(false)
      submittingRef.current = false
    }, 10_000)

    try {
      // When adding a second account, sign out current session first
      if (isAddAccount) {
        await signOut()
      }
      const { error: loginError } = await tokenRefreshCoordinator.signInWithPassword({
        email,
        password,
      })
      if (loginError) {
        clearTimeout(timeoutId)
        const msg = loginError.message
        if (msg.includes('Invalid login credentials')) setError(t('loginIncorrectCredentials'))
        else if (msg.includes('Email not confirmed')) setError(t('loginEmailNotVerified'))
        else if (msg.includes('Too many requests') || msg.includes('rate limit')) {
          const RATE_LIMIT_SECONDS = 30
          setRateLimitCountdown(RATE_LIMIT_SECONDS)
          setError(t('loginRateLimitRetry').replace('{n}', String(RATE_LIMIT_SECONDS)))
        } else if (msg.toLowerCase().includes('banned')) {
          setError(t('loginAccountPendingDeletion'))
          setShowRecoveryPrompt(true)
        } else setError(msg)
        setLoading(false)
        return
      }
      clearTimeout(timeoutId)
      await saveNewAccountToStore()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (user) {
        const { data: userProfile } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', user.id)
          .maybeSingle()
        router.push(getRedirectUrl(userProfile?.handle, user.email))
      } else {
        router.push(getRedirectUrl())
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      setError((err instanceof Error ? err.message : undefined) || t('loginFailed'))
    } finally {
      clearTimeout(timeoutId)
      setLoading(false)
      submittingRef.current = false
    }
  }

  const resetForm = () => {
    setCode('')
    setCodeSent(false)
    setCodeVerified(false)
    setPassword('')
    setHandle('')
    setCountdown(0)
    sessionStorage.removeItem('otp_countdown_end')
    setError(null)
    setLoginWithCode(false)
    otpAttemptsRef.current = 0
    setOtpLocked(false)
    setShowRecoveryPrompt(false)
    setTouchedFields({ email: false, password: false, handle: false })
  }

  const handleRecoverAccount = async () => {
    if (recovering || (!accountRecoveryToken && (!email || !password))) return
    setRecovering(true)
    setError(null)
    try {
      const res = await fetch('/api/account/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          accountRecoveryToken ? { recovery_token: accountRecoveryToken } : { email, password }
        ),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setShowRecoveryPrompt(false)
        showToast(t('loginAccountRecovered'), 'success')
        if (accountRecoveryToken) {
          localStorage.removeItem('arena_account_recovery_token')
          setAccountRecoveryToken(null)
          setError(null)
          return
        }
        // Now sign in normally since the ban has been lifted
        const { error: loginError } = await tokenRefreshCoordinator.signInWithPassword({
          email,
          password,
        })
        if (loginError) {
          setError(loginError.message)
        } else {
          await saveNewAccountToStore()
          const {
            data: { user },
          } = await supabase.auth.getUser()
          if (user) {
            const { data: userProfile } = await supabase
              .from('user_profiles')
              .select('handle')
              .eq('id', user.id)
              .maybeSingle()
            router.push(getRedirectUrl(userProfile?.handle, user.email))
          } else {
            router.push(getRedirectUrl())
          }
        }
      } else {
        setError(data.error || t('loginRecoveryFailed'))
      }
    } catch (err) {
      logger.error('Account recovery error:', err)
      setError(t('networkErrorRetry'))
    } finally {
      setRecovering(false)
    }
  }

  if (!mounted) return null

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div className="login-page-bg" />

      <div
        className="login-card"
        style={{
          maxWidth: 440,
          width: '100%',
          background: 'var(--color-bg-secondary, var(--color-backdrop-heavy))',
          border: '1px solid var(--color-accent-primary-15)',
          borderRadius: tokens.radius['3xl'],
          padding: 'clamp(24px, 5vw, 40px) clamp(20px, 4vw, 36px)',
          position: 'relative',
          zIndex: 1,
          boxShadow:
            '0 25px 50px -12px var(--color-overlay-dark), 0 0 80px var(--color-accent-primary-08)',
        }}
      >
        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize['2xl'],
              fontWeight: tokens.typography.fontWeight.extrabold,
              marginBottom: 8,
              background:
                'linear-gradient(135deg, var(--color-text-primary) 0%, var(--color-brand-accent) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            {isRegister ? t('loginCreateAccount') : t('loginWelcomeBack')}
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, fontWeight: 500 }}>
            {t('loginSubtitle')}
          </p>
        </div>

        {/* Value / trust panel — reuses existing marketing copy keys */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginBottom: 24,
            padding: '14px 16px',
            borderRadius: tokens.radius.lg,
            background: 'var(--color-accent-primary-08)',
            border: '1px solid var(--color-accent-primary-15)',
          }}
        >
          {[
            t('loginValueProp1').replace(
              '{count}',
              formatRankedTraderCount(productFacts.rankedTraderCount, lang)
            ),
            t('loginValueProp2').replace('{count}', String(productFacts.exchangeCount)),
            t('loginValueProp3'),
          ].map((prop, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.medium,
                color: 'var(--color-text-secondary)',
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-accent-success)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{prop}</span>
            </div>
          ))}
        </div>

        {/* Social + Wallet — surfaced prominently (crypto audience converts here) */}
        <SocialLogin
          lang={lang}
          searchParams={searchParams}
          isAddAccount={isAddAccount}
          onError={(msg) => setError(msg || null)}
          onWalletSuccess={(result) => {
            showToast(t('loginWalletSignInSuccess'), 'success')
            router.push(getRedirectUrl(result.handle))
          }}
          t={t}
        />
        {/* Divider — email/password is the secondary path */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0 16px' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--glass-border-light)' }} />
          <span
            style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}
          >
            {t('loginOrDivider')}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--glass-border-light)' }} />
        </div>

        {/* Email input */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              marginBottom: 8,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-secondary)',
            }}
          >
            {t('loginEmail')}
          </label>
          <input
            type="email"
            className="login-input"
            style={{
              width: '100%',
              padding: '14px 16px',
              borderRadius: tokens.radius.lg,
              border: `1px solid ${touchedFields.email && !emailValidation.valid ? 'var(--color-accent-error)' : 'var(--glass-border-light)'}`,
              background: 'var(--color-bg-tertiary)',
              color: tokens.colors.text.primary,
              fontSize: 16,
              outline: 'none',
            }}
            placeholder="you@email.com"
            maxLength={254}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (isRegister) resetForm()
            }}
            onBlur={() => markTouched('email')}
            disabled={codeVerified}
            autoComplete="email"
            autoFocus
          />
          {touchedFields.email && email && !emailValidation.valid && (
            <div
              style={{ marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span style={{ color: 'var(--color-accent-error)' }}>
                X - {t(emailValidation.messageKey)}
              </span>
            </div>
          )}
        </div>

        {/* Register / Login forms */}
        {isRegister ? (
          <RegisterForm
            email={email}
            password={password}
            setPassword={setPassword}
            handle={handle}
            setHandle={setHandle}
            code={code}
            setCode={setCode}
            codeSent={codeSent}
            codeVerified={codeVerified}
            loading={loading}
            sendingCode={sendingCode}
            countdown={countdown}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            touchedFields={touchedFields}
            markTouched={markTouched}
            onSendCode={handleSendCode}
            onVerifyCode={handleVerifyCode}
            onResendCode={handleSendCode}
            onSetPassword={handleSetPassword}
            t={t}
          />
        ) : (
          <LoginForm
            email={email}
            password={password}
            setPassword={setPassword}
            code={code}
            setCode={setCode}
            loginWithCode={loginWithCode}
            codeSent={codeSent}
            loading={loading}
            sendingCode={sendingCode}
            countdown={countdown}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            touchedFields={touchedFields}
            markTouched={(f) => markTouched(f)}
            onLogin={handleLogin}
            onSendLoginCode={handleSendLoginCode}
            onVerifyCode={handleVerifyCode}
            onSwitchToCode={() => {
              trackEvent('login_switch_to_code')
              setLoginWithCode(true)
              setCodeSent(false)
              setCode('')
              setError(null)
            }}
            onSwitchToPassword={() => {
              trackEvent('login_switch_to_password')
              setLoginWithCode(false)
              setCodeSent(false)
              setCode('')
              setError(null)
            }}
            t={t}
            rateLimitCountdown={rateLimitCountdown}
          />
        )}

        {/* Switch login/register — hover + focus states handled in globals.css */}
        <button
          className="login-switch-btn"
          onClick={() => {
            trackEvent(isRegister ? 'login_switch_to_login' : 'login_switch_to_register')
            if (!isRegister) trackEvent('signup_start')
            setIsRegister(!isRegister)
            resetForm()
          }}
          style={{
            width: '100%',
            padding: '14px 16px',
            borderRadius: tokens.radius.lg,
            border: '1px solid var(--color-accent-primary-30)',
            background: 'transparent',
            color: 'var(--color-text-secondary)',
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
          }}
        >
          {isRegister ? t('loginSwitchToLogin') : t('loginSwitchToRegister')}
        </button>

        {/* Terms */}
        <p
          style={{
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
            marginTop: 16,
            lineHeight: 1.6,
          }}
        >
          {t('loginTermsNote')}{' '}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--color-brand)', textDecoration: 'none' }}
          >
            {t('termsOfService')}
          </a>{' '}
          {t('loginTermsAnd')}{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--color-brand)', textDecoration: 'none' }}
          >
            {t('privacyPolicy')}
          </a>
        </p>

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
              color: 'var(--color-accent-error)',
              fontSize: 13,
              fontWeight: 500,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ flexShrink: 0 }}
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {rateLimitCountdown > 0
                ? t('loginRateLimitRetry').replace('{n}', String(rateLimitCountdown))
                : error}
            </div>
            {showRecoveryPrompt && (
              <button
                onClick={handleRecoverAccount}
                disabled={recovering}
                style={{
                  padding: '10px 16px',
                  borderRadius: tokens.radius.md,
                  border: '1px solid var(--color-accent-success-40)',
                  background: 'var(--color-accent-success-10)',
                  color: 'var(--color-accent-success)',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: recovering ? 'wait' : 'pointer',
                  opacity: recovering ? 0.6 : 1,
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {recovering ? t('loginRecovering') : t('loginRecoverMyAccount')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
