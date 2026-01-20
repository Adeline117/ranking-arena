'use client'

import { useState, useCallback } from 'react'

export interface AdminStats {
  users: {
    total: number
    newToday: number
    newYesterday: number
    banned: number
  }
  posts: {
    total: number
    newToday: number
    newYesterday: number
  }
  comments: {
    total: number
    newToday: number
  }
  reports: {
    pending: number
    thisWeek: number
  }
  groups: {
    total: number
    pendingApplications: number
  }
  scraperHealth: {
    fresh: number
    stale: number
    critical: number
  }
}

export function useStats(accessToken: string | null) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    if (!accessToken) return
    
    setLoading(true)
    setError(null)
    
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const data = await res.json()
      
      if (data.ok) {
        setStats(data.stats)
      } else {
        setError(data.error || 'Failed to load stats')
      }
    } catch (err) {
      console.error('Error loading stats:', err)
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  return {
    stats,
    loading,
    error,
    loadStats,
  }
}
