import type { Metadata } from 'next'
export const metadata: Metadata = { title: 'Bookmarks | Arena', description: 'Your bookmarked content on Arena.' }
export default function Layout({ children }: { children: React.ReactNode }) { return children }
