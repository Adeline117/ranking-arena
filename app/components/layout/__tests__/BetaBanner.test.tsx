import { renderToStaticMarkup } from 'react-dom/server'
import BetaBanner from '../BetaBanner'

jest.mock('@/lib/types/premium', () => ({ PRO_FREE_PROMO: false }))

describe('BetaBanner', () => {
  test('pre-paint script does not mutate React-owned banner styles', () => {
    const markup = renderToStaticMarkup(<BetaBanner />)

    expect(markup).toContain('data-beta-lang="en"')
    expect(markup).toContain('data-beta-lang="zh"')
    expect(markup).toContain('data-beta-banner-hidden')
    expect(markup).not.toContain('style.display')
    expect(markup).not.toContain('querySelectorAll')
  })
})
