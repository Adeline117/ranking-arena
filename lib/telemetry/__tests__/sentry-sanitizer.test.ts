import type { Event, TransactionEvent } from '@sentry/core'
import {
  redactRecoveryTokenFromUrl,
  sanitizeSentryEvent,
  sanitizeSentryReplayRecordingEvent,
} from '../sentry-sanitizer'

const TOKEN = 'AQ'.repeat(21)

describe('Sentry recovery-token sanitizer', () => {
  it('redacts only the sensitive query/hash parameter and preserves URL diagnostics', () => {
    expect(
      redactRecoveryTokenFromUrl(
        `https://www.arenafi.org/login?recover=1&recovery_token=${TOKEN}#source=deletion`
      )
    ).toBe('https://www.arenafi.org/login?recover=1&recovery_token=[Filtered]#source=deletion')
    expect(
      redactRecoveryTokenFromUrl(
        `/login?recover=1#source=deletion&recovery%5Ftoken=${TOKEN}&step=confirm`
      )
    ).toBe('/login?recover=1#source=deletion&recovery%5Ftoken=[Filtered]&step=confirm')
    expect(
      redactRecoveryTokenFromUrl(`/login#%72%65%63%6f%76%65%72%79%5f%74%6f%6b%65%6e=${TOKEN}`)
    ).toBe('/login#%72%65%63%6f%76%65%72%79%5f%74%6f%6b%65%6e=[Filtered]')
    expect(redactRecoveryTokenFromUrl('/login?recover=1#source=deletion')).toBe(
      '/login?recover=1#source=deletion'
    )
  })

  it('scrubs actual Sentry error-event URL fields without dropping route/source context', () => {
    const event: Event = {
      message: `navigation failed at /login#recovery_token=${TOKEN}&source=deletion`,
      request: {
        url: `https://www.arenafi.org/login?recover=1#recovery_token=${TOKEN}&source=deletion`,
        query_string: [
          ['recover', '1'],
          ['recovery_token', TOKEN],
        ],
        headers: {
          referer: `https://www.arenafi.org/settings#recovery_token=${TOKEN}`,
          'user-agent': 'test-browser',
        },
      },
      transaction: `/login?recover=1#recovery_token=${TOKEN}`,
      transaction_info: { source: 'url' },
      breadcrumbs: [
        {
          category: 'navigation',
          data: {
            from: '/settings?tab=account',
            to: `/login?recover=1#recovery_token=${TOKEN}`,
          },
        },
      ],
      extra: {
        source: `https://www.arenafi.org/login#recovery_token=${TOKEN}`,
        recovery_token: TOKEN,
        safe: 'retained',
      },
    }

    const result = sanitizeSentryEvent(event)
    const serialized = JSON.stringify(result)

    expect(result).toBe(event)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).toContain('[Filtered]')
    expect(result.request?.url).toContain('recover=1')
    expect(result.request?.url).toContain('source=deletion')
    expect(result.request?.headers?.['user-agent']).toBe('test-browser')
    expect(result.transaction_info?.source).toBe('url')
    expect(result.extra?.safe).toBe('retained')
  })

  it('scrubs Sentry transaction/span fields and tolerates cyclic supplemental data', () => {
    const cyclic: Record<string, unknown> = {
      url: `/login#recovery_token=${TOKEN}&source=span`,
    }
    cyclic.self = cyclic
    const transaction = {
      type: 'transaction',
      transaction: `/login?recover=1#recovery_token=${TOKEN}`,
      transaction_info: { source: 'route' },
      contexts: {
        trace: {
          trace_id: '1'.repeat(32),
          span_id: '2'.repeat(16),
          data: {
            'sentry.source': 'route',
            'url.full': `https://www.arenafi.org/login#recovery_token=${TOKEN}`,
          },
        },
      },
      spans: [
        {
          trace_id: '1'.repeat(32),
          span_id: '3'.repeat(16),
          parent_span_id: '2'.repeat(16),
          start_timestamp: 1,
          timestamp: 2,
          description: `GET /login#recovery_token=${TOKEN}`,
          data: cyclic,
        },
      ],
    } as TransactionEvent

    sanitizeSentryEvent(transaction)

    expect(transaction.transaction).toBe('/login?recover=1#recovery_token=[Filtered]')
    expect(transaction.transaction_info?.source).toBe('route')
    expect(transaction.contexts?.trace?.data?.['sentry.source']).toBe('route')
    expect(transaction.contexts?.trace?.data?.['url.full']).toContain('recovery_token=[Filtered]')
    expect(transaction.spans?.[0]?.description).toContain('recovery_token=[Filtered]')
    expect(cyclic.self).toBe(cyclic)
    expect(cyclic.url).toBe('/login#recovery_token=[Filtered]&source=span')
  })

  it('scrubs the Replay custom navigation frame used by beforeAddRecordingEvent', () => {
    const frame = {
      type: 5,
      data: {
        tag: 'performanceSpan',
        payload: {
          op: 'navigation.push',
          description: `/login?recover=1#recovery_token=${TOKEN}&source=replay`,
          data: {
            previous: `/settings#recovery_token=${TOKEN}`,
          },
        },
      },
    }

    expect(sanitizeSentryReplayRecordingEvent(frame)).toBe(frame)
    expect(JSON.stringify(frame)).not.toContain(TOKEN)
    expect(frame.data.payload.description).toContain('source=replay')
    expect(frame.data.payload.description).toContain('recovery_token=[Filtered]')
  })
})
