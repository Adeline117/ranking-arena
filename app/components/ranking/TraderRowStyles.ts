/**
 * Module-level style constants for TraderRow and its sub-components.
 * Extracted to avoid allocating new objects on every render
 * (defeats React.memo; ~750-1000 throwaway objects per 50-row render pass -> ~0).
 */
import { tokens } from '@/lib/design-tokens'
import { TRADER_TEXT_TERTIARY, TRADER_ACCENT_ERROR } from './shared/TraderDisplay'

// Shared horizontal rhythm for the sticky column header AND every data row.
// The header used gap 8 / padding-x 16 while rows used 12 / 20, so numeric
// columns drifted 16–20px from their labels. Both now read these.
export const ROW_GAP = tokens.spacing[3] // 12px
export const ROW_PADDING_X = tokens.spacing[5] // 20px

// Hero row styles (top 3): left medal bar + subtle tint. No horizontal margin
// (hero numbers must line up with every other row and the header) and no
// outer glow (it bled over neighbouring rows). Mirrored for the SSR first
// paint in lib/performance/critical-css.ts (.ssr-ranking-entry-rank-N).
export const HERO_STYLE_RANK_1: React.CSSProperties = {
  background:
    'linear-gradient(135deg, rgba(255,215,0,0.18) 0%, rgba(255,215,0,0.06) 35%, rgba(255,215,0,0.02) 70%, transparent 100%)',
  boxShadow: 'inset 4px 0 0 var(--color-rank-gold), inset 0 1px 0 rgba(255,215,0,0.10)',
  borderRadius: 14,
  margin: '6px 0 8px',
  borderTop: '1px solid rgba(255,215,0,0.12)',
}
export const HERO_STYLE_RANK_2: React.CSSProperties = {
  background:
    'linear-gradient(135deg, rgba(192,192,192,0.14) 0%, rgba(192,192,192,0.04) 35%, transparent 80%)',
  boxShadow: 'inset 4px 0 0 var(--color-rank-silver), inset 0 1px 0 rgba(192,192,192,0.08)',
  borderRadius: 14,
  margin: '4px 0 6px',
  borderTop: '1px solid rgba(192,192,192,0.08)',
}
export const HERO_STYLE_RANK_3: React.CSSProperties = {
  background:
    'linear-gradient(135deg, rgba(205,127,50,0.14) 0%, rgba(205,127,50,0.04) 35%, transparent 80%)',
  boxShadow: 'inset 4px 0 0 var(--color-rank-bronze), inset 0 1px 0 rgba(205,127,50,0.08)',
  borderRadius: 14,
  margin: '4px 0 6px',
  borderTop: '1px solid rgba(205,127,50,0.08)',
}

// Lazy-loading placeholder styles
export const LAZY_LOADING_STYLE: React.CSSProperties = {
  padding: 16,
  textAlign: 'center',
  opacity: 0.5,
}
export const LAZY_ICON_STYLE: React.CSSProperties = {
  width: 14,
  height: 14,
  display: 'inline-block',
}

// Core layout styles
export const NA_STYLE: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  color: TRADER_TEXT_TERTIARY,
  opacity: 0.4,
  letterSpacing: 1,
  cursor: 'help',
}
export const NA_DASH_STYLE: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  color: TRADER_TEXT_TERTIARY,
  opacity: 0.4,
}
/** Confirmed zero-trade wallet (trades_count === 0): gains come from held
 *  positions, so win% is undefined BY DESIGN — a labeled chip, not a dash. */
export const HOLDER_CHIP_STYLE: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  color: TRADER_TEXT_TERTIARY,
  border: '1px solid var(--color-border-primary)',
  borderRadius: tokens.radius.full,
  padding: '1px 8px',
  cursor: 'help',
  whiteSpace: 'nowrap',
}
export const ROW_BASE_STYLE: React.CSSProperties = {
  display: 'grid',
  alignItems: 'center',
  gap: ROW_GAP,
  padding: `${tokens.spacing[3.5]} ${ROW_PADDING_X}`,
  cursor: 'pointer',
  position: 'relative' as const,
}
export const TRADER_INFO_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'nowrap',
  minWidth: 0,
}
export const SCORE_CELL_STYLE: React.CSSProperties = {
  textAlign: 'center',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
}
export const ROI_CELL_STYLE: React.CSSProperties = {
  textAlign: 'right',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 2,
}
export const PNL_CELL_STYLE: React.CSSProperties = {
  textAlign: 'right',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
}
export const RIGHT_CELL_STYLE: React.CSSProperties = {
  textAlign: 'right',
  alignItems: 'center',
  justifyContent: 'flex-end',
}

