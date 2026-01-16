'use client'

import { useState, useEffect } from 'react'
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
  },
}

// 密码强度计算函数
function getPasswordStrength(password: string): { level: 0 | 1 | 2 | 3 | 4; label: string; color: string } {
  if (!password) return { level: 0, label: '', color: '' }
  
  let score = 0
  if (password.length >= 6) score++
  if (password.length >= 8) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++
  
  if (score <= 1) return { level: 1, label: '弱', color: '#ff4d4d' }
  if (score === 2) return { level: 2, label: '一般', color: '#ffa500' }
  if (score === 3) return { level: 3, label: '中等', color: '#ffc107' }
  return { level: 4, label: '强', color: '#2fe57d' }
}

// 实时验证函数
function validateEmail(email: string): { valid: boolean; message: string } {
  if (!email) return { valid: true, message: '' }  // 空值不显示错误
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return { valid: false, message: '请输入有效的邮箱地址' }
  }
  return { valid: true, message: '' }
}

function validatePassword(password: string, lang: 'zh' | 'en'): { valid: boolean; message: string } {
  if (!password) return { valid: true, message: '' }  // 空值不显示错误
  if (password.length < 6) {
    return { 
      valid: false, 
      message: lang === 'zh' ? '密码至少需要6个字符' : 'Password must be at least 6 characters' 
    }
  }
  return { valid: true, message: '' }
}

function validateHandle(handle: string, lang: 'zh' | 'en'): { valid: boolean; message: string } {
  if (!handle) return { valid: true, message: '' }  // 空值不显示错误
  if (handle.length < 1) {
    return { 
      valid: false, 
      message: lang === 'zh' ? '用户名至少需要1个字符' : 'Username must be at least 1 character' 
    }
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(handle)) {
    return { 
      valid: false, 
      message: lang === 'zh' ? '用户名只能包含字母、数字、下划线和中文' : 'Username can only contain letters, numbers, underscores and Chinese characters' 
    }
  }
  return { valid: true, message: '' }
}

// 内联验证提示样式
const validationStyle = {
  marginTop: 4,
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
}

const errorTextStyle = {
  color: '#ff7c7c',
}

const successTextStyle = {
  color: '#2fe57d',
}

