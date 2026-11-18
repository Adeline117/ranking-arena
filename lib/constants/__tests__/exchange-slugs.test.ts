import { TOP_EXCHANGE_SLUGS } from '../exchange-slugs'
import { resolveExchangeSlug } from '../exchanges'
import { isRetiredSource } from '../retired-sources'

describe('TOP_EXCHANGE_SLUGS', () => {
  it('never lists a retired source (its landing page is a 404)', () => {
    const retired = TOP_EXCHANGE_SLUGS.filter((slug) => isRetiredSource(resolveExchangeSlug(slug)))
    expect(retired).toEqual([])
  })

  it('uses the hyphenated canonical form', () => {
    for (const slug of TOP_EXCHANGE_SLUGS) expect(slug).not.toContain('_')
  })
})
