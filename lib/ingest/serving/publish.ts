/**
 * Serving-layer publish gate (spec §2.1 STAGING→SERVING, §5.1).
 *
 * Tier-A flow: RAW written → rows parsed+validated → snapshot row records
 * the count-check verdict → ONLY IF PASSED do entries/traders/headline
 * stats reach serving (transactionally). A failed snapshot leaves the last
 * good snapshot live; serving reads always resolve "latest passed".
 *
 * WORKER-ONLY MODULE (direct PG).
 */

import type { PoolClient } from 'pg'
import { getIngestPool, ingestClientConnect } from '../db'
import type {
  BoardSeriesBlock,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
  ParsedHistoryRow,
  HistoryKind,
  SourceRow,
} from '../core/types'
import type { RejectedRow } from '../staging/validate'
import { deriveMissingRatios, deriveRiskFromBlocks } from '../core/series-risk'

/** PURE-DEX sources the spec authorizes to self-compute risk from chain data
 *  (§31/32/34: "所有数据要靠我们链上算"). CEX gives real Sharpe on its page —
 *  self-deriving a daily-approx there is inaccurate (user directive 2026-07-02),
 *  so it's gated OUT for every CEX source. */
const SELF_DERIVE_RISK_SOURCES = new Set(['hyperliquid', 'gmx', 'gtrade'])
import {
  BOOTSTRAP_DEVIATION_PCT,
  ROLLING_DEVIATION_PCT,
  evaluateCount,
  getCountBaseline,
  type CountVerdict,
} from '../staging/count-check'

async function lockSourcePublication(client: PoolClient, sourceId: number): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `arena.publish-board-series:${sourceId}`,
  ])
}

export interface PublishSnapshotInput {
  src: SourceRow
  timeframe: 7 | 30 | 90
  rows: ParsedLeaderboardRow[]
  rejects: RejectedRow[]
  rawObjectId: number | null
  isDerived?: boolean
  /** Override sources.expected_count as the day-one baseline. Derived
   *  boards (spec §1.1-C) have no upstream count — pass null so bootstrap
   *  cycles pass on actual; once 7 derived snapshots exist the rolling
   *  median takes over as usual. undefined = use sources.expected_count. */
  expectedCountOverride?: number | null
}

export interface PublishSnapshotResult {
  snapshotId: number
  scrapedAt: string
  verdict: CountVerdict
  published: boolean
  traderIds: Map<string, number> // exchange_trader_id → arena.traders.id
}

async function insertRejects(
  client: PoolClient,
  sourceId: number,
  rawObjectId: number | null,
  rejects: RejectedRow[]
): Promise<void> {
  if (rejects.length === 0) return
  await client.query(
    `INSERT INTO arena.staging_rejects (source_id, raw_object_id, reason, row_payload)
     SELECT $1, $2, r.reason, r.payload
       FROM jsonb_to_recordset($3::jsonb) AS r(reason text, payload jsonb)`,
    [
      sourceId,
      rawObjectId,
      JSON.stringify(rejects.map((r) => ({ reason: r.reason, payload: r.payload ?? {} }))),
    ]
  )
}

