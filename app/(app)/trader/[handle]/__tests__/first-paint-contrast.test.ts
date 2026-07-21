import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Declaration, type Rule } from 'postcss'

describe('trader first-paint contrast contract', () => {
  it('keeps text-bearing glass cards fully opaque during mount animations', () => {
    const stylesheet = postcss.parse(readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8'))
    const rule = stylesheet.nodes.find(
      (node): node is Rule =>
        node.type === 'rule' && node.selector === '.trader-page-container .glass-card'
    )
    const opacity = rule?.nodes.find(
      (node): node is Declaration => node.type === 'decl' && node.prop === 'opacity'
    )

    expect(opacity?.value).toBe('1')
    expect(opacity?.important).toBe(true)
  })
})
