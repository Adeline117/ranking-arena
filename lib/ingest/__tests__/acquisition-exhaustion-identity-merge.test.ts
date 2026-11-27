/**
 * identity_merge (one ranked row per identity) in exhaustionCompletenessHolds,
 * and the guarantee that every declaration without it is judged exactly as
 * before: a verbatim copy of the pre-identity_merge predicate is the oracle.
 */

import {
  exhaustionBindingIssues,
  exhaustionCompletenessHolds,
  exhaustionEndSignalHolds,
  leaderboardExhaustionCompletenessSchema,
  leaderboardExhaustionDeclarationSchema,
  type LeaderboardExhaustionCompleteness,
  type LeaderboardExhaustionDeclaration,
  type LeaderboardExhaustionManifestFacts,
} from '../acquisition-exhaustion'
import { BINANCE_FUTURES_LEADERBOARD_EXHAUSTION } from '../adapters/binance'
import { BINANCE_WEB3_LEADERBOARD_EXHAUSTION } from '../adapters/binance-web3'
import {
  BITGET_CFD_LEADERBOARD_EXHAUSTION,
  BITGET_SPOT_LEADERBOARD_EXHAUSTION,
} from '../adapters/bitget'
import { BYBIT_MT5_LEADERBOARD_EXHAUSTION } from '../adapters/bybit-mt5'
import { OKX_LEADERBOARD_EXHAUSTION } from '../adapters/okx'

const PAGE_SIZE = 30

// ── The predicate as it was before identity_merge (oracle; do not edit) ──

function legacyBoardVersionHolds(completeness: LeaderboardExhaustionCompleteness): boolean {
  const pages = completeness.pages
  if (completeness.board_version.kind === 'token') {
    const token = pages[0].version_token_sha256
    return token !== null && pages.every((page) => page.version_token_sha256 === token)
  }
  if (completeness.board_version.kind === 'reported_total_drift') {
    const declared = completeness.declaration.board_version
    if (declared.kind !== 'reported_total_drift') return false
    const totals = completeness.board_version.reported_totals
    const allowance = Math.min(
      Math.floor((totals.last * declared.max_drift_bps) / 10_000),
      completeness.declaration.max_duplicate_rows
    )
    return (
      totals.min <= totals.last &&
      totals.last <= totals.max &&
      totals.max - totals.min <= allowance &&
      Math.abs(totals.last - completeness.row_keys.distinct) <= allowance &&
      completeness.row_keys.duplicate <= allowance
    )
  }
  const reread = completeness.board_version.reread
  return (
    reread !== null &&
    reread.http_status >= 200 &&
    reread.http_status <= 299 &&
    reread.row_keys_sha256 === pages[0].row_keys_sha256
  )
}

function legacyHolds(
  completeness: LeaderboardExhaustionCompleteness,
  facts: LeaderboardExhaustionManifestFacts
): boolean {
  if (exhaustionBindingIssues(completeness, facts).length > 0) return false
  const rows = completeness.row_keys
  return (
    facts.population_report_state === 'unknown' &&
    facts.rejected_row_count === 0 &&
    facts.accepted_population > 0 &&
    rows.distinct === facts.accepted_population &&
    rows.duplicate === facts.deduplicated_row_count &&
    rows.duplicate <= completeness.declaration.max_duplicate_rows &&
    exhaustionEndSignalHolds(completeness, facts) &&
    legacyBoardVersionHolds(completeness)
  )
}

// ── Fixtures ──

const hex = (seed: string) => (seed.replace(/[^0-9a-f]/g, '') + 'a'.repeat(64)).slice(0, 63) + 'b'

interface Board {
  declaration: LeaderboardExhaustionDeclaration
  /** Rows per page, in order. */
  pageRows: number[]
  distinct: number
  totals?: { min: number; max: number; last: number }
  merge?: { identities: number; merged_rows: number }
  termination?: string
  facts?: Partial<LeaderboardExhaustionManifestFacts>
  tokens?: 'same' | 'split'
  reread?: 'same' | 'other' | 'failed'
}

