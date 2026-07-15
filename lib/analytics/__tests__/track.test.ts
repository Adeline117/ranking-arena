import { track as trackVercelEvent } from '@vercel/analytics'
import { ANALYTICS_EVENTS, trackEvent } from '../track'

jest.mock('@vercel/analytics', () => ({
  track: jest.fn(),
}))

jest.mock('@/lib/api/csrf', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'test-csrf' }),
}))

jest.mock('@/lib/auth/local-session', () => ({
  getLocalAccessToken: () => 'access-token',
}))

const vercelTrackMock = trackVercelEvent as jest.MockedFunction<typeof trackVercelEvent>

describe('trackEvent', () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    global.fetch = fetchMock
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vercelTrackMock.mockClear()
    fetchMock.mockClear()
    delete (window as typeof window & { plausible?: unknown }).plausible
    delete (window as typeof window & { posthog?: unknown }).posthog
  })

  it('always emits the canonical event to Vercel Analytics in the browser', () => {
    trackEvent(ANALYTICS_EVENTS.rankingFilter, { period: '30D', mobile: true })

    expect(vercelTrackMock).toHaveBeenCalledWith('ranking_filter', {
      period: '30D',
      mobile: true,
    })
  })

  it('mirrors the event to optional providers when they are loaded', () => {
    const plausible = jest.fn()
    const capture = jest.fn()
    ;(window as typeof window & { plausible: typeof plausible }).plausible = plausible
    ;(window as typeof window & { posthog: { capture: typeof capture } }).posthog = { capture }

    trackEvent(ANALYTICS_EVENTS.saveTrader, { source: 'ranking' })

    expect(plausible).toHaveBeenCalledWith('save_trader', {
      props: { source: 'ranking' },
    })
    expect(capture).toHaveBeenCalledWith('save_trader', { source: 'ranking' })
  })

  it('mirrors a bounded event to the first-party measurement endpoint', () => {
    trackEvent(ANALYTICS_EVENTS.viewTrader, { source: 'ranking' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/analytics/events',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'x-csrf-token': 'test-csrf',
        }),
      })
    )
    const request = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(request.body as string)
    expect(body).toEqual(
      expect.objectContaining({
        event_name: 'view_trader',
        path: '/',
        properties: { source: 'ranking' },
      })
    )
    expect(body.event_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.anonymous_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
