import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cachedRowsStillInPublicCohort,
  applyPublicCohortFilters,
  isInPublicCohort,
  PUBLIC_COHORT_MAX_ABS_ROI,
  PUBLIC_COHORT_MAX_COMPUTED_AGE_MS,
  PUBLIC_COHORT_MIN_ARENA_SCORE_EXCLUSIVE,
  type PublicCohortFilterable,
} from '../public-cohort'

const NOW = Date.parse('2026-11-13T12:00:00.000Z')

type Call = [string, string, number | string]
class RecordingQuery implements PublicCohortFilterable<RecordingQuery> {
  calls: Call[] = []
  gt(column: string, value: number) {
    this.calls.push(['gt', column, value])
    return this
  }
  gte(column: string, value: number | string) {
    this.calls.push(['gte', column, value])
    return this
  }
  lte(column: string, value: number) {
    this.calls.push(['lte', column, value])
    return this
  }
}

describe('shared public cohort predicate', () => {
  it('applies score floor, ROI bound and the sealed view 48h window in SQL', () => {
    const query = applyPublicCohortFilters(new RecordingQuery(), NOW)
    expect(query.calls).toEqual([
      ['gt', 'arena_score', 0],
      ['gte', 'roi', -50_000],
      ['lte', 'roi', 50_000],
      ['gte', 'computed_at', '2026-11-11T12:00:00.000Z'],
    ])
    expect(PUBLIC_COHORT_MAX_COMPUTED_AGE_MS).toBe(48 * 3600_000)
  })

  it('re-checks cached rows with exactly the same boundaries', () => {
    const fresh = { arena_score: 1, roi: 10, computed_at: '2026-11-13T00:00:00.000Z' }
    expect(isInPublicCohort(fresh, NOW)).toBe(true)
    expect(
      isInPublicCohort({ ...fresh, arena_score: PUBLIC_COHORT_MIN_ARENA_SCORE_EXCLUSIVE }, NOW)
    ).toBe(false)
    expect(isInPublicCohort({ ...fresh, arena_score: null }, NOW)).toBe(false)
    expect(isInPublicCohort({ ...fresh, roi: PUBLIC_COHORT_MAX_ABS_ROI }, NOW)).toBe(true)
    expect(isInPublicCohort({ ...fresh, roi: -PUBLIC_COHORT_MAX_ABS_ROI - 1 }, NOW)).toBe(false)
    expect(isInPublicCohort({ ...fresh, roi: null }, NOW)).toBe(false)
    // 6–48h old rows stay in the cohort (previously hidden by the 6h reader window)
    expect(isInPublicCohort({ ...fresh, computed_at: '2026-11-12T00:00:00.000Z' }, NOW)).toBe(true)
    expect(isInPublicCohort({ ...fresh, computed_at: '2026-11-11T12:00:00.000Z' }, NOW)).toBe(true)
    expect(isInPublicCohort({ ...fresh, computed_at: '2026-11-11T11:59:59.999Z' }, NOW)).toBe(false)
    expect(isInPublicCohort({ ...fresh, computed_at: 'not-a-date' }, NOW)).toBe(false)
  })

  it.each(['lib/data/trader/queries.ts', 'app/api/traders/route.ts', 'app/api/rankings/route.ts'])(
    '%s uses the shared predicate instead of a private score/age/ROI filter',
    (file) => {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).toContain('applyPublicCohortFilters(')
      expect(source).not.toMatch(/\.gte\(\s*'computed_at'/)
      expect(source).not.toMatch(/\.gt\(\s*'arena_score',\s*\d/)
      expect(source).not.toMatch(/\.(gte|lte)\(\s*'roi'/)
    }
  )

  it('the homepage SSR page no longer narrows the cohort with its own score floor', () => {
    const source = readFileSync(join(process.cwd(), 'lib/getInitialTraders.ts'), 'utf8')
    expect(source).not.toMatch(/minScore:\s*\d/)
  })
})

describe('cachedRowsStillInPublicCohort', () => {
  function client(live: Array<Record<string, unknown>> | null, error: string | null = null) {
    const query: Record<string, jest.Mock> & PromiseLike<unknown> = {
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: live, error: error ? { message: error } : null }).then(resolve),
    } as never
    for (const method of ['select', 'eq', 'in', 'gt', 'gte', 'lte']) {
      query[method] = jest.fn(() => query)
    }
    return { client: { from: jest.fn(() => query) }, query }
  }
  const row = (id: string, idle?: boolean) => ({
    source: 'binance_futures',
    source_trader_id: id,
    ...(idle === undefined ? {} : { idle_window: idle }),
  })

  it('accepts a cached page whose rows are all still live with the same idle flag', async () => {
    const { client: c, query } = client([row('a', false), row('b', true)])
    await expect(
      cachedRowsStillInPublicCohort(c, '90D', [row('a', false), row('b', true)])
    ).resolves.toBe(true)
    expect(query.select).toHaveBeenCalledWith('source, source_trader_id, idle_window')
  })

  it('rejects a cached page in which a row has become idle since it was cached', async () => {
    const { client: c } = client([row('a', true)])
    await expect(cachedRowsStillInPublicCohort(c, '90D', [row('a', false)])).resolves.toBe(false)
    // An older cache entry without the flag counts as "not idle".
    await expect(cachedRowsStillInPublicCohort(c, '90D', [row('a')])).resolves.toBe(false)
  })

  it('rejects a cached page with a withdrawn row, and throws when it cannot check', async () => {
    const { client: c } = client([])
    await expect(cachedRowsStillInPublicCohort(c, '90D', [row('a', false)])).resolves.toBe(false)
    const failing = client(null, 'boom').client
    await expect(cachedRowsStillInPublicCohort(failing, '90D', [row('a')])).rejects.toThrow('boom')
  })
})
