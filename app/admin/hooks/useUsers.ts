'use client'

import { useState, useCallback } from 'react'

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

export function useUsers(accessToken: string | null) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [pagination, setPagination] = useState<UsersPagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  })
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})

  const loadUsers = useCallback(async (
    page: number = 1,
    search: string = '',
    filter: 'all' | 'banned' | 'active' = 'all'
  ) => {
    if (!accessToken) return
    
    setLoading(true)
    
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
        setUsers(data.users)
        setPagination(data.pagination)
      }
    } catch (err) {
      console.error('Error loading users:', err)
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
        alert(data.error || '操作失败')
        return false
      }
    } catch (err) {
      alert('网络错误')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [userId]: false }))
    }
  }, [accessToken])

  const unbanUser = useCallback(async (userId: string) => {
    if (!accessToken) return false
    
    setActionLoading(prev => ({ ...prev, [userId]: true }))
    
    try {
      const res = await fetch(`/api/admin/users/${userId}/unban`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
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
        alert(data.error || '操作失败')
        return false
      }
    } catch (err) {
      alert('网络错误')
      return false
    } finally {
      setActionLoading(prev => ({ ...prev, [userId]: false }))
    }
  }, [accessToken])

  return {
    users,
    pagination,
    loading,
    actionLoading,
    loadUsers,
    banUser,
    unbanUser,
  }
}
