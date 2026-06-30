import type { Metadata } from 'next'
import AdminNav from './components/AdminNav'

export const revalidate = 0 // Admin: no cache

export const metadata: Metadata = {
  title: 'Admin Dashboard',
  description: 'Arena admin dashboard.',
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AdminNav />
      {children}
    </>
  )
}
