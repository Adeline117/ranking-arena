'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

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
  const { t } = useLanguage()
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
      setError(t('adminNotLoggedIn'))
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
        setError(data.error || t('adminLoadFailed'))
        setUsers([])
      }
    } catch (err) {
      logger.error('Error loading users:', err)
      setError(t('adminNetworkErrorRetry'))
      setUsers([])
    } finally {
      setLoading(false)
    }
  }, [accessToken, t])

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
        showToast?.(data.error || t('adminOperationFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [userId]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setUsers/setActionLoading use updater form
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
        showToast?.(data.error || t('adminOperationFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [userId]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setUsers/setActionLoading use updater form
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
