'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

export interface AdminUser {
  id: string
  handle: string | null
  email: string | null
  avatar_url: string | null
  bio: string | null
  follower_count: number
  following_count: number
  role: string | null
  banned_at: string | null
  banned_reason: string | null
  banned_by: string | null
  created_at: string
  updated_at: string
}

export interface UsersPagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export function useUsers(accessToken: string | null, showToast?: ToastFn) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [pagination, setPagination] = useState<UsersPagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})

  const loadUsers = useCallback(async (
    page: number = 1,
    search: string = '',
    filter: 'all' | 'banned' | 'active' = 'all'
  ) => {
    if (!accessToken) {
      setError('未登录或无权限')
      return
    }
    
    setLoading(true)
    setError(null)
    
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
        filter,
      })
      if (search) params.set('search', search)
      
      const res = await fetch(`/api/admin/users?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const data = await res.json()
      
      if (data.ok) {
        setUsers(data.users || [])
        setPagination(data.pagination)
      } else {
        setError(data.error || '加载失败')
        setUsers([])
      }
    } catch (err) {
      console.error('Error loading users:', err)
      setError('网络错误，请稍后重试')
      setUsers([])
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  const banUser = useCallback(async (userId: string, reason?: string) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [userId]: true }))
    
    try {
      const res = await fetch(`/api/admin/users/${userId}/ban`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ reason }),
      })
      const data = await res.json()
      
      if (data.ok) {
        // Update local state
        setUsers(prev => prev.map(u =>
          u.id === userId
            ? { ...u, banned_at: new Date().toISOString(), banned_reason: reason || null }
            : u
        ))
        return true
      } else {
        showToast?.(data.error || '操作失败', 'error')
        return false
      }
    } catch (err) {
      showToast?.('网络错误', 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [userId]: false }))
    }
  }, [accessToken, showToast])

  const unbanUser = useCallback(async (userId: string) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [userId]: true }))
    
    try {
      const res = await fetch(`/api/admin/users/${userId}/unban`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
      })
      const data = await res.json()
      
      if (data.ok) {
        // Update local state
        setUsers(prev => prev.map(u =>
          u.id === userId
            ? { ...u, banned_at: null, banned_reason: null, banned_by: null }
            : u
        ))
        return true
      } else {
        showToast?.(data.error || '操作失败', 'error')
        return false
      }
    } catch (err) {
      showToast?.('网络错误', 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [userId]: false }))
    }
  }, [accessToken, showToast])

  return {
    users,
    pagination,
    loading,
    error,
    actionLoading,
    loadUsers,
    banUser,
    unbanUser,
  }
}
