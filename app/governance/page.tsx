import { ProposalList } from '@/app/components/governance/ProposalList'
import { GovernanceHeader } from '@/app/components/governance/GovernanceHeader'

export const metadata = {
  title: 'Governance',
  description: 'Vote on Arena platform proposals using your wallet or Pro NFT.',
}

export default function GovernancePage() {
  return (
    <div className="max-w-[800px] mx-auto px-4 py-8">
      <GovernanceHeader />
      <ProposalList showHeader={true} />
    </div>
  )
}
