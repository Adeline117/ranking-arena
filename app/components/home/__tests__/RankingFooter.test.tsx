import { render, screen } from '@testing-library/react'
import RankingFooter from '../RankingFooter'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en' }),
}))

const commonProps = {
  loading: false,
  lastUpdated: '2020-01-01T00:00:00.000Z',
  formatLastUpdated: (value: string | null | undefined) => value ?? null,
  t: (key: string) => key,
}

describe('RankingFooter source freshness', () => {
  it('does not reclassify an old timestamp when the server says sources are fresh', () => {
    render(<RankingFooter {...commonProps} isStale={false} />)

    expect(screen.queryByText('dataStaleWarning')).not.toBeInTheDocument()
  })

  it('shows the warning from the authoritative server flag even for a recent timestamp', () => {
    render(<RankingFooter {...commonProps} lastUpdated={new Date().toISOString()} isStale />)

    expect(screen.getByText('dataStaleWarning')).toBeInTheDocument()
  })

  it('renders a machine-readable "Data as of" source time after hydration', () => {
    const watermark = new Date().toISOString()
    render(<RankingFooter {...commonProps} lastUpdated={watermark} isStale={false} />)

    const time = screen.getByText(/^rankingControlsDataAsOf /)
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('datetime', watermark)
  })

  it('omits the source time when the watermark is not a valid timestamp', () => {
    render(<RankingFooter {...commonProps} lastUpdated="not-a-time" isStale={false} />)

    expect(screen.queryByText(/^rankingControlsDataAsOf /)).not.toBeInTheDocument()
  })
})
