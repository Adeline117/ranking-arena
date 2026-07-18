import { render, within } from '@testing-library/react'
import FundingRatesClient from '../funding-rates/FundingRatesClient'
import OpenInterestClient from '../open-interest/OpenInterestClient'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

describe('market subpage breadcrumb affordance', () => {
  it.each([
    ['funding rates', <FundingRatesClient rates={[]} />],
    ['open interest', <OpenInterestClient rows={[]} />],
  ])('renders the Market parent as a high-contrast underlined link on %s', (_name, page) => {
    const view = render(page)
    const link = within(view.container).getByRole('link', { name: 'market' })

    expect(link).toHaveAttribute('href', '/market')
    expect(link).toHaveStyle({
      color: 'var(--color-text-primary)',
      textDecoration: 'underline',
    })
  })
})
