'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'

// 管理员邮箱白名单（必须通过环境变量 NEXT_PUBLIC_ADMIN_EMAILS 配置，逗号分隔）
// 安全默认值：空数组，不允许任何未配置的管理员
const ADMIN_EMAILS: string[] = process.env.NEXT_PUBLIC_ADMIN_EMAILS
  ? process.env.NEXT_PUBLIC_ADMIN_EMAILS.split(',').map(e => e.trim()).filter(e => e.length > 0)
  : []

export function useAdminAuth() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    checkAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function checkAuth() {
    try {
      // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
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
