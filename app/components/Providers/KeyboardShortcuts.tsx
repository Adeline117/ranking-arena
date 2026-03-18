'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Global keyboard shortcuts component
 * Handles keyboard navigation throughout the app
 *
 * Shortcuts:
 * /         - Focus search
 * Shift+G   - Go to home
 * J         - Scroll to next item (ranking row, post)
 * K         - Scroll to previous item
 * N         - Go to new post (if logged in)
 * ?         - Toggle help overlay
 * Cmd+K     - (handled by useTopNavState)
 */

function ShortcutsHelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'var(--color-backdrop-medium)',
        display: 'grid', placeItems: 'center', zIndex: 9999, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-secondary)', borderRadius: 16, padding: 24,
          border: '1px solid var(--color-border-primary)', maxWidth: 400, width: '100%',
          boxShadow: '0 20px 60px var(--color-overlay-dark)',
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 16 }}>Keyboard Shortcuts</div>
        {[
          ['/', 'Focus search'],
          ['Shift+G', 'Go to home'],
          ['J', 'Next item'],
          ['K', 'Previous item'],
          ['N', 'New post'],
          ['?', 'Show this help'],
          ['Cmd/Ctrl+K', 'Command palette'],
        ].map(([key, desc]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{desc}</span>
            <kbd style={{
              padding: '2px 8px', borderRadius: 6, background: 'var(--color-bg-tertiary)',
              border: '1px solid var(--color-border-primary)', fontSize: 12, fontFamily: 'monospace',
            }}>{key}</kbd>
          </div>
        ))}
        <button
          onClick={onClose}
          style={{
            marginTop: 16, width: '100%', padding: '10px 16px', border: '1px solid var(--color-border-primary)',
            borderRadius: 8, background: 'transparent', color: 'var(--color-text-secondary)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Close (Esc)
        </button>
      </div>
    </div>
  )
}

export default function KeyboardShortcuts() {
  const router = useRouter()
  const [showHelp, setShowHelp] = useState(false)

  const scrollToItem = useCallback((direction: 'next' | 'prev') => {
    // Find scrollable items: ranking rows, post items, or trader cards
    const selectors = '.ranking-row, .post-list-item, .trader-row, [data-keyboard-item]'
    const items = Array.from(document.querySelectorAll(selectors)) as HTMLElement[]
    if (items.length === 0) return

    const viewportMiddle = window.innerHeight / 2
    let currentIndex = -1

    // Find the item closest to the middle of the viewport
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect()
      if (rect.top > viewportMiddle - rect.height && rect.top < viewportMiddle + rect.height) {
        currentIndex = i
        break
      }
    }

    let targetIndex: number
    if (direction === 'next') {
      targetIndex = currentIndex < items.length - 1 ? currentIndex + 1 : items.length - 1
    } else {
      targetIndex = currentIndex > 0 ? currentIndex - 1 : 0
    }

    items[targetIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return
      }

      // Cmd+K / Ctrl+K is handled by useTopNavState (uses React ref, avoids DOM querying)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        return
      }

      // Shortcuts with no modifiers
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        switch (e.key) {
          case '/':
            e.preventDefault()
            // Focus search
            const searchInput = document.querySelector('input[type="search"], input[placeholder*="搜索"], .top-nav-search-input') as HTMLInputElement
            if (searchInput) {
              searchInput.focus()
              searchInput.select()
            }
            break
          case 'g':
            // Go to home
            if (e.shiftKey) {
              e.preventDefault()
              router.push('/')
            }
            break
          case 'j':
          case 'J':
            if (!e.shiftKey) {
              e.preventDefault()
              scrollToItem('next')
            }
            break
          case 'k':
          case 'K':
            if (!e.shiftKey) {
              e.preventDefault()
              scrollToItem('prev')
            }
            break
          case 'n':
          case 'N':
            if (!e.shiftKey) {
              // Navigate to new post page - user handle is needed
              // Use a well-known path pattern
              e.preventDefault()
              const profileLink = document.querySelector('a[href^="/u/"][href$="/new"]') as HTMLAnchorElement
              if (profileLink) {
                router.push(profileLink.href)
              }
            }
            break
          case '?':
            e.preventDefault()
            setShowHelp(prev => !prev)
            break
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [router, scrollToItem])

  if (showHelp) return <ShortcutsHelpOverlay onClose={() => setShowHelp(false)} />
  return null
}
