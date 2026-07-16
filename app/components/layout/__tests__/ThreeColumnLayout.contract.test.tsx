import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import postcss, { type AtRule, type Rule } from 'postcss'
import ThreeColumnLayout from '../ThreeColumnLayout'

jest.mock('../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

const stylesheet = postcss.parse(readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8'))

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function findBaseRule(selector: string) {
  return stylesheet.nodes.find(
    (node): node is Rule =>
      node.type === 'rule' && normalized(node.selector) === normalized(selector)
  )
}

function findMediaRule(media: RegExp, selector: string) {
  let match: Rule | undefined

  stylesheet.walkAtRules('media', (atRule: AtRule) => {
    if (!media.test(normalized(atRule.params))) return

    atRule.walkRules((rule) => {
      if (normalized(rule.selector) === normalized(selector)) match = rule
    })
  })

  return match
}

function declaration(rule: Rule | undefined, property: string) {
  return rule?.nodes.find((node) => node.type === 'decl' && node.prop === property)?.value
}

function gridTrackCount(value: string | undefined) {
  if (!value) return 0

  let depth = 0
  let current = ''
  const tracks: string[] = []

  for (const character of value.trim()) {
    if (/\s/.test(character) && depth === 0) {
      if (current) tracks.push(current)
      current = ''
      continue
    }

    current += character
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
  }

  if (current) tracks.push(current)
  return tracks.length
}

describe('ThreeColumnLayout protected structure', () => {
  it('keeps the direct desktop regions in left, center, right DOM order', () => {
    const { container } = render(
      <ThreeColumnLayout
        leftSidebar={<div>Discovery</div>}
        rightSidebar={<div>Market context</div>}
      >
        <div>Rankings</div>
      </ThreeColumnLayout>
    )

    const layout = container.querySelector('.three-col-layout')
    expect(layout).not.toBeNull()

    const regions = Array.from(layout?.children ?? []).filter((element) =>
      ['three-col-left', 'three-col-center', 'three-col-right'].some((className) =>
        element.classList.contains(className)
      )
    )

    expect(
      regions.map((element) =>
        ['three-col-left', 'three-col-center', 'three-col-right'].find((className) =>
          element.classList.contains(className)
        )
      )
    ).toEqual(['three-col-left', 'three-col-center', 'three-col-right'])
  })

  it('keeps the responsive column-count breakpoints without pinning column widths', () => {
    const baseLayout = findBaseRule('.three-col-layout')
    const compactDesktopLayout = findMediaRule(
      /min-width:\s*1024px.*max-width:\s*1279px/,
      '.three-col-layout'
    )
    const compactDesktopRight = findMediaRule(
      /min-width:\s*1024px.*max-width:\s*1279px/,
      '.three-col-right'
    )
    const mobileLayout = findMediaRule(/max-width:\s*1023px/, '.three-col-layout')
    const mobileSidebars = findMediaRule(/max-width:\s*1023px/, '.three-col-left, .three-col-right')

    expect(declaration(baseLayout, 'display')).toBe('grid')
    expect(gridTrackCount(declaration(baseLayout, 'grid-template-columns'))).toBe(3)
    expect(gridTrackCount(declaration(compactDesktopLayout, 'grid-template-columns'))).toBe(2)
    expect(declaration(compactDesktopRight, 'display')).toBe('none')
    expect(declaration(mobileLayout, 'display')).toBe('block')
    expect(declaration(mobileSidebars, 'display')).toBe('none')
  })
})
