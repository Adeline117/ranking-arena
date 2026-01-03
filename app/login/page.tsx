'use client'

import { useState } from 'react'
import { supabase } from "@/lib/supabase/client"
import { useRouter } from 'next/navigation'

type Language = 'zh' | 'en'

const translations = {
  zh: {
    title: '登录 / 注册',
    email: '邮箱',
    password: '密码',
    login: '登录',
    register: '注册',
    loggingIn: '登录中...',
    registering: '注册中...',
    switchToRegister: '还没有账号？点击注册',
    switchToLogin: '已有账号？点击登录',
    language: '语言',
    loginSuccess: '登录成功',
    registerSuccess: '注册成功，请登录',
  },
  en: {
    title: 'Login / Register',
    email: 'Email',
    password: 'Password',
    login: 'Login',
    register: 'Register',
    loggingIn: 'Logging in...',
    registering: 'Registering...',
    switchToRegister: 'No account? Click to register',
    switchToLogin: 'Have an account? Click to login',
    language: 'Language',
    loginSuccess: 'Login successful',
    registerSuccess: 'Registration successful, please login',
  },
}

export default function LoginPage() {
  const [lang, setLang] = useState<Language>('zh')
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const t = translations[lang]

  const handleSubmit = async () => {
    setError(null)
    setLoading(true)

    try {
      if (isRegister) {
        // 注册
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        })

        if (signUpError) {
          setError(signUpError.message)
          setLoading(false)
          return
        }

        // 注册成功，切换到登录模式
        setIsRegister(false)
        setError(null)
        alert(t.registerSuccess)
      } else {
        // 登录
        const { error: loginError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (loginError) {
          setError(loginError.message)
          setLoading(false)
          return
        }

        // 登录成功，跳转到首页
        router.push('/')
      }
    } catch (err: any) {
      setError(err?.message || 'An error occurred')
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
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !loading && email && password) {
                handleSubmit()
              }
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
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
                handleSubmit()
              }
            }}
          />
        </div>

        <button
          onClick={handleSubmit}
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
            marginBottom: 16,
          }}
        >
          {loading 
            ? (isRegister ? t.registering : t.loggingIn)
            : (isRegister ? t.register : t.login)
          }
        </button>

        <button
          onClick={() => {
            setIsRegister(!isRegister)
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
