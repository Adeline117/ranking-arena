'use client'

import { useRouter } from 'next/navigation'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Button } from '@/app/components/base'
import type { MembershipInfo } from './membership-config'

interface NftMembershipCardProps {
  info: MembershipInfo | null
  language: string
  cardStyle: React.CSSProperties
  t: (key: string) => string
}

export default function NftMembershipCard({ info, language, cardStyle, t }: NftMembershipCardProps) {
  const router = useRouter()

  return (
    <div style={cardStyle}>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
        {t('nftMembershipCard')}
      </h3>

      {info?.nft?.hasNft ? (
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
          }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: tokens.radius.lg,
              background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, ${tokens.colors.accent.success})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tokens.colors.white,
              fontWeight: 700,
              fontSize: 20,
            }}>
              PRO
            </div>
            <div>
              <div style={{ fontWeight: 700, color: tokens.colors.text.primary }}>Arena Pro NFT #{info.nft.tokenId}</div>
              <div style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
                {info.nft.walletAddress?.slice(0, 6)}...{info.nft.walletAddress?.slice(-4)}
              </div>
            </div>
          </div>
          {info.nft.expiresAt && (
            <div style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
              {t('validUntil')} {new Date(info.nft.expiresAt).toLocaleDateString(getLocaleFromLanguage(language))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: tokens.colors.text.tertiary }}>
          <p style={{ marginBottom: 12, fontSize: 14 }}>
            {t('proMintNft')}
          </p>
          <Button variant="secondary" onClick={() => router.push('/settings')}>
            {t('linkWallet')}
          </Button>
        </div>
      )}
    </div>
  )
}
