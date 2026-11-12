import { act, render, screen } from '@testing-library/react'
import HomeHeroText from '../HomeHeroText'

// The homepage renders outside LanguageProvider, so HomeHeroText relies on the
// provider-less useLanguage fallback: English first (matching the static,
// ISR-cached server HTML), then the saved language once mounted.
describe('HomeHeroText', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('renders English when no language is saved', () => {
    render(<HomeHeroText k="heroHeadline" />)
    expect(screen.getByText("Track the World's Best Crypto Traders")).toBeInTheDocument()
  })

  it('switches a saved Chinese visitor from the English shell to Chinese after mount', async () => {
    window.localStorage.setItem('language', 'zh')
    await act(async () => {
      render(<HomeHeroText k="heroHeadline" />)
    })
    expect(await screen.findByText('追踪全球最优秀的加密交易员')).toBeInTheDocument()
    expect(screen.queryByText("Track the World's Best Crypto Traders")).not.toBeInTheDocument()
  })

  it('fills placeholders in every occurrence', async () => {
    window.localStorage.setItem('language', 'zh')
    await act(async () => {
      render(<HomeHeroText k="heroSubtitle" vars={{ boards: 28 }} />)
    })
    const subtitle = await screen.findByText(/汇总 28 个当前有排名数据的来源板/)
    expect(subtitle.textContent).not.toContain('{boards}')
  })

  it('switches the hero copy that was previously only in the async dictionary', async () => {
    window.localStorage.setItem('language', 'zh')
    let container: HTMLElement | undefined
    await act(async () => {
      ;({ container } = render(
        <>
          <HomeHeroText k="heroHowRanked" />
          <HomeHeroText k="heroNeutrality" />
          <HomeHeroText k="heroScoreExplainer" />
        </>
      ))
    })
    const text = container?.textContent ?? ''
    expect(text).toContain('排名是怎么算的 →')
    expect(text).toContain('任何来源都不能付费买排名')
    expect(text).toContain('Arena Score 按同一规则')
    expect(text).not.toMatch(/How ranking works|No source can pay/)
  })
})

describe('HomeHeroText dictionary coverage', () => {
  // The hero renders on the server with the full English dictionary but the
  // first client render only has en-core (full dictionaries load after the
  // hydration commit). A hero key missing from en-core renders differently on
  // each side and throws React #418 on `/`.
  it('keeps every hero key in the synchronous English core', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const ssr = readFileSync(join(process.cwd(), 'app/components/home/HomeHeroSSR.tsx'), 'utf8')
    const keys = new Set([
      ...[...ssr.matchAll(/HomeHeroText k="(\w+)"/g)].map((m) => m[1]),
      ...[...ssr.matchAll(/'(hero\w+)'/g)].map((m) => m[1]),
    ])
    const { default: enCore } = await import('@/lib/i18n/en-core')
    expect(keys.size).toBeGreaterThanOrEqual(10)
    for (const key of keys) expect(enCore).toHaveProperty(key)
  })
})
