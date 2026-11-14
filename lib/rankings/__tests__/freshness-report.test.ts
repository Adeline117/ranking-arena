import { parseFreshnessReport, type FreshnessReport } from '../freshness-report'

function report(overrides: Partial<FreshnessReport> = {}): FreshnessReport {
  return {
    ok: true,
    checked_at: '2026-07-18T18:00:00.000Z',
    summary: { total: 1, fresh: 1, stale: 0, critical: 0, unknown: 0, quarantined: 0 },
    thresholds: { stale_hours: 8, critical_hours: 24 },
    platforms: [
      {
        platform: 'gmx',
        displayName: 'GMX',
        lastUpdate: '2026-07-18T17:00:00.000Z',
        ageMs: 3_600_000,
        ageHours: 1,
        status: 'fresh',
        recordCount: 120,
      },
    ],
    ...overrides,
  }
}

describe('parseFreshnessReport', () => {
  it('accepts the shared numeric threshold and camelCase platform contract', () => {
    expect(parseFreshnessReport(report())).toEqual(report())
  })

  it('accepts an unknown-only fail-closed report', () => {
    const unknownReport = report({
      ok: false,
      summary: { total: 1, fresh: 0, stale: 0, critical: 0, unknown: 1, quarantined: 0 },
      platforms: [
        {
          platform: 'gmx',
          displayName: 'GMX',
          lastUpdate: null,
          ageMs: null,
          ageHours: null,
          status: 'unknown',
          recordCount: 0,
        },
      ],
    })

    expect(parseFreshnessReport(unknownReport)).toEqual(unknownReport)
  })

  it('accepts a quarantined source with its seasons, reasons and start time', () => {
    const quarantined = report({
      ok: false,
      summary: { total: 1, fresh: 0, stale: 0, critical: 0, unknown: 0, quarantined: 1 },
      platforms: [
        {
          platform: 'bybit',
          displayName: 'bybit',
          lastUpdate: '2026-07-16T17:00:00.000Z',
          ageMs: 1,
          ageHours: 0,
          status: 'quarantined',
          recordCount: 0,
          quarantine: [
            {
              season: '90D',
              reasons: ['stale'],
              since: '2026-07-17T00:00:00.000Z',
              lastConfirmedAt: '2026-07-18T17:00:00.000Z',
            },
          ],
        },
      ],
    })
    expect(parseFreshnessReport(quarantined)).toEqual(quarantined)
    expect(() => parseFreshnessReport({ ...quarantined, ok: true })).toThrow(
      'freshness ok does not match summary'
    )
  })

  it('treats a report without a quarantined count (older deployment) as none', () => {
    const legacy = {
      ...report(),
      summary: { total: 1, fresh: 1, stale: 0, critical: 0, unknown: 0 },
    }
    expect(parseFreshnessReport(legacy).summary.quarantined).toBe(0)
  })

  it.each([
    [{ error: 'unauthorized' }, 'freshness report ok must be boolean'],
    [{ ...report(), thresholds: { stale: '8h', critical: '24h' } }, 'freshness stale threshold'],
    [
      {
        ...report(),
        ok: false,
        summary: { total: 1, fresh: 1, stale: 0, critical: 0, unknown: 0 },
      },
      'freshness ok does not match summary',
    ],
    [
      {
        ...report(),
        summary: { total: 2, fresh: 2, stale: 0, critical: 0, unknown: 0 },
      },
      'freshness summary does not match platform statuses',
    ],
  ])('rejects malformed or internally inconsistent payloads', (payload, message) => {
    expect(() => parseFreshnessReport(payload)).toThrow(message)
  })
})
