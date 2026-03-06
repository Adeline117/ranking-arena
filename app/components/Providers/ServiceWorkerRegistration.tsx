'use client'

import { useEffect } from 'react'

/**
 * Service Worker Registration component
 * Registers service worker for PWA functionality
 * Handles update detection and cache refresh on new deployments
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      // Only register in production
      if (process.env.NODE_ENV === 'production') {
        navigator.serviceWorker
          .register('/sw.js')
          .then((registration) => {
            // Check for updates periodically (every 60 minutes)
            setInterval(() => {
              registration.update()
            }, 60 * 60 * 1000)

            // Listen for new service worker waiting to activate
            registration.addEventListener('updatefound', () => {
              const newWorker = registration.installing
              if (!newWorker) return

              newWorker.addEventListener('statechange', () => {
                if (
                  newWorker.state === 'installed' &&
                  navigator.serviceWorker.controller
                ) {
                  // New version available - skip waiting to activate immediately
                  // The SW already calls skipWaiting(), so this is a fallback
                  newWorker.postMessage({ type: 'SKIP_WAITING' })
                }
              })
            })
          })
          .catch(() => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
            // Registration failed silently
          })

        // Reload page when new SW takes control (seamless update)
        let refreshing = false
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!refreshing) {
            refreshing = true
            window.location.reload()
          }
        })
      }
    }
  }, [])

  return null
}

export default ServiceWorkerRegistration
