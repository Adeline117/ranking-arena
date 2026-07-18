import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import postcss, { type AtRule, type Root, type Rule } from 'postcss'
import { criticalCss } from '@/lib/performance/critical-css'
import ThreeColumnLayout from '../ThreeColumnLayout'

jest.mock('../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

const globalStylesheet = postcss.parse(readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8'))
const criticalStylesheet = postcss.parse(criticalCss)

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function findBaseRule(selector: string) {
  return globalStylesheet.nodes.find(
    (node): node is Rule =>
      node.type === 'rule' && normalized(node.selector) === normalized(selector)
  )
}

function findMediaRule(media: RegExp, selector: string) {
  let match: Rule | undefined

  globalStylesheet.walkAtRules('media', (atRule: AtRule) => {
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

function splitCssTokens(value: string) {
  let depth = 0
  let current = ''
  const tokens: string[] = []

  for (const character of value.trim()) {
    if (/\s/.test(character) && depth === 0) {
      if (current) tokens.push(current)
      current = ''
      continue
    }

    current += character
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
  }

  if (current) tokens.push(current)
  return tokens
}

function gridTrackCount(value: string | undefined) {
  return value ? splitCssTokens(value).length : 0
}

function mediaQueryMatchesWidth(params: string, width: number) {
  return params.split(',').some((rawQuery) => {
    const query = normalized(rawQuery).toLowerCase()
    if (/\bprint\b/.test(query)) return false

    const constraints = Array.from(
      query.matchAll(/\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g)
    )

    return constraints.every(([, boundary, rawValue]) => {
      const value = Number(rawValue)
      return boundary === 'min' ? width >= value : width <= value
    })
  })
}

function ruleMatchesWidth(rule: Rule, width: number) {
  let parent = rule.parent

  while (parent) {
    if (
      parent.type === 'atrule' &&
      parent.name === 'media' &&
      !mediaQueryMatchesWidth(parent.params, width)
    ) {
      return false
    }
    parent = parent.parent
  }

  return true
}

function horizontalPadding(tokens: string[]) {
  if (tokens.length === 1) return { left: tokens[0], right: tokens[0] }
  if (tokens.length === 2 || tokens.length === 3) {
    return { left: tokens[1], right: tokens[1] }
  }
  return { left: tokens[3], right: tokens[1] }
}

function resolveThreeColumnGeometry(stylesheet: Root, width: number) {
  const resolved: {
    display?: string
    columns?: string
    columnGap?: string
    paddingLeft?: string
    paddingRight?: string
  } = {}

  stylesheet.walkRules((rule) => {
    if (normalized(rule.selector) !== '.three-col-layout' || !ruleMatchesWidth(rule, width)) {
      return
    }

    rule.nodes.forEach((node) => {
      if (node.type !== 'decl') return

      if (node.prop === 'display') resolved.display = normalized(node.value)
      if (node.prop === 'grid-template-columns') resolved.columns = normalized(node.value)
      if (node.prop === 'column-gap') resolved.columnGap = normalized(node.value)
      if (node.prop === 'gap') {
        const gap = splitCssTokens(node.value)
        resolved.columnGap = normalized(gap[1] ?? gap[0])
      }
      if (node.prop === 'padding') {
        const padding = horizontalPadding(splitCssTokens(node.value))
        resolved.paddingLeft = normalized(padding.left)
        resolved.paddingRight = normalized(padding.right)
      }
      if (node.prop === 'padding-left') resolved.paddingLeft = normalized(node.value)
      if (node.prop === 'padding-right') resolved.paddingRight = normalized(node.value)
    })
  })

  return resolved
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

  it.each([
    ['first-paint critical CSS', criticalStylesheet],
    ['hydrated globals.css', globalStylesheet],
  ])('keeps the exact 1440px homepage geometry in %s', (_name, stylesheet) => {
    // Resolve only rules that apply at exactly 1440px. This deliberately
    // ignores the legitimate two-column 1024–1279px and wider >1440px
    // contracts while catching a 1280–1440px override of this selector.
    expect(resolveThreeColumnGeometry(stylesheet, 1440)).toEqual({
      display: 'grid',
      columns: '240px 1fr 260px',
      columnGap: '20px',
      paddingLeft: '16px',
      paddingRight: '16px',
    })
  })
})
