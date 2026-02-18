import type { Metadata } from 'next'
export const metadata: Metadata = { title: 'My Posts | Arena', description: 'View and manage your posts on Arena.' }
export default function Layout({ children }: { children: React.ReactNode }) { return children }
