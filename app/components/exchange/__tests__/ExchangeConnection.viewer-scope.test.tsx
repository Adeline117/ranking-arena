import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'

type MockAuthState = {
  userId: string | null
  accessToken: string | null
  loading: boolean
  authChecked: boolean
}

let mockAuthState: MockAuthState
const mockShowToast = jest.fn()
const mockShowConfirm = jest.fn()
const mockTranslate = (key: string) => key

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockTranslate }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showConfirm: mockShowConfirm }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf' }),
}))

jest.mock('@/app/(app)/exchange/auth/api-key/exchange-configs', () => ({
  EXCHANGE_BIND_LIST: [{ id: 'binance', name: 'Binance' }],
}))

jest.mock('../../ui/ExchangeLogo', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

jest.mock('@/lib/design-tokens', () => ({
  alpha: (value: string) => value,
  tokens: {
    spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px' },
    radius: { sm: '4px', md: '8px' },
    typography: { fontSize: { xs: '12px' } },
    colors: {
      bg: { primary: '#fff', tertiary: '#eee' },
      border: { primary: '#ddd' },
      text: { secondary: '#666' },
      accent: { error: '#f00', success: '#0a0' },
    },
  },
}))

import ExchangeConnectionManager from '../ExchangeConnection'

const originalFetch = global.fetch

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function accessTokenFor(viewerId: string) {
  const payload = Buffer.from(JSON.stringify({ sub: viewerId })).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
}

function connectionResponse(viewerId: string, marker: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        connections: [
          {
            id: `connection-${viewerId}`,
            user_id: viewerId,
            exchange: 'binance',
            is_active: true,
            last_sync_status: 'error',
            last_sync_error: marker,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    }),
  }
}

function successResponse() {
  return { ok: true, status: 200, json: async () => ({ success: true }) }
}

