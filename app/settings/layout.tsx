import type { Metadata } from 'next'
export const revalidate = 0 // Auth-walled: no cache
export const metadata: Metadata = { title: 'Settings', description: 'Manage your Arena account settings.' }
export default function Layout({ children }: { children: React.ReactNode }) { return children }
