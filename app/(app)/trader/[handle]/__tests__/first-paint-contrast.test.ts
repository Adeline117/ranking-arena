import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Declaration, type Rule } from 'postcss'

describe('trader first-paint contrast contract', () => {
  it('keeps text-bearing surfaces fully opaque during mount animations', () => {
    const stylesheet = postcss.parse(readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8'))

    for (const selector of [
      '.trader-page-container .glass-card',
      '.trader-page-container .tab-pane-enter',
      '.trader-page-container .trader-data-disclaimer',
    ]) {
      const rule = stylesheet.nodes.find(
        (node): node is Rule => node.type === 'rule' && node.selector === selector
      )
      const opacity = rule?.nodes.find(
        (node): node is Declaration => node.type === 'decl' && node.prop === 'opacity'
      )

      expect(opacity?.value).toBe('1')
      expect(opacity?.important).toBe(true)
    }
  })
})
