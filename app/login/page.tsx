'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from "@/lib/supabase/client"
import { useRouter, useSearchParams } from 'next/navigation'
import { useToast } from '@/app/components/ui/Toast'
import dynamic from 'next/dynamic'
const OneClickWalletButton = dynamic(() => import('@/app/components/web3/OneClickWalletButton').then(m => ({ default: m.OneClickWalletButton })), { ssr: false })
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// 密码强度计算函数
function getPasswordStrength(password: string): { level: 0 | 1 | 2 | 3 | 4; labelKey: string; color: string } {
  if (!password) return { level: 0, labelKey: '', color: '' }

  let score = 0
  if (password.length >= 6) score++
  if (password.length >= 8) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++

  if (score <= 1) return { level: 1, labelKey: 'loginPasswordWeak', color: '#ff4d4d' }
  if (score === 2) return { level: 2, labelKey: 'loginPasswordFair', color: '#ffa500' }
  if (score === 3) return { level: 3, labelKey: 'loginPasswordGood', color: '#ffc107' }
  return { level: 4, labelKey: 'loginPasswordStrong', color: '#2fe57d' }
}

// 实时验证函数
function validateEmail(email: string): { valid: boolean; messageKey: string } {
  if (!email) return { valid: true, messageKey: '' }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return { valid: false, messageKey: 'loginInvalidEmail' }
  }
  return { valid: true, messageKey: '' }
}

function validatePassword(password: string): { valid: boolean; messageKey: string } {
  if (!password) return { valid: true, messageKey: '' }
  if (password.length < 6) {
    return { valid: false, messageKey: 'loginPasswordTooShort' }
  }
  return { valid: true, messageKey: '' }
}

function validateHandle(handle: string): { valid: boolean; messageKey: string } {
  if (!handle) return { valid: true, messageKey: '' }
  if (handle.length < 1) {
    return { valid: false, messageKey: 'loginHandleTooShort' }
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(handle)) {
    return { valid: false, messageKey: 'loginHandleInvalidChars' }
  }
  return { valid: true, messageKey: '' }
}

