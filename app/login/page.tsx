'use client'

import { useState, useEffect } from 'react'
import { supabase } from "@/lib/supabase/client"
import { useRouter } from 'next/navigation'

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
    switchToLogin: '已有账号？使用密码登录',
    switchToPasswordRegister: '使用密码注册',
    language: '语言',
    loginSuccess: '登录成功',
    registerSuccess: '注册成功，请登录',
    codeSent: '验证码已发送，请查收邮箱',
    codeVerified: '验证成功，请设置密码和用户名',
    setPassword: '完成注册',
    passwordRequired: '请设置密码',
    passwordMinLength: '密码至少6位',
    handleRequired: '请输入用户名',
    handleMinLength: '用户名至少3个字符',
    countdown: '秒后重发',
    loginWithLink: '或使用邮箱链接登录',
    sendLink: '发送登录链接',
    linkSent: '登录链接已发送，请查收邮箱',
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
    switchToLogin: 'Have an account? Login with password',
    switchToPasswordRegister: 'Register with password',
    language: 'Language',
    loginSuccess: 'Login successful',
    registerSuccess: 'Registration successful, please login',
    codeSent: 'Code sent, please check your email',
    codeVerified: 'Verification successful, please set password and username',
    setPassword: 'Complete Registration',
    passwordRequired: 'Please set password',
    passwordMinLength: 'Password must be at least 6 characters',
    handleRequired: 'Please enter username',
    handleMinLength: 'Username must be at least 3 characters',
    countdown: 's to resend',
    loginWithLink: 'Or login with email link',
    sendLink: 'Send Login Link',
    linkSent: 'Login link sent, please check your email',
  },
}

type RegisterMode = 'otp' | 'password'

