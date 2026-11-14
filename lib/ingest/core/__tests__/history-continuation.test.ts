import type { ParsedHistoryRow } from '../types'
import {
  continuationRequest,
  effectiveContinuationState,
  evaluateContinuationRun,
  initialContinuationState,
  oldestEventAt,
  parseTruncationMarker,
  type HistoryContinuationState,
} from '../history-continuation'

const order = (ts: string, id = ts): ParsedHistoryRow => ({
  kind: 'orders',
  ts,
  orderKind: 'open_long',
  symbol: 'BTCUSDT',
  side: 'long',
  price: 1,
  qty: 1,
  dedupeHash: id,
  raw: {},
})

const BOUNDARY = '2026-07-10T00:00:00.000Z'
const pagePending: Extract<HistoryContinuationState, { state: 'pending' }> = {
  state: 'pending',
  mode: 'page_offset',
  resume_page: 21,
  boundary_at: BOUNDARY,
  runs: 0,
  last_error: null,
}
const timePending: Extract<HistoryContinuationState, { state: 'pending' }> = {
  state: 'pending',
  mode: 'end_time',
  boundary_at: BOUNDARY,
  runs: 2,
  last_error: 'previous failure',
}

describe('initialContinuationState (cap hit → cursor saved)', () => {
  it('saves a page resume point for page_offset sources', () => {
    expect(
      initialContinuationState({ supported: true, mode: 'page_offset' }, BOUNDARY, 21)
    ).toEqual(pagePending)
  })

  it('saves the oldest captured event for end_time sources', () => {
    expect(
      initialContinuationState({ supported: true, mode: 'end_time' }, BOUNDARY, undefined)
    ).toMatchObject({ state: 'pending', mode: 'end_time', boundary_at: BOUNDARY })
  })

  it('records an unsupported source explicitly', () => {
    expect(
      initialContinuationState({ supported: false, reason: 'surface_auth_gated' }, BOUNDARY, 21)
    ).toEqual({ state: 'unsupported', reason: 'surface_auth_gated' })
  })

  it('blocks instead of guessing when no resume point or timestamp exists', () => {
    expect(
      initialContinuationState({ supported: true, mode: 'page_offset' }, BOUNDARY, undefined)
    ).toMatchObject({ state: 'blocked', reason: 'resume_page_not_reported' })
    expect(
      initialContinuationState({ supported: true, mode: 'end_time' }, null, undefined)
    ).toMatchObject({ state: 'blocked', reason: 'no_event_timestamp' })
  })
})

