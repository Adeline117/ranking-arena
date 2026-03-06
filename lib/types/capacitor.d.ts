/**
 * Capacitor type declarations
 * For packages that may not be installed but are dynamically imported
 */

declare module '@capacitor/push-notifications' {
  export interface PushNotificationToken {
    value: string
  }

  export interface PermissionStatus {
    receive: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
  }

  export interface RegistrationError {
    error: string
  }

  export const PushNotifications: {
    checkPermissions(): Promise<PermissionStatus>
    requestPermissions(): Promise<PermissionStatus>
    register(): Promise<void>
    addListener(
      event: 'registration',
      callback: (data: PushNotificationToken) => void
    ): Promise<{ remove: () => void }>
    addListener(
      event: 'registrationError',
      callback: (data: RegistrationError) => void
    ): Promise<{ remove: () => void }>
    addListener(
      event: 'pushNotificationReceived' | 'pushNotificationActionPerformed',
      callback: (data: unknown) => void
    ): Promise<{ remove: () => void }>
    removeAllListeners(): Promise<void>
  }
}

declare module '@capacitor/splash-screen' {
  export const SplashScreen: {
    hide(options?: { fadeOutDuration?: number }): Promise<void>
    show(options?: { fadeInDuration?: number; autoHide?: boolean }): Promise<void>
  }
}

declare module '@capacitor/keyboard' {
  export const Keyboard: {
    hide(): Promise<void>
    show(): Promise<void>
    addListener(
      event: 'keyboardWillShow',
      callback: (info: { keyboardHeight: number }) => void
    ): Promise<{ remove: () => void }>
    addListener(
      event: 'keyboardWillHide',
      callback: () => void
    ): Promise<{ remove: () => void }>
  }
}

declare module '@capacitor/status-bar' {
  export enum Style {
    Dark = 'DARK',
    Light = 'LIGHT',
    Default = 'DEFAULT',
  }
  export const StatusBar: {
    setStyle(options: { style: Style }): Promise<void>
    setBackgroundColor(options: { color: string }): Promise<void>
    show(): Promise<void>
    hide(): Promise<void>
  }
}

declare module '@capacitor/share' {
  export const Share: {
    share(options: {
      title?: string
      text?: string
      url?: string
      dialogTitle?: string
    }): Promise<{ activityType?: string }>
  }
}

declare module '@capacitor/browser' {
  export const Browser: {
    open(options: {
      url: string
      presentationStyle?: string
      toolbarColor?: string
    }): Promise<void>
    close(): Promise<void>
  }
}

declare module '@capacitor/app' {
  export const App: {
    addListener(
      event: 'appStateChange',
      callback: (state: { isActive: boolean }) => void
    ): Promise<{ remove: () => void }>
    addListener(
      event: 'appUrlOpen',
      callback: (data: { url: string }) => void
    ): Promise<{ remove: () => void }>
    addListener(
      event: 'backButton',
      callback: () => void
    ): Promise<{ remove: () => void }>
    exitApp(): Promise<void>
  }
}

declare module '@capacitor/haptics' {
  export enum ImpactStyle {
    Heavy = 'HEAVY',
    Medium = 'MEDIUM',
    Light = 'LIGHT',
  }
  export enum NotificationType {
    Success = 'SUCCESS',
    Warning = 'WARNING',
    Error = 'ERROR',
  }
  export const Haptics: {
    impact(options?: { style?: ImpactStyle }): Promise<void>
    notification(options?: { type?: NotificationType }): Promise<void>
    selectionChanged(): Promise<void>
    vibrate(options?: { duration?: number }): Promise<void>
  }
}

declare module '@capacitor/local-notifications' {
  export const LocalNotifications: {
    requestPermissions(): Promise<{ display: 'granted' | 'denied' | 'prompt' }>
    schedule(options: {
      notifications: Array<{
        id: number
        title: string
        body: string
        schedule?: { at: Date }
        extra?: Record<string, string>
      }>
    }): Promise<void>
    cancel(options: { notifications: Array<{ id: number }> }): Promise<void>
  }
}

declare module '@capacitor/camera' {
  export enum CameraResultType {
    Uri = 'uri',
    Base64 = 'base64',
    DataUrl = 'dataUrl',
  }
  export enum CameraSource {
    Prompt = 'PROMPT',
    Camera = 'CAMERA',
    Photos = 'PHOTOS',
  }
  export const Camera: {
    getPhoto(options: {
      quality?: number
      allowEditing?: boolean
      resultType: CameraResultType
      source?: CameraSource
    }): Promise<{
      base64String?: string
      dataUrl?: string
      webPath?: string
      path?: string
    }>
  }
}

declare module 'capacitor-native-biometric' {
  export const NativeBiometric: {
    isAvailable(): Promise<{
      isAvailable: boolean
      biometryType: string
    }>
    verifyIdentity(options: {
      reason?: string
      title?: string
      subtitle?: string
      description?: string
      useFallback?: boolean
      maxAttempts?: number
    }): Promise<void>
    setCredentials(options: {
      server: string
      username: string
      password: string
    }): Promise<void>
    getCredentials(options: {
      server: string
    }): Promise<{ username: string; password: string }>
    deleteCredentials(options: { server: string }): Promise<void>
  }
}