function build(board: Board): {
  completeness: LeaderboardExhaustionCompleteness
  facts: LeaderboardExhaustionManifestFacts
} {
  const { declaration, pageRows } = board
  const observed = pageRows.reduce((sum, rows) => sum + rows, 0)
  const signal = declaration.end_signal
  const pages = pageRows.map((rows, index) => ({
    ordinal: index + 1,
    request_sha256: hex(`a${index}`),
    response_sha256: hex(`b${index}`),
    row_count: rows,
    row_keys_sha256: hex(`c${index}`),
    end_signal_value:
      signal.kind === 'short_page'
        ? null
        : signal.kind === 'page_count'
          ? pageRows.length
          : index === pageRows.length - 1
            ? (signal.end_values[0] as string | number | boolean | null)
            : '__more__',
    version_token_sha256:
      declaration.board_version.kind === 'token'
        ? board.tokens === 'split' && index > 0
          ? hex('e')
          : hex('d')
        : null,
  }))
  const version = declaration.board_version
  const completeness = leaderboardExhaustionCompletenessSchema.parse({
    data_contract: 'arena.ingest.leaderboard-exhaustion-completeness@1',
    declaration,
    pages,
    row_keys: { observed, distinct: board.distinct, duplicate: observed - board.distinct },
    ...(board.merge ? { identity_merge: board.merge } : {}),
    board_version:
      version.kind === 'token'
        ? { kind: 'token' }
        : version.kind === 'first_page_reread'
          ? {
              kind: 'first_page_reread',
              reread:
                board.reread === 'failed'
                  ? null
                  : {
                      request_sha256: hex('f'),
                      response_sha256: hex('f0'),
                      http_status: 200,
                      row_keys_sha256: board.reread === 'other' ? hex('9') : hex('c0'),
                    },
            }
          : {
              kind: 'reported_total_drift',
              reported_totals: board.totals ?? {
                min: board.distinct,
                max: board.distinct,
                last: board.distinct,
              },
            },
  })
  const last = pageRows[pageRows.length - 1]
  const termination =
    board.termination ??
    (signal.kind === 'short_page'
      ? last === 0
        ? 'empty_page'
        : 'short_page'
      : signal.kind === 'page_count'
        ? 'reported_page_count_reached'
        : 'cursor_exhausted')
  const accepted = board.merge ? board.merge.identities : board.distinct
  const facts: LeaderboardExhaustionManifestFacts = {
    termination_reason: termination,
    configured_page_size: PAGE_SIZE,
    population_report_state: 'unknown',
    source_pages: pages.map((page) => ({
      ordinal: page.ordinal,
      request_sha256: page.request_sha256,
      payload_sha256: page.response_sha256,
      source_row_count: page.row_count,
    })),
    observed_row_count: observed,
    accepted_population: accepted,
    rejected_row_count: 0,
    deduplicated_row_count: observed - accepted,
    ...board.facts,
  }
  return { completeness, facts }
}

const pagesOf = (rows: number) => {
  const full = Math.floor(rows / PAGE_SIZE)
  return [...Array.from({ length: full }, () => PAGE_SIZE), rows - full * PAGE_SIZE]
}

const CFD: LeaderboardExhaustionDeclaration = leaderboardExhaustionDeclarationSchema.parse({
  completeness_mode: 'exhausted',
  list_path: ['data', 'rows'],
  row_key_path: ['portfolioId'],
  end_signal: { kind: 'short_page' },
  board_version: { kind: 'reported_total_drift', path: ['data', 'maxShowSizes'], max_drift_bps: 0 },
  max_duplicate_rows: 0,
  identity_merge: { kind: 'best_rank', identity_path: ['traderUid'] },
})

// ── Every registered declaration without identity_merge: unchanged ──

