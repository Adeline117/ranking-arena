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
import { getIngestPool } from '../db'
import type {
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
  ParsedHistoryRow,
  HistoryKind,
  SourceRow,
} from '../core/types'
import type { RejectedRow } from '../staging/validate'
import {
  BOOTSTRAP_DEVIATION_PCT,
  ROLLING_DEVIATION_PCT,
  evaluateCount,
  getCountBaseline,
  type CountVerdict,
} from '../staging/count-check'

export interface PublishSnapshotInput {
  src: SourceRow
  timeframe: 7 | 30 | 90
  rows: ParsedLeaderboardRow[]
  rejects: RejectedRow[]
  rawObjectId: number | null
  isDerived?: boolean
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
        trader_kind, bot_strategy, last_seen_at)
     SELECT $1, r.exchange_trader_id, r.nickname, r.avatar_url_origin, r.wallet_address,
            r.trader_kind, r.bot_strategy, now()
       FROM jsonb_to_recordset($2::jsonb) AS r(
         exchange_trader_id text, nickname text, avatar_url_origin text,
         wallet_address text, trader_kind text, bot_strategy text)
     ON CONFLICT (source_id, exchange_trader_id) DO UPDATE SET
       nickname          = COALESCE(EXCLUDED.nickname, arena.traders.nickname),
       avatar_url_origin = COALESCE(EXCLUDED.avatar_url_origin, arena.traders.avatar_url_origin),
       wallet_address    = COALESCE(EXCLUDED.wallet_address, arena.traders.wallet_address),
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
  const { baseline, isBootstrap } = await getCountBaseline(src.id, timeframe, src.expected_count)
  const verdict = evaluateCount(
    rows.length,
    baseline,
    isBootstrap ? BOOTSTRAP_DEVIATION_PCT : ROLLING_DEVIATION_PCT
  )

  const client = await getIngestPool().connect()
  try {
    await client.query('BEGIN')

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
        src.expected_count,
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

      // Headline stats (Tier A guarantee: profile first screen renders with
      // zero on-demand fetching, spec §2.3-A).
      await client.query(
        `INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, roi, pnl, win_rate)
         SELECT t.id, $1, $2, $3, r.roi, r.pnl, r.win_rate
           FROM jsonb_to_recordset($4::jsonb) AS r(
             exchange_trader_id text, roi numeric, pnl numeric, win_rate numeric)
           JOIN arena.traders t
             ON t.source_id = $5 AND t.exchange_trader_id = r.exchange_trader_id
         ON CONFLICT (trader_id, timeframe) DO UPDATE SET
           as_of    = EXCLUDED.as_of,
           currency = EXCLUDED.currency,
           roi      = COALESCE(EXCLUDED.roi, arena.trader_stats.roi),
           pnl      = COALESCE(EXCLUDED.pnl, arena.trader_stats.pnl),
           win_rate = COALESCE(EXCLUDED.win_rate, arena.trader_stats.win_rate)`,
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
            }))
          ),
          src.id,
        ]
      )
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
  const client = await getIngestPool().connect()
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

    for (const s of profile.stats) {
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
           mdd = EXCLUDED.mdd, win_rate = EXCLUDED.win_rate,
           win_positions = EXCLUDED.win_positions,
           total_positions = EXCLUDED.total_positions,
           copier_pnl = EXCLUDED.copier_pnl, copier_count = EXCLUDED.copier_count,
           aum = EXCLUDED.aum, volume = EXCLUDED.volume,
           profit_share_rate = EXCLUDED.profit_share_rate,
           holding_duration_avg = EXCLUDED.holding_duration_avg,
           trading_preferences = EXCLUDED.trading_preferences,
           extras = EXCLUDED.extras`,
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
        ]
      )
    }

    for (const series of profile.series) {
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

/** Tier-D: fully replace a trader's open-positions snapshot (spec §2.3). */
export async function publishPositions(
  src: SourceRow,
  traderId: number,
  positions: ParsedPosition[],
  asOf: string
): Promise<void> {
  const client = await getIngestPool().connect()
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
  const client = await getIngestPool().connect()
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
         DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
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
