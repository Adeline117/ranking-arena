import { readFileSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const css = readFileSync(join(root, 'app/globals.css'), 'utf8')
const cookie = readFileSync(join(root, 'app/components/ui/CookieConsent.tsx'), 'utf8')
const fab = readFileSync(join(root, 'app/components/layout/FloatingActionButton.tsx'), 'utf8')
const feedback = readFileSync(join(root, 'app/components/common/FeedbackWidget.tsx'), 'utf8')
const scrollToTop = readFileSync(join(root, 'app/components/ui/ScrollToTop.tsx'), 'utf8')
const compare = readFileSync(join(root, 'app/components/trader/CompareFloatingBar.tsx'), 'utf8')
const mobileNav = readFileSync(join(root, 'app/components/layout/MobileBottomNav.tsx'), 'utf8')
const settings = readFileSync(join(root, 'app/(app)/settings/page.tsx'), 'utf8')

// Audited global fixed-bottom inventory. The nav is the viewport anchor and
// CookieConsent publishes the transient reservation; every overlay that can
// float above page content belongs in this consumer list.
const reservationConsumers = [
  ['FloatingActionButton', fab],
  ['FeedbackWidget', feedback],
  ['ScrollToTop', scrollToTop],
  ['CompareFloatingBar', compare],
] as const

describe('bottom overlay offset contract', () => {
  it('exposes one measured offset with a compatibility alias', () => {
    expect(css).toContain('--safe-area-inset-bottom: env(safe-area-inset-bottom, 0px)')
    expect(css).toContain('--transient-bottom-offset: 0px')
    expect(css).toContain('--page-bottom-overlay-offset: 0px')
    expect(css).toContain('--transient-bottom-bar: var(--transient-bottom-offset)')
    expect(cookie).toContain("root.style.setProperty('--transient-bottom-offset', `${height}px`)")
    expect(cookie).toContain("root.classList.add('has-cookie-consent')")
    expect(cookie).toMatch(
      /measured height[\s\S]*?useLayoutEffect\(\(\) => \{[\s\S]*?publishHeight\(\)/
    )
  })

  it('keeps every cookie action at least 44px', () => {
    expect(css).toMatch(/\.cookie-consent-action\s*\{[\s\S]*?min-height:\s*44px/)
  })

  it.each(reservationConsumers)(
    'keeps the global %s widget above transient and page-owned bottom overlays',
    (_name, source) => {
      expect(source).toContain("position: 'fixed'")
      expect(source).toContain('bottom:')
      expect(source).toMatch(/var\(--transient-bottom-(?:offset|bar), 0px\)/)
      expect(source).toContain('var(--page-bottom-overlay-offset, 0px)')
      expect(source).toContain('var(--safe-area-inset-bottom, 0px)')
    }
  )

  it('keeps fixed-bottom anchors and producers separate from reservation consumers', () => {
    expect(mobileNav).toContain("position: 'fixed'")
    expect(mobileNav).toContain('bottom: 0')
    expect(cookie).toContain("root.style.setProperty('--transient-bottom-offset', `${height}px`)")
  })

  it('routes every audited bottom-stack safe area through the overridable variables', () => {
    for (const source of [
      ...reservationConsumers.map(([, value]) => value),
      cookie,
      mobileNav,
      settings,
    ]) {
      expect(source).not.toMatch(/env\(safe-area-inset/)
    }
    expect(settings).toContain('var(--safe-area-inset-left, 0px)')
    expect(settings).toContain('var(--safe-area-inset-right, 0px)')
    expect(settings).toContain('var(--safe-area-inset-bottom, 0px)')
  })

  it('snaps CompareFloatingBar when a dynamic bottom reservation changes', () => {
    expect(compare).toContain('hasFab ? 208 : 128')
    expect(compare).toContain('isFloatingActionRoute(pathname)')
    expect(compare).toContain('100dvh')
    expect(compare).toContain("flex: '1 1 200px'")
    expect(compare).toContain('className="compare-floating-toggle"')
    expect(compare).toContain('transition: `width ${tokens.transition.slow}')
    expect(compare).not.toMatch(/transition:\s*`all\b/)
  })

  it('makes expanded bottom overlays non-overlapping on a short viewport', () => {
    expect(css).toContain('html.has-feedback-panel .compare-floating-bar')
    expect(css).toContain('html.has-feedback-panel .scroll-to-top-btn')
    expect(css).toContain('html.has-feedback-panel .fab-container')
    expect(feedback).toContain('className="feedback-panel"')
    expect(feedback).toContain('var(--safe-area-inset-bottom, 0px)')
    expect(feedback).toContain('var(--page-bottom-overlay-offset, 0px) + 16px')
    expect(fab).toContain("right: 'calc(100% + 12px)'")
  })
})