describe('marker parsing', () => {
  it('derives a resume page from a pre-#440 marker (forward run started at page 1)', () => {
    const parsed = parseTruncationMarker({
      detected_at: '2026-07-11T00:00:00Z',
      page_cap: 20,
      oldest_captured_at: BOUNDARY,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(
      effectiveContinuationState(parsed.marker, { supported: true, mode: 'page_offset' })
    ).toEqual(pagePending)
  })

  it('round-trips a stored continuation', () => {
    const parsed = parseTruncationMarker({
      detected_at: 'x',
      page_cap: 20,
      oldest_captured_at: BOUNDARY,
      continuation: timePending,
    })
    expect(parsed).toEqual({
      ok: true,
      marker: expect.objectContaining({ continuation: timePending }),
    })
  })

  it('fails closed on malformed markers', () => {
    expect(parseTruncationMarker('nope')).toMatchObject({ ok: false })
    expect(parseTruncationMarker({ page_cap: 0 })).toMatchObject({ ok: false })
    expect(
      parseTruncationMarker({
        page_cap: 20,
        oldest_captured_at: BOUNDARY,
        continuation: {
          state: 'pending',
          mode: 'page_offset',
          resume_page: 'x',
          boundary_at: BOUNDARY,
        },
      })
    ).toEqual({ ok: false, reason: 'marker_continuation_invalid' })
  })
})

describe('continuationRequest', () => {
  it('overlaps one page for page_offset and starts 1ms above the boundary for end_time', () => {
    expect(continuationRequest(pagePending)).toEqual({ mode: 'page_offset', startPage: 20 })
    expect(continuationRequest(timePending)).toEqual({
      mode: 'end_time',
      endTimeMs: Date.parse(BOUNDARY) + 1,
    })
  })
})

describe('evaluateContinuationRun: page_offset', () => {
  const request = { mode: 'page_offset' as const, startPage: 20 }

  it('resume → older pages advance the boundary and resume page', () => {
    const decision = evaluateContinuationRun(pagePending, request, {
      pages: [
        { pageIndex: 20, rows: [order('2026-07-10T00:00:05.000Z'), order(BOUNDARY)] },
        { pageIndex: 21, rows: [order('2026-07-09T00:00:00.000Z')] },
      ],
      capReached: { nextPage: 22 },
      pageCap: 2,
    })
    expect(decision).toEqual({
      action: 'publish_and_advance',
      next: {
        ...pagePending,
        resume_page: 22,
        boundary_at: '2026-07-09T00:00:00.000Z',
        runs: 1,
      },
    })
  })

  it('exhaustion (no cut) → publish and clear', () => {
    expect(
      evaluateContinuationRun(pagePending, request, {
        pages: [{ pageIndex: 20, rows: [order(BOUNDARY), order('2026-07-01T00:00:00.000Z')] }],
        capReached: null,
        pageCap: 2,
      })
    ).toEqual({ action: 'publish_and_clear' })
  })

  it('no overlap on the first page → publish nothing and step back one budget', () => {
    expect(
      evaluateContinuationRun(pagePending, request, {
        pages: [{ pageIndex: 20, rows: [order('2026-07-01T00:00:00.000Z')] }],
        capReached: null,
        pageCap: 5,
      })
    ).toEqual({
      action: 'reject',
      reason: 'overlap_not_proven',
      next: { ...pagePending, resume_page: 16, runs: 1, last_error: 'overlap_not_proven' },
    })
  })

  it('no overlap even from page 1 → blocked', () => {
    const atStart = { ...pagePending, resume_page: 2 }
    expect(
      evaluateContinuationRun(
        atStart,
        { mode: 'page_offset', startPage: 1 },
        {
          pages: [{ pageIndex: 1, rows: [order('2026-07-01T00:00:00.000Z')] }],
          capReached: null,
          pageCap: 5,
        }
      )
    ).toMatchObject({ action: 'reject', next: { state: 'blocked', reason: 'overlap_not_proven' } })
  })

  it('a cut without a reported resume page blocks', () => {
    expect(
      evaluateContinuationRun(pagePending, request, {
        pages: [{ pageIndex: 20, rows: [order(BOUNDARY)] }],
        capReached: { nextPage: undefined },
        pageCap: 2,
      })
    ).toMatchObject({ action: 'reject', next: { state: 'blocked' } })
  })
})

describe('evaluateContinuationRun: end_time', () => {
  const request = { mode: 'end_time' as const, endTimeMs: Date.parse(BOUNDARY) + 1 }

  it('advances the boundary to the oldest row on a repeated cut', () => {
    expect(
      evaluateContinuationRun(timePending, request, {
        pages: [{ pageIndex: 1, rows: [order(BOUNDARY), order('2026-07-05T00:00:00.000Z')] }],
        capReached: { nextPage: undefined },
        pageCap: 25,
      })
    ).toEqual({
      action: 'publish_and_advance',
      next: { ...timePending, boundary_at: '2026-07-05T00:00:00.000Z', runs: 3, last_error: null },
    })
  })

  it('exhaustion → publish and clear (including an empty window)', () => {
    expect(
      evaluateContinuationRun(timePending, request, { pages: [], capReached: null, pageCap: 25 })
    ).toEqual({ action: 'publish_and_clear' })
  })

  it('rows newer than the window bound → reject and block (source ignored endTime)', () => {
    expect(
      evaluateContinuationRun(timePending, request, {
        pages: [{ pageIndex: 1, rows: [order('2026-07-20T00:00:00.000Z')] }],
        capReached: null,
        pageCap: 25,
      })
    ).toMatchObject({ action: 'reject', next: { state: 'blocked', reason: 'window_not_honored' } })
  })

  it('a cut that cannot move the boundary blocks with no_progress', () => {
    expect(
      evaluateContinuationRun(timePending, request, {
        pages: [{ pageIndex: 1, rows: [order(BOUNDARY, 'a'), order(BOUNDARY, 'b')] }],
        capReached: { nextPage: undefined },
        pageCap: 25,
      })
    ).toMatchObject({
      action: 'publish_and_advance',
      next: { state: 'blocked', reason: 'no_progress' },
    })
  })
})

describe('oldestEventAt', () => {
  it('normalizes and ignores unparseable timestamps', () => {
    expect(oldestEventAt([order('2026-07-02T00:00:00Z'), order('bad'), order(BOUNDARY)])).toBe(
      '2026-07-02T00:00:00.000Z'
    )
    expect(oldestEventAt([])).toBeNull()
  })
})
