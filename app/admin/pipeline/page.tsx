'use client'

import dynamic from 'next/dynamic'

const PipelineMonitor = dynamic(() => import('@/app/components/admin/PipelineMonitor'), {
  ssr: false,
  loading: () => <div style={{ padding: 40, textAlign: 'center' }}>Loading pipeline monitor…</div>,
})

export default function PipelinePage() {
  return <PipelineMonitor />
}