export default function LoginPage() {
  const [lang, setLang] = useState<Language>('zh')
  const [isRegister, setIsRegister] = useState(false)
  const [registerMode, setRegisterMode] = useState<RegisterMode>('otp')
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
  const [sendingLink, setSendingLink] = useState(false)
  const router = useRouter()

  const t = translations[lang]

  // 处理邮箱链接登录（Magic Link）
  useEffect(() => {
    const handleAuthStateChange = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        router.push('/')
      }
    }

    // 检查URL中的token（Magic Link）
    const hashParams = new URLSearchParams(window.location.hash.substring(1))
    const accessToken = hashParams.get('access_token')
    const type = hashParams.get('type')

    if (accessToken && type === 'magiclink') {
      handleAuthStateChange()
    }

    // 监听认证状态变化
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        router.push('/')
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [router])

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
      // 不设置 emailRedirectTo，这样会发送 OTP 验证码而不是 Magic Link
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true, // 如果用户不存在则创建
          // 不设置 emailRedirectTo，这样会发送 6 位数字验证码
        },
      })

      if (otpError) {
        setError(otpError.message)
        setSendingCode(false)
        return
      }

      setCodeSent(true)
      setCountdown(60) // 开始60秒倒计时
      alert(t.codeSent)
    } catch (err: any) {
      setError(err?.message || '发送失败')
    } finally {
      setSendingCode(false)
    }
  }

  // 重新发送验证码
  const handleResendCode = async () => {
    if (countdown > 0) return // 倒计时未结束，不允许重发
    await handleSendCode()
  }

  // 发送登录链接（Magic Link）
  const handleSendLoginLink = async () => {
    if (!email) {
      setError('请输入邮箱')
      return
    }

    setError(null)
    setSendingLink(true)

    try {
      const redirectTo = `${window.location.origin}/login`
      
      const { error: linkError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false, // 登录时不创建新用户
          emailRedirectTo: redirectTo,
        },
      })

      if (linkError) {
        setError(linkError.message)
        setSendingLink(false)
        return
      }

      setCountdown(60) // 开始60秒倒计时
      alert(t.linkSent)
    } catch (err: any) {
      setError(err?.message || '发送失败')
    } finally {
      setSendingLink(false)
    }
  }

  // 验证验证码并注册
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
        setError(verifyError.message)
        setLoading(false)
        return
      }

      if (data.user) {
        setCodeVerified(true)
        // 创建用户 profile
        await createUserProfile(data.user.id, email)
        alert(t.codeVerified)
      }
    } catch (err: any) {
      setError(err?.message || '验证失败')
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

    if (!handle || handle.length < 3) {
      setError(t.handleMinLength)
      return
    }

    setError(null)
    setLoading(true)

    try {
      // 检查用户名是否已存在
      const { data: existingUserProfile } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('handle', handle)
        .maybeSingle()

      if (existingUserProfile) {
        setError('用户名已被使用，请选择其他用户名')
        setLoading(false)
        return
      }

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
        // 创建/更新用户 profile
        await createUserProfile(user.id, email, handle)
        
        // 注册完成，直接使用设置的 handle 跳转到用户主页
        router.push(`/u/${handle}`)
      } else {
        router.push('/')
      }
    } catch (err: any) {
      setError(err?.message || '设置失败')
    } finally {
      setLoading(false)
    }
  }

  // 密码注册
  const handlePasswordRegister = async () => {
    if (!password || password.length < 6) {
      setError(t.passwordMinLength)
      setLoading(false)
      return
    }

    setError(null)
    setLoading(true)

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        })

        if (signUpError) {
          setError(signUpError.message)
          setLoading(false)
          return
        }

      if (data.user) {
        // 创建用户 profile
        await createUserProfile(data.user.id, email)
      }

        // 注册成功，切换到登录模式
        setIsRegister(false)
        setError(null)
        alert(t.registerSuccess)
    } catch (err: any) {
      setError(err?.message || '注册失败')
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
      <div style={{ 
        maxWidth: 420, 
        width: '100%',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid #1f1f1f',
        borderRadius: 16,
        padding: 32,
      }}>
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

        <h1 style={{ fontSize: 24, marginBottom: 24, fontWeight: 950 }}>
          {t.title}
        </h1>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
            {t.email}
          </label>
          <input
            type="email"
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
            placeholder="you@email.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (isRegister) resetForm()
            }}
            disabled={codeVerified}
          />
        </div>

        {/* 注册模式：验证码流程 */}
        {isRegister && registerMode === 'otp' && (
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
                      border: '1px solid #1f1f1f',
                      background: '#0b0b0b',
                      color: '#eaeaea',
                      fontSize: 14,
                      outline: 'none',
                    }}
                    placeholder="用户名（至少3个字符）"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !loading && handle && handle.length >= 3 && password && password.length >= 6) {
                        handleSetPassword()
                      }
                    }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                    {t.password}
                  </label>
                  <input
                    type="password"
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
                    placeholder="设置密码（至少6位）"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !loading && handle && handle.length >= 3 && password && password.length >= 6) {
                        handleSetPassword()
                      }
                    }}
                  />
                </div>
                <button
                  onClick={handleSetPassword}
                  disabled={loading || !password || password.length < 6 || !handle || handle.length < 3}
                  style={{ 
                    width: '100%',
                    padding: '12px 16px', 
                    borderRadius: 12,
                    border: 'none',
                    background: loading || !password || password.length < 6 || !handle || handle.length < 3 ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                    color: '#fff',
                    fontWeight: 900,
                    fontSize: 14,
                    cursor: loading || !password || password.length < 6 || !handle || handle.length < 3 ? 'not-allowed' : 'pointer',
                    marginBottom: 16,
                  }}
                >
                  {loading ? t.registering : t.setPassword}
                </button>
              </>
            )}
          </>
        )}

        {/* 注册模式：密码注册 */}
        {isRegister && registerMode === 'password' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                {t.password}
              </label>
              <input
                type="password"
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
                placeholder="密码（至少6位）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading && email && password && password.length >= 6) {
                    handlePasswordRegister()
                  }
                }}
              />
            </div>
            <button
              onClick={handlePasswordRegister}
              disabled={loading || !email || !password || password.length < 6}
              style={{ 
                width: '100%',
                padding: '12px 16px', 
                borderRadius: 12,
                border: 'none',
                background: loading || !email || !password || password.length < 6 ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                color: '#fff',
                fontWeight: 900,
                fontSize: 14,
                cursor: loading || !email || !password || password.length < 6 ? 'not-allowed' : 'pointer',
                marginBottom: 16,
              }}
            >
              {loading ? t.registering : t.register}
            </button>
          </>
        )}

        {/* 登录模式 */}
        {!isRegister && (
          <>
            <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
            {t.password}
          </label>
          <input
            type="password"
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
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !loading && email && password) {
                    handleLogin()
              }
            }}
          />
        </div>
        <button
              onClick={handleLogin}
          disabled={loading || !email || !password}
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
            {/* 邮箱链接登录 */}
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: 12, 
            marginBottom: 16,
              padding: '12px',
              background: 'rgba(255,255,255,0.02)',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.05)',
            }}>
              <div style={{ flex: 1, fontSize: 12, color: '#9a9a9a' }}>
                {t.loginWithLink}
              </div>
              <button
                onClick={handleSendLoginLink}
                disabled={sendingLink || !email || countdown > 0}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: sendingLink || !email || countdown > 0 ? 'rgba(139,111,168,0.3)' : 'rgba(139,111,168,0.2)',
                  color: '#8b6fa8',
                  fontWeight: 800,
                  fontSize: 12,
                  cursor: sendingLink || !email || countdown > 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {sendingLink ? t.sendingCode : countdown > 0 ? `${countdown}s` : t.sendLink}
        </button>
            </div>
          </>
        )}

        {/* 切换登录/注册 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
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
          }}
        >
          {isRegister ? t.switchToLogin : t.switchToRegister}
        </button>
          
          {/* 注册时切换注册方式 */}
          {isRegister && (
            <button
              onClick={() => {
                setRegisterMode(registerMode === 'otp' ? 'password' : 'otp')
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
              }}
            >
              {registerMode === 'otp' ? t.switchToPasswordRegister : t.switchToRegister}
            </button>
          )}
        </div>

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
