'use client'

import { useState, useEffect, useCallback } from 'react'

export interface TraderAlert {
  id: string
  traderId: string
  platform: string
  traderName: string
  alertType: 'roi_change' | 'rank_change' | 'drawdown'
  threshold: number
  enabled: boolean
  createdAt: string
  lastTriggered?: string
}

const LS_KEY = 'trader-alerts'

function getStoredAlerts(): TraderAlert[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(LS_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

function saveAlerts(alerts: TraderAlert[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(alerts))
  } catch {
    // ignore
  }
}

export function useTraderAlerts() {
  const [alerts, setAlerts] = useState<TraderAlert[]>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setAlerts(getStoredAlerts())
    setMounted(true)
  }, [])

  const addAlert = useCallback((alert: Omit<TraderAlert, 'id' | 'createdAt'>) => {
    const newAlert: TraderAlert = {
      ...alert,
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    }
    setAlerts(prev => {
      const updated = [...prev, newAlert]
      saveAlerts(updated)
      return updated
    })
    return newAlert
  }, [])

  const removeAlert = useCallback((alertId: string) => {
    setAlerts(prev => {
      const updated = prev.filter(a => a.id !== alertId)
      saveAlerts(updated)
      return updated
    })
  }, [])

  const toggleAlert = useCallback((alertId: string) => {
    setAlerts(prev => {
      const updated = prev.map(a => 
        a.id === alertId ? { ...a, enabled: !a.enabled } : a
      )
      saveAlerts(updated)
      return updated
    })
  }, [])

  const updateAlert = useCallback((alertId: string, updates: Partial<TraderAlert>) => {
    setAlerts(prev => {
      const updated = prev.map(a => 
        a.id === alertId ? { ...a, ...updates } : a
      )
      saveAlerts(updated)
      return updated
    })
  }, [])

  const getAlertsForTrader = useCallback((traderId: string, platform: string) => {
    return alerts.filter(a => a.traderId === traderId && a.platform === platform)
  }, [alerts])

  const hasAlert = useCallback((traderId: string, platform: string) => {
    return alerts.some(a => a.traderId === traderId && a.platform === platform)
  }, [alerts])

  return {
    alerts,
    mounted,
    addAlert,
    removeAlert,
    toggleAlert,
    updateAlert,
    getAlertsForTrader,
    hasAlert,
  }
}