describe('ExchangeConnectionManager viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthState = {
      userId: 'viewer-a',
      accessToken: accessTokenFor('viewer-a'),
      loading: false,
      authChecked: true,
    }
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('never reads a second browser session and calls only the safe connection API', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/components/exchange/ExchangeConnection.tsx'),
      'utf8'
    )

    expect(source).toContain("from '@/lib/hooks/useAuthSession'")
    expect(source).not.toContain("from '@/lib/supabase/client'")
    expect(source).not.toContain('auth.getSession')
    expect(source).not.toContain('auth.getUser')
    expect(source).not.toContain("from('user_exchange_connections')")
  })

  it('hides A synchronously and discards A responses after switching to B', async () => {
    const viewerB = deferred<ReturnType<typeof connectionResponse>>()
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(connectionResponse('viewer-a', 'viewer-a-secret'))
      .mockReturnValueOnce(viewerB.promise)
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<ExchangeConnectionManager userId="viewer-a" />)
    expect(await screen.findByText(/viewer-a-secret/)).toBeInTheDocument()

    mockAuthState = {
      userId: 'viewer-b',
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
      authChecked: true,
    }
    rerender(<ExchangeConnectionManager userId="viewer-b" />)

    expect(screen.queryByText(/viewer-a-secret/)).not.toBeInTheDocument()
    expect(screen.getByText('loading')).toBeInTheDocument()

    await act(async () => {
      viewerB.resolve(connectionResponse('viewer-b', 'viewer-b-secret'))
      await viewerB.promise
    })
    expect(await screen.findByText(/viewer-b-secret/)).toBeInTheDocument()
  })

  it('rejects a late A load that resolves after B has already rendered', async () => {
    const viewerA = deferred<ReturnType<typeof connectionResponse>>()
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(viewerA.promise)
      .mockResolvedValueOnce(connectionResponse('viewer-b', 'viewer-b-secret'))
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<ExchangeConnectionManager userId="viewer-a" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    mockAuthState = {
      userId: 'viewer-b',
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
      authChecked: true,
    }
    rerender(<ExchangeConnectionManager userId="viewer-b" />)
    expect(await screen.findByText(/viewer-b-secret/)).toBeInTheDocument()

    await act(async () => {
      viewerA.resolve(connectionResponse('viewer-a', 'viewer-a-secret'))
      await viewerA.promise
    })
    expect(screen.queryByText(/viewer-a-secret/)).not.toBeInTheDocument()
    expect(screen.getByText(/viewer-b-secret/)).toBeInTheDocument()
  })

  it('does not disconnect A if the viewer changes while confirmation is open', async () => {
    const confirmation = deferred<boolean>()
    mockShowConfirm.mockReturnValue(confirmation.promise)
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      if (url === '/api/exchange/connections') {
        const authHeader = (options?.headers as Record<string, string>)?.Authorization
        const viewerId = authHeader?.includes(accessTokenFor('viewer-b')) ? 'viewer-b' : 'viewer-a'
        return Promise.resolve(connectionResponse(viewerId, `${viewerId}-secret`))
      }
      return Promise.resolve(successResponse())
    })
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<ExchangeConnectionManager userId="viewer-a" />)
    expect(await screen.findByText(/viewer-a-secret/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'disconnect' }))
    expect(mockShowConfirm).toHaveBeenCalledTimes(1)

    mockAuthState = {
      userId: 'viewer-b',
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
      authChecked: true,
    }
    rerender(<ExchangeConnectionManager userId="viewer-b" />)
    expect(await screen.findByText(/viewer-b-secret/)).toBeInTheDocument()

    await act(async () => {
      confirmation.resolve(true)
      await confirmation.promise
    })

    expect(
      fetchMock.mock.calls.some(
        ([url, options]) =>
          url === '/api/exchange/disconnect' &&
          (options as RequestInit | undefined)?.method === 'DELETE'
      )
    ).toBe(false)
  })

  it('keeps B syncing when A finishes late and reloads B with B token only', async () => {
    const syncA = deferred<ReturnType<typeof successResponse>>()
    const syncB = deferred<ReturnType<typeof successResponse>>()
    const connectionLoads: string[] = []
    const fetchMock = jest.fn((url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string> | undefined
      const viewerId = headers?.Authorization?.includes(accessTokenFor('viewer-b'))
        ? 'viewer-b'
        : 'viewer-a'
      if (url === '/api/exchange/connections') {
        connectionLoads.push(viewerId)
        return Promise.resolve(connectionResponse(viewerId, `${viewerId}-secret`))
      }
      if (url === '/api/exchange/sync') {
        return viewerId === 'viewer-a' ? syncA.promise : syncB.promise
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<ExchangeConnectionManager userId="viewer-a" />)
    expect(await screen.findByText(/viewer-a-secret/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'refreshData' }))
    expect(screen.getByRole('button', { name: 'syncing' })).toBeDisabled()

    mockAuthState = {
      userId: 'viewer-b',
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
      authChecked: true,
    }
    rerender(<ExchangeConnectionManager userId="viewer-b" />)
    expect(await screen.findByText(/viewer-b-secret/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'refreshData' }))
    expect(screen.getByRole('button', { name: 'syncing' })).toBeDisabled()

    await act(async () => {
      syncA.resolve(successResponse())
      await syncA.promise
    })
    expect(screen.getByRole('button', { name: 'syncing' })).toBeDisabled()
    expect(connectionLoads.filter((viewer) => viewer === 'viewer-a')).toHaveLength(1)

    await act(async () => {
      syncB.resolve(successResponse())
      await syncB.promise
    })
    expect(await screen.findByText(/viewer-b-secret/)).toBeInTheDocument()
    expect(connectionLoads.filter((viewer) => viewer === 'viewer-b')).toHaveLength(2)
  })

  it('fails closed when the prop, canonical viewer and bearer subject disagree', async () => {
    mockAuthState = {
      userId: 'viewer-a',
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
      authChecked: true,
    }
    const fetchMock = jest.fn()
    global.fetch = fetchMock as typeof fetch

    render(<ExchangeConnectionManager userId="viewer-a" />)

    expect(screen.getByText('pleaseLogin')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
