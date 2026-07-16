import { act, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

type MockAuthState = {
  userId: string | null
  accessToken: string | null
  authChecked: boolean
  loading: boolean
  viewerKey: `user:${string}`
  sessionGeneration: number
}

let mockAuthState: MockAuthState
const mockTranslate = (key: string) => key

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockTranslate }),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('@/app/components/base', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}))

jest.mock('@/lib/design-tokens', () => ({
  alpha: (value: string) => value,
  tokens: {
    spacing: { 4: '16px', 5: '20px', 6: '24px' },
    radius: { lg: '12px', '2xl': '24px' },
    colors: { accent: { primary: '#00f', brand: '#0ff' } },
  },
}))

import { ExchangeBindingBanner } from '../ExchangeBindingBanner'

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

function setMockViewer(viewerId: string, tokenSubject = viewerId) {
  const scope = synchronizeViewerScope(true, viewerId)
  mockAuthState = {
    userId: viewerId,
    accessToken: accessTokenFor(tokenSubject),
    authChecked: true,
    loading: false,
    viewerKey: `user:${viewerId}`,
    sessionGeneration: scope.sessionGeneration,
  }
}

function responseFor(viewerId: string, hasConnection: boolean) {
  return {
    ok: true,
    json: async () => ({
      data: {
        connections: hasConnection ? [{ id: `connection-${viewerId}`, user_id: viewerId }] : [],
      },
    }),
  }
}

describe('ExchangeBindingBanner viewer ownership', () => {
  beforeEach(() => {
    __resetViewerScopeForTests()
    setMockViewer('viewer-a')
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('uses canonical auth and never reads Supabase session state directly', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/settings/components/ExchangeBindingBanner.tsx'),
      'utf8'
    )

    expect(source).toContain("from '@/lib/hooks/useAuthSession'")
    expect(source).not.toContain("from '@/lib/supabase/client'")
    expect(source).not.toContain('auth.getSession')
  })

  it('hides A synchronously while loading B ownership', async () => {
    const viewerB = deferred<ReturnType<typeof responseFor>>()
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(responseFor('viewer-a', false))
      .mockReturnValueOnce(viewerB.promise)
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<ExchangeBindingBanner userId="viewer-a" />)
    expect(await screen.findByText('bindExchangeBannerTitle')).toBeInTheDocument()

    setMockViewer('viewer-b')
    rerender(<ExchangeBindingBanner userId="viewer-b" />)
    expect(screen.queryByText('bindExchangeBannerTitle')).not.toBeInTheDocument()

    await act(async () => {
      viewerB.resolve(responseFor('viewer-b', false))
      await viewerB.promise
    })
    expect(await screen.findByText('bindExchangeBannerTitle')).toBeInTheDocument()
  })

  it('does not let a late A decision overwrite the settled B banner', async () => {
    const viewerA = deferred<ReturnType<typeof responseFor>>()
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(viewerA.promise)
      .mockResolvedValueOnce(responseFor('viewer-b', false))
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<ExchangeBindingBanner userId="viewer-a" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    setMockViewer('viewer-b')
    rerender(<ExchangeBindingBanner userId="viewer-b" />)
    expect(await screen.findByText('bindExchangeBannerTitle')).toBeInTheDocument()

    await act(async () => {
      viewerA.resolve(responseFor('viewer-a', true))
      await viewerA.promise
    })
    expect(screen.getByText('bindExchangeBannerTitle')).toBeInTheDocument()
  })

  it('fails closed when the bearer subject does not own the rendered viewer', () => {
    setMockViewer('viewer-a', 'viewer-b')
    const fetchMock = jest.fn()
    global.fetch = fetchMock as typeof fetch

    render(<ExchangeBindingBanner userId="viewer-a" />)

    expect(screen.queryByText('bindExchangeBannerTitle')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
