import React from 'react'
import TopNav from '@/app/components/layout/TopNav'

/**
 * Legal pages layout — adds TopNav to all legal pages (terms, privacy, about, etc.)
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopNav />
      {children}
    </>
  )
}
