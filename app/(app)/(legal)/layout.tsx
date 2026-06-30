import React from 'react'
/**
 * Route-group layout for legal pages (terms, privacy, disclaimer, about, dmca).
 * It is a pass-through wrapper: the surrounding (app) layout already provides the
 * top navigation and chrome, so this only groups the legal routes together (e.g.
 * for shared metadata defaults). It intentionally renders children unchanged.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
