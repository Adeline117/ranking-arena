import { render, screen } from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/utils/api-fetch'
import GlobalMarketBar from '../GlobalMarketBar'

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
}))

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: jest.fn(),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          dataUnavailable: 'Unavailable',
          retry: 'Retry',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const mockedUseQuery = jest.mocked(useQuery)
const mockedApiFetch = jest.mocked(apiFetch)

describe('GlobalMarketBar V1 unavailable state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('preserves the bar shell with local unavailable copy and no acquisition controls', () => {
    const view = render(<GlobalMarketBar />)

    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(mockedUseQuery).not.toHaveBeenCalled()
    expect(mockedApiFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })
})
