/**
 * useTableKeyboardNav Hook
 *
 * Adds keyboard navigation to the ranking table rows.
 * - Arrow Up/Down: Move focus between rows
 * - Enter: Navigate to the trader detail page (follows the row's <a> link)
 * - Home/End: Jump to first/last visible row
 * - Escape: Clear focus
 *
 * The hook manages a focusedIndex and returns:
 *   - containerProps: spread onto the rows' parent container
 *   - getRowProps(index): spread onto each row wrapper
 *   - focusedIndex: current focused row (-1 = none)
 *
 * Focused rows receive `data-kb-focused="true"` for CSS targeting.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

export interface UseTableKeyboardNavOptions {
  /** Total number of visible rows */
  rowCount: number
  /** Return the href for a given row index so Enter can navigate */
  getRowHref: (index: number) => string
  /** Whether keyboard nav is enabled (disable in card view, loading, etc.) */
  enabled?: boolean
}

export interface UseTableKeyboardNavReturn {
  /** Spread on the scrollable container that wraps all rows */
  containerProps: {
    role: 'grid'
    tabIndex: 0
    onKeyDown: (e: React.KeyboardEvent) => void
    onBlur: (e: React.FocusEvent) => void
    'aria-activedescendant': string | undefined
    'aria-rowcount': number
  }
  /** Call with the row index; spread the result onto each row wrapper element */
  getRowProps: (index: number) => {
    id: string
    role: 'row'
    'aria-rowindex': number
    'data-kb-focused': boolean
    tabIndex: -1
  }
  /** The currently focused row index (-1 means nothing focused) */
  focusedIndex: number
  /** Programmatically set focused index */
  setFocusedIndex: (index: number) => void
}

export function useTableKeyboardNav({
  rowCount,
  getRowHref,
  enabled = true,
}: UseTableKeyboardNavOptions): UseTableKeyboardNavReturn {
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const router = useRouter()
  const containerRef = useRef<HTMLElement | null>(null)

  // Reset focus when row count changes (pagination, filter, sort)
  useEffect(() => {
    setFocusedIndex(-1)
  }, [rowCount])

  // Scroll the focused row into view
  useEffect(() => {
    if (focusedIndex < 0) return
    const el = document.getElementById(`ranking-row-${focusedIndex}`)
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [focusedIndex])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!enabled || rowCount === 0) return

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          setFocusedIndex((prev) => {
            if (prev < rowCount - 1) return prev + 1
            return prev // stop at last row
          })
          break
        }

        case 'ArrowUp': {
          e.preventDefault()
          setFocusedIndex((prev) => {
            if (prev > 0) return prev - 1
            if (prev === -1) return rowCount - 1 // if nothing focused, go to last
            return prev // stop at first row
          })
          break
        }

        case 'Home': {
          e.preventDefault()
          setFocusedIndex(0)
          break
        }

        case 'End': {
          e.preventDefault()
          setFocusedIndex(rowCount - 1)
          break
        }

        case 'Enter': {
          if (focusedIndex >= 0 && focusedIndex < rowCount) {
            e.preventDefault()
            const href = getRowHref(focusedIndex)
            if (href) {
              router.push(href)
            }
          }
          break
        }

        case 'Escape': {
          e.preventDefault()
          setFocusedIndex(-1)
          break
        }

        default:
          break
      }
    },
    [enabled, rowCount, focusedIndex, getRowHref, router]
  )

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      // If focus leaves the container entirely, clear keyboard focus
      const container = e.currentTarget
      const relatedTarget = e.relatedTarget as Node | null
      if (relatedTarget && container.contains(relatedTarget)) {
        // Focus is still inside the container (e.g., clicked a child link) — do nothing
        return
      }
      setFocusedIndex(-1)
    },
    []
  )

  const containerProps = {
    role: 'grid' as const,
    tabIndex: 0,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    'aria-activedescendant':
      focusedIndex >= 0 ? `ranking-row-${focusedIndex}` : undefined,
    'aria-rowcount': rowCount,
  }

  const getRowProps = useCallback(
    (index: number) => ({
      id: `ranking-row-${index}`,
      role: 'row' as const,
      'aria-rowindex': index + 1,
      'data-kb-focused': focusedIndex === index,
      tabIndex: -1 as const,
    }),
    [focusedIndex]
  )

  return {
    containerProps: enabled ? containerProps : {
      role: 'grid' as const,
      tabIndex: 0,
      onKeyDown: () => {},
      onBlur: () => {},
      'aria-activedescendant': undefined,
      'aria-rowcount': rowCount,
    },
    getRowProps,
    focusedIndex,
    setFocusedIndex,
  }
}

export default useTableKeyboardNav
