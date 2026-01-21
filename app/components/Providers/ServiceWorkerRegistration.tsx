'use client'

import { useEffect } from 'react'

/**
 * Service Worker Registration component
 * Registers service worker for PWA functionality
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      // Only register in production
      if (process.env.NODE_ENV === 'production') {
        navigator.serviceWorker
          .register('/sw.js')
          .then((registration) => {
            console.log('SW registered:', registration.scope)
          })
          .catch((error) => {
            console.log('SW registration failed:', error)
          })
      }
    }
  }, [])

  return null
}

export default ServiceWorkerRegistration
