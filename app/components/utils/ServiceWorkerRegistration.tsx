'use client'

/**
 * Service Worker 注册组件
 * 在客户端注册 Service Worker 以启用 PWA 功能
 */

import { useEffect } from 'react'

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      process.env.NODE_ENV === 'production'
    ) {
      // 页面加载完成后注册 Service Worker
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/sw.js')
          .then((registration) => {
            console.log('[SW] 注册成功:', registration.scope)

            // 检查更新
            registration.addEventListener('updatefound', () => {
              const newWorker = registration.installing
              if (newWorker) {
                newWorker.addEventListener('statechange', () => {
                  if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    // 新版本可用，提示用户刷新
                    console.log('[SW] 新版本可用')
                    // 可以在这里显示更新提示
                  }
                })
              }
            })
          })
          .catch((error) => {
            console.error('[SW] 注册失败:', error)
          })
      })

      // 监听控制器变化（当新 SW 激活时）
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        console.log('[SW] 控制器已更新')
      })
    }
  }, [])

  return null
}

/**
 * 检查是否可以安装 PWA
 */
export function useInstallPrompt() {
  useEffect(() => {
    let deferredPrompt: BeforeInstallPromptEvent | null = null

    const handleBeforeInstallPrompt = (e: Event) => {
      // 阻止默认的安装提示
      e.preventDefault()
      deferredPrompt = e as BeforeInstallPromptEvent
      console.log('[PWA] 可以安装')
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    }
  }, [])
}

// BeforeInstallPromptEvent 类型定义
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed'
    platform: string
  }>
  prompt(): Promise<void>
}
