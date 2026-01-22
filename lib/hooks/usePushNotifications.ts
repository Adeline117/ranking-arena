/**
 * 推送通知 Hook
 * 
 * 用于 Capacitor 应用中管理推送通知权限和订阅
 */

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'

// ============================================
// 类型定义
// ============================================

interface PushNotificationState {
  isSupported: boolean
  isEnabled: boolean
  token: string | null
  permission: 'granted' | 'denied' | 'default' | 'unknown'
  loading: boolean
  error: string | null
}

interface PushNotificationHandlers {
  requestPermission: () => Promise<boolean>
  registerToken: () => Promise<void>
  unregisterToken: () => Promise<void>
}

type UsePushNotificationsReturn = PushNotificationState & PushNotificationHandlers

// ============================================
// 平台检测
// ============================================

function getPlatform(): 'ios' | 'android' | 'web' {
  if (typeof window === 'undefined') return 'web'
  
  const userAgent = window.navigator.userAgent.toLowerCase()
  
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return 'ios'
  }
  if (/android/.test(userAgent)) {
    return 'android'
  }
  
  return 'web'
}

function isCapacitor(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as unknown as { Capacitor?: unknown }).Capacitor
}

// ============================================
// Hook
// ============================================

export function usePushNotifications(): UsePushNotificationsReturn {
  const [state, setState] = useState<PushNotificationState>({
    isSupported: false,
    isEnabled: false,
    token: null,
    permission: 'unknown',
    loading: true,
    error: null,
  })

  // 初始化检查
  useEffect(() => {
    async function init() {
      const platform = getPlatform()
      const capacitor = isCapacitor()

      // 检查是否支持推送
      let isSupported = false
      let permission: PushNotificationState['permission'] = 'unknown'

      if (capacitor) {
        // Capacitor 环境：始终支持（iOS/Android）
        isSupported = platform !== 'web'
        
        try {
          // 动态导入 Capacitor Push Notifications
          const { PushNotifications } = await import('@capacitor/push-notifications')
          const permResult = await PushNotifications.checkPermissions()
          permission = permResult.receive as PushNotificationState['permission']
        } catch {
          // 插件未安装
          isSupported = false
        }
      } else if ('Notification' in window) {
        // Web 环境
        isSupported = true
        permission = Notification.permission as PushNotificationState['permission']
      }

      setState(prev => ({
        ...prev,
        isSupported,
        permission,
        isEnabled: permission === 'granted',
        loading: false,
      }))
    }

    init()
  }, [])

  // 请求权限
  const requestPermission = useCallback(async (): Promise<boolean> => {
    setState(prev => ({ ...prev, loading: true, error: null }))

    try {
      const capacitor = isCapacitor()
      let granted = false

      if (capacitor) {
        const { PushNotifications } = await import('@capacitor/push-notifications')
        const result = await PushNotifications.requestPermissions()
        granted = result.receive === 'granted'
      } else if ('Notification' in window) {
        const result = await Notification.requestPermission()
        granted = result === 'granted'
      }

      setState(prev => ({
        ...prev,
        permission: granted ? 'granted' : 'denied',
        isEnabled: granted,
        loading: false,
      }))

      return granted
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: String(error),
        loading: false,
      }))
      return false
    }
  }, [])

  // 注册推送 token
  const registerToken = useCallback(async (): Promise<void> => {
    setState(prev => ({ ...prev, loading: true, error: null }))

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        throw new Error('用户未登录')
      }

      let token: string | null = null
      let provider: 'fcm' | 'apns' | 'web' = 'fcm'
      const platform = getPlatform()

      if (isCapacitor()) {
        const { PushNotifications } = await import('@capacitor/push-notifications')
        
        // 注册推送并获取 token
        await PushNotifications.register()
        
        // 监听 token
        const tokenResult = await new Promise<string>((resolve, reject) => {
          let registrationHandle: { remove: () => void } | null = null
          let errorHandle: { remove: () => void } | null = null

          const cleanup = () => {
            registrationHandle?.remove()
            errorHandle?.remove()
          }

          const timeout = setTimeout(() => {
            cleanup()
            reject(new Error('获取 token 超时'))
          }, 10000)

          PushNotifications.addListener('registration', (data) => {
            clearTimeout(timeout)
            cleanup()
            resolve(data.value)
          }).then(handle => { registrationHandle = handle })

          PushNotifications.addListener('registrationError', (error) => {
            clearTimeout(timeout)
            cleanup()
            reject(error)
          }).then(handle => { errorHandle = handle })
        })
        
        token = tokenResult
        provider = platform === 'ios' ? 'apns' : 'fcm'
      }

      if (!token) {
        throw new Error('无法获取推送 token')
      }

      // 发送到服务器
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          token,
          provider,
          platform,
          deviceName: navigator.userAgent.slice(0, 100),
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || '注册失败')
      }

      setState(prev => ({
        ...prev,
        token,
        isEnabled: true,
        loading: false,
      }))
    } catch (error) {
      console.error('[usePushNotifications] 注册失败:', error)
      setState(prev => ({
        ...prev,
        error: String(error),
        loading: false,
      }))
    }
  }, [])

  // 取消注册
  const unregisterToken = useCallback(async (): Promise<void> => {
    setState(prev => ({ ...prev, loading: true, error: null }))

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token || !state.token) {
        throw new Error('未登录或无 token')
      }

      const response = await fetch(`/api/push/subscribe?token=${encodeURIComponent(state.token)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || '取消注册失败')
      }

      setState(prev => ({
        ...prev,
        token: null,
        isEnabled: false,
        loading: false,
      }))
    } catch (error) {
      console.error('[usePushNotifications] 取消注册失败:', error)
      setState(prev => ({
        ...prev,
        error: String(error),
        loading: false,
      }))
    }
  }, [state.token])

  return {
    ...state,
    requestPermission,
    registerToken,
    unregisterToken,
  }
}

export default usePushNotifications
