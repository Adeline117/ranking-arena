'use client'

import dynamic from 'next/dynamic'

const ProposalList = dynamic(() => import('@/app/components/governance/ProposalList').then(m => m.ProposalList), { ssr: false })
const GovernanceHeader = dynamic(() => import('@/app/components/governance/GovernanceHeader').then(m => m.GovernanceHeader), { ssr: false })

export default function GovernanceContent() {
  return (
    <div className="max-w-[800px] mx-auto px-4 py-8">
      <GovernanceHeader />
      <ProposalList showHeader={true} />
    </div>
  )
}
