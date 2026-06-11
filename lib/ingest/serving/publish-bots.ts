/**
 * Bots-specific publish step (spec §3 shadow-row decision): bot boards run
 * through the SAME Tier-A pipeline (traders/entries/stats via the shadow
 * trader rows), and this post-publish hook additionally upserts the
 * arena.bots row from the adapter-normalized fields in row.traderMeta.bot.
 *
 * Owner resolution is best-effort: the bot card exposes the owner's
 * exchange uid (owner_account_id); if that human trader is already known
 * in ANY source of the same exchange, link it — otherwise leave NULL and
 * let a later crawl resolve it (ON CONFLICT keeps the newest non-null).
 *
 * WORKER-ONLY MODULE (direct PG).
 */

import { getIngestPool } from '../db'
import type { ParsedLeaderboardRow, SourceRow } from '../core/types'

interface BotFields {
  exchange_bot_id: string
  product_id?: string | null
  owner_account_id?: string | null
  pair?: string | null
  product_type?: string | null
  strategy?: string | null
  direction?: string | null
  created_at_origin?: string | null
  runtime_days?: number | null
  profit_share_rate?: number | null
  status?: string | null
}

export interface PublishBotsResult {
  written: number
}

export async function publishBots(
  src: SourceRow,
  rows: ParsedLeaderboardRow[],
  traderIds: Map<string, number>
): Promise<PublishBotsResult> {
  const bots: Array<BotFields & { shadow_trader_id: number; raw: unknown }> = []
  for (const row of rows) {
    const bot = (row.traderMeta?.bot ?? null) as BotFields | null
    const shadowId = traderIds.get(row.exchangeTraderId)
    if (!bot || !bot.exchange_bot_id || shadowId === undefined) continue
    bots.push({ ...bot, shadow_trader_id: shadowId, raw: row.raw })
  }
  if (bots.length === 0) return { written: 0 }

  const result = await getIngestPool().query(
    `INSERT INTO arena.bots
       (source_id, exchange_bot_id, shadow_trader_id, owner_trader_id, pair,
        product_type, bot_strategy, direction, created_at_origin, runtime_days,
        profit_share_rate, status, raw)
     SELECT $1, b.exchange_bot_id, b.shadow_trader_id, owner.id, b.pair,
            b.product_type, b.strategy, b.direction,
            b.created_at_origin::timestamptz, b.runtime_days,
            b.profit_share_rate, b.status, b.raw
       FROM jsonb_to_recordset($2::jsonb) AS b(
         exchange_bot_id text, shadow_trader_id bigint, owner_account_id text,
         pair text, product_type text, strategy text, direction text,
         created_at_origin text, runtime_days int, profit_share_rate numeric,
         status text, raw jsonb)
       LEFT JOIN LATERAL (
         SELECT t.id
           FROM arena.traders t
           JOIN arena.sources s ON s.id = t.source_id
          WHERE s.exchange_id = (SELECT exchange_id FROM arena.sources WHERE id = $1)
            AND t.exchange_trader_id = b.owner_account_id
            AND t.trader_kind = 'human'
          ORDER BY t.id
          LIMIT 1
       ) AS owner ON true
     ON CONFLICT (source_id, exchange_bot_id) DO UPDATE SET
       shadow_trader_id  = EXCLUDED.shadow_trader_id,
       owner_trader_id   = COALESCE(EXCLUDED.owner_trader_id, arena.bots.owner_trader_id),
       pair              = COALESCE(EXCLUDED.pair, arena.bots.pair),
       product_type      = COALESCE(EXCLUDED.product_type, arena.bots.product_type),
       bot_strategy      = COALESCE(EXCLUDED.bot_strategy, arena.bots.bot_strategy),
       direction         = COALESCE(EXCLUDED.direction, arena.bots.direction),
       created_at_origin = COALESCE(EXCLUDED.created_at_origin, arena.bots.created_at_origin),
       runtime_days      = COALESCE(EXCLUDED.runtime_days, arena.bots.runtime_days),
       profit_share_rate = COALESCE(EXCLUDED.profit_share_rate, arena.bots.profit_share_rate),
       status            = COALESCE(EXCLUDED.status, arena.bots.status),
       raw               = EXCLUDED.raw`,
    [
      src.id,
      JSON.stringify(
        bots.map((b) => ({
          exchange_bot_id: b.exchange_bot_id,
          shadow_trader_id: b.shadow_trader_id,
          owner_account_id: b.owner_account_id ?? null,
          pair: b.pair ?? null,
          product_type: b.product_type ?? null,
          strategy: b.strategy ?? null,
          direction: b.direction ?? null,
          created_at_origin: b.created_at_origin ?? null,
          runtime_days: b.runtime_days ?? null,
          profit_share_rate: b.profit_share_rate ?? null,
          status: b.status ?? null,
          raw: b.raw,
        }))
      ),
    ]
  )
  return { written: result.rowCount ?? 0 }
}
