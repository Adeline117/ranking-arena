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
