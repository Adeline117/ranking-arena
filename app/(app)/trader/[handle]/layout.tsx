// Metadata is generated in page.tsx — no duplicate generateMetadata here
// ISR: match page.tsx revalidate (5 min) — layout revalidate must be <= page
export const revalidate = 300

import TopNav from '@/app/components/layout/TopNav'

/**
 * TraderLayout renders TopNav server-side so TraderProfileClient (the
 * big 'use client' component) doesn't have to pull the server TopNav
 * into its client bundle + doesn't duplicate the render work on every
 * state transition (loading / error / main). Previously TraderProfileClient
 * rendered <TopNav/> in three places internally.
 */
export default function TraderLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <TopNav />
      {children}
    </>
  )
}
