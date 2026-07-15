/** @jest-environment node */

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, key) {
        return process.env[String(key)]
      },
    }
  ),
}))

const mockRunTraderAlerts = jest.fn()
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()
const mockSendToUser = jest.fn()
const mockSendEmail = jest.fn()
const mockProfilesIn = jest.fn()

jest.mock('@/lib/alerts/run-trader-alerts', () => ({
  runTraderAlerts: (...args: unknown[]) => mockRunTraderAlerts(...args),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn().mockResolvedValue({
      success: (...args: unknown[]) => mockPipelineSuccess(...args),
      error: (...args: unknown[]) => mockPipelineError(...args),
    }),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({ in: (...args: unknown[]) => mockProfilesIn(...args) })),
    })),
  })),
}))

jest.mock('@/lib/services/push-notification', () => ({
  getPushNotificationService: jest.fn(() => ({ sendToUser: mockSendToUser })),
}))

jest.mock('@/lib/services/email', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  buildTraderAlertEmail: jest.fn(() => '<html>alert</html>'),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { GET } from '../route'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

const baseResult = {
  alertsConfigured: 1,
  alertsChecked: 1,
  alertsSkippedNoSubscription: 0,
  tradersChecked: 1,
  statesWritten: 5,
  alertsSent: 0,
  deliveryFailures: 0,
  deliveredAlerts: [],
}

function request(secret?: string): Request {
  return new Request('https://www.arenafi.org/api/cron/check-trader-alerts', {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  })
}

describe('check-trader-alerts cron route', () => {
  beforeAll(() => {
    process.env.CRON_SECRET = 'test-secret'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockRunTraderAlerts.mockResolvedValue(baseResult)
    mockProfilesIn.mockResolvedValue({ data: [], error: null })
    mockSendToUser.mockResolvedValue([])
    mockSendEmail.mockResolvedValue(true)
  })

  it('rejects unauthorized requests before creating a pipeline run', async () => {
    const response = await GET(request('wrong'))

    expect(response.status).toBe(401)
    expect(PipelineLogger.start).not.toHaveBeenCalled()
    expect(mockRunTraderAlerts).not.toHaveBeenCalled()
  })

  it('reports the durable run result', async () => {
    const response = await GET(request('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      alertsChecked: 1,
      statesWritten: 5,
      alertsSent: 0,
      pushSent: 0,
      emailsSent: 0,
    })
    expect(body).not.toHaveProperty('deliveredAlerts')
    expect(mockPipelineSuccess).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ alertsChecked: 1, deliveryFailures: 0 })
    )
  })

  it('fans out only newly finalized deliveries and gives email a stable idempotency key', async () => {
    mockRunTraderAlerts.mockResolvedValue({
      ...baseResult,
      alertsSent: 1,
      deliveredAlerts: [
        {
          deliveryId: 'delivery-1',
          userId: 'user-1',
          notificationType: 'trader_alert_roi',
          title: 'ROI change',
          message: 'ROI moved',
          link: '/trader/alpha?platform=binance_futures',
        },
      ],
    })
    mockProfilesIn.mockResolvedValue({
      data: [{ id: 'user-1', email: 'qa@example.com', email_digest: 'daily' }],
      error: null,
    })

    const response = await GET(request('test-secret'))
    const body = await response.json()

    expect(body).toMatchObject({ alertsSent: 1, pushSent: 1, emailsSent: 1 })
    expect(mockSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        data: expect.objectContaining({ deliveryId: 'delivery-1', type: 'trader_alert_roi' }),
      })
    )
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey:
          'trader-alert/0b220df1969115139ffebb337981298d243a44f84dad5d20d7e7da5fdb34de43',
      })
    )
  })

  it('returns 500 and marks the pipeline failed when the durable run fails', async () => {
    mockRunTraderAlerts.mockRejectedValue(new Error('database unavailable'))

    const response = await GET(request('test-secret'))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: 'database unavailable' })
    expect(mockPipelineError).toHaveBeenCalled()
  })
})
