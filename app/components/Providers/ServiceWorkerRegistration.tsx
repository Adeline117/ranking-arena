'use client'

import { useEffect } from 'react'

/**
 * Service Worker Registration component
 * Registers service worker for PWA functionality
 * Handles update detection and cache refresh on new deployments
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    if (process.env.NODE_ENV !== 'production') return

    let intervalId: ReturnType<typeof setInterval> | undefined

    // Reload page when new SW takes control (seamless update)
    let refreshing = false
    const onControllerChange = () => {
      if (!refreshing) {
        refreshing = true
        window.location.reload()
      }
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    let registrationRef: ServiceWorkerRegistration | null = null
    const onUpdateFound = () => {
      const newWorker = registrationRef?.installing
      if (!newWorker) return
      newWorker.addEventListener('statechange', onStateChange)
    }
    const onStateChange = function(this: ServiceWorker) {
      if (this.state === 'installed' && navigator.serviceWorker.controller) {
        this.postMessage({ type: 'SKIP_WAITING' })
      }
    }

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        registrationRef = registration
        intervalId = setInterval(() => { registration.update() }, 60 * 60 * 1000)
        registration.addEventListener('updatefound', onUpdateFound)
      })
      .catch(() => { /* Registration failed silently */ })

    return () => {
      if (intervalId) clearInterval(intervalId)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      if (registrationRef) {
        registrationRef.removeEventListener('updatefound', onUpdateFound)
        registrationRef.installing?.removeEventListener('statechange', onStateChange)
        registrationRef.waiting?.removeEventListener('statechange', onStateChange)
      }
    }
  }, [])

  return null
}

export default ServiceWorkerRegistration
