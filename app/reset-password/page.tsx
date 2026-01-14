'use client'

import { useState, useEffect, Suspense } from 'react'
import { supabase } from "@/lib/supabase/client"
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

type Language = 'zh' | 'en'

const translations = {
  zh: {
    title: '重置密码',
    email: '邮箱',
    sendResetLink: '发送重置链接',
    sending: '发送中...',
    newPassword: '新密码',
    confirmPassword: '确认密码',
    resetPassword: '重置密码',
    resetting: '重置中...',
    backToLogin: '返回登录',
    emailSent: '重置链接已发送到您的邮箱，请查收',
    emailRequired: '请输入邮箱',
    passwordRequired: '请输入新密码',
    passwordMinLength: '密码至少6位',
    passwordMismatch: '两次输入的密码不一致',
    resetSuccess: '密码重置成功，正在跳转登录页...',
    countdown: '秒后可重发',
    description: '输入您的注册邮箱，我们将发送密码重置链接',
    setNewPassword: '设置新密码',
    setNewPasswordDesc: '请输入您的新密码',
  },
  en: {
    title: 'Reset Password',
    email: 'Email',
    sendResetLink: 'Send Reset Link',
    sending: 'Sending...',
    newPassword: 'New Password',
    confirmPassword: 'Confirm Password',
    resetPassword: 'Reset Password',
    resetting: 'Resetting...',
    backToLogin: 'Back to Login',
    emailSent: 'Reset link has been sent to your email',
    emailRequired: 'Please enter your email',
    passwordRequired: 'Please enter new password',
    passwordMinLength: 'Password must be at least 6 characters',
    passwordMismatch: 'Passwords do not match',
    resetSuccess: 'Password reset successful, redirecting to login...',
    countdown: 's to resend',
    description: 'Enter your email address and we\'ll send you a reset link',
    setNewPassword: 'Set New Password',
    setNewPasswordDesc: 'Please enter your new password',
  },
}

function ResetPasswordContent() {
  const [lang, setLang] = useState<Language>('zh')
  const [email, setEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [isResetMode, setIsResetMode] = useState(false) // 是否是重置模式（点击邮件链接后）
  const router = useRouter()
  const searchParams = useSearchParams()

  const t = translations[lang]

  // 检查是否有 access_token（从邮件链接跳转）
  useEffect(() => {
    // Supabase 会在 URL hash 中包含 access_token
    const hashParams = new URLSearchParams(window.location.hash.substring(1))
    const accessToken = hashParams.get('access_token')
    const type = hashParams.get('type')
    
    if (accessToken && type === 'recovery') {
      setIsResetMode(true)
    }

    // 监听认证状态
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsResetMode(true)
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  // 倒计时
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // 发送重置邮件
  const handleSendResetEmail = async () => {
    if (!email) {
      setError(t.emailRequired)
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

      setSuccess(t.emailSent)
      setCountdown(60)
    } catch (err: any) {
      setError(err?.message || '发送失败')
    } finally {
      setLoading(false)
    }
  }

  // 重置密码
  const handleResetPassword = async () => {
    if (!newPassword) {
      setError(t.passwordRequired)
      return
    }

    if (newPassword.length < 6) {
      setError(t.passwordMinLength)
      return
    }

    if (newPassword !== confirmPassword) {
      setError(t.passwordMismatch)
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

      setSuccess(t.resetSuccess)
      
      // 3秒后跳转到登录页
      setTimeout(() => {
        router.push('/login')
      }, 3000)
    } catch (err: any) {
      setError(err?.message || '重置失败')
    } finally {
      setLoading(false)
    }
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

        <h1 style={{ fontSize: 24, marginBottom: 8, fontWeight: 950 }}>
          {isResetMode ? t.setNewPassword : t.title}
        </h1>
        
        <p style={{ fontSize: 13, color: '#9a9a9a', marginBottom: 24 }}>
          {isResetMode ? t.setNewPasswordDesc : t.description}
        </p>

        {!isResetMode ? (
          // 发送重置邮件表单
          <>
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
              style={{ 
                width: '100%',
                padding: '12px 16px', 
                borderRadius: 12,
                border: 'none',
                background: loading || !email || countdown > 0 ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                color: '#fff',
                fontWeight: 900,
                fontSize: 14,
                cursor: loading || !email || countdown > 0 ? 'not-allowed' : 'pointer',
                marginBottom: 16,
              }}
            >
              {loading ? t.sending : countdown > 0 ? `${countdown} ${t.countdown}` : t.sendResetLink}
            </button>
          </>
        ) : (
          // 设置新密码表单
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                {t.newPassword}
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
                placeholder="••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800 }}>
                {t.confirmPassword}
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
                placeholder="••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading && newPassword && confirmPassword) {
                    handleResetPassword()
                  }
                }}
              />
            </div>

            <button
              onClick={handleResetPassword}
              disabled={loading || !newPassword || !confirmPassword}
              style={{ 
                width: '100%',
                padding: '12px 16px', 
                borderRadius: 12,
                border: 'none',
                background: loading || !newPassword || !confirmPassword ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                color: '#fff',
                fontWeight: 900,
                fontSize: 14,
                cursor: loading || !newPassword || !confirmPassword ? 'not-allowed' : 'pointer',
                marginBottom: 16,
              }}
            >
              {loading ? t.resetting : t.resetPassword}
            </button>
          </>
        )}

        {/* 返回登录 */}
        <Link
          href="/login"
          style={{
            display: 'block',
            textAlign: 'center',
            color: '#8b6fa8',
            fontSize: 13,
            fontWeight: 800,
            textDecoration: 'underline',
          }}
        >
          {t.backToLogin}
        </Link>

        {/* 错误信息 */}
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

        {/* 成功信息 */}
        {success && (
          <div style={{ 
            marginTop: 16,
            padding: 12,
            borderRadius: 12,
            background: 'rgba(47,229,125,0.15)',
            border: '1px solid rgba(47,229,125,0.3)',
            color: '#2fe57d',
            fontSize: 13,
          }}>
            {success}
          </div>
        )}
      </div>
    </div>
  )
}

// 使用 Suspense 包装主组件
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div style={{ 
        minHeight: '100vh', 
        background: '#060606', 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{ color: '#9a9a9a' }}>加载中...</div>
      </div>
    }>
      <ResetPasswordContent />
    </Suspense>
  )
}

