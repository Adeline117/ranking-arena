import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockApiFetch = jest.fn()

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))
jest.mock('@/lib/i18n', () => ({ registerFullDict: jest.fn() }))
jest.mock('@/lib/i18n/en', () => ({ __esModule: true, default: {} }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))
jest.mock('@/app/components/base', () => ({
  Text: ({
    as: Tag = 'span',
    children,
    ...props
  }: React.ComponentProps<'span'> & { as?: string }) => <Tag {...props}>{children}</Tag>,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
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
      <button onClick={retry}>retry-error</button>
    </div>
  ),
}))
jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <div>{title}</div>,
}))
jest.mock('@/app/components/ui/Metric', () => ({
  __esModule: true,
  default: ({ display }: { display: string }) => <span>{display}</span>,
}))

import StatusPage from '../page'

function healthPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: 'healthy',
    timestamp: new Date(Date.now() - 1_000).toISOString(),
    version: '0.1.0',
    commit: 'abc123',
    uptime: 3600,
    responseTimeMs: 20,
    checks: {
      api: { status: 'pass', latency: 1, message: 'Responding' },
      database: { status: 'pass', latency: 10 },
      redis: { status: 'skip', message: 'Not configured' },
    },
    _detail: '/api/health/detailed',
    ...overrides,
  }
}

function platformPayload() {
  return {
    platforms: [
      {
        platform: 'binance_futures',
        status: 'healthy',
        last_success_at: new Date(Date.now() - 20_000).toISOString(),
        error_count: 0,
      },
    ],
    freshness: { binance_futures: new Date(Date.now() - 10_000).toISOString() },
  }
}

function installHealthyResponses() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url === '/api/health') return Promise.resolve(healthPayload())
    if (url === '/api/platforms/health') return Promise.resolve(platformPayload())
    throw new Error(`Unexpected URL: ${url}`)
  })
}

describe('StatusPage authority and loading states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installHealthyResponses()
  })

  it('renders a stable loading region, exact healthy state, and unknown skipped service', async () => {
    render(<StatusPage />)

    expect(screen.getByRole('status')).toHaveTextContent('checking')
    expect(screen.getByRole('button', { name: 'refresh' })).toHaveStyle({ minHeight: '44px' })

    await screen.findByText('statusAllOperational')
    expect(screen.getByLabelText('dataUnknown')).toBeInTheDocument()
    expect(screen.queryByText('statusServiceUnavailable')).not.toBeInTheDocument()
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ acceptedStatuses: [202, 503], timeoutMs: 15_000 })
    )
  })

  it('keeps last-good health but marks the page degraded when a refresh lane fails', async () => {
    render(<StatusPage />)
    await screen.findByText('statusAllOperational')

    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/health') return Promise.reject(new Error('offline'))
      if (url === '/api/platforms/health') return Promise.resolve(platformPayload())
      throw new Error(`Unexpected URL: ${url}`)
    })
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))

    await screen.findByText('statusServiceUnavailable')
    expect(screen.getByText('statusDegraded')).toBeInTheDocument()
    expect(screen.queryByText('statusAllOperational')).not.toBeInTheDocument()
    expect(screen.getByText('statusServices')).toBeInTheDocument()
  })

  it('fails closed on a malformed health payload instead of crashing or showing green', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/health') {
        return Promise.resolve(healthPayload({ checks: { api: { status: 'green' } } }))
      }
      if (url === '/api/platforms/health') return Promise.resolve(platformPayload())
      throw new Error(`Unexpected URL: ${url}`)
    })

    render(<StatusPage />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText('statusUnableToLoad')).toBeInTheDocument()
    expect(screen.getByText('statusServiceUnavailable')).toBeInTheDocument()
    expect(screen.queryByText('statusAllOperational')).not.toBeInTheDocument()
  })
})
