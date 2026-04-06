'use client'

/**
 * Capacitor Native Integration Hook
 *
 * Provides access to native APIs when running in a Capacitor app:
 * - Splash Screen: manual hide after data loads
 * - Keyboard: event listeners for show/hide
 * - Status Bar: dynamic style changes
 * - Share: native share sheet
 * - Browser: in-app browser for external links
 * - App: lifecycle events (foreground/background)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PushNotificationsPlugin } from '@capacitor/push-notifications/dist/esm/definitions'

// ============================================
// Platform Detection
// ============================================

export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor?.isNativePlatform?.()
}

export function getNativePlatform(): 'ios' | 'android' | 'web' {
  if (typeof window === 'undefined') return 'web'
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  const platform = cap?.getPlatform?.()
  if (platform === 'ios') return 'ios'
  if (platform === 'android') return 'android'
  return 'web'
}

// ============================================
// Splash Screen
// ============================================

export function useCapacitorSplash() {
  const hidden = useRef(false)

  const hideSplash = useCallback(async () => {
    if (hidden.current || !isNativeApp()) return
    hidden.current = true
    try {
      const { SplashScreen } = await import('@capacitor/splash-screen')
      await SplashScreen.hide({ fadeOutDuration: 300 })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  return { hideSplash }
}

// ============================================
// Keyboard
// ============================================

export interface KeyboardState {
  isVisible: boolean
  height: number
}

export function useCapacitorKeyboard() {
  const [keyboardState, setKeyboardState] = useState<KeyboardState>({
    isVisible: false,
    height: 0,
  })

  useEffect(() => {
    if (!isNativeApp()) return

    let showListener: { remove: () => void } | null = null
    let hideListener: { remove: () => void } | null = null

    async function init() {
      try {
        const { Keyboard } = await import('@capacitor/keyboard')

        const show = await Keyboard.addListener('keyboardWillShow', (info) => {
          setKeyboardState({ isVisible: true, height: info.keyboardHeight })
        })
        showListener = show

        const hide = await Keyboard.addListener('keyboardWillHide', () => {
          setKeyboardState({ isVisible: false, height: 0 })
        })
        hideListener = hide
      } catch (_err) {
        // Intentionally swallowed: Capacitor plugin not available on this platform
      }
    }

    init()

    return () => {
      showListener?.remove()
      hideListener?.remove()
    }
  }, [])

  const hideKeyboard = useCallback(async () => {
    if (!isNativeApp()) return
    try {
      const { Keyboard } = await import('@capacitor/keyboard')
      await Keyboard.hide()
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin unavailable in web browser context
    }
  }, [])

  return { ...keyboardState, hideKeyboard }
}

// ============================================
// Status Bar
// ============================================

export type StatusBarStyle = 'Dark' | 'Light' | 'Default'

export function useCapacitorStatusBar() {
  const setStyle = useCallback(async (style: StatusBarStyle) => {
    if (!isNativeApp()) return
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar')
      const styleMap = {
        Dark: Style.Dark,
        Light: Style.Light,
        Default: Style.Default,
      }
      await StatusBar.setStyle({ style: styleMap[style] })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  const setBackgroundColor = useCallback(async (color: string) => {
    if (!isNativeApp() || getNativePlatform() !== 'android') return
    try {
      const { StatusBar } = await import('@capacitor/status-bar')
      await StatusBar.setBackgroundColor({ color })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  return { setStyle, setBackgroundColor }
}

// ============================================
// Native Share
// ============================================

export function useCapacitorShare() {
  const share = useCallback(async (options: {
    title?: string
    text?: string
    url?: string
    dialogTitle?: string
  }): Promise<boolean> => {
    if (!isNativeApp()) {
      // Fallback to web share API
      if (navigator.share) {
        try {
          await navigator.share(options)
          return true
        } catch (_err) {
          /* non-critical: share cancelled or unsupported */
          return false
        }
      }
      return false
    }

    try {
      const { Share } = await import('@capacitor/share')
      await Share.share(options)
      return true
    } catch (_err) {
      /* non-critical: share cancelled or plugin unavailable */
      return false
    }
  }, [])

  return { share }
}

