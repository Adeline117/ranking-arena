/**
 * Module-level style constants for TraderRow and its sub-components.
 * Extracted to avoid allocating new objects on every render
 * (defeats React.memo; ~750-1000 throwaway objects per 50-row render pass -> ~0).
 */
import { tokens } from '@/lib/design-tokens'
import { TRADER_TEXT_TERTIARY, TRADER_ACCENT_ERROR } from './shared/TraderDisplay'

// Hero row gradient styles (top 3)
export const HERO_STYLE_RANK_1: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(255,215,0,0.13) 0%, rgba(255,215,0,0.04) 40%, transparent 80%)',
  boxShadow: 'inset 3px 0 0 var(--color-rank-gold), 0 2px 20px rgba(255,215,0,0.08)',
  borderRadius: 12,
  margin: '4px',
}
export const HERO_STYLE_RANK_2: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(192,192,192,0.10) 0%, rgba(192,192,192,0.03) 40%, transparent 80%)',
  boxShadow: 'inset 3px 0 0 var(--color-rank-silver), 0 2px 16px rgba(192,192,192,0.06)',
  borderRadius: 12,
  margin: '4px',
}
export const HERO_STYLE_RANK_3: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(205,127,50,0.10) 0%, rgba(205,127,50,0.03) 40%, transparent 80%)',
  boxShadow: 'inset 3px 0 0 var(--color-rank-bronze), 0 2px 16px rgba(205,127,50,0.06)',
  borderRadius: 12,
  margin: '4px',
}

// Lazy-loading placeholder styles
export const LAZY_LOADING_STYLE: React.CSSProperties = { padding: 16, textAlign: 'center', opacity: 0.5 }
export const LAZY_ICON_STYLE: React.CSSProperties = { width: 14, height: 14, display: 'inline-block' }

// Core layout styles
export const NA_STYLE: React.CSSProperties = { fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, opacity: 0.4, letterSpacing: 1, cursor: 'help' }
export const NA_DASH_STYLE: React.CSSProperties = { fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, opacity: 0.4 }
export const ROW_BASE_STYLE: React.CSSProperties = { display: 'grid', alignItems: 'center', gap: tokens.spacing[3], padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`, cursor: 'pointer', position: 'relative' as const }
export const TRADER_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }
export const SCORE_CELL_STYLE: React.CSSProperties = { textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }
export const ROI_CELL_STYLE: React.CSSProperties = { textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }
export const PNL_CELL_STYLE: React.CSSProperties = { textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }
export const RIGHT_CELL_STYLE: React.CSSProperties = { textAlign: 'right', alignItems: 'center', justifyContent: 'flex-end' }

// Trader info sub-layout styles
export const NAME_COLUMN_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }
export const NAME_ROW_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
export const TAGS_ROW_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }

// Mobile score badge styles
export const MOBILE_BADGE_STYLE: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }
export const MOBILE_BADGE_TEXT_STYLE: React.CSSProperties = { fontSize: tokens.typography.fontSize.xs, fontWeight: 700, color: TRADER_TEXT_TERTIARY }

// Verified badge style
export const VERIFIED_BADGE_STYLE: React.CSSProperties = {
  padding: '1px 6px',
  borderRadius: tokens.radius.md,
  fontSize: 12,
  fontWeight: 600,
  color: '#22d3ee',
  background: 'rgba(34, 211, 238, 0.12)',
  border: '1px solid rgba(34, 211, 238, 0.25)',
  lineHeight: 1.4,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
}

// Bot badge style
export const BOT_BADGE_STYLE: React.CSSProperties = {
  padding: '1px 6px',
  borderRadius: tokens.radius.md,
  fontSize: 12,
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
  padding: '1px 6px',
  borderRadius: tokens.radius.md,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.4,
}

// "also on" text style
export const ALSO_ON_STYLE: React.CSSProperties = { fontSize: tokens.typography.fontSize.xs, color: TRADER_TEXT_TERTIARY, lineHeight: 1.2 }

// Tabular-nums text style for stat columns (followers, trades count)
export const STAT_TEXT_TERTIARY_STYLE: React.CSSProperties = { color: TRADER_TEXT_TERTIARY, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }

// MDD text base style (opacity merged at render time)
export const MDD_TEXT_BASE_STYLE: React.CSSProperties = { color: TRADER_ACCENT_ERROR, lineHeight: 1.2, fontSize: tokens.typography.fontSize.sm, fontVariantNumeric: 'tabular-nums' }

// AnimatedROI base style (color merged at render time)
export const ROI_TEXT_BASE_STYLE: React.CSSProperties = { lineHeight: 1.2, fontSize: '16px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' }

// Expand button style
// 36x36 touch target: meets WCAG 2.2 AA (24×24) comfortably while staying
// small enough to fit between the right-edge of the row and the sort chevron
// area. Was 28×28 — too small for thumbs in the dense ranking list.
export const EXPAND_BTN_STYLE: React.CSSProperties = {
  position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
  width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', opacity: 0.6, transition: 'opacity 0.15s',
  borderRadius: tokens.radius.sm,
}

// Expand chevron styles
export const CHEVRON_EXPANDED_STYLE: React.CSSProperties = { transform: 'rotate(180deg)', transition: 'transform 0.2s' }
export const CHEVRON_COLLAPSED_STYLE: React.CSSProperties = { transform: 'rotate(0deg)', transition: 'transform 0.2s' }

// Swipe action button styles
export const SWIPE_COMPARE_BTN_STYLE: React.CSSProperties = { background: tokens.colors.accent.primary }
export const SWIPE_SHARE_BTN_STYLE: React.CSSProperties = { background: tokens.colors.accent.brand }

// Link base style
export const LINK_BASE_STYLE: React.CSSProperties = { textDecoration: 'none', display: 'block' }

// Swipe constants
export const SWIPE_THRESHOLD = 50
export const ACTION_WIDTH = 140
