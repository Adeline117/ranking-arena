'use client'

import { tokens } from '@/lib/design-tokens'

interface Web3VerifiedBadgeProps {
  size?: 'sm' | 'md'
}

/**
 * 链上验证标识 — 给 source_type=web3 的交易员显示
 * 纯文字+SVG，不使用emoji
 */
export function Web3VerifiedBadge({ size = 'sm' }: Web3VerifiedBadgeProps) {
  const iconSize = size === 'sm' ? 12 : 16
  const fontSize = 12

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: size === 'sm' ? '1px 6px' : '2px 8px',
        borderRadius: tokens.radius.full,
        background: 'var(--color-violet-subtle)',
        border: '1px solid var(--color-violet-border)',
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
      title="Verified On-Chain / 链上验证"
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke={tokens.colors.verified.web3}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
      <span
        style={{
          fontSize,
          fontWeight: 600,
          color: tokens.colors.verified.web3,
        }}
      >
        On-Chain
      </span>
    </span>
  )
}

export default Web3VerifiedBadge
