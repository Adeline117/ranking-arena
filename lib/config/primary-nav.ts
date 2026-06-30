/**
 * Canonical primary navigation destinations — single source of truth.
 *
 * All three nav surfaces (top `NavLinks`, `MobileBottomNav`, feed
 * `DesktopSidebar`) derive their primary items from this list so the core
 * destinations + labels stay consistent. Each surface may append
 * surface-specific extras (e.g. "Me" on mobile / sidebar) and renders its own
 * sized SVG via the stable `icon` kind — only paths + label keys are shared.
 *
 * Decision: "/" is canonically **Rankings** (the homepage IS the leaderboard,
 * per the active-path logic `pathname === '/' || startsWith('/rankings')`), NOT
 * "Home". This reconciles the previous "/" = "Rankings" vs "Home" split.
 */

export type PrimaryNavIconKind = 'rankings' | 'market' | 'groups' | 'hot'

export interface PrimaryNavItem {
  href: string
  /** i18n key resolved via t() at the call site (exists in all 4 locales). */
  labelKey: string
  icon: PrimaryNavIconKind
}

export const PRIMARY_NAV_ITEMS: readonly PrimaryNavItem[] = [
  { href: '/', labelKey: 'rankings', icon: 'rankings' },
  { href: '/market', labelKey: 'market', icon: 'market' },
  { href: '/groups', labelKey: 'groups', icon: 'groups' },
  { href: '/hot', labelKey: 'hot', icon: 'hot' },
] as const
