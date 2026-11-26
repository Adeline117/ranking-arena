/**
 * The drawdown filter means the same thing on both sides of the wire:
 * once a drawdown bound is set, a row with no published max drawdown does not
 * match; with no bound set it is not excluded. The first page is filtered in
 * the browser (applyAdvancedFilter) and later pages in SQL
 * (applyLeaderboardFilters), so the two must select the same rows.
 */
import type { Trader } from '../../ranking/RankingTable'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', setLanguage: jest.fn(), t: (key: string) => key }),
  LanguageProvider: ({ children }: { children: unknown }) => children,
}))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ getAuthHeaders: () => null }),
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

import { applyAdvancedFilter } from '../useRankingFilters'
import {
  applyLeaderboardFilters,
  type LeaderboardFilterable,
  type LeaderboardFilters,
} from '@/lib/rankings/leaderboard-filters'

type Row = Record<string, number | string | null>
type Config = Parameters<typeof applyAdvancedFilter>[1]

/** PostgREST filter subset evaluated in memory with SQL NULL semantics. */
class RowFilter implements LeaderboardFilterable<RowFilter> {
  constructor(private readonly tests: ((row: Row) => boolean)[] = []) {}

  private compare(column: string, test: (value: number) => boolean): (row: Row) => boolean {
    return (row) => {
      const value = row[column]
      // NULL compared with anything is not true.
      return typeof value === 'number' && test(value)
    }
  }
  private and(test: (row: Row) => boolean): RowFilter {
    return new RowFilter([...this.tests, test])
  }
  gte(column: string, bound: number): RowFilter {
    return this.and(this.compare(column, (value) => value >= bound))
  }
  lte(column: string, bound: number): RowFilter {
    return this.and(this.compare(column, (value) => value <= bound))
  }
  lt(column: string, bound: number): RowFilter {
    return this.and(this.compare(column, (value) => value < bound))
  }
  in(column: string, values: readonly string[]): RowFilter {
    return this.and((row) => values.includes(String(row[column])))
  }
  or(filters: string): RowFilter {
    const alternatives = filters.split(',').map((part) => {
      const match = /^([a-z_]+)\.(gte|lte)\.(-?[0-9.]+)$/.exec(part)
      if (!match) throw new Error(`unsupported or() term: ${part}`)
      const bound = Number(match[3])
      return this.compare(match[1], (value) =>
        match[2] === 'gte' ? value >= bound : value <= bound
      )
    })
    return this.and((row) => alternatives.some((test) => test(row)))
  }
  matches(row: Row): boolean {
    return this.tests.every((test) => test(row))
  }
}

function trader(id: string, maxDrawdown: number | null): Trader {
  return {
    id,
    handle: id,
    roi: 10,
    pnl: 500,
    win_rate: maxDrawdown == null ? null : 50,
    max_drawdown: maxDrawdown,
    followers: 0,
    source: 'binance_futures',
    arena_score: 60,
  } as Trader
}

const FULL_ROWS = [trader('dd-0', 0), trader('dd-10', 10), trader('dd-20', 20), trader('dd-45', 45)]
const NO_DRAWDOWN = trader('dd-null', null)

/** The mapping /api/traders applies to the same-named query params. */
function serverFilters(config: Config): LeaderboardFilters {
  const filters: LeaderboardFilters = {}
  if (config.drawdown_min != null) filters.ddMin = config.drawdown_min
  if (config.drawdown_max != null) filters.ddMax = config.drawdown_max
  if (config.roi_min != null) filters.roiMin = config.roi_min
  if (config.min_score != null) filters.minScore = config.min_score
  return filters
}

function serverIds(list: Trader[], config: Config): string[] {
  const filter = applyLeaderboardFilters(new RowFilter(), serverFilters(config))
  return list.filter((row) => filter.matches(row as unknown as Row)).map((row) => row.id)
}
function clientIds(list: Trader[], config: Config): string[] {
  return applyAdvancedFilter(list, config).map((row) => row.id)
}

const DRAWDOWN_CONFIGS: Config[] = [
  { drawdown_max: 20 },
  { drawdown_min: 15 },
  { drawdown_min: 0 },
  { drawdown_min: 5, drawdown_max: 30 },
]

describe('drawdown filter — rows without a published max drawdown', () => {
  it.each(DRAWDOWN_CONFIGS)('excludes them in the browser and in SQL alike: %j', (config) => {
    const list = [...FULL_ROWS, NO_DRAWDOWN]
    expect(clientIds(list, config)).not.toContain('dd-null')
    expect(serverIds(list, config)).not.toContain('dd-null')
    expect(clientIds(list, config)).toEqual(serverIds(list, config))
  })

  it('does not exclude them when no drawdown bound is set', () => {
    const list = [...FULL_ROWS, NO_DRAWDOWN]
    for (const config of [{}, { roi_min: 5 }, { min_score: 50 }] as Config[]) {
      expect(clientIds(list, config)).toContain('dd-null')
      expect(serverIds(list, config)).toContain('dd-null')
    }
  })

  it('selects exactly the rows it selected before when every row has a drawdown (old rule)', () => {
    // Under the old rule every published row carries a max drawdown, so the
    // null branch is never reached; these are the pre-change results.
    expect(clientIds(FULL_ROWS, { drawdown_max: 20 })).toEqual(['dd-0', 'dd-10', 'dd-20'])
    expect(clientIds(FULL_ROWS, { drawdown_min: 15 })).toEqual(['dd-20', 'dd-45'])
    expect(clientIds(FULL_ROWS, { drawdown_min: 0 })).toEqual(['dd-0', 'dd-10', 'dd-20', 'dd-45'])
    expect(clientIds(FULL_ROWS, { drawdown_min: 5, drawdown_max: 30 })).toEqual(['dd-10', 'dd-20'])
    expect(clientIds(FULL_ROWS, {})).toEqual(['dd-0', 'dd-10', 'dd-20', 'dd-45'])
    for (const config of DRAWDOWN_CONFIGS) {
      expect(clientIds(FULL_ROWS, config)).toEqual(serverIds(FULL_ROWS, config))
    }
  })
})
