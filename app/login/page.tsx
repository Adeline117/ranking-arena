'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from "@/lib/supabase/client"
import { useRouter } from 'next/navigation'
import { useToast } from '@/app/components/UI/Toast'

type Language = 'zh' | 'en'

const translations = {
  zh: {
    title: '登录 / 注册',
    email: '邮箱',
    password: '密码',
    code: '验证码',
    handle: '用户名',
    login: '登录',
    register: '注册',
    sendCode: '发送验证码',
    resendCode: '重新发送',
    verifyCode: '验证验证码',
    loggingIn: '登录中...',
    registering: '注册中...',
    sendingCode: '发送中...',
    verifying: '验证中...',
    switchToRegister: '还没有账号？使用验证码注册',
    switchToLogin: '已有账号？使用密码或验证码登录',
    language: '语言',
    loginSuccess: '登录成功',
    registerSuccess: '注册成功，请登录',
    codeSent: '验证码已发送，请查收邮箱（10分钟内有效）',
    codeVerified: '验证成功，请设置密码和用户名',
    setPassword: '完成注册',
    codeExpired: '验证码已过期，请重新获取',
    codeValidFor: '验证码10分钟内有效',
    passwordRequired: '请设置密码',
    passwordMinLength: '密码至少6位',
    handleRequired: '请输入用户名',
    handleMinLength: '用户名至少1个字符',
    countdown: '秒后重发',
    loginWithCode: '或使用验证码登录',
    forgotPassword: '忘记密码？',
    welcomeBack: '欢迎回来',
    createAccount: '创建账号',
    subtitle: '探索顶级交易员的世界',
  },
  en: {
    title: 'Login / Register',
    email: 'Email',
    password: 'Password',
    code: 'Verification Code',
    handle: 'Username',
    login: 'Login',
    register: 'Register',
    sendCode: 'Send Code',
    resendCode: 'Resend',
    verifyCode: 'Verify Code',
    loggingIn: 'Logging in...',
    registering: 'Registering...',
    sendingCode: 'Sending...',
    verifying: 'Verifying...',
    switchToRegister: 'No account? Register with code',
    switchToLogin: 'Have an account? Login with password or code',
    language: 'Language',
    loginSuccess: 'Login successful',
    registerSuccess: 'Registration successful, please login',
    codeSent: 'Code sent, please check your email (valid for 10 minutes)',
    codeVerified: 'Verification successful, please set password and username',
    setPassword: 'Complete Registration',
    codeExpired: 'Code expired, please request a new one',
    codeValidFor: 'Code is valid for 10 minutes',
    passwordRequired: 'Please set password',
    passwordMinLength: 'Password must be at least 6 characters',
    handleRequired: 'Please enter username',
    handleMinLength: 'Username must be at least 1 character',
    countdown: 's to resend',
    loginWithCode: 'Or login with verification code',
    forgotPassword: 'Forgot password?',
    welcomeBack: 'Welcome Back',
    createAccount: 'Create Account',
    subtitle: 'Explore the world of top traders',
  },
}

// 密码强度计算函数
function getPasswordStrength(password: string): { level: 0 | 1 | 2 | 3 | 4; label: string; labelEn: string; color: string } {
  if (!password) return { level: 0, label: '', labelEn: '', color: '' }
  
  let score = 0
  if (password.length >= 6) score++
  if (password.length >= 8) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++
  
  if (score <= 1) return { level: 1, label: '弱', labelEn: 'Weak', color: '#ff4d4d' }
  if (score === 2) return { level: 2, label: '一般', labelEn: 'Fair', color: '#ffa500' }
  if (score === 3) return { level: 3, label: '中等', labelEn: 'Good', color: '#ffc107' }
  return { level: 4, label: '强', labelEn: 'Strong', color: '#2fe57d' }
}

// 实时验证函数
function validateEmail(email: string): { valid: boolean; message: string; messageEn: string } {
  if (!email) return { valid: true, message: '', messageEn: '' }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return { valid: false, message: '请输入有效的邮箱地址', messageEn: 'Please enter a valid email' }
  }
  return { valid: true, message: '', messageEn: '' }
}

function validatePassword(password: string): { valid: boolean; message: string; messageEn: string } {
  if (!password) return { valid: true, message: '', messageEn: '' }
  if (password.length < 6) {
    return { 
      valid: false, 
      message: '密码至少需要6个字符',
      messageEn: 'Password must be at least 6 characters',
    }
  }
  return { valid: true, message: '', messageEn: '' }
}

