import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Declaration, type Rule } from 'postcss'

function declaration(rule: Rule | undefined, property: string): Declaration | undefined {
  return rule?.nodes.find(
    (node): node is Declaration => node.type === 'decl' && node.prop === property
  )
}

describe('trader mobile sticky header contract', () => {
  it('offsets sticky tabs only while the fixed mini header is visible', () => {
    const client = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )
    const stylesheet = postcss.parse(
      readFileSync(join(process.cwd(), 'public/styles/responsive.css'), 'utf8')
    )
    let visibleTabsRule: Rule | undefined
    let obsoleteSiblingRule: Rule | undefined

    stylesheet.walkRules((rule) => {
      if (rule.selector === '.page-container.trader-mini-header-visible .profile-tabs') {
        visibleTabsRule = rule
      }
      if (rule.selector === '.trader-sticky-mini-header.visible ~ .page-container .profile-tabs') {
        obsoleteSiblingRule = rule
      }
    })

    expect(client).toMatch(
      /className=\{`page-container\$\{showMiniHeader \? ' trader-mini-header-visible' : ''\}`\}/
    )
    expect(declaration(visibleTabsRule, 'top')?.value).toBe('45px')
    expect(obsoleteSiblingRule).toBeUndefined()
  })

  it('removes the translated-offscreen mini header from assistive technology', () => {
    const client = readFileSync(
      join(process.cwd(), 'app/(app)/trader/[handle]/TraderProfileClient.tsx'),
      'utf8'
    )

    expect(client).toContain('aria-hidden={!showMiniHeader}')
    expect(client).toContain('inert={!showMiniHeader}')
  })
})