export default function LoginPage() {
  const [lang, setLang] = useState<Language>(() => {
    // 从 localStorage 读取语言偏好
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
  const [loginWithCode, setLoginWithCode] = useState(false) // 登录时是否使用验证码
  const [showPassword, setShowPassword] = useState(false) // 密码可见性切换
  
  // 实时验证相关状态
  const [touchedFields, setTouchedFields] = useState<{
    email: boolean;
    password: boolean;
    handle: boolean;
  }>({ email: false, password: false, handle: false })
  
  const router = useRouter()
  const { showToast } = useToast()

  const t = translations[lang]
  const passwordStrength = getPasswordStrength(password)
  
  // 实时验证结果
  const emailValidation = validateEmail(email)
  const passwordValidation = validatePassword(password, lang)
  const handleValidation = validateHandle(handle, lang)
  
  // 标记字段为已触摸
  const markTouched = (field: 'email' | 'password' | 'handle') => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }

  // 语言偏好保存到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('preferredLanguage', lang)
    }
  }, [lang])

  // 处理认证状态变化（但不自动跳转，等待用户完成注册流程）
  useEffect(() => {
    // 监听认证状态变化
    // 注意：在注册流程中（codeVerified 为 true），不自动跳转，需要等待用户设置密码和用户名
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // 只有在登录模式下（不是注册模式），且不是注册流程中，才自动跳转
      if (event === 'SIGNED_IN' && session && !isRegister && !codeVerified) {
        // 登录成功，获取用户 handle 并跳转到用户主页
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

  // 倒计时
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // 发送验证码（OTP，不是 Magic Link）
  const handleSendCode = async () => {
    if (!email) {
      setError('请输入邮箱')
      return
    }

    setError(null)
    setSendingCode(true)

    try {
      // 关键：确保发送 OTP 验证码而不是 Magic Link
      // 1. 不设置 emailRedirectTo
      // 2. 明确指定 type 为 'email'（虽然这是默认值）
      // 3. 确保 shouldCreateUser 为 true（注册模式）
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true, // 如果用户不存在则创建
          // 关键：绝对不要设置 emailRedirectTo
          // 如果设置了 emailRedirectTo，Supabase 会发送 Magic Link 而不是 OTP 验证码
        },
      })

      if (otpError) {
        // 检查是否是配置问题
        if (otpError.message.includes('redirect') || otpError.message.includes('link')) {
          setError('配置错误：Supabase 可能配置为发送 Magic Link。请检查 Supabase Dashboard → Authentication → Settings → Site URL 是否正确设置为 https://www.arenafi.org，并确保 Email Templates 配置为发送验证码。')
        } else {
          setError(otpError.message || '发送失败，请重试')
        }
        setSendingCode(false)
        return
      }

      // 验证是否成功发送
      if (data) {
        setCodeSent(true)
        setCountdown(60) // 开始60秒倒计时（重发限制）
        showToast(t.codeSent, 'success')
      } else {
        setError('发送失败，请重试。如果仍然收到链接而不是验证码，请检查 Supabase Dashboard 中的 Email Auth 配置。')
      }
    } catch (err: any) {
      setError(err?.message || '发送失败，请检查网络连接')
    } finally {
      setSendingCode(false)
    }
  }

  // 重新发送验证码
  const handleResendCode = async () => {
    if (countdown > 0) return // 倒计时未结束，不允许重发
    await handleSendCode()
  }

  // 发送登录验证码（OTP）
  const handleSendLoginCode = async () => {
    if (!email) {
      setError('请输入邮箱')
      return
    }

    setError(null)
    setSendingCode(true)

    try {
      // 登录时发送验证码，不创建新用户
      const { data, error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false, // 登录时不创建新用户
          // 关键：绝对不要设置 emailRedirectTo，否则会发送 Magic Link
        },
      })

      if (otpError) {
        setError(otpError.message || '发送失败，请重试')
        setSendingCode(false)
        return
      }

      if (data) {
        setCodeSent(true)
        setCountdown(60)
        showToast(t.codeSent, 'success')
      } else {
        setError('发送失败，请重试')
      }
    } catch (err: any) {
      setError(err?.message || '发送失败')
    } finally {
      setSendingCode(false)
    }
  }


  // 验证验证码（注册或登录）
  const handleVerifyCode = async () => {
    if (!code) {
      setError('请输入验证码')
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
        // 检查是否是验证码过期错误
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
          // 注册模式：验证成功，但不立即跳转，需要等待用户设置密码和用户名
          setCodeVerified(true)
          // 创建临时用户 profile（用户名稍后设置）
          await createUserProfile(data.user.id, email)
          showToast(t.codeVerified, 'success')
          // 不在这里跳转，等待用户完成设置密码和用户名
        } else {
          // 登录模式：验证成功，立即登录并跳转
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
      // 检查是否是验证码过期错误
      if (err?.message?.includes('expired') || err?.message?.includes('过期')) {
        setError(t.codeExpired)
      } else {
        setError(err?.message || '验证失败')
      }
    } finally {
      setLoading(false)
    }
  }

  // 创建用户 profile
  const createUserProfile = async (userId: string, userEmail: string, userHandle?: string) => {
    try {
      const finalHandle = userHandle || userEmail.split('@')[0]
      
      // 只使用 user_profiles（避免访问不存在的 profiles 表）
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
      // 不阻止注册流程，profile 可以稍后创建
    }
  }

  // 设置密码和用户名（验证码注册后）
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
      // 用户名可以重复，不需要检查唯一性
      // 用户ID由Supabase自动生成，保证唯一性

      // 更新密码
      const { data: { user }, error: updateError } = await supabase.auth.updateUser({
        password,
      })

      if (updateError) {
        setError(updateError.message)
        setLoading(false)
        return
      }

      if (user) {
        // 创建/更新用户 profile（用户名可以重复）
        await createUserProfile(user.id, email, handle)
        
        // 注册完成，跳转到新用户引导页面
        router.push('/welcome')
      } else {
        router.push('/')
      }
    } catch (err: any) {
      setError(err?.message || '设置失败')
    } finally {
      setLoading(false)
    }
  }


  // 登录
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

      // 登录成功，获取用户 handle 并跳转到用户主页
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        // 只从 user_profiles 取 handle
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
      setError(err?.message || '登录失败')
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

  return (
    <div style={{ 
      minHeight: '100vh', 
      background: '#060606', 
      color: '#f2f2f2',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    }}>
      <div 
        className="login-container"
        style={{ 
          maxWidth: 420, 
          width: '100%',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid #1f1f1f',
          borderRadius: 16,
          padding: 32,
        }}
      >
        {/* 语言选择 */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'flex-end', 
          marginBottom: 20,
          gap: 8,
        }}>
          <button
            onClick={() => setLang('zh')}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: lang === 'zh' ? '1px solid #8b6fa8' : '1px solid #1f1f1f',
              background: lang === 'zh' ? 'rgba(139,111,168,0.15)' : 'transparent',
              color: '#eaeaea',
              cursor: 'pointer',
              fontWeight: lang === 'zh' ? 900 : 700,
              fontSize: 13,
            }}
          >
            中文
          </button>
          <button
            onClick={() => setLang('en')}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: lang === 'en' ? '1px solid #8b6fa8' : '1px solid #1f1f1f',
              background: lang === 'en' ? 'rgba(139,111,168,0.15)' : 'transparent',
              color: '#eaeaea',
              cursor: 'pointer',
              fontWeight: lang === 'en' ? 900 : 700,
              fontSize: 13,
            }}
          >
            English
          </button>
        </div>

        <h1 className="login-title" style={{ fontSize: 24, marginBottom: 24, fontWeight: 950 }}>
          {t.title}
        </h1>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
            {t.email}
          </label>
          <input
            type="email"
            className="login-input"
            style={{ 
              width: '100%', 
              padding: 12, 
              borderRadius: 12,
              border: `1px solid ${touchedFields.email && !emailValidation.valid ? '#ff7c7c' : '#1f1f1f'}`,
              background: '#0b0b0b',
              color: '#eaeaea',
              fontSize: 14,
              outline: 'none',
              transition: 'border-color 0.2s ease',
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
          {/* 实时邮箱验证提示 */}
          {touchedFields.email && email && (
            <div style={validationStyle}>
              {emailValidation.valid ? (
                <span style={successTextStyle}>✓ 邮箱格式正确</span>
              ) : (
                <span style={errorTextStyle}>✕ {emailValidation.message}</span>
              )}
            </div>
          )}
        </div>

        {/* 注册模式：验证码流程 */}
        {isRegister && (
          <>
            {!codeSent ? (
              <button
                onClick={handleSendCode}
                disabled={sendingCode || !email || countdown > 0}
                style={{ 
                  width: '100%',
                  padding: '12px 16px', 
                  borderRadius: 12,
                  border: 'none',
                  background: sendingCode || !email || countdown > 0 ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                  color: '#fff',
                  fontWeight: 900,
                  fontSize: 14,
                  cursor: sendingCode || !email || countdown > 0 ? 'not-allowed' : 'pointer',
                  marginBottom: 16,
                }}
              >
                {sendingCode ? t.sendingCode : t.sendCode}
              </button>
            ) : !codeVerified ? (
              <>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                    {t.code}
                  </label>
                  <input
                    type="text"
                    style={{ 
                      width: '100%', 
                      padding: 12, 
                      borderRadius: 12,
                      border: '1px solid #1f1f1f',
                      background: '#0b0b0b',
                      color: '#eaeaea',
                      fontSize: 14,
                      outline: 'none',
                    }}
                    placeholder="输入验证码"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !loading && code) {
                        handleVerifyCode()
                      }
                    }}
                  />
                  <div style={{ marginTop: 6, fontSize: 11, color: '#9a9a9a' }}>
                    {t.codeValidFor}
                  </div>
                </div>
                <button
                  onClick={handleVerifyCode}
                  disabled={loading || !code}
                  style={{ 
                    width: '100%',
                    padding: '12px 16px', 
                    borderRadius: 12,
                    border: 'none',
                    background: loading || !code ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                    color: '#fff',
                    fontWeight: 900,
                    fontSize: 14,
                    cursor: loading || !code ? 'not-allowed' : 'pointer',
                    marginBottom: 16,
                  }}
                >
                  {loading ? t.verifying : t.verifyCode}
                </button>
                {/* 重新发送验证码 */}
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
                  {countdown > 0 ? (
                    <span style={{ fontSize: 12, color: '#9a9a9a' }}>
                      {countdown} {t.countdown}
                    </span>
                  ) : (
                    <button
                      onClick={handleResendCode}
                      disabled={!email}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#8b6fa8',
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: !email ? 'not-allowed' : 'pointer',
                        textDecoration: 'underline',
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
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                    {t.handle}
                  </label>
                  <input
                    type="text"
                    style={{ 
                      width: '100%', 
                      padding: 12, 
                      borderRadius: 12,
                      border: `1px solid ${touchedFields.handle && !handleValidation.valid ? '#ff7c7c' : '#1f1f1f'}`,
                      background: '#0b0b0b',
                      color: '#eaeaea',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border-color 0.2s ease',
                    }}
                    placeholder="用户名（至少3个字符，可重复）"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    onBlur={() => markTouched('handle')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !loading && handle && handle.length >= 3 && password && password.length >= 6) {
                        handleSetPassword()
                      }
                    }}
                  />
                  {/* 实时用户名验证提示 */}
                  {touchedFields.handle && handle && (
                    <div style={validationStyle}>
                      {handleValidation.valid ? (
                        <span style={successTextStyle}>✓ 用户名格式正确</span>
                      ) : (
                        <span style={errorTextStyle}>✕ {handleValidation.message}</span>
                      )}
                    </div>
                  )}
                  {/* 字符计数 */}
                  {handle && (
                    <div style={{ marginTop: 4, fontSize: 11, color: handle.length >= 3 ? '#9a9a9a' : '#ff7c7c' }}>
                      {handle.length}/3 字符（最少）
                    </div>
                  )}
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                    {t.password}
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      style={{ 
                        width: '100%', 
                        padding: 12, 
                        paddingRight: 44,
                        borderRadius: 12,
                        border: `1px solid ${touchedFields.password && !passwordValidation.valid ? '#ff7c7c' : '#1f1f1f'}`,
                        background: '#0b0b0b',
                        color: '#eaeaea',
                        fontSize: 14,
                        outline: 'none',
                        transition: 'border-color 0.2s ease',
                      }}
                      placeholder="设置密码（至少6位）"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onBlur={() => markTouched('password')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !loading && handle && handle.length >= 3 && password && password.length >= 6) {
                          handleSetPassword()
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: 'absolute',
                        right: 12,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'transparent',
                        border: 'none',
                        padding: 4,
                        cursor: 'pointer',
                        color: '#9a9a9a',
                        fontSize: 16,
                      }}
                      tabIndex={-1}
                    >
                      {showPassword ? '隐藏' : '显示'}
                    </button>
                  </div>
                  {/* 实时密码验证提示 */}
                  {touchedFields.password && password && !passwordValidation.valid && (
                    <div style={validationStyle}>
                      <span style={errorTextStyle}>✕ {passwordValidation.message}</span>
                    </div>
                  )}
                  {/* 密码强度指示器 */}
                  {password && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                        {[1, 2, 3, 4].map((level) => (
                          <div
                            key={level}
                            style={{
                              flex: 1,
                              height: 4,
                              borderRadius: 2,
                              background: level <= passwordStrength.level ? passwordStrength.color : '#2a2a2a',
                              transition: 'background 0.2s ease',
                            }}
                          />
                        ))}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: passwordStrength.color }}>
                          密码强度: {passwordStrength.label}
                        </span>
                        <span style={{ fontSize: 11, color: password.length >= 6 ? '#9a9a9a' : '#ff7c7c' }}>
                          {password.length}/6 字符
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={handleSetPassword}
                  disabled={loading || !password || password.length < 6 || !handle || handle.length < 1}
                  style={{ 
                    width: '100%',
                    padding: '12px 16px', 
                    borderRadius: 12,
                    border: 'none',
                    background: loading || !password || password.length < 6 || !handle || handle.length < 1 ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                    color: '#fff',
                    fontWeight: 900,
                    fontSize: 14,
                    cursor: loading || !password || password.length < 6 || !handle || handle.length < 1 ? 'not-allowed' : 'pointer',
                    marginBottom: 16,
                  }}
                >
                  {loading ? t.registering : t.setPassword}
                </button>
              </>
            )}
          </>
        )}


        {/* 登录模式 */}
        {!isRegister && (
          <>
            {!loginWithCode ? (
              <>
                {/* 密码登录 */}
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                    {t.password}
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="login-input"
                      style={{ 
                        width: '100%', 
                        padding: 12, 
                        paddingRight: 44,
                        borderRadius: 12,
                        border: `1px solid ${touchedFields.password && password && !passwordValidation.valid ? '#ff7c7c' : '#1f1f1f'}`,
                        background: '#0b0b0b',
                        color: '#eaeaea',
                        fontSize: 14,
                        outline: 'none',
                        transition: 'border-color 0.2s ease',
                      }}
                      placeholder="password"
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
                      style={{
                        position: 'absolute',
                        right: 12,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'transparent',
                        border: 'none',
                        padding: 4,
                        cursor: 'pointer',
                        color: '#9a9a9a',
                        fontSize: 16,
                      }}
                      tabIndex={-1}
                    >
                      {showPassword ? '隐藏' : '显示'}
                    </button>
                  </div>
                  {/* 实时密码验证提示（登录模式） */}
                  {touchedFields.password && password && !passwordValidation.valid && (
                    <div style={validationStyle}>
                      <span style={errorTextStyle}>✕ {passwordValidation.message}</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={handleLogin}
                  disabled={loading || !email || !password}
                  className="login-button"
                  style={{ 
                    width: '100%',
                    padding: '12px 16px', 
                    borderRadius: 12,
                    border: 'none',
                    background: loading || !email || !password ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                    color: '#fff',
                    fontWeight: 900,
                    fontSize: 14,
                    cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
                    marginBottom: 12,
                  }}
                >
                  {loading ? t.loggingIn : t.login}
                </button>
                {/* 忘记密码 */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <a
                    href="/reset-password"
                    style={{
                      color: '#9a9a9a',
                      fontSize: 12,
                      textDecoration: 'none',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = '#8b6fa8'
                      e.currentTarget.style.textDecoration = 'underline'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = '#9a9a9a'
                      e.currentTarget.style.textDecoration = 'none'
                    }}
                  >
                    {t.forgotPassword}
                  </a>
                </div>
                {/* 切换到验证码登录 */}
                <button
                  onClick={() => {
                    setLoginWithCode(true)
                    setCodeSent(false)
                    setCode('')
                    setError(null)
                  }}
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: 'none',
                    background: 'transparent',
                    color: '#8b6fa8',
                    fontWeight: 800,
                    fontSize: 13,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    marginBottom: 12,
                  }}
                >
                  {t.loginWithCode}
                </button>
              </>
            ) : (
              <>
                {/* 验证码登录 */}
                {!codeSent ? (
                  <button
                    onClick={handleSendLoginCode}
                    disabled={sendingCode || !email || countdown > 0}
                    style={{ 
                      width: '100%',
                      padding: '12px 16px', 
                      borderRadius: 12,
                      border: 'none',
                      background: sendingCode || !email || countdown > 0 ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                      color: '#fff',
                      fontWeight: 900,
                      fontSize: 14,
                      cursor: sendingCode || !email || countdown > 0 ? 'not-allowed' : 'pointer',
                      marginBottom: 16,
                    }}
                  >
                    {sendingCode ? t.sendingCode : t.sendCode}
                  </button>
                ) : (
                  <>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                        {t.code}
                      </label>
                      <input
                        type="text"
                        className="login-input"
                        style={{ 
                          width: '100%', 
                          padding: 12, 
                          borderRadius: 12,
                          border: '1px solid #1f1f1f',
                          background: '#0b0b0b',
                          color: '#eaeaea',
                          fontSize: 14,
                          outline: 'none',
                        }}
                        placeholder="输入验证码"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !loading && code) {
                            handleVerifyCode()
                          }
                        }}
                      />
                      <div style={{ marginTop: 6, fontSize: 11, color: '#9a9a9a' }}>
                        {t.codeValidFor}
                      </div>
                    </div>
                    <button
                      onClick={handleVerifyCode}
                      disabled={loading || !code}
                      className="login-button"
                      style={{ 
                        width: '100%',
                        padding: '12px 16px', 
                        borderRadius: 12,
                        border: 'none',
                        background: loading || !code ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                        color: '#fff',
                        fontWeight: 900,
                        fontSize: 14,
                        cursor: loading || !code ? 'not-allowed' : 'pointer',
                        marginBottom: 12,
                      }}
                    >
                      {loading ? t.verifying : t.verifyCode}
                    </button>
                    {/* 重新发送验证码 */}
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
                      {countdown > 0 ? (
                        <span style={{ fontSize: 12, color: '#9a9a9a' }}>
                          {countdown} {t.countdown}
                        </span>
                      ) : (
                        <button
                          onClick={handleSendLoginCode}
                          disabled={!email}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#8b6fa8',
                            fontSize: 12,
                            fontWeight: 800,
                            cursor: !email ? 'not-allowed' : 'pointer',
                            textDecoration: 'underline',
                            padding: 0,
                          }}
                        >
                          {t.resendCode}
                        </button>
                      )}
                    </div>
                    {/* 切换回密码登录 */}
                    <button
                      onClick={() => {
                        setLoginWithCode(false)
                        setCodeSent(false)
                        setCode('')
                        setError(null)
                      }}
                      style={{
                        width: '100%',
                        padding: '8px',
                        border: 'none',
                        background: 'transparent',
                        color: '#8b6fa8',
                        fontWeight: 800,
                        fontSize: 13,
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        marginBottom: 12,
                      }}
                    >
                      使用密码登录
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* 切换登录/注册 */}
        <button
          onClick={() => {
            setIsRegister(!isRegister)
            resetForm()
          }}
          style={{
            width: '100%',
            padding: '8px',
            border: 'none',
            background: 'transparent',
            color: '#8b6fa8',
            fontWeight: 800,
            fontSize: 13,
            cursor: 'pointer',
            textDecoration: 'underline',
            marginBottom: 16,
          }}
        >
          {isRegister ? t.switchToLogin : t.switchToRegister}
        </button>

        {error && (
          <div style={{ 
            marginTop: 16,
            padding: 12,
            borderRadius: 12,
            background: 'rgba(255,77,77,0.15)',
            border: '1px solid rgba(255,77,77,0.3)',
            color: '#ff7c7c',
            fontSize: 13,
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