describe('exhaustionCompletenessHolds without identity_merge', () => {
  const declarations: Array<[string, LeaderboardExhaustionDeclaration]> = [
    ['okx (page_count + token)', OKX_LEADERBOARD_EXHAUSTION],
    ['binance_web3 (page_count + reread)', BINANCE_WEB3_LEADERBOARD_EXHAUSTION],
    ['binance_futures (short_page + drift)', BINANCE_FUTURES_LEADERBOARD_EXHAUSTION],
    ['bybit_mt5 (drift)', BYBIT_MT5_LEADERBOARD_EXHAUSTION],
    ['bitget_spot (short_page + drift)', BITGET_SPOT_LEADERBOARD_EXHAUSTION],
  ]

  // A deterministic grid of boards and manifest facts, holding and not.
  function* variants(declaration: LeaderboardExhaustionDeclaration): Generator<Board> {
    for (const size of [1, 29, 30, 191, 220, 5_414]) {
      for (const duplicate of [0, 1, 2, 3, 18, 19, 21, 200, 201]) {
        if (duplicate >= size) continue
        for (const totalShift of [0, -1, 1, -19, 20]) {
          for (const factsVariant of [
            {},
            { rejected_row_count: 1 },
            { population_report_state: 'consistent' as const },
            { deduplicated_row_count: duplicate + 1 },
            { accepted_population: size - duplicate - 1 },
            { termination_reason: 'reported_population_reached' },
          ]) {
            yield {
              declaration,
              pageRows: pagesOf(size),
              distinct: size - duplicate,
              totals: {
                min: Math.max(0, size + Math.min(0, totalShift)),
                max: size + Math.max(0, totalShift),
                last: size,
              },
              facts: factsVariant,
              tokens: duplicate % 2 === 0 ? 'same' : 'split',
              reread: (['same', 'other', 'failed'] as const)[duplicate % 3],
            }
          }
        }
      }
    }
  }

  it.each(declarations)('%s: every case is judged as before', (_label, declaration) => {
    let holding = 0
    let refused = 0
    for (const board of variants(declaration)) {
      const { completeness, facts } = build(board)
      const before = legacyHolds(completeness, facts)
      expect(exhaustionCompletenessHolds(completeness, facts)).toBe(before)
      if (before) holding += 1
      else refused += 1
    }
    // The grid exercises both outcomes for every declaration.
    expect(holding).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
  })

  it('refuses a block that carries identity_merge evidence for such a declaration', () => {
    const { completeness, facts } = build({
      declaration: BITGET_SPOT_LEADERBOARD_EXHAUSTION,
      pageRows: pagesOf(5_414),
      distinct: 5_414,
    })
    expect(exhaustionCompletenessHolds(completeness, facts)).toBe(true)
    const withMerge = { ...completeness, identity_merge: { identities: 5_414, merged_rows: 0 } }
    expect(exhaustionBindingIssues(withMerge, facts)).toContain(
      'identity merge evidence is recorded exactly when the declaration merges identities'
    )
    expect(exhaustionCompletenessHolds(withMerge, facts)).toBe(false)
  })
})

// ── identity_merge ──

describe('identity_merge declaration', () => {
  it('requires reported_total_drift and max_duplicate_rows 0', () => {
    const merge = { kind: 'best_rank', identity_path: ['traderUid'] }
    expect(
      leaderboardExhaustionDeclarationSchema.safeParse({
        ...BITGET_SPOT_LEADERBOARD_EXHAUSTION,
        identity_merge: merge,
      }).success
    ).toBe(false)
    expect(
      leaderboardExhaustionDeclarationSchema.safeParse({
        ...OKX_LEADERBOARD_EXHAUSTION,
        identity_merge: merge,
      }).success
    ).toBe(false)
    expect(
      leaderboardExhaustionDeclarationSchema.safeParse({
        ...CFD,
        identity_merge: { kind: 'first_row', identity_path: ['traderUid'] },
      }).success
    ).toBe(false)
    expect(leaderboardExhaustionDeclarationSchema.safeParse(CFD).success).toBe(true)
  })
})