// Trader info sub-layout styles
export const NAME_COLUMN_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
  flex: 1,
}
export const NAME_ROW_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
export const TAGS_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
}

// Mobile score badge styles
export const MOBILE_BADGE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  flexShrink: 0,
}
export const MOBILE_BADGE_TEXT_STYLE: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  fontWeight: 700,
  color: TRADER_TEXT_TERTIARY,
}

// Verified badge style
export const VERIFIED_BADGE_STYLE: React.CSSProperties = {
  padding: `1px ${tokens.spacing[1.5]}`,
  borderRadius: tokens.radius.md,
  fontSize: tokens.typography.fontSize.xs,
  fontWeight: 600,
  color: 'var(--color-verified-onchain)',
  background: 'rgba(34, 211, 238, 0.12)',
  border: '1px solid rgba(34, 211, 238, 0.25)',
  lineHeight: 1.4,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
}

// Bot badge style
export const BOT_BADGE_STYLE: React.CSSProperties = {
  padding: `1px ${tokens.spacing[1.5]}`,
  borderRadius: tokens.radius.md,
  fontSize: tokens.typography.fontSize.xs,
  fontWeight: 600,
  color: tokens.colors.accent.primary,
  background: 'var(--color-accent-primary-12)',
  border: '1px solid var(--color-accent-primary-30)',
  lineHeight: 1.4,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
}
export const BOT_EMOJI_STYLE: React.CSSProperties = { fontSize: 10 }

// Trading style chip base (colors merged at render time)
export const TRADING_STYLE_BASE_STYLE: React.CSSProperties = {
  padding: `1px ${tokens.spacing[1.5]}`,
  borderRadius: tokens.radius.md,
  fontSize: tokens.typography.fontSize.xs,
  fontWeight: 600,
  lineHeight: 1.4,
}

// "also on" text style
export const ALSO_ON_STYLE: React.CSSProperties = {
  fontSize: tokens.typography.fontSize.xs,
  color: TRADER_TEXT_TERTIARY,
  lineHeight: 1.2,
}

// Tabular-nums text style for stat columns (followers, trades count)
export const STAT_TEXT_TERTIARY_STYLE: React.CSSProperties = {
  color: TRADER_TEXT_TERTIARY,
  lineHeight: 1.2,
  fontSize: tokens.typography.fontSize.sm,
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.75,
}

// MDD text base style (opacity merged at render time)
export const MDD_TEXT_BASE_STYLE: React.CSSProperties = {
  color: TRADER_ACCENT_ERROR,
  lineHeight: 1.2,
  fontSize: tokens.typography.fontSize.sm,
  fontVariantNumeric: 'tabular-nums',
}

// AnimatedROI base style (color merged at render time)
export const ROI_TEXT_BASE_STYLE: React.CSSProperties = {
  lineHeight: 1.2,
  fontSize: tokens.typography.fontSize.lg,
  letterSpacing: '-0.02em',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum" 1',
}

// Expand button style
// 24×36 target: still meets WCAG 2.2 AA (24×24). Width trimmed from 36 so it
// sits inside the row's 20px right padding — flush right, the 10px chevron
// (x 7–17px from the edge) no longer overlaps the right-aligned last value
// (e.g. MDD "%"), which it did at 36px/right:2.
export const EXPAND_BTN_STYLE: React.CSSProperties = {
  position: 'absolute',
  right: 0,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 24,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  opacity: 0.6,
  transition: 'opacity 0.15s',
  borderRadius: tokens.radius.sm,
}

// Expand chevron styles
export const CHEVRON_EXPANDED_STYLE: React.CSSProperties = {
  transform: 'rotate(180deg)',
  transition: 'transform 0.2s',
}
export const CHEVRON_COLLAPSED_STYLE: React.CSSProperties = {
  transform: 'rotate(0deg)',
  transition: 'transform 0.2s',
}

// Swipe action button styles
export const SWIPE_COMPARE_BTN_STYLE: React.CSSProperties = {
  background: tokens.colors.accent.primary,
}
export const SWIPE_SHARE_BTN_STYLE: React.CSSProperties = { background: tokens.colors.accent.brand }

// Link base style
export const LINK_BASE_STYLE: React.CSSProperties = { textDecoration: 'none', display: 'block' }

// Swipe constants
export const SWIPE_THRESHOLD = 50
export const ACTION_WIDTH = 140
