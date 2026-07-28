'use client'

export const BOTTOM_OVERLAY_OPEN_EVENT = 'arena:bottom-overlay-open'

export type BottomOverlayOwner = 'feedback' | 'fab-menu'

export function announceBottomOverlayOpen(owner: BottomOverlayOwner): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<BottomOverlayOwner>(BOTTOM_OVERLAY_OPEN_EVENT, {
      detail: owner,
    })
  )
}

export function subscribeToBottomOverlayOpen(
  listener: (owner: BottomOverlayOwner) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined

  const handleOpen = (event: Event) => {
    listener((event as CustomEvent<BottomOverlayOwner>).detail)
  }
  window.addEventListener(BOTTOM_OVERLAY_OPEN_EVENT, handleOpen)
  return () => window.removeEventListener(BOTTOM_OVERLAY_OPEN_EVENT, handleOpen)
}