/** Batch-upsert traders rows; returns exchange_trader_id → id. */
async function upsertTraders(
  client: PoolClient,
  sourceId: number,
  rows: ParsedLeaderboardRow[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (rows.length === 0) return map
  const { rows: out } = await client.query<{ id: number; exchange_trader_id: string }>(
    `INSERT INTO arena.traders
       (source_id, exchange_trader_id, nickname, avatar_url_origin, wallet_address,
        trader_kind, bot_strategy, meta, last_seen_at)
     SELECT $1, r.exchange_trader_id, r.nickname, r.avatar_url_origin, r.wallet_address,
            r.trader_kind, r.bot_strategy, COALESCE(r.trader_meta, '{}'::jsonb), now()
       FROM jsonb_to_recordset($2::jsonb) AS r(
         exchange_trader_id text, nickname text, avatar_url_origin text,
         wallet_address text, trader_kind text, bot_strategy text, trader_meta jsonb)
     ON CONFLICT (source_id, exchange_trader_id) DO UPDATE SET
       nickname          = COALESCE(EXCLUDED.nickname, arena.traders.nickname),
       avatar_url_origin = COALESCE(EXCLUDED.avatar_url_origin, arena.traders.avatar_url_origin),
       wallet_address    = COALESCE(EXCLUDED.wallet_address, arena.traders.wallet_address),
       -- merge, never erase: adapter routing facts (e.g. UTA portfolio_id)
       meta              = arena.traders.meta || EXCLUDED.meta,
       last_seen_at      = now()
     RETURNING id, exchange_trader_id`,
    [
      sourceId,
      JSON.stringify(
        rows.map((r) => ({
          exchange_trader_id: r.exchangeTraderId,
          nickname: r.nickname,
          avatar_url_origin: r.avatarUrlOrigin,
          wallet_address: r.walletAddress,
          trader_kind: r.traderKind,
          bot_strategy: r.botStrategy,
          trader_meta: r.traderMeta ?? null,
        }))
      ),
    ]
  )
  for (const row of out) map.set(row.exchange_trader_id, row.id)
  return map
}

/**
 * Publish one Tier-A leaderboard crawl through the gate.
 * Headline stats upsert uses COALESCE so a sparse board never erases
 * richer profile-crawl data; roi/pnl/win_rate from the board are
 * authoritative for ranking (cross-checked against profiles per §5.3).
 */
export async function publishLeaderboardSnapshot(
  input: PublishSnapshotInput
): Promise<PublishSnapshotResult> {
  const { src, timeframe, rows, rejects, rawObjectId } = input
  const expectedCount =
    input.expectedCountOverride !== undefined ? input.expectedCountOverride : src.expected_count
  const { baseline, isBootstrap, shifted } = await getCountBaseline(
    src.id,
    timeframe,
    expectedCount
  )
  if (shifted) {
    console.warn(
      `[publish] ${src.slug} tf${timeframe}: sustained level-shift detected — ` +
        `adopting new baseline ${baseline} (was frozen, board un-stuck), actual=${rows.length}`
    )
  }
  const verdict = evaluateCount(
    rows.length,
    baseline,
    isBootstrap ? BOOTSTRAP_DEVIATION_PCT : ROLLING_DEVIATION_PCT
  )

  const client = await ingestClientConnect()
  try {
    await client.query('BEGIN')
    // A snapshot and its board series are separate transactions in Tier A.
    // Sharing this source lock with replay prevents an older RAW re-parse
    // from crossing a newer snapshot commit and winning the final write.
    await lockSourcePublication(client, src.id)

    const { rows: snap } = await client.query<{ id: number; scraped_at: string }>(
      `INSERT INTO arena.leaderboard_snapshots
         (source_id, timeframe, expected_count, actual_count, baseline_used,
          count_check_passed, is_derived, raw_object_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, scraped_at::text AS scraped_at`,
      // ::text — node-pg would otherwise hydrate a JS Date (ms precision),
      // truncating pg's microseconds; entries.scraped_at must round-trip
      // losslessly so it stays exactly equal to the snapshot row's value.
      [
        src.id,
        timeframe,
        expectedCount,
        rows.length,
        verdict.baselineUsed,
        verdict.passed,
        input.isDerived ?? false,
        rawObjectId,
      ]
    )
    const snapshotId = snap[0].id
    const scrapedAt = snap[0].scraped_at

    await insertRejects(client, src.id, rawObjectId, rejects)

    let traderIds = new Map<string, number>()
    if (verdict.passed && rows.length > 0) {
      traderIds = await upsertTraders(client, src.id, rows)

      await client.query(
        `INSERT INTO arena.leaderboard_entries
           (scraped_at, snapshot_id, trader_id, timeframe, rank,
            headline_roi, headline_pnl, headline_win_rate, currency, raw)
         SELECT $1, $2, t.id, $3, r.rank, r.roi, r.pnl, r.win_rate, $4, r.raw
           FROM jsonb_to_recordset($5::jsonb) AS r(
             exchange_trader_id text, rank int, roi numeric, pnl numeric,
             win_rate numeric, raw jsonb)
           JOIN arena.traders t
             ON t.source_id = $6 AND t.exchange_trader_id = r.exchange_trader_id`,
        [
          scrapedAt,
          snapshotId,
          timeframe,
          src.currency,
          JSON.stringify(
            rows.map((r) => ({
              exchange_trader_id: r.exchangeTraderId,
              rank: r.rank,
              roi: r.headlineRoi,
              pnl: r.headlinePnl,
              win_rate: r.headlineWinRate,
              raw: r.raw,
            }))
          ),
          src.id,
        ]
      )

      // Native upstream boards may seed headline stats (Tier A guarantee:
      // profile first screen renders with zero on-demand fetching, spec
      // §2.3-A). A derived board is built FROM trader_stats, so writing its
      // rows back would manufacture a new as_of and keep stale substrate alive
      // forever. Derived snapshots therefore publish membership/ranks only.
      //
      // mdd/sharpe/aum/copier_count: board-level stats for PROFILE-LESS sources
      // (blofin). Parsers that DON'T set them send null, and the
      // COALESCE(EXCLUDED, existing) keeps any richer profile-crawl value — so
      // this never clobbers profile sources, but backfills profile-less ones.
      if (!input.isDerived) {
        await client.query(
          `INSERT INTO arena.trader_stats
           (trader_id, timeframe, as_of, currency, roi, pnl, win_rate, mdd, sharpe, aum, copier_count, copier_pnl, volume,
            win_positions, total_positions, holding_duration_avg, extras)
         SELECT t.id, $1, $2, $3, r.roi, r.pnl, r.win_rate, r.mdd, r.sharpe, r.aum, r.copier_count, r.copier_pnl, r.volume,
                r.win_positions, r.total_positions,
                CASE WHEN r.holding_hours IS NOT NULL THEN make_interval(secs => r.holding_hours * 3600) ELSE NULL END,
                COALESCE(r.extras, '{}'::jsonb)
           FROM jsonb_to_recordset($4::jsonb) AS r(
             exchange_trader_id text, roi numeric, pnl numeric, win_rate numeric,
             mdd numeric, sharpe numeric, aum numeric, copier_count integer, copier_pnl numeric, volume numeric,
             win_positions integer, total_positions integer, holding_hours numeric, extras jsonb)
           JOIN arena.traders t
             ON t.source_id = $5 AND t.exchange_trader_id = r.exchange_trader_id
         ON CONFLICT (trader_id, timeframe) DO UPDATE SET
           as_of           = EXCLUDED.as_of,
           currency        = EXCLUDED.currency,
           roi             = COALESCE(EXCLUDED.roi, arena.trader_stats.roi),
           pnl             = COALESCE(EXCLUDED.pnl, arena.trader_stats.pnl),
           win_rate        = COALESCE(EXCLUDED.win_rate, arena.trader_stats.win_rate),
           mdd             = COALESCE(EXCLUDED.mdd, arena.trader_stats.mdd),
           sharpe          = COALESCE(EXCLUDED.sharpe, arena.trader_stats.sharpe),
           aum             = COALESCE(EXCLUDED.aum, arena.trader_stats.aum),
           copier_count    = COALESCE(EXCLUDED.copier_count, arena.trader_stats.copier_count),
           copier_pnl      = COALESCE(EXCLUDED.copier_pnl, arena.trader_stats.copier_pnl),
           volume          = COALESCE(EXCLUDED.volume, arena.trader_stats.volume),
           win_positions   = COALESCE(EXCLUDED.win_positions, arena.trader_stats.win_positions),
           total_positions = COALESCE(EXCLUDED.total_positions, arena.trader_stats.total_positions),
           holding_duration_avg = COALESCE(EXCLUDED.holding_duration_avg, arena.trader_stats.holding_duration_avg),
           -- Board extras merge INTO existing (profile extras preserved, board
           -- keys win); empty board extras = no-op so profile sources untouched.
           extras          = CASE WHEN EXCLUDED.extras = '{}'::jsonb THEN arena.trader_stats.extras
                                  ELSE COALESCE(arena.trader_stats.extras, '{}'::jsonb) || EXCLUDED.extras END`,
          [
            timeframe,
            scrapedAt,
            src.currency,
            JSON.stringify(
              rows.map((r) => ({
                exchange_trader_id: r.exchangeTraderId,
                roi: r.headlineRoi,
                pnl: r.headlinePnl,
                win_rate: r.headlineWinRate,
                mdd: r.headlineMdd ?? null,
                sharpe: r.headlineSharpe ?? null,
                aum: r.headlineAum ?? null,
                copier_count: r.headlineCopierCount ?? null,
                copier_pnl: r.headlineCopierPnl ?? null,
                volume: r.headlineVolume ?? null,
                win_positions: r.headlineWinPositions ?? null,
                total_positions: r.headlineTotalPositions ?? null,
                holding_hours: r.headlineHoldingDurationHours ?? null,
                extras: r.headlineExtras ?? null,
              }))
            ),
            src.id,
          ]
        )
      }
    }

    await client.query('COMMIT')
    return { snapshotId, scrapedAt, verdict, published: verdict.passed, traderIds }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Resolve (or create) a single trader id — Tier-C path for long-tail views. */
export async function resolveTraderId(src: SourceRow, exchangeTraderId: string): Promise<number> {
  const { rows } = await getIngestPool().query<{ id: number }>(
    `INSERT INTO arena.traders (source_id, exchange_trader_id)
     VALUES ($1, $2)
     ON CONFLICT (source_id, exchange_trader_id)
     DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [src.id, exchangeTraderId]
  )
  return rows[0].id
}

/** Publish a profile crawl: full stats blocks + chart series + identity refresh. */
export async function publishProfile(
  src: SourceRow,
  traderId: number,
  profile: ParsedProfile,
  opts: { fullSeries: boolean } // false → long-tail: latest snapshot only (spec §13.1)
): Promise<void> {
  const client = await ingestClientConnect()
  try {
    await client.query('BEGIN')

    if (profile.nickname || profile.avatarUrlOrigin) {
      await client.query(
        `UPDATE arena.traders SET
           nickname = COALESCE($2, nickname),
           avatar_url_origin = COALESCE($3, avatar_url_origin),
           last_seen_at = now()
         WHERE id = $1`,
        [traderId, profile.nickname, profile.avatarUrlOrigin]
      )
    }

    // A parser may prove a short timeframe while a wider one remains partial.
    // Treat each incomplete window as immutable serving state: keep every old
    // typed value/as-of/series and merge only the newest audit evidence.
    const incompleteTimeframes = new Set(
      profile.stats
        .filter((s) => s.extras.profile_window_metrics_complete === false)
        .map((s) => s.timeframe)
    )

    // Self-derived risk ratios are only legitimate for PURE-DEX sources whose
    // data has no exchange-provided value to harvest (spec §31/32/34: HL/GMX/
    // gTrade "所有数据要靠我们链上算"). For CEX the exchange provides the real
    // Sharpe on its page (e.g. Binance) — a daily-approx self-fill would be
    // INACCURATE and must NOT masquerade as the exchange value. Harvest real or
    // leave honest NULL. (User directive 2026-07-02.)
    if (SELF_DERIVE_RISK_SOURCES.has(src.slug)) {
      deriveMissingRatios(
        profile.stats.filter((s) => !incompleteTimeframes.has(s.timeframe)),
        profile.series.filter((s) => !incompleteTimeframes.has(s.timeframe))
      )
    }

    for (const s of profile.stats) {
      if (incompleteTimeframes.has(s.timeframe)) {
        // UPDATE-only is intentional: a cold trader gets no fresh-looking
        // empty row, while a previously proven row keeps every typed column.
        // The as-of predicate prevents an older failed job from overwriting
        // failure evidence produced after a newer successful publication.
        await client.query(
          `UPDATE arena.trader_stats
              SET extras = COALESCE(extras, '{}'::jsonb) || $3::jsonb
            WHERE trader_id = $1 AND timeframe = $2
              AND as_of <= $4::timestamptz`,
          [traderId, s.timeframe, JSON.stringify(s.extras), s.asOf]
        )
        continue
      }

      // A deep-enrichment failure/defer must not erase the last proven fill
      // metrics while the independent portfolio/risk fields keep refreshing.
      // Complete empty activity sets this flag true and intentionally writes 0.
      const preserveFillMetrics = s.extras.fills_metrics_complete === false
      await client.query(
        `INSERT INTO arena.trader_stats
           (trader_id, timeframe, as_of, currency, roi, pnl, sharpe, mdd, win_rate,
            win_positions, total_positions, copier_pnl, copier_count, aum, volume,
            profit_share_rate, holding_duration_avg, trading_preferences, extras)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 make_interval(secs => $17), $18, $19)
         ON CONFLICT (trader_id, timeframe) DO UPDATE SET
           as_of = EXCLUDED.as_of, currency = EXCLUDED.currency,
           roi = EXCLUDED.roi, pnl = EXCLUDED.pnl, sharpe = EXCLUDED.sharpe,
           mdd = EXCLUDED.mdd,
           win_rate = CASE WHEN $20 THEN arena.trader_stats.win_rate ELSE EXCLUDED.win_rate END,
           win_positions = CASE WHEN $20 THEN arena.trader_stats.win_positions ELSE EXCLUDED.win_positions END,
           total_positions = CASE WHEN $20 THEN arena.trader_stats.total_positions ELSE EXCLUDED.total_positions END,
           copier_pnl = EXCLUDED.copier_pnl, copier_count = EXCLUDED.copier_count,
           aum = EXCLUDED.aum, volume = EXCLUDED.volume,
           profit_share_rate = EXCLUDED.profit_share_rate,
           holding_duration_avg = CASE WHEN $20 THEN arena.trader_stats.holding_duration_avg ELSE EXCLUDED.holding_duration_avg END,
           trading_preferences = EXCLUDED.trading_preferences,
           extras = CASE WHEN $20
             THEN COALESCE(arena.trader_stats.extras, '{}'::jsonb) || EXCLUDED.extras
             ELSE EXCLUDED.extras
           END`,
        [
          traderId,
          s.timeframe,
          s.asOf,
          src.currency,
          s.roi,
          s.pnl,
          s.sharpe,
          s.mdd,
          s.winRate,
          s.winPositions,
          s.totalPositions,
          s.copierPnl,
          s.copierCount,
          s.aum,
          s.volume,
          s.profitShareRate,
          s.holdingDurationAvgHours === null ? null : s.holdingDurationAvgHours * 3600,
          s.tradingPreferences ? JSON.stringify(s.tradingPreferences) : null,
          JSON.stringify(s.extras),
          preserveFillMetrics,
        ]
      )
    }

    for (const replacement of profile.replaceSeries ?? []) {
      if (incompleteTimeframes.has(replacement.timeframe)) continue
      const declaredMetrics = [
        ...new Set(replacement.metrics.map((metric) => metric.trim())),
      ].filter(Boolean)
      // Tier-C intentionally persists only the newest point. Deleting a proven
      // non-empty replacement first would therefore collapse an existing rich
      // Tier-B chart to one point. Preserve those keys and only upsert their
      // endpoint below. A declared key with no points is still a confirmed
      // empty snapshot, so it must clear stale daily and weekly series even on
      // the long-tail path.
      const metrics = opts.fullSeries
        ? declaredMetrics
        : declaredMetrics.filter(
            (metric) =>
              !profile.series.some(
                (series) =>
                  series.timeframe === replacement.timeframe &&
                  series.metric === metric &&
                  series.points.length > 0
              )
          )
      if (metrics.length === 0) continue
      // A complete rolling-window snapshot owns these series keys. Removing
      // both stores first makes a confirmed empty window clear stale charts;
      // any later insert failure rolls the deletes back with the transaction.
      await client.query(
        `DELETE FROM arena.trader_series
          WHERE trader_id = $1 AND timeframe = $2 AND metric = ANY($3::text[])`,
        [traderId, replacement.timeframe, metrics]
      )
      await client.query(
        `DELETE FROM arena.trader_series_weekly
          WHERE trader_id = $1 AND timeframe = $2 AND metric = ANY($3::text[])`,
        [traderId, replacement.timeframe, metrics]
      )
    }

    for (const series of profile.series) {
      if (incompleteTimeframes.has(series.timeframe)) continue
      const points = opts.fullSeries ? series.points : series.points.slice(-1) // long tail keeps only the latest point
      if (points.length === 0) continue
      await client.query(
        `INSERT INTO arena.trader_series (trader_id, timeframe, metric, ts, value, currency)
         SELECT $1, $2, $3, p.ts::timestamptz, p.value, $4
           FROM jsonb_to_recordset($5::jsonb) AS p(ts text, value numeric)
         ON CONFLICT (trader_id, timeframe, metric, ts)
         DO UPDATE SET value = EXCLUDED.value`,
        [traderId, series.timeframe, series.metric, src.currency, JSON.stringify(points)]
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Board-level "free series" publish (spec §13.1): the Tier-A leaderboard row
 * already carries a per-trader sparkline for SOME sources (okx, toobit, xt,
 * blofin, bitunix, binance_web3), so every ranked trader — not just the topN
 * that Tier-B crawls — gets a chart at zero extra fetch cost. Idempotent
 * upsert into the SAME arena.trader_series table the profile crawl writes,
 * so the maintenance downsample/retention (90d native → weekly rollup) and
 * all serving reads apply unchanged. A later Tier-B/C profile crawl with a
 * richer/longer series simply overwrites by (trader,tf,metric,ts) on conflict.
 *
 * `seriesByTrader` keys are exchange_trader_ids; `traderIds` is the
 * exchange_trader_id → arena.traders.id map from the snapshot publish.
 * Returns the number of series points written.
 */
export interface PreparedBoardSeriesRow {
  trader_id: number
  timeframe: number
  metric: string
  ts: string
  value: number
}

export interface PublishBoardSeriesOptions {
  /** Replay-only guard: selected latest-passed snapshot identity per timeframe. */
  expectedLatestSnapshots?: ReadonlyMap<
    number,
    { id: number; rawObjectId: number; scrapedAt: string }
  >
}

/** Pure publication-boundary preparation, also used by replay dry-runs. */
export function prepareBoardSeriesRows(
  seriesByTrader: Map<string, BoardSeriesBlock[]>,
  traderIds: Map<string, number>
): { rows: PreparedBoardSeriesRow[]; traders: number } {
  // Flatten to one row-set: {trader_id, timeframe, metric, ts, value},
  // de-duplicated by the (trader_id, timeframe, metric, ts) upsert key —
  // a trader can repeat across board pages, and a sparkline can carry the
  // same date twice; Postgres rejects "ON CONFLICT affecting a row twice"
  // unless we collapse those here first (last value wins).
  const byKey = new Map<string, PreparedBoardSeriesRow>()
  const tradersSeen = new Set<number>()
  for (const [exchangeTraderId, blocks] of seriesByTrader) {
    const traderId = traderIds.get(exchangeTraderId)
    if (traderId === undefined) continue // not in the passed snapshot
    for (const block of blocks) {
      for (const p of block.points) {
        const parsedTs = Date.parse(p.ts)
        if (
          ![7, 30, 90].includes(block.timeframe) ||
          block.metric.trim().length === 0 ||
          !Number.isFinite(parsedTs) ||
          !Number.isFinite(p.value)
        ) {
          continue
        }
        const ts = new Date(parsedTs).toISOString()
        byKey.set(`${traderId}|${block.timeframe}|${block.metric}|${ts}`, {
          trader_id: traderId,
          timeframe: block.timeframe,
          metric: block.metric,
          ts,
          value: p.value,
        })
        tradersSeen.add(traderId)
      }
    }
  }
  return { rows: [...byKey.values()], traders: tradersSeen.size }
}

export async function publishBoardSeries(
  src: SourceRow,
  seriesByTrader: Map<string, BoardSeriesBlock[]>,
  traderIds: Map<string, number>,
  options: PublishBoardSeriesOptions = {}
): Promise<{ traders: number; points: number }> {
  const prepared = prepareBoardSeriesRows(seriesByTrader, traderIds)
  const flat = prepared.rows
  const tradersWithSeries = prepared.traders
  if (flat.length === 0) return { traders: 0, points: 0 }

  // Chunk the insert — boards reach thousands of traders × ~30-90 pts each.
  const CHUNK = 5000
  const client = await ingestClientConnect()
  let transactionStarted = false
  try {
    await client.query('BEGIN')
    transactionStarted = true
    // Serialize live Tier-A publication and operator replay for one source.
    // Transaction-scoped lock is safe through PgBouncer transaction mode.
    await lockSourcePublication(client, src.id)
    const expectedSnapshots = options.expectedLatestSnapshots
    if (expectedSnapshots && expectedSnapshots.size > 0) {
      const timeframes = [...expectedSnapshots.keys()]
      const { rows } = await client.query<{
        timeframe: number
        id: number
        raw_object_id: number | null
        scraped_at: string
      }>(
        `SELECT DISTINCT ON (timeframe)
                timeframe, id, raw_object_id, scraped_at::text
           FROM arena.leaderboard_snapshots
          WHERE source_id = $1 AND count_check_passed
            AND timeframe = ANY($2::smallint[])
          ORDER BY timeframe, scraped_at DESC, id DESC`,
        [src.id, timeframes]
      )
      const current = new Map(rows.map((row) => [row.timeframe, row]))
      for (const [timeframe, expected] of expectedSnapshots) {
        const latest = current.get(timeframe)
        if (
          latest?.id !== expected.id ||
          latest.raw_object_id !== expected.rawObjectId ||
          new Date(latest.scraped_at).toISOString() !== expected.scrapedAt
        ) {
          throw new Error(
            `[board-series] stale replay snapshot for ${src.slug} ${timeframe}d: expected=${expected.id}, latest=${latest?.id ?? 'missing'}`
          )
        }
      }
    }
    for (let i = 0; i < flat.length; i += CHUNK) {
      const slice = flat.slice(i, i + CHUNK)
      const result = await client.query(
        `INSERT INTO arena.trader_series (trader_id, timeframe, metric, ts, value, currency)
         SELECT r.trader_id, r.timeframe, r.metric, r.ts::timestamptz, r.value, $2
           FROM jsonb_to_recordset($1::jsonb) AS r(
             trader_id bigint, timeframe int, metric text, ts text, value numeric)
         ON CONFLICT (trader_id, timeframe, metric, ts)
         DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(slice), src.currency]
      )
      if (result.rowCount !== slice.length) {
        throw new Error(
          `[board-series] write count mismatch for ${src.slug}: expected=${slice.length}, actual=${result.rowCount ?? 0}`
        )
      }
    }

    // Board-path self-derivation — PURE-DEX only (see publishProfile note +
    // user directive 2026-07-02). CEX gets no self-filled risk ratios: harvest
    // the exchange's real value or leave honest NULL.
    const derived: Array<{
      trader_id: number
      timeframe: number
      sharpe: number | null
      sortino: number | null
      volatility: number | null
    }> = []
    if (SELF_DERIVE_RISK_SOURCES.has(src.slug)) {
      for (const [exchangeTraderId, blocks] of seriesByTrader) {
        const traderId = traderIds.get(exchangeTraderId)
        if (traderId === undefined) continue
        const byTf = new Map<number, BoardSeriesBlock[]>()
        for (const b of blocks) {
          const arr = byTf.get(b.timeframe) ?? []
          arr.push(b)
          byTf.set(b.timeframe, arr)
        }
        for (const [timeframe, tfBlocks] of byTf) {
          const r = deriveRiskFromBlocks(tfBlocks)
          if (r && (r.sharpe !== null || r.sortino !== null || r.volatility !== null)) {
            derived.push({ trader_id: traderId, timeframe, ...r })
          }
        }
      }
    } // end SELF_DERIVE_RISK_SOURCES gate
    for (let i = 0; i < derived.length; i += CHUNK) {
      const slice = derived.slice(i, i + CHUNK)
      await client.query(
        `UPDATE arena.trader_stats ts SET
           sharpe = COALESCE(ts.sharpe, d.sharpe),
           extras = ts.extras
             || CASE WHEN ts.extras ? 'sortino' OR d.sortino IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('sortino', d.sortino) END
             || CASE WHEN ts.extras ? 'volatility' OR d.volatility IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('volatility', d.volatility) END
             || CASE WHEN ts.sharpe IS NOT NULL OR d.sharpe IS NULL THEN '{}'::jsonb
                     ELSE '{"risk_self_derived": true}'::jsonb END
         FROM jsonb_to_recordset($1::jsonb) AS d(
           trader_id bigint, timeframe int, sharpe numeric, sortino numeric, volatility numeric)
         WHERE ts.trader_id = d.trader_id AND ts.timeframe = d.timeframe
           AND (ts.sharpe IS NULL OR NOT (ts.extras ? 'sortino') OR NOT (ts.extras ? 'volatility'))`,
        [JSON.stringify(slice)]
      )
    }
    await client.query('COMMIT')
    transactionStarted = false
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the publication error; the broken client is released below.
      }
    }
    throw err
  } finally {
    client.release()
  }
  return { traders: tradersWithSeries, points: flat.length }
}

