/* eslint-disable @typescript-eslint/no-require-imports */

const mockInit = jest.fn()
const mockReplayIntegration = jest.fn((options) => ({ name: 'Replay', options }))
const mockBrowserTracingIntegration = jest.fn(() => ({ name: 'BrowserTracing' }))
const mockLinkedErrorsIntegration = jest.fn(() => ({ name: 'LinkedErrors' }))
const mockAddIntegration = jest.fn()
const mockGetClient = jest.fn(() => ({ addIntegration: mockAddIntegration }))

jest.mock('@sentry/nextjs', () => ({
  __esModule: true,
  init: mockInit,
  replayIntegration: mockReplayIntegration,
  browserTracingIntegration: mockBrowserTracingIntegration,
  linkedErrorsIntegration: mockLinkedErrorsIntegration,
  getClient: mockGetClient,
  captureRouterTransitionStart: jest.fn(),
}))

const TOKEN = 'AQ'.repeat(21)

type SentryConfig = {
  beforeSend?: (event: Record<string, unknown>, hint?: Record<string, unknown>) => unknown
  beforeSendTransaction?: (event: Record<string, unknown>) => unknown
}

function assertConfigScrubsRecoveryToken(config: SentryConfig): void {
  const event = {
    message: 'account deletion redirect',
    request: {
      url: `/login?account_deleted=1#recovery_token=${TOKEN}&source=config`,
    },
    breadcrumbs: [
      {
        category: 'navigation',
        data: { to: `/login#recovery_token=${TOKEN}` },
      },
    ],
  }
  const transaction = {
    transaction: `/login#recovery_token=${TOKEN}`,
    start_timestamp: 1,
    timestamp: 2,
  }

  expect(config.beforeSend?.(event, {})).toBe(event)
  expect(config.beforeSendTransaction?.(transaction)).toBe(transaction)
  expect(JSON.stringify({ event, transaction })).not.toContain(TOKEN)
}

describe('actual Sentry config recovery-token boundaries', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalPublicDsn = process.env.NEXT_PUBLIC_SENTRY_DSN
  const originalServerDsn = process.env.SENTRY_DSN

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@example.test/1'
    process.env.SENTRY_DSN = 'https://server@example.test/2'
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env.NODE_ENV = originalNodeEnv
    if (originalPublicDsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN
    else process.env.NEXT_PUBLIC_SENTRY_DSN = originalPublicDsn
    if (originalServerDsn === undefined) delete process.env.SENTRY_DSN
    else process.env.SENTRY_DSN = originalServerDsn
  })

  it('captures sanitizers from the imported server and edge configs', () => {
    jest.isolateModules(() => {
      require('../../../sentry.server.config')
    })
    expect(mockInit).toHaveBeenCalledTimes(1)
    assertConfigScrubsRecoveryToken(mockInit.mock.calls[0][0] as SentryConfig)

    mockInit.mockClear()
    jest.isolateModules(() => {
      require('../../../sentry.edge.config')
    })
    expect(mockInit).toHaveBeenCalledTimes(1)
    assertConfigScrubsRecoveryToken(mockInit.mock.calls[0][0] as SentryConfig)
  })

  it('captures the client config and Replay custom-frame sanitizer', async () => {
    jest.useFakeTimers()
    let initSentry!: () => Promise<void>
    jest.isolateModules(() => {
      initSentry = require('../../sentry-init').initSentry as () => Promise<void>
    })

    await initSentry()

    expect(mockInit).toHaveBeenCalled()
    assertConfigScrubsRecoveryToken(mockInit.mock.calls[0][0] as SentryConfig)

    await jest.advanceTimersByTimeAsync(5_000)
    expect(mockReplayIntegration).toHaveBeenCalled()
    expect(mockAddIntegration).toHaveBeenCalled()

    const replayOptions = mockReplayIntegration.mock.calls[0][0] as {
      beforeAddRecordingEvent?: (event: Record<string, unknown>) => unknown
    }
    const navigationFrame = {
      type: 5,
      data: {
        tag: 'performanceSpan',
        payload: {
          op: 'navigation.push',
          description: `/login#recovery_token=${TOKEN}&source=replay-config`,
        },
      },
    }
    expect(replayOptions.beforeAddRecordingEvent?.(navigationFrame)).toBe(navigationFrame)
    expect(JSON.stringify(navigationFrame)).not.toContain(TOKEN)
  })
})
