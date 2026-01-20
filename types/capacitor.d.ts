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