/**
 * Collapse per-order position rows into one net position per (symbol, side).
 * Several sources return the open-orders list rather than netted positions
 * (blofin, btcc, gate), so multiple rows share the (trader, symbol, side)
 * upsert key → "ON CONFLICT cannot affect row a second time". Aggregate: size
 * summed, entry/mark size-weighted, unrealized_pnl summed, leverage = first.
 * Rows without a symbol are dropped (can't key). NULL side is preserved (it is
 * an honest "direction unverified" for CTP-style sources, not a collision).
 */
export function netPositions(positions: ParsedPosition[]): ParsedPosition[] {
  const byKey = new Map<
    string,
    { p: ParsedPosition; size: number; notional: number; markNotional: number; upnl: number | null }
  >()
  for (const p of positions) {
    if (!p.symbol) continue
    const key = `${p.symbol}|${p.side ?? ''}`
    const size = p.size ?? 0
    const agg = byKey.get(key)
    if (!agg) {
      byKey.set(key, {
        p: { ...p },
        size,
        notional: p.entryPrice !== null ? size * p.entryPrice : 0,
        markNotional: p.markPrice !== null ? size * p.markPrice : 0,
        upnl: p.unrealizedPnl,
      })
      continue
    }
    agg.size += size
    if (p.entryPrice !== null) agg.notional += size * p.entryPrice
    if (p.markPrice !== null) agg.markNotional += size * p.markPrice
    if (p.unrealizedPnl !== null) agg.upnl = (agg.upnl ?? 0) + p.unrealizedPnl
    if (agg.p.leverage === null) agg.p.leverage = p.leverage
  }
  return [...byKey.values()].map((a) => ({
    ...a.p,
    size: a.size > 0 ? a.size : a.p.size,
    entryPrice: a.size > 0 && a.notional > 0 ? a.notional / a.size : a.p.entryPrice,
    markPrice: a.size > 0 && a.markNotional > 0 ? a.markNotional / a.size : a.p.markPrice,
    unrealizedPnl: a.upnl,
  }))
}

