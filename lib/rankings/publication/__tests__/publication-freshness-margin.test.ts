/**
 * The publish side must stop trusting a source before the read side stops
 * serving the season it belongs to.
 *
 * Incident 2026-11-24 18:44Z: both sides used 48h. bitget_spot (zero ranked
 * rows) was 47.3h old when 7D was sealed at 18:01Z, crossed 48h at 18:44Z,
 * and arena.public_ranked_leaderboard_serving_seasons hid all 4,080 7D rows
 * until the next round could isolate it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS,
  PUBLIC_SERVING_SOURCE_MAX_AGE_HOURS,
  RANK_PUBLICATION_INTERVAL_HOURS,
  SOURCE_PUBLICATION_FRESHNESS_MARGIN_HOURS,
} from '../source-publication-evidence'

const root = join(__dirname, '..', '..', '..', '..')

describe('publication freshness margin', () => {
  it('isolates a source at least one full round before the read side expires it', () => {
    expect(
      DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS + RANK_PUBLICATION_INTERVAL_HOURS
    ).toBeLessThanOrEqual(PUBLIC_SERVING_SOURCE_MAX_AGE_HOURS)
    expect(SOURCE_PUBLICATION_FRESHNESS_MARGIN_HOURS).toBeGreaterThan(0)
    expect(DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS).toBe(
      PUBLIC_SERVING_SOURCE_MAX_AGE_HOURS -
        RANK_PUBLICATION_INTERVAL_HOURS -
        SOURCE_PUBLICATION_FRESHNESS_MARGIN_HOURS
    )
    expect(DEFAULT_SOURCE_PUBLICATION_MAX_AGE_HOURS).toBe(44)
  })

  it('keeps the read-side constant equal to the serving gate in the database', () => {
    const migration = readFileSync(
      join(
        root,
        'supabase/migrations/20260816184500_public_ranked_leaderboard_source_freshness_gate.sql'
      ),
      'utf8'
    )
    expect(migration).toContain(
      `serving.source_as_of <= p_observed_at - interval '${PUBLIC_SERVING_SOURCE_MAX_AGE_HOURS} hours'`
    )
  })

  it('derives the scoring cadence from the same constant', () => {
    const scheduler = readFileSync(join(root, 'worker/src/scheduler.ts'), 'utf8')
    expect(scheduler).toContain(
      'const SCORE_INTERVALS_MS = RANK_PUBLICATION_INTERVAL_HOURS * 3600_000'
    )
  })
})