describe('exhaustionCompletenessHolds with identity_merge (bitget_cfd)', () => {
  // Measured 2026-11-27: 7D 191 portfolios / 188 traders, 30D 220 / 218, 90D 224 / 222.
  it.each([
    [191, 188],
    [220, 218],
    [224, 222],
  ])('%i portfolios of %i traders, each read once, hold', (portfolios, traders) => {
    const { completeness, facts } = build({
      declaration: CFD,
      pageRows: pagesOf(portfolios),
      distinct: portfolios,
      merge: { identities: traders, merged_rows: portfolios - traders },
    })
    expect(facts.deduplicated_row_count).toBe(portfolios - traders)
    expect(exhaustionCompletenessHolds(completeness, facts)).toBe(true)
  })

  const holding = (): Board => ({
    declaration: CFD,
    pageRows: pagesOf(191),
    distinct: 191,
    merge: { identities: 188, merged_rows: 3 },
  })

  it('a board ending on an empty page holds', () => {
    const { completeness, facts } = build({
      ...holding(),
      pageRows: [...pagesOf(180).slice(0, 6), 0],
      distinct: 180,
      merge: { identities: 177, merged_rows: 3 },
    })
    expect(exhaustionCompletenessHolds(completeness, facts)).toBe(true)
  })

  it('refuses any portfolio read twice', () => {
    const { completeness, facts } = build({
      ...holding(),
      distinct: 190,
      totals: { min: 191, max: 191, last: 191 },
      merge: { identities: 188, merged_rows: 2 },
      facts: { accepted_population: 188, deduplicated_row_count: 3 },
    })
    expect(completeness.row_keys.duplicate).toBe(1)
    expect(exhaustionCompletenessHolds(completeness, facts)).toBe(false)
  })

  it('refuses portfolios fewer or more than the reported total', () => {
    for (const last of [190, 192]) {
      const { completeness, facts } = build({
        ...holding(),
        totals: { min: last, max: last, last },
      })
      expect(exhaustionCompletenessHolds(completeness, facts)).toBe(false)
    }
  })

  it('refuses a reported total that moved during the capture (allowance 0)', () => {
    const { completeness, facts } = build({
      ...holding(),
      totals: { min: 191, max: 192, last: 191 },
    })
    expect(exhaustionCompletenessHolds(completeness, facts)).toBe(false)
  })

  it('refuses merge evidence that does not match the accepted rows or the manifest', () => {
    const cases: Array<Partial<Board>> = [
      // merged rows inconsistent with distinct - identities
      { merge: { identities: 188, merged_rows: 2 } },
      // identities != accepted population
      { facts: { accepted_population: 189, deduplicated_row_count: 2 } },
      // manifest dedupe count != merged rows
      { facts: { deduplicated_row_count: 4 } },
      // nothing accepted
      { merge: { identities: 0, merged_rows: 191 }, facts: { accepted_population: 0 } },
      { facts: { rejected_row_count: 1 } },
      { facts: { population_report_state: 'consistent' } },
      { termination: 'reported_population_reached' },
    ]
    for (const variant of cases) {
      const { completeness, facts } = build({ ...holding(), ...variant })
      expect(exhaustionCompletenessHolds(completeness, facts)).toBe(false)
    }
  })

  it('refuses a mid-board short page and a block without merge evidence', () => {
    const short = build({ ...holding(), pageRows: [30, 30, 29, 30, 30, 30, 12] })
    expect(exhaustionCompletenessHolds(short.completeness, short.facts)).toBe(false)

    const { completeness, facts } = build(holding())
    const { identity_merge: _dropped, ...withoutMerge } = completeness
    expect(exhaustionCompletenessHolds(withoutMerge, facts)).toBe(false)
  })
})

describe('identity_merge drift share (BITGET_CFD_LEADERBOARD_EXHAUSTION, 50 bps)', () => {
  const declaration = BITGET_CFD_LEADERBOARD_EXHAUSTION

  it('is 50 bps with no duplicate allowance', () => {
    expect(declaration.board_version).toMatchObject({ max_drift_bps: 50 })
    expect(declaration.max_duplicate_rows).toBe(0)
  })

  it('at 191 (7D) the share is 0 rows: a moved total is refused', () => {
    const moved = build({
      declaration,
      pageRows: pagesOf(191),
      distinct: 191,
      totals: { min: 191, max: 192, last: 191 },
      merge: { identities: 188, merged_rows: 3 },
    })
    expect(exhaustionCompletenessHolds(moved.completeness, moved.facts)).toBe(false)
  })

  it('bounds only the reported total, not capped by max_duplicate_rows 0', () => {
    // 224 x 0.5% = 1 row: the total may move by one between pages.
    const moved = build({
      declaration,
      pageRows: pagesOf(224),
      distinct: 224,
      totals: { min: 224, max: 225, last: 224 },
      merge: { identities: 222, merged_rows: 2 },
    })
    expect(exhaustionCompletenessHolds(moved.completeness, moved.facts)).toBe(true)
    const movedTwo = build({
      declaration,
      pageRows: pagesOf(224),
      distinct: 224,
      totals: { min: 223, max: 225, last: 224 },
      merge: { identities: 222, merged_rows: 2 },
    })
    expect(exhaustionCompletenessHolds(movedTwo.completeness, movedTwo.facts)).toBe(false)
  })

  it('a total that moved by 1 holds, but one portfolio read twice is still incomplete', () => {
    const duplicated = build({
      declaration,
      pageRows: pagesOf(224),
      distinct: 223,
      totals: { min: 224, max: 225, last: 224 },
      merge: { identities: 221, merged_rows: 2 },
      facts: { accepted_population: 221, deduplicated_row_count: 3 },
    })
    expect(duplicated.completeness.row_keys.duplicate).toBe(1)
    expect(exhaustionCompletenessHolds(duplicated.completeness, duplicated.facts)).toBe(false)
    const short = build({
      declaration,
      pageRows: pagesOf(224),
      distinct: 224,
      totals: { min: 225, max: 225, last: 225 },
      merge: { identities: 222, merged_rows: 2 },
    })
    expect(exhaustionCompletenessHolds(short.completeness, short.facts)).toBe(false)
  })
})
