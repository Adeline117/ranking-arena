'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

export interface AlertConfigItem {
  value: string | null
  enabled: boolean
}

export interface AlertConfig {
  slack_webhook_url?: AlertConfigItem
  feishu_webhook_url?: AlertConfigItem
  alert_email?: AlertConfigItem
}

export function useAlertConfig(accessToken: string | null, showToast?: ToastFn) {
  const { t } = useLanguage()
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
    } catch (_err) {
      logger.error('Error loading alert config:', _err)
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
        showToast?.(data.error || t('adminSaveFailed'), 'error')
        return false
      }
    } catch (_err) {
      showToast?.(t('adminNetworkError'), 'error')
      return false
    } finally {
      setSaving(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref; setSaving/setConfig use updater form
  }, [accessToken, showToast])

  return {
    config,
    loading,
    saving,
    loadConfig,
    updateConfig,
  }
}
