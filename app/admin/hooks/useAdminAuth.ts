'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'

// 管理员邮箱白名单（可以移到环境变量或数据库）
const ADMIN_EMAILS: string[] = ['test@example.com']

export function useAdminAuth() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    checkAuth()
  }, [])

  async function checkAuth() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.user) {
        router.push('/login?redirect=/admin')
        return
      }

      setEmail(session.user.email ?? null)
      setAccessToken(session.access_token)
      setUserId(session.user.id)
      
      // 检查是否是管理员
      // 方法1: 邮箱白名单
      const isAdminByEmail = session.user.email && ADMIN_EMAILS.includes(session.user.email)
      
      // 方法2: 检查数据库中的 admin 角色
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()
      
      const isAdminByRole = profile?.role === 'admin'
      
      if (!isAdminByEmail && !isAdminByRole) {
        // 不是管理员，重定向到首页
        router.push('/')
        return
      }
      
      setIsAdmin(true)
      setAuthChecking(false)
    } catch (error) {
      console.error('Auth check failed:', error)
      router.push('/login')
    }
  }

  return {
    email,
    accessToken,
    isAdmin,
    authChecking,
    userId,
  }
}
