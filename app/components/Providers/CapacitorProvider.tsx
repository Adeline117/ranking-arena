'use client'

/**
 * CapacitorProvider
 *
 * Initializes native app features on mount:
 * - Hides splash screen after first meaningful render
 * - Sets up push notification listeners
 * - Handles deep link navigation
 * - Manages keyboard scroll behavior
 * - Configures status bar
 */

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  isNativeApp,
  getNativePlatform,
  useCapacitorSplash,
  useCapacitorKeyboard,
  useCapacitorAppLifecycle,
} from '@/lib/hooks/useCapacitor'

export default function CapacitorProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { hideSplash } = useCapacitorSplash()
  const { isVisible: keyboardVisible, height: keyboardHeight } = useCapacitorKeyboard()
  const initialized = useRef(false)

  // Hide splash after first render
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    // Give the UI a moment to render, then hide splash
    const timer = setTimeout(() => {
      hideSplash()
    }, 500)

    return () => clearTimeout(timer)
  }, [hideSplash])

  // Handle deep link navigation
  useCapacitorAppLifecycle({
    onUrlOpen: (url) => {
      try {
        const parsed = new URL(url)
        // Only handle our own domain or custom scheme
        if (
          parsed.hostname === 'www.arenafi.org' ||
          parsed.hostname === 'arenafi.org' ||
          parsed.protocol === 'arena:'
        ) {
          const path = parsed.pathname + parsed.search
          router.push(path)
        }
      } catch {
        // Invalid URL, ignore
      }
    },
    onForeground: () => {
      // Could trigger data refresh here
    },
  })

  // Set up push notification click handling
  useEffect(() => {
    if (!isNativeApp()) return

    let clickListener: { remove: () => void } | null = null

    async function setupPushListeners() {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications')

        // Handle notification click (app was in background or closed)
        const listener = await PushNotifications.addListener(
          'pushNotificationActionPerformed',
          (raw) => {
            const action = raw as { notification?: { data?: Record<string, string> } }
            const data = action.notification?.data
            if (data?.url) {
              router.push(data.url)
            } else if (data?.traderId) {
              router.push(`/trader/${data.traderId}`)
            } else if (data?.postId) {
              router.push(`/post/${data.postId}`)
            } else if (data?.groupId) {
              router.push(`/groups/${data.groupId}`)
            }
          }
        )
        clickListener = listener
      } catch {
        // Plugin not available
      }
    }

    setupPushListeners()

    return () => {
      clickListener?.remove()
    }
  }, [router])

  // Keyboard scroll adjustment
  useEffect(() => {
    if (!keyboardVisible || !isNativeApp()) return

    // Find the focused input and ensure it's visible
    const focused = document.activeElement as HTMLElement
    if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
      const rect = focused.getBoundingClientRect()
      const visibleBottom = window.innerHeight - keyboardHeight

      if (rect.bottom > visibleBottom) {
        focused.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [keyboardVisible, keyboardHeight])

  // Configure status bar on mount
  useEffect(() => {
    if (!isNativeApp()) return

    async function configureStatusBar() {
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar')
        await StatusBar.setStyle({ style: Style.Light })

        if (getNativePlatform() === 'android') {
          const theme = document.documentElement.getAttribute('data-theme')
          await StatusBar.setBackgroundColor({ color: theme === 'light' ? '#FFFFFF' : '#0B0A10' })
        }
      } catch {
        // Plugin not available
      }
    }

    configureStatusBar()
  }, [])

  return <>{children}</>
}
