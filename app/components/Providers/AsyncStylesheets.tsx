'use client'

import { useEffect } from 'react'

/**
 * Async CSS Loader
 * Loads non-critical CSS after the page has hydrated to improve LCP
 *
 * How it works:
 * 1. Critical CSS is inlined in <head> via critical-css.ts
 * 2. This component loads additional CSS files after React hydration
 * 3. Uses requestIdleCallback to avoid blocking the main thread
 */

// responsive.css loads first (layout-critical breakpoints not in critical-css.ts)
// animations.css deferred further — purely decorative, never affects LCP
const PRIORITY_STYLESHEETS = ['/styles/responsive.css']
const DEFERRED_STYLESHEETS = ['/styles/animations.css']

function loadStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (document.querySelector(`link[href="${href}"]`)) {
      resolve()
      return
    }

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.onload = () => resolve()
    link.onerror = () => reject(new Error(`Failed to load ${href}`))
    document.head.appendChild(link)
  })
}

export function AsyncStylesheets() {
  useEffect(() => {
    // Priority: responsive.css (layout breakpoints) — load immediately after hydration.
    // Critical grid columns are in critical-css.ts but responsive.css has mobile overrides
    // that prevent CLS on small screens.
    PRIORITY_STYLESHEETS.forEach(href => {
      loadStylesheet(href).catch(_err => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
      })
    })

    // Deferred: animations.css (purely decorative) — load well after LCP
    const loadDeferred = () => {
      DEFERRED_STYLESHEETS.forEach(href => {
        loadStylesheet(href).catch(_err => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
        })
      })
    }

    if ('requestIdleCallback' in window) {
      // Animations after idle — well past LCP window, avoids TBT contribution
      requestIdleCallback(loadDeferred, { timeout: 5000 })
    } else {
      // Safari fallback
      setTimeout(loadDeferred, 2000)
    }
  }, [])

  return null
}

/**
 * Load trader-specific animations only on trader pages
 * This prevents loading 432 lines of CSS on the homepage
 */
export function TraderPageStylesheets() {
  useEffect(() => {
    loadStylesheet('/styles/trader-animations.css').catch(_err => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
    })
  }, [])

  return null
}
