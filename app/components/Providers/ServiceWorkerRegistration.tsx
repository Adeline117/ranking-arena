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
          .then((_registration) => {
          })
          .catch((_error) => {
          })
      }
    }
  }, [])

  return null
}

export default ServiceWorkerRegistration
