'use client'

/**
 * SentryInit — Client component that triggers Sentry initialization.
 * Only rendered in (app)/layout.tsx — NOT on the homepage.
 * This prevents the ~194KB Sentry chunk from loading on the homepage.
 */

import { useEffect } from 'react'

export default function SentryInit() {
  useEffect(() => {
    // Dynamic import to keep this file tiny (~500 bytes)
    import('@/lib/sentry-init')
  }, [])
  return null
}
