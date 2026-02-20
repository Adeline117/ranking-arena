'use client'

import dynamic from 'next/dynamic'
import { useAdminAuth } from '../hooks/useAdminAuth'
import TopNav from '@/app/components/layout/TopNav'

const PipelineMonitor = dynamic(() => import('@/app/components/admin/PipelineMonitor'), {
  ssr: false,
  loading: () => <div style={{ padding: 40, textAlign: 'center' }}>Loading pipeline monitor…</div>,
})

export default function PipelinePage() {
  const { email, isAdmin, authChecking } = useAdminAuth()

  if (authChecking) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Verifying permissions…</div>
  }

  if (!isAdmin) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
        <TopNav email={email} />
        <div style={{ padding: 40, textAlign: 'center' }}>
          <h2>Access Denied</h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>Admin privileges required.</p>
        </div>
      </div>
    )
  }

  return <PipelineMonitor />
}