// ============================================
// In-App Browser
// ============================================

export function useCapacitorBrowser() {
  const open = useCallback(async (url: string) => {
    if (!isNativeApp()) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }

    try {
      const { Browser } = await import('@capacitor/browser')
      await Browser.open({
        url,
        presentationStyle: 'popover',
        toolbarColor: document.documentElement.getAttribute('data-theme') === 'light' ? 'var(--color-on-accent)' : 'var(--color-bg-primary)',
      })
    } catch (_err) {
      /* fallback: open in regular browser tab */
      window.open(url, '_blank')
    }
  }, [])

  return { open }
}

// ============================================
// App Lifecycle
// ============================================

export function useCapacitorAppLifecycle(options?: {
  onForeground?: () => void
  onBackground?: () => void
  onUrlOpen?: (url: string) => void
}) {
  useEffect(() => {
    if (!isNativeApp()) return

    let stateListener: { remove: () => void } | null = null
    let urlListener: { remove: () => void } | null = null

    async function init() {
      try {
        const { App } = await import('@capacitor/app')

        if (options?.onForeground || options?.onBackground) {
          const listener = await App.addListener('appStateChange', ({ isActive }) => {
            if (isActive) {
              options?.onForeground?.()
            } else {
              options?.onBackground?.()
            }
          })
          stateListener = listener
        }

        if (options?.onUrlOpen) {
          const listener = await App.addListener('appUrlOpen', ({ url }) => {
            options?.onUrlOpen?.(url)
          })
          urlListener = listener
        }
      } catch (_err) {
        // Intentionally swallowed: Capacitor plugin not available on this platform
      }
    }

    init()

    return () => {
      stateListener?.remove()
      urlListener?.remove()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- options object identity changes each render; destructured callbacks are the real deps
  }, [options?.onForeground, options?.onBackground, options?.onUrlOpen])
}

// ============================================
// Haptic Feedback
// ============================================

export type HapticImpactStyle = 'light' | 'medium' | 'heavy'
export type HapticNotificationType = 'success' | 'warning' | 'error'

export function useCapacitorHaptics() {
  const impact = useCallback(async (style: HapticImpactStyle = 'medium') => {
    if (!isNativeApp()) return

    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
      const styleMap = {
        light: ImpactStyle.Light,
        medium: ImpactStyle.Medium,
        heavy: ImpactStyle.Heavy,
      }
      await Haptics.impact({ style: styleMap[style] })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  const notification = useCallback(async (type: HapticNotificationType = 'success') => {
    if (!isNativeApp()) return

    try {
      const { Haptics, NotificationType } = await import('@capacitor/haptics')
      const typeMap = {
        success: NotificationType.Success,
        warning: NotificationType.Warning,
        error: NotificationType.Error,
      }
      await Haptics.notification({ type: typeMap[type] })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  const selectionChanged = useCallback(async () => {
    if (!isNativeApp()) return

    try {
      const { Haptics } = await import('@capacitor/haptics')
      await Haptics.selectionChanged()
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  const vibrate = useCallback(async (duration: number = 300) => {
    if (!isNativeApp()) return

    try {
      const { Haptics } = await import('@capacitor/haptics')
      await Haptics.vibrate({ duration })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  return { impact, notification, selectionChanged, vibrate }
}

// ============================================
// Local Notifications
// ============================================

export interface LocalNotificationOptions {
  id?: number
  title: string
  body: string
  schedule?: { at: Date }
  extra?: Record<string, string>
}

export function useCapacitorLocalNotifications() {
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!isNativeApp()) return false

    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      const result = await LocalNotifications.requestPermissions()
      return result.display === 'granted'
    } catch (_err) {
      /* non-critical: plugin unavailable */
      return false
    }
  }, [])

  const schedule = useCallback(async (options: LocalNotificationOptions) => {
    if (!isNativeApp()) return

    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      await LocalNotifications.schedule({
        notifications: [{
          id: options.id ?? Date.now(),
          title: options.title,
          body: options.body,
          schedule: options.schedule,
          extra: options.extra,
        }],
      })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  const cancel = useCallback(async (ids: number[]) => {
    if (!isNativeApp()) return

    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      await LocalNotifications.cancel({ notifications: ids.map(id => ({ id })) })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin not available on this platform
    }
  }, [])

  return { requestPermission, schedule, cancel }
}

// ============================================
// Camera
// ============================================

export interface CameraOptions {
  quality?: number
  allowEditing?: boolean
  resultType?: 'base64' | 'uri' | 'dataUrl'
  source?: 'camera' | 'photos' | 'prompt'
}

export function useCapacitorCamera() {
  const takePicture = useCallback(async (options: CameraOptions = {}): Promise<string | null> => {
    if (!isNativeApp()) {
      // Web fallback - use file input
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (file) {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => resolve(null)
            reader.readAsDataURL(file)
          } else {
            resolve(null)
          }
        }
        input.click()
      })
    }

    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
      const resultTypeMap = {
        base64: CameraResultType.Base64,
        uri: CameraResultType.Uri,
        dataUrl: CameraResultType.DataUrl,
      }
      const sourceMap = {
        camera: CameraSource.Camera,
        photos: CameraSource.Photos,
        prompt: CameraSource.Prompt,
      }
      const image = await Camera.getPhoto({
        quality: options.quality ?? 90,
        allowEditing: options.allowEditing ?? true,
        resultType: resultTypeMap[options.resultType ?? 'dataUrl'],
        source: sourceMap[options.source ?? 'prompt'],
      })
      return image.dataUrl || image.base64String || image.webPath || null
    } catch (_err) {
      /* non-critical: camera cancelled or plugin unavailable */
      return null
    }
  }, [])

  return { takePicture }
}

// ============================================
// Biometric Authentication
// ============================================

export interface BiometricAuthResult {
  success: boolean
  error?: string
}

export function useCapacitorBiometric() {
  const [isAvailable, setIsAvailable] = useState(false)
  const [biometryType, setBiometryType] = useState<'face' | 'fingerprint' | 'iris' | 'none'>('none')

  useEffect(() => {
    if (!isNativeApp()) return

    async function checkAvailability() {
      try {
        // Use NativeBiometric plugin
        const { NativeBiometric } = await import('capacitor-native-biometric')
        const result = await NativeBiometric.isAvailable()

        if (result.isAvailable) {
          setIsAvailable(true)
          // Map biometry type
          const typeMap: Record<string, 'face' | 'fingerprint' | 'iris'> = {
            'faceId': 'face',
            'touchId': 'fingerprint',
            'face': 'face',
            'fingerprint': 'fingerprint',
            'iris': 'iris',
          }
          setBiometryType(typeMap[result.biometryType] || 'fingerprint')
        }
      } catch (_err) {
        // Intentionally swallowed: Capacitor plugin not available on this platform
      }
    }

    checkAvailability()
  }, [])

  const authenticate = useCallback(async (reason?: string): Promise<BiometricAuthResult> => {
    if (!isNativeApp() || !isAvailable) {
      return { success: false, error: 'Biometric not available' }
    }

    try {
      const { NativeBiometric } = await import('capacitor-native-biometric')
      await NativeBiometric.verifyIdentity({
        reason: reason || 'Please authenticate',
        title: 'Authentication Required',
        subtitle: '',
        description: '',
        useFallback: true, // Allow PIN/password fallback
        maxAttempts: 3,
      })
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      }
    }
  }, [isAvailable])

  // Store and retrieve credentials securely
  const setCredentials = useCallback(async (server: string, username: string, password: string) => {
    if (!isNativeApp()) return false

    try {
      const { NativeBiometric } = await import('capacitor-native-biometric')
      await NativeBiometric.setCredentials({
        server,
        username,
        password,
      })
      return true
    } catch (_err) {
      /* non-critical: biometric store unavailable */
      return false
    }
  }, [])

  const getCredentials = useCallback(async (server: string): Promise<{ username: string; password: string } | null> => {
    if (!isNativeApp()) return null

    try {
      const { NativeBiometric } = await import('capacitor-native-biometric')
      const credentials = await NativeBiometric.getCredentials({ server })
      return credentials
    } catch (_err) {
      /* non-critical: credentials not found or plugin unavailable */
      return null
    }
  }, [])

  const deleteCredentials = useCallback(async (server: string) => {
    if (!isNativeApp()) return

    try {
      const { NativeBiometric } = await import('capacitor-native-biometric')
      await NativeBiometric.deleteCredentials({ server })
    } catch (_err) {
      // Intentionally swallowed: Capacitor plugin unavailable in web browser context
    }
  }, [])

  return {
    isAvailable,
    biometryType,
    authenticate,
    setCredentials,
    getCredentials,
    deleteCredentials,
  }
}

// ============================================
// Push Notifications
// ============================================

export interface PushNotificationToken {
  value: string
}

export interface PushNotificationData {
  id?: string
  title?: string
  body?: string
  data?: Record<string, unknown>
}

export function useCapacitorPushNotifications(options?: {
  onRegistration?: (token: PushNotificationToken) => void
  onRegistrationError?: (error: string) => void
  onNotificationReceived?: (notification: PushNotificationData) => void
  onNotificationActionPerformed?: (notification: PushNotificationData, actionId: string) => void
}) {
  const [token, setToken] = useState<string | null>(null)
  const [permissionGranted, setPermissionGranted] = useState(false)

  const register = useCallback(async (): Promise<boolean> => {
    if (!isNativeApp()) return false

    try {
      const mod = await import('@capacitor/push-notifications')
      const PN = mod.PushNotifications as PushNotificationsPlugin
      const permResult = await PN.requestPermissions()
      if (permResult.receive !== 'granted') {
        setPermissionGranted(false)
        return false
      }
      setPermissionGranted(true)
      await PN.register()
      return true
    } catch (_err) {
      /* non-critical: push notification registration failed */
      return false
    }
  }, [])

  useEffect(() => {
    if (!isNativeApp()) return

    const listeners: Array<{ remove: () => void }> = []

    async function init() {
      try {
        const mod = await import('@capacitor/push-notifications')
        const PN = mod.PushNotifications as PushNotificationsPlugin

        const regListener = await PN.addListener('registration', (tok) => {
          setToken(tok.value)
          options?.onRegistration?.(tok)
        })
        listeners.push(regListener)

        const errListener = await PN.addListener('registrationError', (err) => {
          options?.onRegistrationError?.(err.error)
        })
        listeners.push(errListener)

        const recvListener = await PN.addListener('pushNotificationReceived', (notification) => {
          options?.onNotificationReceived?.({
            id: notification.id,
            title: notification.title,
            body: notification.body,
            data: notification.data,
          })
        })
        listeners.push(recvListener)

        const actionListener = await PN.addListener('pushNotificationActionPerformed', (action) => {
          options?.onNotificationActionPerformed?.(
            {
              id: action.notification.id,
              title: action.notification.title,
              body: action.notification.body,
              data: action.notification.data,
            },
            action.actionId,
          )
        })
        listeners.push(actionListener)
      } catch (_err) {
        // Intentionally swallowed: Capacitor plugin not available on this platform
      }
    }

    init()

    return () => {
      for (const l of listeners) l.remove()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.onRegistration, options?.onRegistrationError, options?.onNotificationReceived, options?.onNotificationActionPerformed])

  return {
    token,
    permissionGranted,
    register,
  }
}

// ============================================
// Combined Hook
// ============================================

export function useCapacitor() {
  return {
    isNative: isNativeApp(),
    platform: getNativePlatform(),
  }
}
