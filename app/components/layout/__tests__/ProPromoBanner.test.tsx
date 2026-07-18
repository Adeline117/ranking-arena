import { renderToStaticMarkup } from 'react-dom/server'
import ProPromoBanner from '../ProPromoBanner'

jest.mock('@/lib/types/premium', () => ({ PRO_FREE_PROMO: true }))

describe('ProPromoBanner', () => {
  test('renders its localized document-flow slot before hydration', () => {
    const markup = renderToStaticMarkup(<ProPromoBanner />)

    expect(markup).toContain('id="pro-promo-banner"')
    expect(markup).toContain('data-pro-promo-lang="en"')
    expect(markup).toContain('data-pro-promo-lang="zh"')
    expect(markup).toContain('class="pro-promo-full"')
    expect(markup).toContain('class="pro-promo-short"')
    expect(markup).toContain('Pro is free during beta')
    expect(markup).toContain('Beta 期间 Pro 功能免费')
    expect(markup).toContain('data-pro-promo-hidden')
    expect(markup).not.toContain('style.display')
    expect(markup).not.toContain('querySelectorAll')
  })
})