function validateHandle(handle: string): { valid: boolean; message: string; messageEn: string } {
  if (!handle) return { valid: true, message: '', messageEn: '' }
  if (handle.length < 1) {
    return { 
      valid: false, 
      message: '用户名至少需要1个字符',
      messageEn: 'Username must be at least 1 character',
    }
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(handle)) {
    return { 
      valid: false, 
      message: '用户名只能包含字母、数字、下划线和中文',
      messageEn: 'Only letters, numbers, underscores and Chinese',
    }
  }
  return { valid: true, message: '', messageEn: '' }
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
      border-color: #8b6fa8 !important;
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
      color: #8b6fa8 !important;
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
      background: #8b6fa8;
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
  const [lang, setLang] = useState<Language>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('preferredLanguage')
      if (saved === 'en' || saved === 'zh') return saved
    }
    return 'zh'
  })
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
  const router = useRouter()
  const { showToast } = useToast()

  const t = translations[lang]
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
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('preferredLanguage', lang)
    }
  }, [lang])

  // Shake error box when error changes
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.classList.remove('error-shake')
      void errorRef.current.offsetWidth // Trigger reflow
      errorRef.current.classList.add('error-shake')
    }
  }, [error])

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session && !isRegister && !codeVerified) {
        supabase.auth.getUser().then(({ data: { user } }) => {
          if (user) {
            supabase
              .from('user_profiles')
              .select('handle')
              .eq('id', user.id)
              .maybeSingle()
              .then(({ data: userProfile }) => {
                if (userProfile?.handle) {
                  router.push(`/u/${userProfile.handle}`)
                } else if (user.email) {
                  router.push(`/u/${user.email.split('@')[0]}`)
                } else {
                  router.push('/')
                }
              })
          } else {
            router.push('/')
          }
        })
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [router, isRegister, codeVerified])

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  const handleSendCode = async () => {
    if (!email) {
      setError(lang === 'zh' ? '请输入邮箱' : 'Please enter email')
      return
    }

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
          setError(lang === 'zh' 
            ? '配置错误：请检查 Supabase 设置' 
            : 'Configuration error: Please check Supabase settings')
        } else {
          setError(otpError.message || (lang === 'zh' ? '发送失败，请重试' : 'Failed to send, please retry'))
        }
        setSendingCode(false)
        return
      }

      if (data) {
        setCodeSent(true)
        setCountdown(60)
        showToast(t.codeSent, 'success')
      } else {
        setError(lang === 'zh' ? '发送失败，请重试' : 'Failed to send, please retry')
      }
    } catch (err: any) {
      setError(err?.message || (lang === 'zh' ? '发送失败，请检查网络连接' : 'Failed, please check network'))
    } finally {
      setSendingCode(false)
    }
  }

  const handleResendCode = async () => {
    if (countdown > 0) return
    await handleSendCode()
  }

  const handleSendLoginCode = async () => {
    if (!email) {
      setError(lang === 'zh' ? '请输入邮箱' : 'Please enter email')
      return
    }

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
        setError(otpError.message || (lang === 'zh' ? '发送失败，请重试' : 'Failed to send'))
        setSendingCode(false)
        return
      }

      if (data) {
        setCodeSent(true)
        setCountdown(60)
        showToast(t.codeSent, 'success')
      } else {
        setError(lang === 'zh' ? '发送失败，请重试' : 'Failed to send')
      }
    } catch (err: any) {
      setError(err?.message || (lang === 'zh' ? '发送失败' : 'Failed'))
    } finally {
      setSendingCode(false)
    }
  }

  const handleVerifyCode = async () => {
    if (!code) {
      setError(lang === 'zh' ? '请输入验证码' : 'Please enter code')
      return
    }

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
          setError(t.codeExpired)
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
          showToast(t.codeVerified, 'success')
        } else {
          const { data: userProfile } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('id', data.user.id)
            .maybeSingle()

          if (userProfile?.handle) {
            router.push(`/u/${userProfile.handle}`)
          } else if (data.user.email) {
            router.push(`/u/${data.user.email.split('@')[0]}`)
          } else {
            router.push('/')
          }
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('expired') || err?.message?.includes('过期')) {
        setError(t.codeExpired)
      } else {
        setError(err?.message || (lang === 'zh' ? '验证失败' : 'Verification failed'))
      }
    } finally {
      setLoading(false)
    }
  }

  const createUserProfile = async (userId: string, userEmail: string, userHandle?: string) => {
    try {
      const finalHandle = userHandle || userEmail.split('@')[0]
      
      await supabase
        .from('user_profiles')
        .upsert(
          {
            id: userId,
            handle: finalHandle,
            email: userEmail,
          },
          { onConflict: 'id' }
        )
    } catch (err) {
      console.error('Error creating profile:', err)
    }
  }

  const handleSetPassword = async () => {
    if (!password || password.length < 6) {
      setError(t.passwordMinLength)
      return
    }

    if (!handle || handle.length < 1) {
      setError(t.handleMinLength)
      return
    }

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
        await createUserProfile(user.id, email, handle)
        router.push('/welcome')
      } else {
        router.push('/')
      }
    } catch (err: any) {
      setError(err?.message || (lang === 'zh' ? '设置失败' : 'Setup failed'))
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = async () => {
    setError(null)
    setLoading(true)

    try {
        const { error: loginError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (loginError) {
          setError(loginError.message)
          setLoading(false)
          return
        }

      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: userProfile } = await supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', user.id)
          .maybeSingle()

        if (userProfile?.handle) {
          router.push(`/u/${userProfile.handle}`)
        } else if (user.email) {
          router.push(`/u/${user.email.split('@')[0]}`)
        } else {
          router.push('/')
        }
      } else {
        router.push('/')
      }
    } catch (err: any) {
      setError(err?.message || (lang === 'zh' ? '登录失败' : 'Login failed'))
    } finally {
      setLoading(false)
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
            中文
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
            {isRegister ? t.createAccount : t.welcomeBack}
          </h1>
          <p style={{ 
            fontSize: 14, 
            color: '#7a7a7a',
            fontWeight: 500,
          }}>
            {t.subtitle}
          </p>
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
            {t.email}
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
              <span style={{ color: '#ff7c7c' }}>✕ {lang === 'zh' ? emailValidation.message : emailValidation.messageEn}</span>
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
                    : 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
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
                {sendingCode ? t.sendingCode : t.sendCode}
              </button>
            ) : !codeVerified ? (
              <>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
                    {t.code}
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
                    {t.codeValidFor}
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
                      : 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
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
                  {loading ? t.verifying : t.verifyCode}
                </button>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
                  {countdown > 0 ? (
                    <span style={{ fontSize: 13, color: '#6a6a6a' }}>
                      {countdown} {t.countdown}
                    </span>
                  ) : (
                    <button
                      onClick={handleResendCode}
                      disabled={!email}
                      className="link-hover"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#8b6fa8',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: !email ? 'not-allowed' : 'pointer',
                        padding: 0,
                      }}
                    >
                      {t.resendCode}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Username input */}
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
                    {t.handle}
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
                    placeholder={lang === 'zh' ? '用户名' : 'Username'}
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    onBlur={() => markTouched('handle')}
                  />
                  {touchedFields.handle && handle && !handleValidation.valid && (
                    <div style={{ marginTop: 6, fontSize: 12 }}>
                      <span style={{ color: '#ff7c7c' }}>✕ {lang === 'zh' ? handleValidation.message : handleValidation.messageEn}</span>
                    </div>
                  )}
                </div>
                
                {/* Password input */}
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
                    {t.password}
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
                      placeholder={lang === 'zh' ? '设置密码（至少6位）' : 'Set password (min 6 chars)'}
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
                      {showPassword ? (lang === 'zh' ? '隐藏' : 'Hide') : (lang === 'zh' ? '显示' : 'Show')}
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
                          {lang === 'zh' ? `密码强度: ${passwordStrength.label}` : `Strength: ${passwordStrength.labelEn}`}
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
                      : 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
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
                  {loading ? t.registering : t.setPassword}
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
                    {t.password}
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
                      placeholder={lang === 'zh' ? '密码' : 'Password'}
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
                      {showPassword ? (lang === 'zh' ? '隐藏' : 'Hide') : (lang === 'zh' ? '显示' : 'Show')}
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
                      : 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
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
                  {loading ? t.loggingIn : t.login}
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
                    {t.forgotPassword}
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
                    color: '#8b6fa8',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    marginBottom: 12,
                  }}
                >
                  {t.loginWithCode}
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
                        : 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
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
                    {sendingCode ? t.sendingCode : t.sendCode}
                  </button>
                ) : (
                  <>
                    <div style={{ marginBottom: 20 }}>
                      <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 600, color: '#b0b0b0' }}>
                        {t.code}
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
                        {t.codeValidFor}
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
                          : 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
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
                      {loading ? t.verifying : t.verifyCode}
                    </button>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
                      {countdown > 0 ? (
                        <span style={{ fontSize: 13, color: '#6a6a6a' }}>
                          {countdown} {t.countdown}
                        </span>
                      ) : (
                        <button
                          onClick={handleSendLoginCode}
                          disabled={!email}
                          className="link-hover"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#8b6fa8',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: !email ? 'not-allowed' : 'pointer',
                            padding: 0,
                          }}
                        >
                          {t.resendCode}
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
                        color: '#8b6fa8',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                        marginBottom: 12,
                      }}
                    >
                      {lang === 'zh' ? '使用密码登录' : 'Login with password'}
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
          <span style={{ fontSize: 12, color: '#5a5a5a' }}>or</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255, 255, 255, 0.1)' }} />
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
          {isRegister ? t.switchToLogin : t.switchToRegister}
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
