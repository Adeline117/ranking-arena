/**
 * 用户设置 Hook
 * 
 * 功能:
 * - 主题设置 (深色/浅色/系统)
 * - 语言设置 (中文/英文)
 * - 通知偏好
 * - 隐私设置
 * - 持久化到 localStorage 和数据库
 */

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import { setLanguage } from '@/lib/i18n'

// ============================================
// 类型定义
// ============================================

export type ThemeMode = 'dark' | 'light' | 'system'
export type Language = 'zh' | 'en'

export interface AppSettings {
  // 外观
  theme: ThemeMode
  language: Language
  
  // 显示
  compactMode: boolean
  showAvatars: boolean
  showPreviews: boolean
  
  // 数据
  defaultTimeRange: '7d' | '30d' | '90d'
  defaultSortBy: 'arena_score' | 'roi' | 'pnl' | 'copiers'
  
  // 其他
  soundEnabled: boolean
  autoPlayVideos: boolean
}

export interface NotificationSettings {
  follow: boolean
  like: boolean
  comment: boolean
  mention: boolean
  message: boolean
  traderAlert: boolean
  priceAlert: boolean
  systemAlert: boolean
  emailDigest: 'none' | 'daily' | 'weekly'
}

export interface PrivacySettings {
  showFollowers: boolean
  showFollowing: boolean
  showActivity: boolean
  dmPermission: 'all' | 'mutual' | 'none'
  showProBadge: boolean
  showOnlineStatus: boolean
}

// ============================================
// 默认设置
// ============================================

const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'zh',
  compactMode: false,
  showAvatars: true,
  showPreviews: true,
  defaultTimeRange: '30d',
  defaultSortBy: 'arena_score',
  soundEnabled: true,
  autoPlayVideos: true,
}

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  follow: true,
  like: true,
  comment: true,
  mention: true,
  message: true,
  traderAlert: true,
  priceAlert: true,
  systemAlert: true,
  emailDigest: 'none',
}

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  showFollowers: true,
  showFollowing: true,
  showActivity: true,
  dmPermission: 'all',
  showProBadge: true,
  showOnlineStatus: true,
}

// ============================================
// 存储 Key
// ============================================

const STORAGE_KEYS = {
  APP_SETTINGS: 'arena-app-settings',
  NOTIFICATION_SETTINGS: 'arena-notification-settings',
  PRIVACY_SETTINGS: 'arena-privacy-settings',
}

// ============================================
// 工具函数
// ============================================

function loadFromStorage<T>(key: string, defaults: T): T {
  if (typeof window === 'undefined') return defaults
  
  try {
    const stored = localStorage.getItem(key)
    if (!stored) return defaults
    return { ...defaults, ...JSON.parse(stored) }
  } catch {
    return defaults
  }
}

function saveToStorage<T>(key: string, data: T): void {
  if (typeof window === 'undefined') return
  
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // 存储满了，忽略
  }
}

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// ============================================
// useAppSettings - 应用设置
// ============================================

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => 
    loadFromStorage(STORAGE_KEYS.APP_SETTINGS, DEFAULT_APP_SETTINGS)
  )
  const [mounted, setMounted] = useState(false)

  // 初始化
  useEffect(() => {
    setMounted(true)
    const loaded = loadFromStorage(STORAGE_KEYS.APP_SETTINGS, DEFAULT_APP_SETTINGS)
    setSettings(loaded)
    
    // 应用主题
    applyTheme(loaded.theme)
    
    // 应用语言
    setLanguage(loaded.language)
  }, [])

  // 应用主题
  const applyTheme = useCallback((theme: ThemeMode) => {
    if (typeof window === 'undefined') return
    
    const actualTheme = theme === 'system' ? getSystemTheme() : theme
    document.documentElement.setAttribute('data-theme', actualTheme)
  }, [])

  // 监听系统主题变化
  useEffect(() => {
    if (settings.theme !== 'system') return
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [settings.theme, applyTheme])

  // 更新设置
  const updateSettings = useCallback((updates: Partial<AppSettings>) => {
    setSettings(prev => {
      const newSettings = { ...prev, ...updates }
      saveToStorage(STORAGE_KEYS.APP_SETTINGS, newSettings)
      
      // 应用特殊设置
      if (updates.theme !== undefined) {
        applyTheme(updates.theme)
      }
      if (updates.language !== undefined) {
        setLanguage(updates.language)
      }
      
      return newSettings
    })
  }, [applyTheme])

  // 重置设置
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_APP_SETTINGS)
    saveToStorage(STORAGE_KEYS.APP_SETTINGS, DEFAULT_APP_SETTINGS)
    applyTheme(DEFAULT_APP_SETTINGS.theme)
    setLanguage(DEFAULT_APP_SETTINGS.language)
  }, [applyTheme])

  // 计算实际主题
  const actualTheme = useMemo(() => {
    return settings.theme === 'system' ? getSystemTheme() : settings.theme
  }, [settings.theme])

  return {
    settings,
    updateSettings,
    resetSettings,
    actualTheme,
    isDark: actualTheme === 'dark',
    mounted,
  }
}

