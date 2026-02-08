'use client'

import dynamic from 'next/dynamic'

const ProposalList = dynamic(() => import('@/lib/web3/wallet-components').then(m => m.ProposalList), { ssr: false })
const GovernanceHeader = dynamic(() => import('@/lib/web3/wallet-components').then(m => m.GovernanceHeader), { ssr: false })
const LazyWeb3Boundary = dynamic(() => import('@/lib/web3/wallet-components').then(m => ({ default: m.Web3Boundary })), { ssr: false })

export default function GovernanceContent() {
  return (
    <LazyWeb3Boundary>
      <div className="max-w-[800px] mx-auto px-4 py-8">
        <GovernanceHeader />
        <ProposalList showHeader={true} />
      </div>
    </LazyWeb3Boundary>
  )
}
