'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase as _supabase } from "@/lib/supabase/client"
import type { SupabaseClient } from "@supabase/supabase-js"
const supabase = _supabase as SupabaseClient
import { useRouter, useSearchParams } from 'next/navigation'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { logger } from '@/lib/logger'
import { useMultiAccountStore } from '@/lib/stores/multiAccountStore'
import { injectStyles, validateEmail } from './components/loginHelpers'
import { trackEvent } from '@/lib/analytics/track'
import SocialLogin, { WalletLogin } from './components/SocialLogin'
import RegisterForm from './components/RegisterForm'
import LoginForm from './components/LoginForm'


export default function LoginPage() {
  const { language: lang, setLanguage: setLang, t } = useLanguage()
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
  const [countdown, setCountdown] = useState(0)
  const [loginWithCode, setLoginWithCode] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [mounted, setMounted] = useState(false)
  
  const [touchedFields, setTouchedFields] = useState<{
    email: boolean;
    password: boolean;
    handle: boolean;
  }>({ email: false, password: false, handle: false })
  
  const errorRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()

  const isAddAccount = searchParams.get('addAccount') === 'true'

  const saveNewAccountToStore = useCallback(async () => {
    if (!isAddAccount && !localStorage.getItem('arena_adding_account')) return
    localStorage.removeItem('arena_adding_account')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const { data: { user } } = await supabase.auth.getUser()
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

  const getRedirectUrl = useCallback((_userHandle?: string | null, _userEmail?: string | null): string => {
    if (isAddAccount || localStorage.getItem('arena_adding_account')) {
      return '/'
    }
    const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect')
    if (returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
      return returnUrl
    }
    // Default to homepage — the ranking table is the main content on /
    return '/'
  }, [searchParams, isAddAccount])

  const emailValidation = validateEmail(email)
  
  const markTouched = (field: 'email' | 'password' | 'handle') => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }

  useEffect(() => {
    injectStyles()
    setMounted(true)
  }, [router])

  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.classList.remove('error-shake')
      void errorRef.current.offsetWidth
      errorRef.current.classList.add('error-shake')
    }
  }, [error])

  useEffect(() => {
    let redirected = false
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session && !isRegister && !codeVerified && !redirected) {
        redirected = true
        saveNewAccountToStore().then(() => {
          supabase.auth.getUser().then(({ data: { user } }) => {
            if (user) {
              Promise.resolve(supabase
                .from('user_profiles')
                .select('handle')
                .eq('id', user.id)
                .maybeSingle())
                .then(
                  ({ data: userProfile }) => { router.push(getRedirectUrl(userProfile?.handle, user.email)) },
                  () => { router.push(getRedirectUrl()) }
                )
            } else {
              router.push(getRedirectUrl())
            }
          }).catch(() => { router.push(getRedirectUrl()) })
        }).catch(() => { router.push(getRedirectUrl()) })
      }
    })
    return () => { subscription.unsubscribe() }
  }, [router, isRegister, codeVerified, getRedirectUrl, saveNewAccountToStore])

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // Auth handlers
  const handleSendCode = async () => {
    if (submittingRef.current || sendingCode) return
    if (!email) { setError(t('loginPleaseEnterEmail')); return }
    submittingRef.current = true
    setError(null)
    setSendingCode(true)
    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
      if (otpError) {
        setError(otpError.message.includes('redirect') || otpError.message.includes('link') ? t('loginConfigError') : t('loginSendFailed'))
        setSendingCode(false)
        return
      }
      if (data) { setCodeSent(true); setCountdown(60); showToast(t('loginCodeSent'), 'success') }
      else { setError(t('loginSendFailed')) }
    } catch (err: unknown) { logger.error('Login OTP error:', err); setError(t('loginSendFailedNetwork')) }
    finally { setSendingCode(false); submittingRef.current = false }
  }

  const handleSendLoginCode = async () => {
    if (submittingRef.current || sendingCode) return
    if (!email) { setError(t('loginPleaseEnterEmail')); return }
    submittingRef.current = true
    setError(null)
    setSendingCode(true)
    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
      if (otpError) { setError(t('loginSendFailedShort')); setSendingCode(false); return }
      if (data) { setCodeSent(true); setCountdown(60); showToast(t('loginCodeSent'), 'success') }
      else { setError(t('loginSendFailedShort')) }
    } catch (err: unknown) { logger.error('Login OTP error:', err); setError(t('loginSendFailedSimple')) }
    finally { setSendingCode(false); submittingRef.current = false }
  }

  const handleVerifyCode = async () => {
    if (submittingRef.current || loading) return
    if (!code) { setError(t('loginPleaseEnterCode')); return }
    submittingRef.current = true
    setError(null)
    setLoading(true)
    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' })
      if (verifyError) {
        if (verifyError.message.includes('expired') || verifyError.message.includes('过期')) setError(t('loginCodeExpired'))
        else setError(t('loginVerificationFailed'))
        setLoading(false)
        return
      }
      if (data.user) {
        if (isRegister) {
          setCodeVerified(true)
          await createUserProfile(data.user.id, email)
          trackEvent('signup')
          showToast(t('loginCodeVerified'), 'success')
        } else {
          await saveNewAccountToStore()
          const { data: userProfile } = await supabase.from('user_profiles').select('handle').eq('id', data.user.id).maybeSingle()
          router.push(getRedirectUrl(userProfile?.handle, data.user.email))
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : undefined
      setError(errMsg?.includes('expired') || errMsg?.includes('过期') ? t('loginCodeExpired') : errMsg || t('loginVerificationFailed'))
    } finally { setLoading(false); submittingRef.current = false }
  }

  const createUserProfile = async (userId: string, userEmail: string, userHandle?: string) => {
    try {
      const finalHandle = userHandle || userEmail.split('@')[0]
      const updateData: Record<string, string> = { id: userId, email: userEmail }
      if (userHandle) {
        updateData.handle = finalHandle
      } else {
        const { data: existingProfile } = await supabase.from('user_profiles').select('handle').eq('id', userId).maybeSingle()
        if (!existingProfile || !existingProfile.handle) updateData.handle = finalHandle
      }
      // Sync OAuth avatar if available and not already set
      try {
        const { data: { user } } = await supabase.auth.getUser()
        const meta = user?.user_metadata
        const oauthAvatar = meta?.avatar_url || meta?.picture || null
        if (oauthAvatar) {
          const { data: existing } = await supabase.from('user_profiles').select('avatar_url').eq('id', userId).maybeSingle()
          if (!existing?.avatar_url) {
            updateData.avatar_url = oauthAvatar
          }
        }
      } catch { /* avatar sync is best-effort */ }
      // Capture UTM parameters for attribution
      const utmSource = searchParams.get('utm_source')
      const utmMedium = searchParams.get('utm_medium')
      const utmCampaign = searchParams.get('utm_campaign')
      if (utmSource) updateData.utm_source = utmSource
      if (utmMedium) updateData.utm_medium = utmMedium
      if (utmCampaign) updateData.utm_campaign = utmCampaign
      // Capture referral code
      const refCode = searchParams.get('ref')
      if (refCode) {
        // Look up referrer by referral_code or handle
        const { data: referrer } = await supabase
          .from('user_profiles')
          .select('id')
          .or(`referral_code.eq.${refCode},handle.eq.${refCode}`)
          .maybeSingle()
        if (referrer && referrer.id !== userId) {
          updateData.referred_by = referrer.id
        }
      }
      await supabase.from('user_profiles').upsert(updateData, { onConflict: 'id' })
    } catch (err) { logger.error('Error creating profile:', err) }
  }

  const handleSetPassword = async () => {
    if (submittingRef.current || loading) return
    if (!password || password.length < 6) { setError(t('loginPasswordMinLength')); return }
    if (!handle || handle.length < 1) { setError(t('loginHandleMinLength')); return }
    submittingRef.current = true
    setError(null)
    setLoading(true)
    try {
      const { data: { user }, error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) { setError(t('loginVerificationFailed')); setLoading(false); return }
      if (user) {
        const { data: existingProfile } = await supabase.from('user_profiles').select('handle').eq('id', user.id).maybeSingle()
        if (existingProfile && existingProfile.handle !== handle) {
          const { error: updateError } = await supabase.from('user_profiles').update({ handle }).eq('id', user.id)
          if (updateError) logger.error('Error updating handle:', updateError)
        }
        await createUserProfile(user.id, email, handle)
        router.push('/?welcome=1')
      } else { router.push('/') }
    } catch (err: unknown) { setError((err instanceof Error ? err.message : undefined) || t('loginSetupFailed')) }
    finally { setLoading(false); submittingRef.current = false }
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
        await supabase.auth.signOut()
      }
      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password })
      if (loginError) {
        clearTimeout(timeoutId)
        const msg = loginError.message
        if (msg.includes('Invalid login credentials')) setError(lang === 'zh' ? '邮箱或密码不正确，请重试' : 'Incorrect email or password. Please try again.')
        else if (msg.includes('Email not confirmed')) setError(lang === 'zh' ? '邮箱尚未验证，请检查收件箱' : 'Email not yet verified. Please check your inbox.')
        else if (msg.includes('Too many requests') || msg.includes('rate limit')) setError(lang === 'zh' ? '操作过于频繁，请稍后重试' : 'Too many attempts. Please wait a moment and try again.')
        else setError(msg)
        setLoading(false)
        return
      }
      clearTimeout(timeoutId)
      await saveNewAccountToStore()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: userProfile } = await supabase.from('user_profiles').select('handle').eq('id', user.id).maybeSingle()
        router.push(getRedirectUrl(userProfile?.handle, user.email))
      } else { router.push(getRedirectUrl()) }
    } catch (err: unknown) {
      clearTimeout(timeoutId)
      setError((err instanceof Error ? err.message : undefined) || t('loginFailed'))
    }
    finally { setLoading(false); submittingRef.current = false }
  }

  const resetForm = () => {
    setCode(''); setCodeSent(false); setCodeVerified(false); setPassword(''); setHandle('')
    setCountdown(0); setError(null); setLoginWithCode(false)
    setTouchedFields({ email: false, password: false, handle: false })
  }

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
          boxShadow: '0 25px 50px -12px var(--color-overlay-dark), 0 0 80px var(--color-accent-primary-08)',
        }}
      >
        {/* Logo + Language selector row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg width="32" height="16" viewBox="0 0 56 28" fill="none" style={{ flexShrink: 0 }}>
              <defs>
                <linearGradient id="loginInfGrad" x1="0%" y1="50%" x2="100%" y2="50%">
                  <stop offset="0%" stopColor="var(--color-brand-accent)" />
                  <stop offset="50%" stopColor="var(--color-verified-web3)" />
                  <stop offset="100%" stopColor="var(--color-chart-violet)" />
                </linearGradient>
              </defs>
              <path d="M28 14 C22 6, 12 4, 8 8 C4 12, 4 16, 8 20 C12 24, 22 22, 28 14 C34 6, 44 4, 48 8 C52 12, 52 16, 48 20 C44 24, 34 22, 28 14" stroke="url(#loginInfGrad)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span style={{ fontSize: 24, fontWeight: 700, color: tokens.colors.text.primary, letterSpacing: '-0.3px' }}>
              <span style={{ color: 'var(--color-verified-web3)', fontWeight: 800 }}>a</span>rena
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="lang-btn" onClick={() => setLang('zh')} style={{ padding: '8px 14px', borderRadius: 10, border: lang === 'zh' ? '1px solid var(--color-accent-primary-60)' : '1px solid var(--glass-border-light)', background: lang === 'zh' ? 'var(--color-accent-primary-15)' : 'transparent', color: lang === 'zh' ? 'var(--color-brand-accent)' : 'var(--color-text-secondary)', cursor: 'pointer', fontWeight: lang === 'zh' ? 700 : 500, fontSize: 13 }}>
              {t('chinese')}
            </button>
            <button className="lang-btn" onClick={() => setLang('en')} style={{ padding: '8px 14px', borderRadius: 10, border: lang === 'en' ? '1px solid var(--color-accent-primary-60)' : '1px solid var(--glass-border-light)', background: lang === 'en' ? 'var(--color-accent-primary-15)' : 'transparent', color: lang === 'en' ? 'var(--color-brand-accent)' : 'var(--color-text-secondary)', cursor: 'pointer', fontWeight: lang === 'en' ? 700 : 500, fontSize: 13 }}>
              EN
            </button>
          </div>
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ 
            fontSize: tokens.typography.fontSize['2xl'], 
            fontWeight: tokens.typography.fontWeight.extrabold, 
            marginBottom: 8,
            background: 'linear-gradient(135deg, var(--color-text-primary) 0%, var(--color-brand-accent) 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            {isRegister ? t('loginCreateAccount') : t('loginWelcomeBack')}
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, fontWeight: 500 }}>
            {t('loginSubtitle')}
          </p>
        </div>

        {/* Email input */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            {t('loginEmail')}
          </label>
          <input
            type="email"
            className="login-input"
            style={{ 
              width: '100%', padding: '14px 16px', borderRadius: tokens.radius.lg,
              border: `1px solid ${touchedFields.email && !emailValidation.valid ? 'var(--color-accent-error)' : 'var(--glass-border-light)'}`,
              background: 'var(--color-bg-tertiary)', color: tokens.colors.text.primary, fontSize: 16, outline: 'none',
            }}
            placeholder="you@email.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (isRegister) resetForm() }}
            onBlur={() => markTouched('email')}
            disabled={codeVerified}
            autoComplete="email"
            autoFocus
          />
          {touchedFields.email && email && !emailValidation.valid && (
            <div style={{ marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--color-accent-error)' }}>X - {t(emailValidation.messageKey)}</span>
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
            onSwitchToCode={() => { setLoginWithCode(true); setCodeSent(false); setCode(''); setError(null) }}
            onSwitchToPassword={() => { setLoginWithCode(false); setCodeSent(false); setCode(''); setError(null) }}
            t={t}
          />
        )}

        {/* Switch login/register — hover + focus states handled in globals.css */}
        <button
          className="login-switch-btn"
          onClick={() => { setIsRegister(!isRegister); resetForm() }}
          style={{
            width: '100%', padding: '14px 16px', borderRadius: tokens.radius.lg,
            border: '1px solid var(--color-accent-primary-30)', background: 'transparent',
            color: 'var(--color-text-secondary)', fontWeight: 600, fontSize: 14, cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
          }}
        >
          {isRegister ? t('loginSwitchToLogin') : t('loginSwitchToRegister')}
        </button>

        {/* Divider + Social logins */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0 16px' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--glass-border-light)' }} />
          <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{t('loginOrDivider')}</span>
          <div style={{ flex: 1, height: 1, background: 'var(--glass-border-light)' }} />
        </div>

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

        {/* Wallet Login */}
        <div style={{ marginTop: 8 }}>
          <WalletLogin
            onSuccess={(result) => {
              showToast(t('loginWalletSignInSuccess'), 'success')
              router.push(getRedirectUrl(result.handle))
            }}
            t={t}
          />
        </div>

        {/* Terms */}
        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 16, lineHeight: 1.6 }}>
          {t('loginTermsNote')}{' '}
          <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>{t('termsOfService')}</a>
          {' '}{t('loginTermsAnd')}{' '}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>{t('privacyPolicy')}</a>
        </p>

        {/* Error message */}
        {error && (
          <div ref={errorRef} style={{ 
            marginTop: 20, padding: 14, borderRadius: tokens.radius.lg,
            background: 'var(--color-accent-error-10)', border: '1px solid var(--color-accent-error-20)',
            color: 'var(--color-accent-error)', fontSize: 13, fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
