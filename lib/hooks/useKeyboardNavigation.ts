/**
 * useKeyboardNavigation Hook
 *
 * Provides keyboard navigation for dropdown menus and list components
 * Supports arrow keys, Enter, Escape, Home, End, and type-ahead search
 */

import { useState, useCallback, useEffect, useRef } from 'react'

export interface UseKeyboardNavigationOptions<T> {
  items: T[]
  isOpen: boolean
  onSelect: (item: T, index: number) => void
  onClose: () => void
  getItemLabel?: (item: T) => string
  loop?: boolean  // Whether to loop from end to start
  typeAhead?: boolean  // Enable type-ahead search
  typeAheadTimeout?: number  // Time before type-ahead buffer clears
}

export interface UseKeyboardNavigationReturn {
  activeIndex: number
  setActiveIndex: (index: number) => void
  handleKeyDown: (e: React.KeyboardEvent) => void
  resetActiveIndex: () => void
}

export function useKeyboardNavigation<T>({
  items,
  isOpen,
  onSelect,
  onClose,
  getItemLabel = (item) => String(item),
  loop = true,
  typeAhead = true,
  typeAheadTimeout = 500,
}: UseKeyboardNavigationOptions<T>): UseKeyboardNavigationReturn {
  const [activeIndex, setActiveIndex] = useState(-1)
  const typeAheadBuffer = useRef('')
  const typeAheadTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Reset active index when dropdown closes
  useEffect(() => {
    if (!isOpen) {
      setActiveIndex(-1)
      typeAheadBuffer.current = ''
    }
  }, [isOpen])

  // Clear type-ahead buffer after timeout
  const clearTypeAhead = useCallback(() => {
    if (typeAheadTimeoutRef.current) {
      clearTimeout(typeAheadTimeoutRef.current)
    }
    typeAheadTimeoutRef.current = setTimeout(() => {
      typeAheadBuffer.current = ''
    }, typeAheadTimeout)
  }, [typeAheadTimeout])

  // Find item by type-ahead
  const findByTypeAhead = useCallback((char: string): number => {
    typeAheadBuffer.current += char.toLowerCase()
    clearTypeAhead()

    const searchString = typeAheadBuffer.current
    const startIndex = activeIndex >= 0 ? activeIndex + 1 : 0

    // Search from current position
    for (let i = 0; i < items.length; i++) {
      const index = (startIndex + i) % items.length
      const label = getItemLabel(items[index]).toLowerCase()
      if (label.startsWith(searchString)) {
        return index
      }
    }

    // If not found, try searching with just the last character
    if (searchString.length > 1) {
      typeAheadBuffer.current = char.toLowerCase()
      for (let i = 0; i < items.length; i++) {
        const index = (startIndex + i) % items.length
        const label = getItemLabel(items[index]).toLowerCase()
        if (label.startsWith(char.toLowerCase())) {
          return index
        }
      }
    }

    return -1
  }, [items, activeIndex, getItemLabel, clearTypeAhead])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen || items.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((prev) => {
          if (prev < items.length - 1) return prev + 1
          return loop ? 0 : prev
        })
        break

      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((prev) => {
          if (prev > 0) return prev - 1
          if (prev === -1) return items.length - 1
          return loop ? items.length - 1 : prev
        })
        break

      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        break

      case 'End':
        e.preventDefault()
        setActiveIndex(items.length - 1)
        break

      case 'Enter':
      case ' ':
        e.preventDefault()
        if (activeIndex >= 0 && activeIndex < items.length) {
          onSelect(items[activeIndex], activeIndex)
        }
        break

      case 'Escape':
        e.preventDefault()
        onClose()
        break

      case 'Tab':
        // Close dropdown on Tab (standard behavior)
        onClose()
        break

      default:
        // Type-ahead search for single printable characters
        if (typeAhead && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          const foundIndex = findByTypeAhead(e.key)
          if (foundIndex >= 0) {
            setActiveIndex(foundIndex)
          }
        }
        break
    }
  }, [isOpen, items, activeIndex, loop, onSelect, onClose, typeAhead, findByTypeAhead])

  const resetActiveIndex = useCallback(() => {
    setActiveIndex(-1)
    typeAheadBuffer.current = ''
  }, [])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (typeAheadTimeoutRef.current) {
        clearTimeout(typeAheadTimeoutRef.current)
      }
    }
  }, [])

  return {
    activeIndex,
    setActiveIndex,
    handleKeyDown,
    resetActiveIndex,
  }
}

export default useKeyboardNavigation
