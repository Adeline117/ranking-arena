'use client'

/**
 * NFTBadge
 *
 * Displays a "Pro (NFT)" badge indicating the user has
 * Pro membership via holding an ArenaFiFi Pro NFT.
 */

import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface NFTBadgeProps {
  size?: 'sm' | 'md'
}

export function NFTBadge({ size = 'sm' }: NFTBadgeProps) {
  const { t } = useLanguage()
  const sizes = {
    sm: { px: 'px-1.5', py: 'py-0.5', text: 'text-[10px]', icon: 12 },
    md: { px: 'px-2', py: 'py-1', text: 'text-xs', icon: 14 },
  }
  const s = sizes[size]

  return (
    <span
      className={`inline-flex items-center gap-1 ${s.px} ${s.py} rounded-md bg-purple-500/10 border border-purple-500/20 ${s.text} font-semibold text-purple-400`}
      title={t('nftBadgeTitle')}
    >
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
      {t('nftBadgePro')}
    </span>
  )
}
