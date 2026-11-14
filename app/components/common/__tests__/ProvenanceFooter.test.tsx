import { render, screen } from '@testing-library/react'
import ProvenanceFooter from '../ProvenanceFooter'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/lib/utils/date', () => ({
  formatTimeAgo: (timestamp: string) => `ago:${timestamp}`,
}))
jest.mock('../DerivedBoardBadge', () => ({
  __esModule: true,
  default: () => null,
}))

const NOW = Date.parse('2026-11-11T12:00:00.000Z')

describe('ProvenanceFooter data time', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }))
  afterEach(() => jest.useRealTimers())

  it('shows a fresh source time without a delay notice', () => {
    const asOf = '2026-11-11T10:00:00.000Z'
    render(<ProvenanceFooter provenance={{ source: 'okx', asOf }} exchangeName="OKX" />)
    expect(screen.getByText(`ago:${asOf}`)).toHaveAttribute('dateTime', asOf)
    expect(screen.queryByTestId('provenance-stale')).not.toBeInTheDocument()
  })

  it('flags a source time older than 48 hours as possibly delayed', () => {
    const asOf = '2026-08-20T00:00:00.000Z'
    render(<ProvenanceFooter provenance={{ source: 'okx', asOf }} exchangeName="OKX" />)
    expect(screen.getByText(`ago:${asOf}`)).toBeInTheDocument()
    expect(screen.getByTestId('provenance-stale')).toHaveTextContent('dataStaleWarning')
  })

  it.each(['1970-01-01T00:00:00.000Z', 'not-a-date', ''])(
    'renders the unknown sentinel %p as unknown, not as an age',
    (asOf) => {
      const { container } = render(
        <ProvenanceFooter provenance={{ source: 'okx', asOf }} exchangeName="OKX" />
      )
      expect(container.querySelector('time')).not.toBeInTheDocument()
      expect(screen.getByText(/provenanceAsOf/)).toHaveTextContent('provenanceAsOf unknown')
      expect(screen.queryByTestId('provenance-stale')).not.toBeInTheDocument()
    }
  )
})
