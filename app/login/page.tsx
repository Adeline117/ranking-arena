'use client'

import { useState } from 'react'
import { supabase } from "../../lib/supabase/client"
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const login = async () => {
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    setLoading(false)

    if (error) {
      setError(error.message)
      return
    }

    router.push('/app') // 登录成功 → 跳去 /app
  }

  return (
    <main style={{ padding: 40, maxWidth: 420 }}>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Login · Ranking Arena</h1>

      <label style={{ display: 'block', marginBottom: 6 }}>Email</label>
      <input
        style={{ width: '100%', padding: 10, marginBottom: 12 }}
        placeholder="you@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label style={{ display: 'block', marginBottom: 6 }}>Password</label>
      <input
        style={{ width: '100%', padding: 10, marginBottom: 12 }}
        type="password"
        placeholder="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <button
        onClick={login}
        disabled={loading || !email || !password}
        style={{ padding: '10px 14px', cursor: 'pointer' }}
      >
        {loading ? 'Logging in...' : 'Log in'}
      </button>

      {error && (
        <p style={{ color: 'tomato', marginTop: 12 }}>
          {error}
        </p>
      )}
    </main>
  )
}