// CSS keyframe animations
const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('login-page-styles')) return
  
  const style = document.createElement('style')
  style.id = 'login-page-styles'
  style.textContent = `
    @keyframes loginGradient {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    
    @keyframes floatParticle {
      0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.3; }
      50% { transform: translateY(-20px) rotate(180deg); opacity: 0.6; }
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
      0% { box-shadow: 0 0 0 0 rgba(139, 111, 168, 0.4); }
      100% { box-shadow: 0 0 0 4px rgba(139, 111, 168, 0.1); }
    }
    
    @keyframes buttonPulse {
      0%, 100% { box-shadow: 0 4px 20px rgba(139, 111, 168, 0.3); }
      50% { box-shadow: 0 4px 30px rgba(139, 111, 168, 0.5); }
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
    
    @keyframes strengthBarFill {
      from { width: 0; }
    }
    
    @keyframes glowPulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    
    .login-page-bg {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #0a0a0f 0%, #13111a 50%, #0f0d14 100%);
      z-index: 0;
    }
    
    .login-page-bg::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at center, rgba(139, 111, 168, 0.08) 0%, transparent 50%);
      animation: loginGradient 20s ease infinite;
    }
    
    .login-card {
      animation: cardEnter 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    
    .login-input {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .login-input:focus {
      border-color: var(--color-brand) !important;
      animation: inputFocus 0.3s ease forwards;
      background: rgba(139, 111, 168, 0.05) !important;
    }
    
    .login-button {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .login-button:not(:disabled):hover {
      transform: translateY(-2px);
      animation: buttonPulse 2s ease infinite;
    }
    
    .login-button:not(:disabled):active {
      transform: translateY(0) scale(0.98);
    }
    
    .error-shake {
      animation: shake 0.5s ease;
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
      background: linear-gradient(135deg, rgba(139, 111, 168, 0.3), rgba(139, 111, 168, 0.1));
      animation: floatParticle 6s ease-in-out infinite;
    }
    
    .password-toggle {
      transition: all 0.2s ease;
    }
    
    .password-toggle:hover {
      color: var(--color-brand) !important;
    }
    
    .strength-segment {
      transition: all 0.3s ease;
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
    
    .loader-spin {
      animation: spinLoader 1s linear infinite;
    }
  `
  document.head.appendChild(style)
}

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
  const submittingRef = useRef(false) // Prevent double submissions
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()

  // Get returnUrl from query params for post-login redirect
  // Support both 'returnUrl' and 'redirect' parameters for compatibility
  const getRedirectUrl = (userHandle?: string | null, userEmail?: string | null): string => {
    const returnUrl = searchParams.get('returnUrl') || searchParams.get('redirect')
    if (returnUrl && returnUrl.startsWith('/')) {
      return returnUrl
    }
    if (userHandle) return `/u/${userHandle}`
    if (userEmail) return `/u/${userEmail.split('@')[0]}`
    return '/'
  }


  const passwordStrength = getPasswordStrength(password)
  
  const emailValidation = validateEmail(email)
  const passwordValidation = validatePassword(password)
  const handleValidation = validateHandle(handle)
  
  const markTouched = (field: 'email' | 'password' | 'handle') => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }

  useEffect(() => {
    injectStyles()
    setMounted(true)
    
    // 检查是否已完成初始设置
    const hasOnboarded = localStorage.getItem('hasOnboarded')
    if (hasOnboarded !== 'true') {
      router.push('/onboarding')
      return
    }
  }, [router])

  // Language persistence is handled by LanguageProvider

  // Shake error box when error changes
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.classList.remove('error-shake')
      void errorRef.current.offsetWidth // Trigger reflow
      errorRef.current.classList.add('error-shake')
    }
  }, [error])

  useEffect(() => {
    let redirected = false
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session && !isRegister && !codeVerified && !redirected) {
        redirected = true
        // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
        supabase.auth.getUser().then(({ data: { user } }) => {
          if (user) {
            supabase
              .from('user_profiles')
              .select('handle')
              .eq('id', user.id)
              .maybeSingle()
              .then(({ data: userProfile }) => {
                router.push(getRedirectUrl(userProfile?.handle, user.email))
              })
          } else {
            router.push(getRedirectUrl())
          }
        })
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [router, isRegister, codeVerified, getRedirectUrl])

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  const handleSendCode = async () => {
    if (submittingRef.current || sendingCode) return
    if (!email) {
      setError(t('loginPleaseEnterEmail'))
      return
    }

    submittingRef.current = true
    setError(null)
    setSendingCode(true)

    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
        },
      })

      if (otpError) {
        if (otpError.message.includes('redirect') || otpError.message.includes('link')) {
          setError(t('loginConfigError'))
        } else {
          setError(otpError.message || t('loginSendFailed'))
        }
        setSendingCode(false)
        return
      }

      if (data) {
        setCodeSent(true)
        setCountdown(60)
        showToast(t('loginCodeSent'), 'success')
      } else {
        setError(t('loginSendFailed'))
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : undefined) || t('loginSendFailedNetwork'))
    } finally {
      setSendingCode(false)
      submittingRef.current = false
    }
  }

  const handleResendCode = async () => {
    if (countdown > 0) return
    await handleSendCode()
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

    try {
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
        },
      })

      if (otpError) {
        setError(otpError.message || t('loginSendFailedShort'))
        setSendingCode(false)
        return
      }

      if (data) {
        setCodeSent(true)
        setCountdown(60)
        showToast(t('loginCodeSent'), 'success')
      } else {
        setError(t('loginSendFailedShort'))
      }
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : undefined) || t('loginSendFailedSimple'))
    } finally {
      setSendingCode(false)
      submittingRef.current = false
    }
  }

  const handleVerifyCode = async () => {
    if (submittingRef.current || loading) return
    if (!code) {
      setError(t('loginPleaseEnterCode'))
      return
    }

    submittingRef.current = true
    setError(null)
    setLoading(true)

    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: 'email',
      })

      if (verifyError) {
        if (verifyError.message.includes('expired') || verifyError.message.includes('过期')) {
          setError(t('loginCodeExpired'))
        } else {
          setError(verifyError.message)
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
          const { data: userProfile } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('id', data.user.id)
            .maybeSingle()

          router.push(getRedirectUrl(userProfile?.handle, data.user.email))
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : undefined
      if (errMsg?.includes('expired') || errMsg?.includes('过期')) {
        setError(t('loginCodeExpired'))
      } else {
        setError(errMsg || t('loginVerificationFailed'))
      }
    } finally {
      setLoading(false)
      submittingRef.current = false
    }
  }

  const createUserProfile = async (userId: string, userEmail: string, userHandle?: string) => {
    try {
      const finalHandle = userHandle || userEmail.split('@')[0]
      
      // 如果提供了 userHandle，强制更新 handle
      const updateData: Record<string, string> = {
        id: userId,
        email: userEmail,
      }
      
      // 只有当提供了 userHandle 时才更新 handle，否则保持现有值
      if (userHandle) {
        updateData.handle = finalHandle
      } else {
        // 如果没有提供 userHandle，只在 profile 不存在时设置默认值
        const { data: existingProfile } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', userId)
          .maybeSingle()
        
        if (!existingProfile || !existingProfile.handle) {
          updateData.handle = finalHandle
        }
      }
      
      await supabase
        .from('user_profiles')
        .upsert(updateData, { onConflict: 'id' })
    } catch (err) {
      console.error('Error creating profile:', err)
    }
  }

  const handleSetPassword = async () => {
    if (submittingRef.current || loading) return
    if (!password || password.length < 6) {
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
      const { data: { user }, error: updateError } = await supabase.auth.updateUser({
        password,
      })

      if (updateError) {
        setError(updateError.message)
        setLoading(false)
        return
      }

      if (user) {
        // 先检查现有 profile，确保 handle 能正确更新
        const { data: existingProfile } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', user.id)
          .maybeSingle()
        
        // 如果已有 profile 且 handle 不同，强制更新
        if (existingProfile && existingProfile.handle !== handle) {
          const { error: updateError } = await supabase
            .from('user_profiles')
            .update({ handle: handle })
            .eq('id', user.id)
          
          if (updateError) {
            console.error('Error updating handle:', updateError)
          }
        }
        
        await createUserProfile(user.id, email, handle)
        router.push('/welcome')
      } else {
        router.push('/')
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

    try {
        const { error: loginError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (loginError) {
          // Translate common Supabase errors to user-friendly messages
          const msg = loginError.message
          if (msg.includes('Invalid login credentials')) {
            setError(lang === 'zh' ? '邮箱或密码不正确，请重试' : 'Incorrect email or password. Please try again.')
          } else if (msg.includes('Email not confirmed')) {
            setError(lang === 'zh' ? '邮箱尚未验证，请检查收件箱' : 'Email not yet verified. Please check your inbox.')
          } else if (msg.includes('Too many requests') || msg.includes('rate limit')) {
            setError(lang === 'zh' ? '操作过于频繁，请稍后重试' : 'Too many attempts. Please wait a moment and try again.')
          } else {
            setError(msg)
          }
          setLoading(false)
          return
        }

      // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
      const { data: { user } } = await supabase.auth.getUser()
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
      setError((err instanceof Error ? err.message : undefined) || t('loginFailed'))
    } finally {
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
    setError(null)
    setLoginWithCode(false)
    setTouchedFields({ email: false, password: false, handle: false })
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
      <div className="login-page-bg" />
      
      {/* Floating particles */}
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="floating-particle"
          style={{
            width: 8 + i * 4,
            height: 8 + i * 4,
            left: `${10 + i * 15}%`,
            top: `${20 + (i % 3) * 25}%`,
            animationDelay: `${i * 0.5}s`,
            animationDuration: `${5 + i}s`,
          }}
        />
      ))}
      
      <div 
        className="login-card"
        style={{ 
          maxWidth: 440, 
          width: '100%',
          background: 'rgba(15, 15, 20, 0.8)',
          border: '1px solid rgba(139, 111, 168, 0.15)',
          borderRadius: 24,
          padding: '40px 36px',
          position: 'relative',
          zIndex: 1,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 80px rgba(139, 111, 168, 0.08)',
        }}
      >
        {/* Logo + Language selector row */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: 28,
        }}>
          {/* Arena Logo */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            {/* 无限符号 ∞ */}
            <svg
              width="32"
              height="16"
              viewBox="0 0 56 28"
              fill="none"
              style={{ flexShrink: 0 }}
            >
              <defs>
                <linearGradient id="loginInfGrad" x1="0%" y1="50%" x2="100%" y2="50%">
                  <stop offset="0%" stopColor="#A78BFA" />
                  <stop offset="50%" stopColor="#8B5CF6" />
                  <stop offset="100%" stopColor="#7C3AED" />
                </linearGradient>
              </defs>
              <path
                d="M28 14 C22 6, 12 4, 8 8 C4 12, 4 16, 8 20 C12 24, 22 22, 28 14 C34 6, 44 4, 48 8 C52 12, 52 16, 48 20 C44 24, 34 22, 28 14"
                stroke="url(#loginInfGrad)"
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            {/* 文字：arena */}
            <span style={{
              fontSize: 24,
              fontWeight: 700,
              color: '#f2f2f2',
              letterSpacing: '-0.3px',
            }}>
              <span style={{ color: '#8B5CF6', fontWeight: 800 }}>a</span>rena
            </span>
          </div>

          {/* Language selector */}
          <div style={{ 
            display: 'flex', 
            gap: 8,
          }}>
          <button
            className="lang-btn"
            onClick={() => setLang('zh')}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: lang === 'zh' ? '1px solid rgba(139, 111, 168, 0.5)' : '1px solid rgba(255, 255, 255, 0.1)',
              background: lang === 'zh' ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
              color: lang === 'zh' ? '#c9b8db' : '#8a8a8a',
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
              border: lang === 'en' ? '1px solid rgba(139, 111, 168, 0.5)' : '1px solid rgba(255, 255, 255, 0.1)',
              background: lang === 'en' ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
              color: lang === 'en' ? '#c9b8db' : '#8a8a8a',
              cursor: 'pointer',
              fontWeight: lang === 'en' ? 700 : 500,
              fontSize: 13,
            }}
          >
            EN
          </button>
          </div>
        </div>

        {/* Google OAuth */}
        <button
          onClick={async () => {
            setError(null)
            const { error: oauthError } = await supabase.auth.signInWithOAuth({
              provider: 'google',
              options: {
                redirectTo: `${window.location.origin}/auth/callback`,
              },
            })
            if (oauthError) setError(oauthError.message)
          }}
          className="login-button"
          style={{
            width: '100%',
            padding: '14px 16px',
            borderRadius: 12,
            border: '1px solid rgba(255, 255, 255, 0.15)',
            background: 'rgba(255, 255, 255, 0.05)',
            color: '#eaeaea',
            fontWeight: 600,
            fontSize: 15,
            cursor: 'pointer',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {lang === 'zh' ? '使用 Google 登录' : 'Sign in with Google'}
        </button>

        {/* Divider */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 24,
        }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255, 255, 255, 0.1)' }} />
          <span style={{ fontSize: 12, color: '#5a5a5a' }}>{lang === 'zh' ? '或使用邮箱登录' : 'or use email'}</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255, 255, 255, 0.1)' }} />
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ 
            fontSize: 28, 
            fontWeight: 800, 
            marginBottom: 8,
            background: 'linear-gradient(135deg, #f2f2f2 0%, #c9b8db 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            {isRegister ? t('loginCreateAccount') : t('loginWelcomeBack')}
          </h1>
          <p style={{
            fontSize: 14,
            color: '#7a7a7a',
            fontWeight: 500,
            marginBottom: 16,
          }}>
            {t('loginSubtitle')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'left', maxWidth: 320, margin: '0 auto' }}>
            {['loginValueProp1', 'loginValueProp2', 'loginValueProp3'].map((key) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#9a9a9a' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {t(key)}
              </div>
            ))}
          </div>
        </div>

        {/* Email input */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ 
            display: 'block', 
            marginBottom: 8, 
            fontSize: 13, 
            fontWeight: 600,
            color: '#b0b0b0',
          }}>
            {t('loginEmail')}
          </label>
          <input
            type="email"
            className="login-input"
            style={{ 
              width: '100%', 
              padding: '14px 16px', 
              borderRadius: 12,
              border: `1px solid ${touchedFields.email && !emailValidation.valid ? 'rgba(255, 124, 124, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
              background: 'rgba(0, 0, 0, 0.3)',
              color: '#eaeaea',
              fontSize: 15,
              outline: 'none',
            }}
            placeholder="you@email.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (isRegister) resetForm()
            }}
            onBlur={() => markTouched('email')}
            disabled={codeVerified}
          />
          {touchedFields.email && email && !emailValidation.valid && (
            <div style={{ marginTop: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#ff7c7c' }}>X - {t(emailValidation.messageKey)}</span>
            </div>
          )}
        </div>

        {/* Register mode: verification code flow */}
        {isRegister && (
          <>
            {!codeSent ? (
              <button
                onClick={handleSendCode}
                disabled={sendingCode || !email || countdown > 0}
                className="login-button"
                style={{ 
                  width: '100%',
                  padding: '14px 16px', 
                  borderRadius: 12,
                  border: 'none',
                  background: sendingCode || !email || countdown > 0 
                    ? 'rgba(139, 111, 168, 0.2)' 
                    : 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 15,
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
            ) : !codeVerified ? (
              <>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
                    {t('loginVerificationCode')}
                  </label>
                  <input
                    type="text"
                    className="login-input"
                    style={{ 
                      width: '100%', 
                      padding: '14px 16px', 
                      borderRadius: 12,
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      background: 'rgba(0, 0, 0, 0.3)',
                      color: '#eaeaea',
                      fontSize: 15,
                      outline: 'none',
                      letterSpacing: 4,
                      textAlign: 'center',
                    }}
                    placeholder="000000"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !loading && code) {
                        handleVerifyCode()
                      }
                    }}
                    maxLength={6}
                  />
                  <div style={{ marginTop: 6, fontSize: 11, color: '#6a6a6a' }}>
                    {t('loginCodeValidFor')}
                  </div>
                </div>
                <button
                  onClick={handleVerifyCode}
                  disabled={loading || !code}
                  className="login-button"
                  style={{ 
                    width: '100%',
                    padding: '14px 16px', 
                    borderRadius: 12,
                    border: 'none',
                    background: loading || !code 
                      ? 'rgba(139, 111, 168, 0.2)' 
                      : 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: loading || !code ? 'not-allowed' : 'pointer',
                    marginBottom: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  {loading && <Spinner />}
                  {loading ? t('loginVerifying') : t('loginVerifyCode')}
                </button>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
                  {countdown > 0 ? (
                    <span style={{ fontSize: 13, color: '#6a6a6a' }}>
                      {countdown} {t('loginCountdown')}
                    </span>
                  ) : (
                    <button
                      onClick={handleResendCode}
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
              </>
            ) : (
              <>
                {/* Username input */}
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
                    {t('loginHandle')}
                  </label>
                  <input
                    type="text"
                    className="login-input"
                    style={{ 
                      width: '100%', 
                      padding: '14px 16px', 
                      borderRadius: 12,
                      border: `1px solid ${touchedFields.handle && !handleValidation.valid ? 'rgba(255, 124, 124, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
                      background: 'rgba(0, 0, 0, 0.3)',
                      color: '#eaeaea',
                      fontSize: 15,
                      outline: 'none',
                    }}
                    placeholder={t('loginUsernamePlaceholder')}
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    onBlur={() => markTouched('handle')}
                  />
                  {touchedFields.handle && handle && !handleValidation.valid && (
                    <div style={{ marginTop: 6, fontSize: 12 }}>
                      <span style={{ color: '#ff7c7c' }}>X - {t(handleValidation.messageKey)}</span>
                    </div>
                  )}
                </div>
                
                {/* Password input */}
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
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
                        borderRadius: 12,
                        border: `1px solid ${touchedFields.password && !passwordValidation.valid ? 'rgba(255, 124, 124, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
                        background: 'rgba(0, 0, 0, 0.3)',
                        color: '#eaeaea',
                        fontSize: 15,
                        outline: 'none',
                      }}
                      placeholder={t('loginSetPasswordPlaceholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onBlur={() => markTouched('password')}
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
                        color: '#6a6a6a',
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
                              background: level <= passwordStrength.level ? passwordStrength.color : 'rgba(255, 255, 255, 0.1)',
                            }}
                          />
                        ))}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: passwordStrength.color, fontWeight: 500 }}>
                          {t('loginPasswordStrength').replace('{label}', t(passwordStrength.labelKey))}
                        </span>
                        <span style={{ fontSize: 11, color: password.length >= 6 ? '#6a6a6a' : '#ff7c7c' }}>
                          {password.length}/6
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                
                <button
                  onClick={handleSetPassword}
                  disabled={loading || !password || password.length < 6 || !handle || handle.length < 1}
                  className="login-button"
                  style={{ 
                    width: '100%',
                    padding: '14px 16px', 
                    borderRadius: 12,
                    border: 'none',
                    background: loading || !password || password.length < 6 || !handle || handle.length < 1 
                      ? 'rgba(139, 111, 168, 0.2)' 
                      : 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 15,
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
            )}
          </>
        )}

        {/* Login mode */}
        {!isRegister && (
          <>
            {!loginWithCode ? (
              <>
                {/* Password login */}
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
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
                        borderRadius: 12,
                        border: `1px solid ${touchedFields.password && password && !passwordValidation.valid ? 'rgba(255, 124, 124, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
                        background: 'rgba(0, 0, 0, 0.3)',
                        color: '#eaeaea',
                        fontSize: 15,
                        outline: 'none',
                      }}
                      placeholder={t('loginPasswordPlaceholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onBlur={() => markTouched('password')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !loading && email && password) {
                          handleLogin()
                        }
                      }}
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
                        color: '#6a6a6a',
                        fontSize: 12,
                      }}
                      tabIndex={-1}
                    >
                      {showPassword ? t('loginHide') : t('loginShow')}
                    </button>
                  </div>
                </div>
                
                <button
                  onClick={handleLogin}
                  disabled={loading || !email || !password}
                  className="login-button"
                  style={{ 
                    width: '100%',
                    padding: '14px 16px', 
                    borderRadius: 12,
                    border: 'none',
                    background: loading || !email || !password 
                      ? 'rgba(139, 111, 168, 0.2)' 
                      : 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 15,
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
                      color: '#6a6a6a',
                      fontSize: 13,
                      textDecoration: 'none',
                    }}
                  >
                    {t('loginForgotPassword')}
                  </a>
                </div>
                
                {/* Switch to code login */}
                <button
                  onClick={() => {
                    setLoginWithCode(true)
                    setCodeSent(false)
                    setCode('')
                    setError(null)
                  }}
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
            ) : (
              <>
                {/* Code login */}
                {!codeSent ? (
                  <button
                    onClick={handleSendLoginCode}
                    disabled={sendingCode || !email || countdown > 0}
                    className="login-button"
                    style={{ 
                      width: '100%',
                      padding: '14px 16px', 
                      borderRadius: 12,
                      border: 'none',
                      background: sendingCode || !email || countdown > 0 
                        ? 'rgba(139, 111, 168, 0.2)' 
                        : 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: 15,
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
                ) : (
                  <>
                    <div style={{ marginBottom: 20 }}>
                      <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
                        {t('loginVerificationCode')}
                      </label>
                      <input
                        type="text"
                        className="login-input"
                        style={{ 
                          width: '100%', 
                          padding: '14px 16px', 
                          borderRadius: 12,
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          background: 'rgba(0, 0, 0, 0.3)',
                          color: '#eaeaea',
                          fontSize: 15,
                          outline: 'none',
                          letterSpacing: 4,
                          textAlign: 'center',
                        }}
                        placeholder="000000"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !loading && code) {
                            handleVerifyCode()
                          }
                        }}
                        maxLength={6}
                      />
                      <div style={{ marginTop: 6, fontSize: 11, color: '#6a6a6a' }}>
                        {t('loginCodeValidFor')}
                      </div>
                    </div>
                    <button
                      onClick={handleVerifyCode}
                      disabled={loading || !code}
                      className="login-button"
                      style={{ 
                        width: '100%',
                        padding: '14px 16px', 
                        borderRadius: 12,
                        border: 'none',
                        background: loading || !code 
                          ? 'rgba(139, 111, 168, 0.2)' 
                          : 'linear-gradient(135deg, var(--color-brand) 0%, #6b4f88 100%)',
                        color: '#fff',
                        fontWeight: 700,
                        fontSize: 15,
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
                        <span style={{ fontSize: 13, color: '#6a6a6a' }}>
                          {countdown} {t('loginCountdown')}
                        </span>
                      ) : (
                        <button
                          onClick={handleSendLoginCode}
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
                    <button
                      onClick={() => {
                        setLoginWithCode(false)
                        setCodeSent(false)
                        setCode('')
                        setError(null)
                      }}
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
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* Divider */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          margin: '20px 0',
        }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255, 255, 255, 0.1)' }} />
          <span style={{ fontSize: 12, color: '#5a5a5a' }}>{t('loginOrDivider')}</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255, 255, 255, 0.1)' }} />
        </div>

        {/* One-Click Wallet Sign-In */}
        <div style={{ marginBottom: 16 }}>
          <OneClickWalletButton
            fullWidth
            size="md"
            onSuccess={(result) => {
              showToast(t('loginWalletSignInSuccess'), 'success')
              router.push(getRedirectUrl(result.handle))
            }}
          />
        </div>

        {/* Switch login/register */}
        <button
          onClick={() => {
            setIsRegister(!isRegister)
            resetForm()
          }}
          style={{
            width: '100%',
            padding: '14px 16px',
            borderRadius: 12,
            border: '1px solid rgba(139, 111, 168, 0.3)',
            background: 'transparent',
            color: '#b0b0b0',
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.6)'
            e.currentTarget.style.color = '#c9b8db'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.3)'
            e.currentTarget.style.color = '#b0b0b0'
          }}
        >
          {isRegister ? t('loginSwitchToLogin') : t('loginSwitchToRegister')}
        </button>

        {/* Error message */}
        {error && (
          <div 
            ref={errorRef}
            style={{ 
              marginTop: 20,
              padding: 14,
              borderRadius: 12,
              background: 'rgba(255, 77, 77, 0.1)',
              border: '1px solid rgba(255, 77, 77, 0.2)',
              color: '#ff7c7c',
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
      </div>
    </div>
  )
}
