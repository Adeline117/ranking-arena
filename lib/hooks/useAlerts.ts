/**
 * 告警相关 Hooks
 * 提供告警数据的获取和实时更新
 */

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { TraderAlert, UserAlertConfig } from '@/lib/types/alerts'
import { getCsrfHeaders } from '@/lib/api/client'

// ============================================
// useAlerts - 获取告警历史
// ============================================

interface UseAlertsOptions {
  limit?: number
  unread_only?: boolean
  trader_id?: string
  source?: string
}

interface UseAlertsReturn {
  alerts: TraderAlert[]
  unreadCount: number
  loading: boolean
  error: Error | null
  refresh: () => void
  markAsRead: (alertId: string) => Promise<void>
  markAllAsRead: () => Promise<void>
}

export function useAlerts(options: UseAlertsOptions = {}): UseAlertsReturn {
  const { limit = 50, unread_only = false, trader_id, source } = options
  
  const [alerts, setAlerts] = useState<TraderAlert[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchAlerts = useCallback(async () => {
    setLoading(true)
    setError(null)
    
    try {
      const params = new URLSearchParams()
      params.set('limit', String(limit))
      if (unread_only) params.set('unread_only', 'true')
      if (trader_id) params.set('trader_id', trader_id)
      if (source) params.set('source', source)

      const res = await fetch(`/api/alerts?${params.toString()}`)
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Failed to fetch alerts')
      }

      setAlerts(data.data?.alerts || [])
      setUnreadCount(data.data?.unread_count || 0)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      setLoading(false)
    }
  }, [limit, unread_only, trader_id, source])

  // 初始加载
  useEffect(() => {
    fetchAlerts()
  }, [fetchAlerts])

  // 实时订阅新告警
  useEffect(() => {
    const setupSubscription = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const channel = supabase
        .channel('user-alerts')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'trader_alerts',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            // 新告警插入时刷新
            setAlerts((prev) => [payload.new as TraderAlert, ...prev])
            setUnreadCount((prev) => prev + 1)
          }
        )
        .subscribe()

      return () => {
        supabase.removeChannel(channel)
      }
    }

    setupSubscription()
  }, [])

  // 标记单个告警为已读
  const markAsRead = async (alertId: string) => {
    try {
      await fetch(`/api/alerts/${alertId}`, {
        method: 'PUT',
        headers: getCsrfHeaders(),
      })
      
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, read: true } : a))
      )
      setUnreadCount((prev) => Math.max(0, prev - 1))
    } catch (err) {
      console.error('Failed to mark alert as read:', err)
    }
  }

  // 标记所有告警为已读
  const markAllAsRead = async () => {
    try {
      await fetch('/api/alerts', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ mark_all_read: true }),
      })
      
      setAlerts((prev) => prev.map((a) => ({ ...a, read: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error('Failed to mark all alerts as read:', err)
    }
  }

  return {
    alerts,
    unreadCount,
    loading,
    error,
    refresh: fetchAlerts,
    markAsRead,
    markAllAsRead,
  }
}

// ============================================
// useAlertConfigs - 获取告警配置
// ============================================

interface UseAlertConfigsReturn {
  configs: UserAlertConfig[]
  loading: boolean
  error: Error | null
  refresh: () => void
  createConfig: (input: Partial<UserAlertConfig>) => Promise<UserAlertConfig | null>
  updateConfig: (id: string, input: Partial<UserAlertConfig>) => Promise<UserAlertConfig | null>
  deleteConfig: (id: string) => Promise<boolean>
}

export function useAlertConfigs(): UseAlertConfigsReturn {
  const [configs, setConfigs] = useState<UserAlertConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchConfigs = useCallback(async () => {
    setLoading(true)
    setError(null)
    
    try {
      const res = await fetch('/api/alerts?type=configs')
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Failed to fetch configs')
      }

      setConfigs(data.data?.configs || [])
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConfigs()
  }, [fetchConfigs])

  const createConfig = async (input: Partial<UserAlertConfig>): Promise<UserAlertConfig | null> => {
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders(),
        },
        body: JSON.stringify(input),
      })
      
      const data = await res.json()
      
      if (!res.ok) {
        throw new Error(data.message || 'Failed to create config')
      }
      
      const newConfig = data.data?.config
      if (newConfig) {
        setConfigs((prev) => [newConfig, ...prev])
      }
      
      return newConfig
    } catch (err) {
      console.error('Failed to create alert config:', err)
      return null
    }
  }

  const updateConfig = async (id: string, input: Partial<UserAlertConfig>): Promise<UserAlertConfig | null> => {
    try {
      const res = await fetch(`/api/alerts/config/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders(),
        },
        body: JSON.stringify(input),
      })
      
      const data = await res.json()
      
      if (!res.ok) {
        throw new Error(data.message || 'Failed to update config')
      }
      
      const updatedConfig = data.data?.config
      if (updatedConfig) {
        setConfigs((prev) =>
          prev.map((c) => (c.id === id ? updatedConfig : c))
        )
      }
      
      return updatedConfig
    } catch (err) {
      console.error('Failed to update alert config:', err)
      return null
    }
  }

  const deleteConfig = async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/alerts/config/${id}`, {
        method: 'DELETE',
        headers: getCsrfHeaders(),
      })
      
      if (!res.ok) {
        throw new Error('Failed to delete config')
      }
      
      setConfigs((prev) => prev.filter((c) => c.id !== id))
      return true
    } catch (err) {
      console.error('Failed to delete alert config:', err)
      return false
    }
  }

  return {
    configs,
    loading,
    error,
    refresh: fetchConfigs,
    createConfig,
    updateConfig,
    deleteConfig,
  }
}

// ============================================
// useUnreadAlertCount - 仅获取未读数量
// ============================================

export function useUnreadAlertCount(): { count: number; loading: boolean } {
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchCount = async () => {
      try {
        const res = await fetch('/api/alerts?limit=1')
        const data = await res.json()
        setCount(data.data?.unread_count || 0)
      } catch (err) {
        console.error('Failed to fetch unread count:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchCount()

    // 实时订阅
    const setupSubscription = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const channel = supabase
        .channel('alert-count')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'trader_alerts',
            filter: `user_id=eq.${user.id}`,
          },
          () => {
            setCount((prev) => prev + 1)
          }
        )
        .subscribe()

      return () => {
        supabase.removeChannel(channel)
      }
    }

    setupSubscription()
  }, [])

  return { count, loading }
}
