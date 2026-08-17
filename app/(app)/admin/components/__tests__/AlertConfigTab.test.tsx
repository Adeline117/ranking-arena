'use client'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockShowToast = jest.fn()
const mockGetCsrfHeaders = jest.fn(() => ({ 'X-CSRF-Token': 'csrf-token' }))

type MockAuthSession = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

let mockAuth: MockAuthSession
const mockUseAuthSession = jest.fn(() => mockAuth)

const translations: Record<string, string> = {
  adminAlertConfiguration: 'Alert Configuration',
  adminAlertConfigDesc: 'Configure alert delivery',
  adminAlertCronNote: 'Cron note',
  adminAlertEmail: 'Alert email',
  adminAlertEmailDesc: 'Alert email description',
  adminAlertTriggerTitle: 'Triggers',
  adminCriticalAlertDesc: 'Critical alert',
  adminFeishuDesc: 'Feishu description',
  adminFeishuWebhook: 'Feishu webhook',
  adminLoadFailed: 'Unable to load alert configuration',
  adminSaveBtn: 'Save',
  adminSaving: 'Saving',
  adminSlackDesc: 'Slack description',
  adminSlackWebhook: 'Slack webhook',
  adminStaleAlertDesc: 'Stale alert',
  loading: 'Loading',
}
const mockT = (key: string) => translations[key] ?? key

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockT }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => mockGetCsrfHeaders(),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  __esModule: true,
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({
      as,
      children,
      color: _color,
      size: _size,
      weight: _weight,
      ...props
    }: React.HTMLAttributes<HTMLElement> & {
      as?: keyof HTMLElementTagNameMap
      color?: string
      size?: string
      weight?: string
    }) => React.createElement(as || 'span', props, children),
    Button: ({
      children,
      loading,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      loading?: boolean
      size?: string
      variant?: string
    }) =>
      React.createElement(
        'button',
        { ...props, disabled: props.disabled || loading, 'aria-busy': Boolean(loading) },
        children
      ),
  }
})

jest.mock('@/app/components/ui/Card', () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))

import AlertConfigTab from '../AlertConfigTab'

const mockFetch = jest.fn()
let getQueue: Array<Response | Promise<Response>>
let postQueue: Array<Response | Promise<Response>>
const SLACK_PLACEHOLDER = 'https://hooks.slack.com/services/...'
const ORIGINAL_SLACK_WEBHOOK = 'https://hooks.slack.com/services/original'
const UPDATED_SLACK_WEBHOOK = 'https://hooks.slack.com/services/updated'
const NEWER_SLACK_WEBHOOK = 'https://hooks.slack.com/services/newer-draft'
const SCOPE_B_SLACK_WEBHOOK = 'https://hooks.slack.com/services/scope-b'

