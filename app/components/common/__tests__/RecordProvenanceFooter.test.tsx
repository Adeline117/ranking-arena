import { render, screen } from '@testing-library/react'
import RecordProvenanceFooter from '../RecordProvenanceFooter'
import type { RecordProvenance } from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/lib/utils/date', () => ({
  formatTimeAgo: (timestamp: string) => `ago:${timestamp}`,
}))

function provenance(overrides: Partial<RecordProvenance> = {}): RecordProvenance {
  return {
    source: 'gmx',
    sourceAsOf: null,
    observedAt: null,
    publishedAt: null,
    ...overrides,
  }
}

describe('RecordProvenanceFooter', () => {
  it('labels missing source and observation clocks as unknown', () => {
    const { container } = render(
      <RecordProvenanceFooter provenance={provenance()} exchangeName="GMX" />
    )

    const footer = screen.getByText(/provenanceSource: GMX/)
    expect(footer).toHaveTextContent('recordProvenanceSourceAsOf recordProvenanceUnknown')
    expect(footer).toHaveTextContent('recordProvenanceObservedAt recordProvenanceUnknown')
    expect(container.querySelector('time')).not.toBeInTheDocument()
  })

  it('keeps source freshness unknown when only an observation clock exists', () => {
    const observedAt = '2026-07-29T12:00:00.000Z'
    render(<RecordProvenanceFooter provenance={provenance({ observedAt })} />)

    const footer = screen.getByText(/recordProvenanceSourceAsOf/)
    expect(footer).toHaveTextContent('recordProvenanceSourceAsOf recordProvenanceUnknown')
    expect(footer).toHaveTextContent('recordProvenanceObservedAt')
    expect(screen.getByText(`ago:${observedAt}`)).toHaveAttribute('dateTime', observedAt)
  })

  it('shows distinct source and capture clocks without treating publication as freshness', () => {
    const sourceAsOf = '2026-07-29T11:00:00.000Z'
    const observedAt = '2026-07-29T12:00:00.000Z'
    render(
      <RecordProvenanceFooter
        provenance={provenance({
          sourceAsOf,
          observedAt,
          publishedAt: '2026-07-29T12:01:00.000Z',
        })}
      />
    )

    expect(screen.getByText(/recordProvenanceSourceAsOf/)).toHaveTextContent(
      'recordProvenanceObservedAt'
    )
    expect(document.querySelectorAll('time')).toHaveLength(2)
    expect(screen.queryByText(/12:01:00/)).not.toBeInTheDocument()
  })

  it('keeps equal-valued source and capture clocks semantically distinct', () => {
    const timestamp = '2026-07-29T12:00:00.000Z'
    render(
      <RecordProvenanceFooter
        provenance={provenance({ sourceAsOf: timestamp, observedAt: timestamp })}
      />
    )

    expect(screen.getAllByText(`ago:${timestamp}`)).toHaveLength(2)
  })

  it('does not promote a publication-only clock to data freshness', () => {
    const { container } = render(
      <RecordProvenanceFooter
        provenance={provenance({ publishedAt: '2026-07-29T12:01:00.000Z' })}
      />
    )

    const footer = screen.getByText(/recordProvenanceSourceAsOf/)
    expect(footer.textContent?.match(/recordProvenanceUnknown/g)).toHaveLength(2)
    expect(container.querySelector('time')).not.toBeInTheDocument()
  })

  it('flags a source clock older than 48 hours as possibly delayed', () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00.000Z') })
    try {
      render(
        <RecordProvenanceFooter
          provenance={provenance({ sourceAsOf: '2026-08-01T00:00:00.000Z' })}
        />
      )
      expect(screen.getByTestId('record-provenance-stale')).toHaveTextContent('dataStaleWarning')
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not flag a fresh source clock and treats the epoch sentinel as unknown', () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00.000Z') })
    try {
      const { rerender, container } = render(
        <RecordProvenanceFooter
          provenance={provenance({ sourceAsOf: '2026-11-11T11:00:00.000Z' })}
        />
      )
      expect(screen.queryByTestId('record-provenance-stale')).not.toBeInTheDocument()

      rerender(
        <RecordProvenanceFooter
          provenance={provenance({ sourceAsOf: '1970-01-01T00:00:00.000Z' })}
        />
      )
      expect(container.querySelector('time')).not.toBeInTheDocument()
      expect(screen.getByText(/recordProvenanceSourceAsOf/)).toHaveTextContent(
        'recordProvenanceSourceAsOf recordProvenanceUnknown'
      )
    } finally {
      jest.useRealTimers()
    }
  })
})
