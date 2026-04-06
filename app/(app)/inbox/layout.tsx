import type { Metadata } from 'next'
export const revalidate = 0 // Auth-walled: no cache
export const metadata: Metadata = { title: 'Inbox', description: 'Your notifications and updates on Arena.' }
export default function Layout({ children }: { children: React.ReactNode }) { return children }