/** Tier-D: fully replace a trader's open-positions snapshot (spec §2.3). */
export async function publishPositions(
  src: SourceRow,
  traderId: number,
  rawPositions: ParsedPosition[],
  asOf: string
): Promise<void> {
  const positions = netPositions(rawPositions)
  const client = await ingestClientConnect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM arena.positions_current WHERE trader_id = $1`, [traderId])
    if (positions.length > 0) {
      await client.query(
        `INSERT INTO arena.positions_current
           (trader_id, snapshot_at, as_of, symbol, side, leverage, size,
            entry_price, mark_price, unrealized_pnl, currency, raw)
         SELECT $1, now(), $2, p.symbol, p.side, p.leverage, p.size,
                p.entry_price, p.mark_price, p.unrealized_pnl, $3, p.raw
           FROM jsonb_to_recordset($4::jsonb) AS p(
             symbol text, side text, leverage numeric, size numeric,
             entry_price numeric, mark_price numeric, unrealized_pnl numeric, raw jsonb)
         ON CONFLICT (trader_id, symbol, side) DO UPDATE SET
           snapshot_at = EXCLUDED.snapshot_at, as_of = EXCLUDED.as_of,
           leverage = EXCLUDED.leverage, size = EXCLUDED.size,
           entry_price = EXCLUDED.entry_price, mark_price = EXCLUDED.mark_price,
           unrealized_pnl = EXCLUDED.unrealized_pnl, raw = EXCLUDED.raw`,
        [
          traderId,
          asOf,
          src.currency,
          JSON.stringify(
            positions.map((p) => ({
              symbol: p.symbol,
              side: p.side,
              leverage: p.leverage,
              size: p.size,
              entry_price: p.entryPrice,
              mark_price: p.markPrice,
              unrealized_pnl: p.unrealizedPnl,
              raw: p.raw,
            }))
          ),
        ]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Incremental history publish: idempotent upsert by dedupe_hash + cursor
 * update (spec §2.3 Histories). Returns rows actually written.
 */
export async function publishHistoryRows(
  src: SourceRow,
  traderId: number,
  kind: HistoryKind,
  rows: ParsedHistoryRow[],
  newCursor: string | null
): Promise<number> {
  if (rows.length === 0) return 0
  const client = await ingestClientConnect()
  try {
    await client.query('BEGIN')
    let written = 0

    if (kind === 'position_history') {
      const result = await client.query(
        `INSERT INTO arena.position_history
           (trader_id, opened_at, closed_at, symbol, side, leverage, size,
            entry_price, exit_price, realized_pnl, currency, dedupe_hash, raw)
         SELECT $1, r.opened_at::timestamptz, r.closed_at::timestamptz, r.symbol,
                r.side, r.leverage, r.size, r.entry_price, r.exit_price,
                r.realized_pnl, $2, r.dedupe_hash, r.raw
           FROM jsonb_to_recordset($3::jsonb) AS r(
             opened_at text, closed_at text, symbol text, side text,
             leverage numeric, size numeric, entry_price numeric,
             exit_price numeric, realized_pnl numeric, dedupe_hash text, raw jsonb)
         ON CONFLICT (closed_at, dedupe_hash) DO NOTHING`,
        [
          traderId,
          src.currency,
          JSON.stringify(
            rows
              .filter(
                (r): r is Extract<ParsedHistoryRow, { kind: 'position_history' }> =>
                  r.kind === 'position_history'
              )
              .map((r) => ({
                opened_at: r.openedAt,
                closed_at: r.closedAt,
                symbol: r.symbol,
                side: r.side,
                leverage: r.leverage,
                size: r.size,
                entry_price: r.entryPrice,
                exit_price: r.exitPrice,
                realized_pnl: r.realizedPnl,
                dedupe_hash: r.dedupeHash,
                raw: r.raw,
              }))
          ),
        ]
      )
      written = result.rowCount ?? 0
    } else if (kind === 'orders') {
      const result = await client.query(
        `INSERT INTO arena.order_records
           (trader_id, ts, kind, symbol, side, price, qty, currency, dedupe_hash, raw)
         SELECT $1, r.ts::timestamptz, r.order_kind, r.symbol, r.side, r.price,
                r.qty, $2, r.dedupe_hash, r.raw
           FROM jsonb_to_recordset($3::jsonb) AS r(
             ts text, order_kind text, symbol text, side text, price numeric,
             qty numeric, dedupe_hash text, raw jsonb)
         ON CONFLICT (ts, dedupe_hash) DO NOTHING`,
        [
          traderId,
          src.currency,
          JSON.stringify(
            rows
              .filter(
                (r): r is Extract<ParsedHistoryRow, { kind: 'orders' }> => r.kind === 'orders'
              )
              .map((r) => ({
                ts: r.ts,
                order_kind: r.orderKind,
                symbol: r.symbol,
                side: r.side,
                price: r.price,
                qty: r.qty,
                dedupe_hash: r.dedupeHash,
                raw: r.raw,
              }))
          ),
        ]
      )
      written = result.rowCount ?? 0
    } else if (kind === 'transfers') {
      const result = await client.query(
        `INSERT INTO arena.transfer_history
           (trader_id, ts, direction, asset, amount, currency, dedupe_hash, raw)
         SELECT $1, r.ts::timestamptz, r.direction, r.asset, r.amount, $2,
                r.dedupe_hash, r.raw
           FROM jsonb_to_recordset($3::jsonb) AS r(
             ts text, direction text, asset text, amount numeric,
             dedupe_hash text, raw jsonb)
         ON CONFLICT (ts, dedupe_hash) DO NOTHING`,
        [
          traderId,
          src.currency,
          JSON.stringify(
            rows
              .filter(
                (r): r is Extract<ParsedHistoryRow, { kind: 'transfers' }> => r.kind === 'transfers'
              )
              .map((r) => ({
                ts: r.ts,
                direction: r.direction,
                asset: r.asset,
                amount: r.amount,
                dedupe_hash: r.dedupeHash,
                raw: r.raw,
              }))
          ),
        ]
      )
      written = result.rowCount ?? 0
    } else {
      const result = await client.query(
        `INSERT INTO arena.copier_records
           (trader_id, ts, copier_label, copier_pnl, copier_invested,
            copy_duration_days, currency, dedupe_hash, raw)
         SELECT $1, r.ts::timestamptz, r.copier_label, r.copier_pnl,
                r.copier_invested, r.copy_duration_days, $2, r.dedupe_hash, r.raw
           FROM jsonb_to_recordset($3::jsonb) AS r(
             ts text, copier_label text, copier_pnl numeric,
             copier_invested numeric, copy_duration_days int,
             dedupe_hash text, raw jsonb)
         ON CONFLICT (ts, dedupe_hash) DO NOTHING`,
        [
          traderId,
          src.currency,
          JSON.stringify(
            rows
              .filter(
                (r): r is Extract<ParsedHistoryRow, { kind: 'copiers' }> => r.kind === 'copiers'
              )
              .map((r) => ({
                ts: r.ts,
                copier_label: r.copierLabel,
                copier_pnl: r.copierPnl,
                copier_invested: r.copierInvested,
                copy_duration_days: r.copyDurationDays,
                dedupe_hash: r.dedupeHash,
                raw: r.raw,
              }))
          ),
        ]
      )
      written = result.rowCount ?? 0
    }

    if (newCursor !== null) {
      await client.query(
        `INSERT INTO arena.ingest_cursors (trader_id, kind, cursor_value, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (trader_id, kind)
         DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()
         -- Caller checks are not enough: Tier-B and Tier-C can commit out of
         -- order. The database is the final monotonic checkpoint authority.
         WHERE EXCLUDED.cursor_value::timestamptz
               > arena.ingest_cursors.cursor_value::timestamptz`,
        [traderId, kind, newCursor]
      )
    }

    await client.query('COMMIT')
    return written
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Read the stored incremental cursor for (trader, kind). */
export async function getHistoryCursor(
  traderId: number,
  kind: HistoryKind
): Promise<string | null> {
  const { rows } = await getIngestPool().query<{ cursor_value: string }>(
    `SELECT cursor_value FROM arena.ingest_cursors WHERE trader_id = $1 AND kind = $2`,
    [traderId, kind]
  )
  return rows[0]?.cursor_value ?? null
}
