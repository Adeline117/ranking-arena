import { renderToStaticMarkup } from 'react-dom/server'
import ProPromoBanner from '../ProPromoBanner'

jest.mock('@/lib/types/premium', () => ({ PRO_FREE_PROMO: true }))

describe('ProPromoBanner', () => {
  test('renders its localized document-flow slot before hydration', () => {
    const markup = renderToStaticMarkup(<ProPromoBanner />)

    expect(markup).toContain('id="pro-promo-banner"')
    expect(markup).toContain('data-pro-promo-lang="en"')
    expect(markup).toContain('data-pro-promo-lang="zh"')
    expect(markup).toContain('data-pro-promo-hidden')
    expect(markup).not.toContain('style.display')
    expect(markup).not.toContain('querySelectorAll')
  })
})
