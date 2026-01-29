import { useEffect } from 'react'

/**
 * Loads ranking-table.css asynchronously after hydration.
 *
 * The CSS contains only non-critical visual enhancements:
 *   - Medal glow animations (gold/silver/bronze)
 *   - Pagination hover effects
 *   - Toolbar button hover states
 *   - Sort header styles
 *
 * Critical layout styles (grid columns, responsive breakpoints)
 * are already in critical-css.ts and responsive.css.
 *
 * This avoids ~5KB of render-blocking CSS on the critical path.
 */
export function useRankingTableStyles() {
  useEffect(() => {
    const href = '/styles/ranking-table.css'

    // Skip if already loaded
    if (document.querySelector(`link[href="${href}"]`)) {
      return
    }

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.onerror = () => {
      console.warn('Failed to load ranking-table.css')
    }
    document.head.appendChild(link)
  }, [])
}
