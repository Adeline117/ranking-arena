'use client'

import { type RefObject, useLayoutEffect } from 'react'

export const PAGE_BOTTOM_OVERLAY_OFFSET = '--page-bottom-overlay-offset'

type ReservationMap = Map<symbol, number>

// A document can contain more than one independently mounted client root. Keep
// reservations per document and add them so every global floating control clears
// the complete page-owned bottom stack instead of whichever overlay mounted last.
const reservationsByDocument = new WeakMap<Document, ReservationMap>()

function reservationsFor(document: Document): ReservationMap {
  const existing = reservationsByDocument.get(document)
  if (existing) return existing

  const reservations = new Map<symbol, number>()
  reservationsByDocument.set(document, reservations)
  return reservations
}

function publishReservationTotal(document: Document, reservations: ReservationMap): void {
  const total = Array.from(reservations.values()).reduce((sum, height) => sum + height, 0)
  if (total > 0) {
    document.documentElement.style.setProperty(PAGE_BOTTOM_OVERLAY_OFFSET, `${total}px`)
  } else {
    document.documentElement.style.removeProperty(PAGE_BOTTOM_OVERLAY_OFFSET)
  }
}

/**
 * Reserves the measured height of a page-owned bottom overlay for global
 * floating controls such as Feedback, ScrollToTop and the create FAB.
 *
 * The reservation is active only while `mediaQuery` matches. ResizeObserver
 * keeps wrapped/localized controls accurate without guessed language-specific
 * constants, and useLayoutEffect publishes before paint to avoid a transient
 * overlap when the overlay first appears.
 */
export function useBottomOverlayReservation<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  mediaQuery = '(max-width: 768px)'
): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!active || !element) return

    const owner = Symbol('bottom-overlay-reservation')
    const ownerDocument = element.ownerDocument
    const ownerWindow = ownerDocument.defaultView
    if (!ownerWindow) return

    const reservations = reservationsFor(ownerDocument)
    const viewport = ownerWindow.matchMedia(mediaQuery)

    const publishHeight = () => {
      const height = viewport.matches ? Math.ceil(element.getBoundingClientRect().height) : 0
      if (height > 0) reservations.set(owner, height)
      else reservations.delete(owner)
      publishReservationTotal(ownerDocument, reservations)
    }

    publishHeight()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishHeight)
    observer?.observe(element)
    ownerWindow.addEventListener('resize', publishHeight)
    viewport.addEventListener('change', publishHeight)

    return () => {
      observer?.disconnect()
      ownerWindow.removeEventListener('resize', publishHeight)
      viewport.removeEventListener('change', publishHeight)
      reservations.delete(owner)
      publishReservationTotal(ownerDocument, reservations)
    }
  }, [active, mediaQuery, ref])
}
