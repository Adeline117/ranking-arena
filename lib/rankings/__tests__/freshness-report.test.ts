import { parseFreshnessReport, type FreshnessReport } from '../freshness-report'

function report(overrides: Partial<FreshnessReport> = {}): FreshnessReport {
  return {
    ok: true,
    checked_at: '2026-07-18T18:00:00.000Z',
    summary: { total: 1, fresh: 1, stale: 0, critical: 0, unknown: 0 },
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
      summary: { total: 1, fresh: 0, stale: 0, critical: 0, unknown: 1 },
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
