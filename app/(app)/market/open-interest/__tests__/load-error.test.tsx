import type { ReactElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

const mockRefresh = jest.fn()
const mockRpc = jest.fn()
const mockLimit = jest.fn()
const mockOrder = jest.fn(() => ({ limit: mockLimit }))
const mockSelect = jest.fn(() => ({ order: mockOrder }))
const mockFrom = jest.fn(() => ({ select: mockSelect }))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          all: 'All',
          failedToLoad: 'Failed to load',
          marketDataPending: 'Market data is pending',
          noOpenInterestData: 'No open interest data',
          retry: 'Retry',
          tryAgain: 'Please try again',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <div>{title}</div>,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({
    title,
    description,
    retry,
  }: {
    title: string
    description: string
    retry: () => void
  }) => (
    <div role="alert">
      <span>{title}</span>
      <span>{description}</span>
      <button onClick={retry}>Retry</button>
    </div>
  ),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import OpenInterestPage from '../page'

type PageElementProps = {
  rows: unknown[]
  loadError: boolean
}

describe('OpenInterestPage load state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('passes a retryable error to the client when RPC and fallback both fail', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } })
    mockLimit.mockResolvedValue({ data: null, error: { message: 'DB unavailable' } })

    const element = (await OpenInterestPage()) as ReactElement<PageElementProps>
    expect(element.props).toMatchObject({ rows: [], loadError: true })

    render(element)

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load')
    expect(screen.queryByText('No open interest data')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful empty response as a genuine empty state', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })

    const element = (await OpenInterestPage()) as ReactElement<PageElementProps>
    expect(element.props).toMatchObject({ rows: [], loadError: false })

    render(element)

    expect(screen.getByText('No open interest data')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
