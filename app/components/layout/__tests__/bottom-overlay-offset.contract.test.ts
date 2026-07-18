import { readFileSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const css = readFileSync(join(root, 'app/globals.css'), 'utf8')
const cookie = readFileSync(join(root, 'app/components/ui/CookieConsent.tsx'), 'utf8')
const fab = readFileSync(join(root, 'app/components/layout/FloatingActionButton.tsx'), 'utf8')

describe('bottom overlay offset contract', () => {
  it('exposes one measured offset with a compatibility alias', () => {
    expect(css).toContain('--transient-bottom-offset: 0px')
    expect(css).toContain('--transient-bottom-bar: var(--transient-bottom-offset)')
    expect(cookie).toContain("root.style.setProperty('--transient-bottom-offset', `${height}px`)")
    expect(cookie).toContain("root.classList.add('has-cookie-consent')")
  })

  it('keeps every cookie action at least 44px and lifts the create FAB', () => {
    expect(css).toMatch(/\.cookie-consent-action\s*\{[\s\S]*?min-height:\s*44px/)
    expect(fab).toContain('var(--transient-bottom-offset, 0px)')
  })
})
