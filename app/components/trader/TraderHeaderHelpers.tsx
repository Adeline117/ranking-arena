import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'

// ─── Source / Category Helpers ────────────────────────────────────────────────

export const SOURCE_CONFIG: Record<string, string> = {
  binance_futures: 'categoryFutures',
  binance_spot: 'categorySpot',
  binance_web3: 'categoryWeb3',
  bybit: 'categoryFutures',
  bitget_futures: 'categoryFutures',
  bitget_spot: 'categorySpot',
  mexc: 'categoryFutures',
  coinex: 'categoryFutures',
  okx_web3: 'categoryWeb3',
  kucoin: 'categoryFutures',
  gmx: 'categoryWeb3',
}

export function getSourceCategory(source?: string): 'web3' | 'spot' | 'futures' | null {
  if (!source) return null
  if (source.includes('web3') || source === 'gmx') return 'web3'
  if (source.includes('spot')) return 'spot'
  if (source.includes('futures') || source === 'bybit' || source === 'okx') return 'futures'
  return null
}

export const CATEGORY_COLORS: Record<string, string> = {
  web3: tokens.colors.verified.web3,
  spot: tokens.colors.accent.translated,
  futures: tokens.colors.accent.warning,
}

export const CATEGORY_I18N_KEYS: Record<string, string> = {
  web3: 'categoryWeb3',
  spot: 'categorySpot',
  futures: 'categoryFutures',
}

export function getTradingStyleTags(
  t: (key: string) => string,
  source?: string,
  roi90d?: number,
  maxDrawdown?: number,
  winRate?: number
): Array<{ label: string; color: string }> {
  const tags: Array<{ label: string; color: string }> = []

  const category = getSourceCategory(source)
  if (category) {
    tags.push({ label: t(CATEGORY_I18N_KEYS[category]), color: CATEGORY_COLORS[category] })
  }

  if (maxDrawdown != null && Math.abs(maxDrawdown) < 10) {
    tags.push({ label: t('tagLowDrawdown'), color: tokens.colors.accent.success })
  }
  if (winRate != null && winRate > 70) {
    tags.push({ label: t('tagHighWinRate'), color: tokens.colors.accent.success })
  }
  if (roi90d != null && roi90d > 100) {
    tags.push({ label: t('tagHighReturns'), color: tokens.colors.accent.error })
  }

  return tags.slice(0, 3)
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

export function formatAum(aum: number): string {
  if (aum >= 1_000_000) return `$${(aum / 1_000_000).toFixed(1)}M`
  if (aum >= 1_000) return `$${(aum / 1_000).toFixed(0)}K`
  return `$${aum.toFixed(0)}`
}

export function getActiveDays(activeSince?: string): number | null {
  if (!activeSince) return null
  const start = new Date(activeSince)
  if (isNaN(start.getTime())) return null
  const now = new Date()
  return Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
}

export function formatActiveDays(days: number, t: (key: string) => string): string {
  return days > 365 ? `${Math.floor(days / 365)}${t('activeYears')}` : `${days}${t('activeDaysUnit')}`
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

interface BadgeProps {
  children: React.ReactNode
  color: string
  style?: React.CSSProperties
  title?: string
}

export function Badge({ children, color, style, title }: BadgeProps): React.ReactElement {
  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: `4px ${tokens.spacing[3]}`,
        background: `${color}18`,
        borderRadius: tokens.radius.full,
        border: `1px solid ${color}40`,
        ...style,
      }}
      title={title}
    >
      {children}
    </Box>
  )
}

interface StatItemProps {
  icon?: React.ReactNode
  value: string | number
  label: string
  hasCover: boolean
}

export function StatItem({ icon, value, label, hasCover }: StatItemProps): React.ReactElement {
  const textColor = hasCover ? 'var(--glass-bg-medium)' : tokens.colors.text.tertiary
  const valueColor = hasCover ? tokens.colors.white : tokens.colors.text.primary
  const textShadow = hasCover ? '0 1px 4px var(--color-overlay-dark)' : undefined

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
      }}
    >
      {icon}
      <Text
        as="span"
        weight="bold"
        style={{
          color: valueColor,
          textShadow,
          fontSize: tokens.typography.fontSize.sm,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
          letterSpacing: '-0.01em',
        }}
      >
        {typeof value === 'number' ? value.toLocaleString('en-US') : value}
      </Text>
      <Text size="sm" style={{ color: textColor, textShadow }}>
        {label}
      </Text>
    </Box>
  )
}

interface ActionButtonProps {
  onClick: () => void
  variant: 'accent' | 'ghost'
  icon?: React.ReactNode
  children: React.ReactNode
}

export function ActionButton({ onClick, variant, icon, children }: ActionButtonProps): React.ReactElement {
  const isAccent = variant === 'accent'
  const baseBackground = isAccent ? `${tokens.colors.accent.primary}15` : tokens.colors.bg.tertiary
  const baseBorder = isAccent ? `${tokens.colors.accent.primary}40` : tokens.colors.border.primary
  const textColor = isAccent ? tokens.colors.text.primary : tokens.colors.text.tertiary

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      style={{
        color: textColor,
        fontSize: tokens.typography.fontSize.sm,
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.lg,
        background: baseBackground,
        border: `1px solid ${baseBorder}`,
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
      }}
      onMouseEnter={(e) => {
        if (isAccent) {
          e.currentTarget.style.background = `${tokens.colors.accent.primary}25`
          e.currentTarget.style.borderColor = tokens.colors.accent.primary
        } else {
          e.currentTarget.style.background = tokens.colors.bg.secondary
          e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}40`
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = baseBackground
        e.currentTarget.style.borderColor = baseBorder
      }}
    >
      {icon}
      {children}
    </Button>
  )
}
