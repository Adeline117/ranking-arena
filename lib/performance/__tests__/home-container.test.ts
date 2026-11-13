import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type AtRule } from 'postcss'
import { tokens } from '@/lib/design-tokens'
import { criticalCss, containerCss } from '../critical-css'

const globalsCss = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')
const compact = (css: string) => css.replace(/\s+/g, '')

describe('homepage single outer container (owner decision 2026-11-13)', () => {
  const { container, gutter, breakpoint } = tokens.layout

  it('generates the container custom properties from tokens.layout', () => {
    const css = compact(containerCss)
    expect(css).toContain(`--container-content:${container.content}px`)
    expect(css).toContain(`--container-wide:${container.wide}px`)
    expect(css).toContain(`--container-max:${container.max}px`)
    expect(css).toContain(`--container-gutter:${gutter.mobile}px`)
    expect(css).toContain(
      `@media(min-width:${tokens.breakpoint.md}){:root{--container-gutter:${gutter.tablet}px}}`
    )
    expect(css).toContain(
      `@media(min-width:${tokens.breakpoint.lg}){:root{--container-gutter:${gutter.desktop}px}}`
    )
    expect(css).toContain(
      `@media(min-width:${breakpoint.wide}px){:root{--home-container:var(--container-max)}}`
    )
    expect(compact(criticalCss)).toContain(css)
  })

  it('puts nav, hero, source strip and three-column grid on the same container', () => {
    const css = compact(containerCss)
    // One width + one gutter for every homepage band.
    expect(css).toContain(
      '.home-container{width:100%;max-width:var(--home-container);margin-left:auto;margin-right:auto;padding-left:var(--container-gutter);padding-right:var(--container-gutter)}'
    )
    // The nested grid must not add its own inset on top of the container.
    expect(css).toContain(
      '.home-container.three-col-layout{max-width:none;padding-left:0;padding-right:0}'
    )
    expect(css).toContain(
      '.top-nav-inner.top-nav-inner--home{max-width:var(--home-container);padding-left:var(--container-gutter);padding-right:var(--container-gutter)}'
    )
    // The 1440px protected geometry: (1440 - wide) / 2 + desktop gutter = 52.
    expect((1440 - container.wide) / 2 + gutter.desktop).toBe(52)
  })

  it('no longer sizes .home-page-container separately in globals.css', () => {
    const root = postcss.parse(globalsCss)
    root.walkRules((rule) => {
      if (rule.selector.trim() !== '.home-page-container') return
      rule.walkDecls((decl) => {
        expect(['max-width', 'padding', 'padding-left', 'padding-right']).not.toContain(decl.prop)
      })
    })
  })

  it.each([
    ['critical CSS', criticalCss],
    ['globals.css', globalsCss],
  ])('three-column breakpoints in %s only use the token tiers', (_name, css) => {
    const allowedMin = new Set([
      Number.parseInt(tokens.breakpoint.lg, 10),
      breakpoint.compact,
      breakpoint.wide,
    ])
    const allowedMax = new Set([
      Number.parseInt(tokens.breakpoint.lg, 10) - 1,
      breakpoint.compact - 1,
      breakpoint.baseline - 1,
      Number.parseInt(tokens.breakpoint.md, 10),
      Number.parseInt(tokens.breakpoint.md, 10) - 1,
      480,
    ])
    const root = postcss.parse(css)
    root.walkAtRules('media', (atRule: AtRule) => {
      let touchesThreeCol = false
      atRule.walkRules((rule) => {
        if (rule.selector.includes('.three-col-layout')) touchesThreeCol = true
      })
      if (!touchesThreeCol) return
      for (const [, kind, value] of atRule.params.matchAll(/(min|max)-width:\s*(\d+)px/g)) {
        const px = Number(value)
        if (kind === 'min') expect(allowedMin).toContain(px)
        else expect(allowedMax).toContain(px)
      }
    })
  })
})