// ============================================
// useNotificationSettings - 通知设置
// ============================================

export function useNotificationSettings(userId?: string | null) {
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 从数据库加载
  useEffect(() => {
    const load = async () => {
      // 先从 localStorage 加载
      const local = loadFromStorage(STORAGE_KEYS.NOTIFICATION_SETTINGS, DEFAULT_NOTIFICATION_SETTINGS)
      setSettings(local)
      
      // 如果有用户 ID，从数据库加载
      if (userId) {
        try {
          const { data } = await supabase
            .from('user_profiles')
            .select('notify_follow, notify_like, notify_comment, notify_mention, notify_message')
            .eq('id', userId)
            .single()
          
          if (data) {
            const dbSettings: Partial<NotificationSettings> = {
              follow: data.notify_follow !== false,
              like: data.notify_like !== false,
              comment: data.notify_comment !== false,
              mention: data.notify_mention !== false,
              message: data.notify_message !== false,
            }
            setSettings(prev => ({ ...prev, ...dbSettings }))
          }
        } catch {
          // 忽略错误
        }
      }
      
      setLoading(false)
    }
    
    load()
  }, [userId])

  // 更新设置
  const updateSettings = useCallback(async (updates: Partial<NotificationSettings>) => {
    setSaving(true)

    // 乐观更新本地
    const previousSettings = { ...settings }
    setSettings(prev => {
      const newSettings = { ...prev, ...updates }
      saveToStorage(STORAGE_KEYS.NOTIFICATION_SETTINGS, newSettings)
      return newSettings
    })

    // 同步到数据库，完成后再关闭 saving 状态
    try {
      if (userId) {
        const { error } = await supabase
          .from('user_profiles')
          .update({
            notify_follow: updates.follow,
            notify_like: updates.like,
            notify_comment: updates.comment,
            notify_mention: updates.mention,
            notify_message: updates.message,
          })
          .eq('id', userId)
        if (error) throw error
      }
    } catch {
      // 回滚
      setSettings(previousSettings)
      saveToStorage(STORAGE_KEYS.NOTIFICATION_SETTINGS, previousSettings)
    } finally {
      setSaving(false)
    }
  }, [userId, settings])

  return {
    settings,
    updateSettings,
    loading,
    saving,
  }
}

// ============================================
// usePrivacySettings - 隐私设置
// ============================================

export function usePrivacySettings(userId?: string | null) {
  const [settings, setSettings] = useState<PrivacySettings>(DEFAULT_PRIVACY_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 从数据库加载
  useEffect(() => {
    const load = async () => {
      const local = loadFromStorage(STORAGE_KEYS.PRIVACY_SETTINGS, DEFAULT_PRIVACY_SETTINGS)
      setSettings(local)
      
      if (userId) {
        try {
          const { data } = await supabase
            .from('user_profiles')
            .select('show_followers, show_following, dm_permission, show_pro_badge')
            .eq('id', userId)
            .single()
          
          if (data) {
            const dbSettings: Partial<PrivacySettings> = {
              showFollowers: data.show_followers !== false,
              showFollowing: data.show_following !== false,
              dmPermission: data.dm_permission || 'all',
              showProBadge: data.show_pro_badge !== false,
            }
            setSettings(prev => ({ ...prev, ...dbSettings }))
          }
        } catch {
          // 忽略错误
        }
      }
      
      setLoading(false)
    }
    
    load()
  }, [userId])

  // 更新设置
  const updateSettings = useCallback(async (updates: Partial<PrivacySettings>) => {
    setSaving(true)

    // 乐观更新本地
    const previousSettings = { ...settings }
    setSettings(prev => {
      const newSettings = { ...prev, ...updates }
      saveToStorage(STORAGE_KEYS.PRIVACY_SETTINGS, newSettings)
      return newSettings
    })

    try {
      if (userId) {
        const { error } = await supabase
          .from('user_profiles')
          .update({
            show_followers: updates.showFollowers,
            show_following: updates.showFollowing,
            dm_permission: updates.dmPermission,
            show_pro_badge: updates.showProBadge,
          })
          .eq('id', userId)
        if (error) throw error
      }
    } catch {
      // 回滚
      setSettings(previousSettings)
      saveToStorage(STORAGE_KEYS.PRIVACY_SETTINGS, previousSettings)
    } finally {
      setSaving(false)
    }
  }, [userId, settings])

  return {
    settings,
    updateSettings,
    loading,
    saving,
  }
}

// ============================================
// 设置面板组件 Props
// ============================================

export interface SettingItemProps {
  label: string
  description?: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}

export interface SettingSelectProps<T extends string> {
  label: string
  description?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
}

export default {
  useAppSettings,
  useNotificationSettings,
  usePrivacySettings,
}
