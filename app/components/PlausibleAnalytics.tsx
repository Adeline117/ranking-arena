'use client'

import Script from 'next/script'

/**
 * Plausible Analytics — lightweight, privacy-friendly analytics.
 * No-op until NEXT_PUBLIC_PLAUSIBLE_DOMAIN env var is set.
 */
export default function PlausibleAnalytics() {
  if (process.env.NODE_ENV !== 'production') return null
  const domain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN
  if (!domain) return null

  return (
    <Script
      defer
      data-domain={domain}
      src="https://plausible.io/js/script.js"
      strategy="lazyOnload"
    />
  )
}
