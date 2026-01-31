import { ProposalList } from '@/app/components/governance/ProposalList'

export const metadata = {
  title: 'Governance',
  description: 'Vote on Arena platform proposals using your wallet or Pro NFT.',
}

export default function GovernancePage() {
  return (
    <div style={{
      maxWidth: 800,
      margin: '0 auto',
      padding: '32px 16px',
    }}>
      {/* Hero section */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{
          fontSize: 32,
          fontWeight: 800,
          color: '#eaeaea',
          marginBottom: 8,
        }}>
          Arena Governance
        </h1>
        <p style={{
          fontSize: 15,
          color: '#8a8a8a',
          lineHeight: 1.6,
        }}>
          Shape the future of Arena. Pro NFT holders can vote on platform features,
          trader disputes, and community proposals via Snapshot (gasless).
        </p>
      </div>

      {/* Proposal list */}
      <ProposalList showHeader={true} />
    </div>
  )
}