function authFor(userId: string, sessionGeneration: number, accessToken = `token-${userId}`) {
  return {
    accessToken,
    authChecked: true,
    email: `${userId}@example.com`,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function anonymousAuth(sessionGeneration: number): MockAuthSession {
  return {
    accessToken: null,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration,
    userId: null,
    viewerKey: 'anon',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function configResponse(webhook = ORIGINAL_SLACK_WEBHOOK): Response {
  return response({
    ok: true,
    config: {
      slack_webhook_url: {
        value: webhook,
        enabled: true,
      },
      feishu_webhook_url: {
        value: null,
        enabled: false,
      },
      alert_email: {
        value: null,
        enabled: false,
      },
    },
  })
}

describe('AlertConfigTab save reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getQueue = []
    postQueue = []
    mockFetch.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const queue = (init?.method ?? 'GET') === 'POST' ? postQueue : getQueue
      const next = queue.shift()
      if (!next) throw new Error(`Unexpected ${init?.method ?? 'GET'} request`)
      return Promise.resolve(next)
    })
    global.fetch = mockFetch
    mockAuth = authFor('admin-a', 1, 'token-a')
  })

  function queueGet(...responses: Array<Response | Promise<Response>>) {
    getQueue.push(...responses)
  }

  function queuePost(...responses: Array<Response | Promise<Response>>) {
    postQueue.push(...responses)
  }

  function slackInput() {
    return screen.getByPlaceholderText(SLACK_PLACEHOLDER) as HTMLInputElement
  }

  function firstSaveButton() {
    return screen.getAllByRole('button', { name: /save|saving/i })[0]
  }

  it('keeps a failed draft dirty, surfaces the toast, and allows retry', async () => {
    queueGet(configResponse(), configResponse())
    queuePost(response({ error: 'Alert config save failed' }, 500), response({ ok: true }))

    render(<AlertConfigTab accessToken="token-a" />)

    await waitFor(() => expect(slackInput().value).toBe(ORIGINAL_SLACK_WEBHOOK))
    fireEvent.change(slackInput(), { target: { value: UPDATED_SLACK_WEBHOOK } })
    fireEvent.click(firstSaveButton())

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Alert config save failed', 'error')
    )
    expect(screen.getByDisplayValue(UPDATED_SLACK_WEBHOOK)).toBeInTheDocument()
    await waitFor(() => expect(firstSaveButton()).toBeEnabled())

    fireEvent.click(firstSaveButton())

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(firstSaveButton()).toBeDisabled())
  })

  it('clears dirty state only after the successful acknowledgement updates the committed config', async () => {
    queueGet(configResponse(), configResponse())
    queuePost(response({ ok: true }))

    render(<AlertConfigTab accessToken="token-a" />)

    await waitFor(() => expect(slackInput().value).toBe(ORIGINAL_SLACK_WEBHOOK))
    fireEvent.change(slackInput(), { target: { value: UPDATED_SLACK_WEBHOOK } })
    fireEvent.click(firstSaveButton())

    await waitFor(() => expect(screen.getByDisplayValue(UPDATED_SLACK_WEBHOOK)).toBeInTheDocument())
    await waitFor(() => expect(firstSaveButton()).toBeDisabled())
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('preserves a newer local draft when an older save acknowledgement arrives', async () => {
    const saveResponse = deferred<Response>()
    queueGet(configResponse(), configResponse())
    queuePost(saveResponse.promise)

    render(<AlertConfigTab accessToken="token-a" />)

    await waitFor(() => expect(slackInput().value).toBe(ORIGINAL_SLACK_WEBHOOK))
    fireEvent.change(slackInput(), { target: { value: UPDATED_SLACK_WEBHOOK } })
    fireEvent.click(firstSaveButton())
    fireEvent.change(slackInput(), { target: { value: NEWER_SLACK_WEBHOOK } })

    await act(async () => {
      saveResponse.resolve(response({ ok: true }))
      await saveResponse.promise
    })

    expect(screen.getByDisplayValue(NEWER_SLACK_WEBHOOK)).toBeInTheDocument()
    await waitFor(() => expect(firstSaveButton()).toBeEnabled())
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('drops a slow load from the previous admin scope', async () => {
    const loadA = deferred<Response>()
    queueGet(loadA.promise, loadA.promise)

    const view = render(<AlertConfigTab accessToken="token-a" />)

    expect(screen.getByText('Loading')).toBeInTheDocument()

    getQueue.length = 0
    mockAuth = authFor('admin-b', 2, 'token-b')
    queueGet(configResponse(SCOPE_B_SLACK_WEBHOOK), configResponse(SCOPE_B_SLACK_WEBHOOK))
    view.rerender(<AlertConfigTab accessToken="token-b" />)

    await waitFor(() => expect(slackInput().value).toBe(SCOPE_B_SLACK_WEBHOOK))

    await act(async () => {
      loadA.resolve(configResponse(ORIGINAL_SLACK_WEBHOOK))
      await loadA.promise
    })

    expect(screen.queryByDisplayValue(ORIGINAL_SLACK_WEBHOOK)).not.toBeInTheDocument()
    expect(screen.getByDisplayValue(SCOPE_B_SLACK_WEBHOOK)).toBeInTheDocument()
  })

  it('clears sensitive config and shows an inline error when the replacement scope load fails', async () => {
    queueGet(configResponse(), configResponse())

    const view = render(<AlertConfigTab accessToken="token-a" />)

    await waitFor(() => expect(slackInput().value).toBe(ORIGINAL_SLACK_WEBHOOK))

    getQueue.length = 0
    mockAuth = authFor('admin-b', 2, 'token-b')
    queueGet(
      response({ error: 'Failed to load scope B' }, 500),
      response({ error: 'Failed to load scope B' }, 500)
    )
    view.rerender(<AlertConfigTab accessToken="token-b" />)

    await screen.findByText('Failed to load scope B')
    expect(slackInput().value).toBe('')
    expect(screen.queryByDisplayValue(ORIGINAL_SLACK_WEBHOOK)).not.toBeInTheDocument()
  })

  it('clears sensitive config on malformed load acknowledgements', async () => {
    queueGet(configResponse(), configResponse())

    const view = render(<AlertConfigTab accessToken="token-a" />)

    await waitFor(() => expect(slackInput().value).toBe(ORIGINAL_SLACK_WEBHOOK))

    getQueue.length = 0
    mockAuth = authFor('admin-b', 2, 'token-b')
    queueGet(
      response({
        ok: true,
        config: {
          slack_webhook_url: {
            value: 42,
            enabled: true,
          },
        },
      }),
      response({
        ok: true,
        config: {
          slack_webhook_url: {
            value: 42,
            enabled: true,
          },
        },
      })
    )
    view.rerender(<AlertConfigTab accessToken="token-b" />)

    await screen.findByText('Unable to load alert configuration')
    expect(slackInput().value).toBe('')
    expect(screen.queryByDisplayValue(ORIGINAL_SLACK_WEBHOOK)).not.toBeInTheDocument()
  })

  it('fails empty on logout', async () => {
    queueGet(configResponse(), configResponse())

    const view = render(<AlertConfigTab accessToken="token-a" />)

    await waitFor(() => expect(slackInput().value).toBe(ORIGINAL_SLACK_WEBHOOK))

    getQueue.length = 0
    mockAuth = anonymousAuth(2)
    view.rerender(<AlertConfigTab accessToken={null} />)

    expect(slackInput().value).toBe('')
    expect(slackInput()).toBeDisabled()
    expect(screen.queryByDisplayValue(ORIGINAL_SLACK_WEBHOOK)).not.toBeInTheDocument()
  })
})
