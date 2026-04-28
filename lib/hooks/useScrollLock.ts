'use client'
import { useEffect } from 'react'

/**
 * iOS-safe, ref-counted scroll lock.
 *
 * `overflow: hidden` on body does NOT prevent scroll-through on iOS Safari.
 * This hook uses `position: fixed` + scroll position save/restore.
 *
 * Ref-counted: multiple simultaneous locks (nested modals) are safe.
 * The body is locked on the FIRST lock and unlocked on the LAST unlock.
 * Individual components never clobber each other's cleanup.
 */

let lockCount = 0
let savedScrollY = 0
let savedBodyStyles = {
  position: '',
  top: '',
  width: '',
  overflow: '',
  htmlOverflow: '',
}

function lock() {
  lockCount++
  if (lockCount === 1) {
    // First lock — save state and apply
    savedScrollY = window.scrollY
    const body = document.body
    const html = document.documentElement

    savedBodyStyles = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
      htmlOverflow: html.style.overflow,
    }

    body.style.position = 'fixed'
    body.style.top = `-${savedScrollY}px`
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    html.style.overflow = 'hidden'
  }
}

function unlock() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) {
    // Last unlock — restore state
    const body = document.body
    const html = document.documentElement

    body.style.position = savedBodyStyles.position
    body.style.top = savedBodyStyles.top
    body.style.width = savedBodyStyles.width
    body.style.overflow = savedBodyStyles.overflow
    html.style.overflow = savedBodyStyles.htmlOverflow

    window.scrollTo(0, savedScrollY)
  }
}

export function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return
    lock()
    return () => unlock()
  }, [locked])
}
