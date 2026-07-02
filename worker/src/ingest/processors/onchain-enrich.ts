/**
 * On-chain web3 enrichment processor (Phase A — cron-wired, item A).
 *
 * Periodically recomputes the top-N web3 wallets' profile detail 100% from
 * chain data (durable — no exchange/WAF) and writes onchain_* fields into
 * arena.trader_stats.extras (90d), never clobbering board values. The durable
 * replacement for the AWS-WAF-blocked binance_web3 / okx_web3 profile detail.
 *
 * Bounded to top-N per source (deep-profile budget) + retry/backoff in the
 * fetchers keeps it within the shared Alchemy free tier ($0). Ordered by 90d
 * PnL (trader_stats has no rank column).
 */
import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { chainForSource, enrichWeb3Wallet, enrichmentExtras } from '@/lib/ingest/onchain/enrich'
import { fetchBscInternalBnb } from '@/lib/ingest/onchain/dune-bsc-internal'
import type { NormalizedTransfer } from '@/lib/ingest/onchain/bsc-swaps'
import { logger } from '@/lib/logger'

const WEB3_SOURCES = ['okx_web3_solana', 'binance_web3_bsc'] as const
/** Per-source batch cap per run. Coverage grows across runs via the two-tier
 *  selection (below), so this bounds each 12h run, not total reach. */
const TOP_N = Number(process.env.ONCHAIN_ENRICH_TOPN) || 150
/** A HOT (high-PnL) wallet is due for refresh once its enrichment is older than
 *  this. Keeps active top traders fresh without re-doing everything each run. */
const HOT_TTL_HOURS = Number(process.env.ONCHAIN_ENRICH_HOT_TTL_HOURS) || 24

export async function processOnchainEnrich(
  _job: Job
): Promise<{ enriched: number; failed: number }> {
  const pool = getIngestPool()
  let enriched = 0
  let failed = 0

  for (const slug of WEB3_SOURCES) {
    const chain = chainForSource(slug)
    if (!chain) continue
    // Two-tier selection so BOTH initial coverage AND ongoing freshness work:
    //   HOT  (½ budget): highest-PnL wallets that are never-enriched OR stale
    //        beyond HOT_TTL — keeps the most-viewed/active traders fresh.
    //   TAIL (½ budget): globally oldest-enriched — rotates the long tail so it
    //        eventually refreshes too (dormant wallets rarely change/are viewed).
    // During initial coverage both return un-enriched wallets; after full
    // coverage HOT re-does top traders ≤HOT_TTL while TAIL rolls the rest.
    const half = Math.max(1, Math.floor(TOP_N / 2))
    const [hot, tail] = await Promise.all([
      pool.query<{ wallet: string }>(
        `SELECT t.exchange_trader_id AS wallet
           FROM arena.trader_stats ts
           JOIN arena.traders t ON t.id = ts.trader_id
           JOIN arena.sources s ON s.id = t.source_id
          WHERE s.slug = $1 AND ts.timeframe = 90 AND ts.pnl IS NOT NULL
            AND (NOT (ts.extras ? 'onchain_enriched_at')
                 OR (ts.extras->>'onchain_enriched_at')::timestamptz < now() - ($3 || ' hours')::interval)
          ORDER BY ts.pnl DESC
          LIMIT $2`,
        [slug, half, String(HOT_TTL_HOURS)]
      ),
      pool.query<{ wallet: string }>(
        `SELECT t.exchange_trader_id AS wallet
           FROM arena.trader_stats ts
           JOIN arena.traders t ON t.id = ts.trader_id
           JOIN arena.sources s ON s.id = t.source_id
          WHERE s.slug = $1 AND ts.timeframe = 90 AND ts.pnl IS NOT NULL
          ORDER BY (ts.extras ? 'onchain_enriched_at') ASC,
                   (ts.extras->>'onchain_enriched_at') ASC NULLS FIRST,
                   ts.pnl DESC
          LIMIT $2`,
        [slug, TOP_N - half]
      ),
    ])
    // Merge + dedup (a wallet can appear in both tiers).
    const seen = new Set<string>()
    const rows = [...hot.rows, ...tail.rows].filter((r) =>
      seen.has(r.wallet) ? false : (seen.add(r.wallet), true)
    )

    // BSC only: one batched Dune query for all wallets' native-BNB sell
    // receipts (item C — Alchemy omits BSC internal txs). $0, existing key.
    let internalByWallet = new Map<string, NormalizedTransfer[]>()
    if (chain === 'bsc' && rows.length > 0) {
      try {
        internalByWallet = await fetchBscInternalBnb(rows.map((r) => r.wallet))
        logger.info(
          `[onchain-enrich] ${slug}: Dune internal-BNB for ${internalByWallet.size} wallets`
        )
      } catch (err) {
        logger.error(`[onchain-enrich] ${slug}: Dune internal fetch failed:`, err)
      }
    }

    for (const { wallet } of rows) {
      try {
        const e = await enrichWeb3Wallet(chain, wallet, {
          lookbackDays: 90,
          maxSigs: 400,
          bscInternalBnb:
            chain === 'bsc' ? (internalByWallet.get(wallet.toLowerCase()) ?? []) : undefined,
        })
        const extras = { ...enrichmentExtras(e), onchain_enriched_at: new Date().toISOString() }
        await pool.query(
          `UPDATE arena.trader_stats ts SET
             extras = ts.extras || $3::jsonb,
             win_rate = COALESCE(ts.win_rate, $4)
           FROM arena.traders t, arena.sources s
           WHERE ts.trader_id = t.id AND t.source_id = s.id
             AND s.slug = $1 AND t.exchange_trader_id = $2 AND ts.timeframe = 90`,
          [slug, wallet, JSON.stringify(extras), e.winRate]
        )
        enriched += 1
      } catch (err) {
        failed += 1
        logger.error(
          `[onchain-enrich] ${slug} ${wallet.slice(0, 10)}… failed:`,
          err instanceof Error ? err.message : err
        )
      }
    }
    logger.info(`[onchain-enrich] ${slug}: enriched ${rows.length} wallets`)
  }

  return { enriched, failed }
}
