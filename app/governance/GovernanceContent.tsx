'use client'

import dynamic from 'next/dynamic'

const ProposalList = dynamic(() => import('@/app/components/governance/ProposalList').then(m => m.ProposalList), { ssr: false })
const GovernanceHeader = dynamic(() => import('@/app/components/governance/GovernanceHeader').then(m => m.GovernanceHeader), { ssr: false })
const Web3Boundary = dynamic(() => import('@/lib/web3/withWeb3').then(m => ({ default: m.Web3Boundary })), { ssr: false })

export default function GovernanceContent() {
  return (
    <Web3Boundary>
      <div className="max-w-[800px] mx-auto px-4 py-8">
        <GovernanceHeader />
        <ProposalList showHeader={true} />
      </div>
    </Web3Boundary>
  )
}
