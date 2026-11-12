import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// On phones the avatar sits left of the name (row layout), so the name block
// must be left-aligned; centering it detached the name and badges from the
// avatar (seen at 390px in the hermetic UI sweep, 2026-11-11).
describe('trader header mobile alignment', () => {
  const css = readFileSync(join(process.cwd(), 'public/styles/responsive.css'), 'utf8')
  const mobile = css.slice(css.indexOf('交易员页面移动端 Header 按钮'))
  const block = (selector: string) => {
    const start = mobile.indexOf(`  ${selector} {`)
    return mobile.slice(start, mobile.indexOf('}', start))
  }

  it('left-aligns the row-layout name block', () => {
    expect(block('.profile-header-info')).toContain('flex-direction: row')
    expect(block('.profile-header-info')).toContain('text-align: left')
  })

  it('starts the badge row at the name, not the centre', () => {
    expect(block('.trader-name-badges-row')).toContain('justify-content: flex-start')
    expect(block('.trader-name-badges-row')).not.toContain('center')
  })
})
