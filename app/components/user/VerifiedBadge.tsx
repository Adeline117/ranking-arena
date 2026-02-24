
interface VerifiedBadgeProps {
  tier: 'tier1' | 'tier2' | 'tier3'
  size?: number
}

const TIER_COLORS: Record<string, string> = {
  tier1: 'var(--color-medal-gold)', // 金色
  tier2: 'var(--color-medal-silver)', // 银色
  tier3: 'var(--color-chart-blue)', // 蓝色
}

const TIER_LABELS: Record<string, string> = {
  tier1: '头部KOL认证',
  tier2: '实盘认证',
  tier3: '社区认证',
}

export default function VerifiedBadge({ tier, size = 16 }: VerifiedBadgeProps) {
  const color = TIER_COLORS[tier] || TIER_COLORS.tier3

  return (
    <span
      title={TIER_LABELS[tier]}
      style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 4, verticalAlign: 'middle' }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M12 2L14.09 4.26L17 3.64L17.18 6.57L19.82 8.07L18.56 10.74L20 13.14L17.72 14.84L17.5 17.78L14.58 17.96L12.68 20.36L10.24 18.82L7.5 19.82L6.36 17.1L3.54 16.08L4.26 13.18L2.5 10.96L4.72 9.14L4.64 6.2L7.42 5.58L9.04 3.18L12 2Z"
          fill={color}
        />
        <path
          d="M9.5 12.5L11 14L15 10"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
