'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'

export interface AlertConfigItem {
  value: string | null
  enabled: boolean
}

export interface AlertConfig {
  slack_webhook_url?: AlertConfigItem
  feishu_webhook_url?: AlertConfigItem
  alert_email?: AlertConfigItem
}

export function useAlertConfig(accessToken: string | null) {
  const [config, setConfig] = useState<AlertConfig>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadConfig = useCallback(async () => {
    if (!accessToken) return
    
    setLoading(true)
    
    try {
      const res = await fetch('/api/admin/alert-config', {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      const data = await res.json()
      
      if (data.ok) {
        setConfig(data.config)
      }
    } catch (err) {
      console.error('Error loading alert config:', err)
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  const updateConfig = useCallback(async (
    key: string,
    value: string | null,
    enabled: boolean
  ) => {
    if (!accessToken) return false
    
    setSaving(true)
    
    try {
      const res = await fetch('/api/admin/alert-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ key, value, enabled }),
      })
      const data = await res.json()
      
      if (data.ok) {
        setConfig(prev => ({
          ...prev,
          [key]: { value, enabled },
        }))
        return true
      } else {
        alert(data.error || '保存失败')
        return false
      }
    } catch (err) {
      alert('网络错误')
      return false
    } finally {
      setSaving(false)
    }
  }, [accessToken])

  return {
    config,
    loading,
    saving,
    loadConfig,
    updateConfig,
  }
}
