import type { Metadata } from 'next'
export const revalidate = 0 // Auth-walled: no cache
export const metadata: Metadata = { title: 'Bookmarks', description: 'Your bookmarked content on Arena.' }
export default function Layout({ children }: { children: React.ReactNode }) { return children }
