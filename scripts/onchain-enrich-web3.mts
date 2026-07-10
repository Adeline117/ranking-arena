/**
 * Web3 wallet on-chain enrichment runner (Phase A item A → Phase B recurring).
 *
 * Recomputes web3 wallets' profile detail 100% from chain data (durable — no
 * exchange/WAF) and writes onchain_* fields into arena.trader_stats.extras
 * (90d row) WITHOUT clobbering board values. Solana via HELIUS_API_KEY
 * (fallback ALCHEMY_API_KEY), BSC via Alchemy + Dune internal legs, pricing
 * via keyless Dexscreener.
 *
 * Phase B sweep semantics (2026-07-09, owner 批全量): selection prefers
 * never-enriched wallets, then stalest (extras.onchain_enriched_at), skipping
 * anything refreshed within 7 days — a nightly cron with a fixed batch walks
 * the whole population weekly instead of re-hitting the same whales.
 *
 * Usage:
 *   npx tsx scripts/onchain-enrich-web3.mts [batch] [source] [concurrency]
 *   npx tsx scripts/onchain-enrich-web3.mts 900 okx_web3_solana 4
 *   npx tsx scripts/onchain-enrich-web3.mts 300 binance_web3_bsc 3
 *
 * Cron: nightly via crontab (see docs/DATA_COMPLETENESS_PLAN_2026-07-08.md).
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

const topN = Number(process.argv[2]) || 5
const onlySource = process.argv[3]
const concurrency = Math.max(1, Number(process.argv[4]) || 4)

async function main() {
  const { Pool } = await import('pg')
  const { chainForSource, enrichWeb3Wallet, enrichmentExtras } = await import(
    '@/lib/ingest/onchain/enrich'
  )
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!dbUrl) throw new Error('SUPABASE_DB_URL / DATABASE_URL missing')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })

  const sources = onlySource ? [onlySource] : ['okx_web3_solana', 'binance_web3_bsc']
  for (const slug of sources) {
    const chain = chainForSource(slug)
    if (!chain) {
      console.log(`[skip] ${slug} — not an on-chain source`)
      continue
    }
    // Sweep selection (Phase B): never-enriched first, then stalest; skip
    // fresh (<7d). Within a bucket, richest pnl first (user-visible wallets
    // win ties). trader_stats has no rank col — pnl is the proxy.
    const { rows } = await pool.query(
      `SELECT t.exchange_trader_id AS wallet, ts.pnl
         FROM arena.trader_stats ts
         JOIN arena.traders t ON t.id = ts.trader_id
         JOIN arena.sources s ON s.id = t.source_id
         LEFT JOIN public.leaderboard_ranks lr
                ON lr.source = s.slug AND lr.source_trader_id = t.exchange_trader_id
               AND lr.season_id = '90D'
        WHERE s.slug = $1 AND ts.timeframe = 90 AND ts.pnl IS NOT NULL
          AND (NOT ts.extras ? 'onchain_enriched_at'
               OR (ts.extras->>'onchain_enriched_at')::timestamptz < now() - interval '7 days')
        ORDER BY (ts.extras->>'onchain_enriched_at')::timestamptz ASC NULLS FIRST,
                 -- 桶内按 serving 榜名次优先(P3 2026-07-10):此前按 pnl,
                 -- top500 可见缺口反而排后。LEFT JOIN 无榜者按 pnl 兜底。
                 lr.rank ASC NULLS LAST,
                 ts.pnl DESC
        LIMIT $2`,
      [slug, topN]
    )
    console.log(`\n=== ${slug} (${chain}) — sweep batch ${rows.length} wallets ×${concurrency} ===`)
    let ok = 0
    let failed = 0
    const queue = [...rows]
    const runOne = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        const { wallet, pnl } = next
        const rank = `pnl$${Math.round(pnl)}`
        try {
          const e = await enrichWeb3Wallet(chain, wallet, { lookbackDays: 90, maxSigs: 250 })
          const extras = enrichmentExtras(e)
          const upd = await pool.query(
            `UPDATE arena.trader_stats ts SET
               extras = ts.extras || $3::jsonb,
               win_rate = COALESCE(ts.win_rate, $4)
             FROM arena.traders t, arena.sources s
             WHERE ts.trader_id = t.id AND t.source_id = s.id
               AND s.slug = $1 AND t.exchange_trader_id = $2 AND ts.timeframe = 90`,
            [slug, wallet, JSON.stringify(extras), e.winRate]
          )
          ok++
          console.log(
            `  #${rank} ${wallet.slice(0, 10)}… realized=$${e.realizedPnlUsd} unreal=$${e.unrealizedPnlUsd} total=$${e.totalPnlUsd} win=${e.winRate ?? '—'} buys=${e.txsBuy} sells=${e.txsSell} tok=${e.tokensTraded} priced=${e.pricedTokens}/${e.pricedTokens + e.unpricedTokens} (rows=${upd.rowCount})${e.realizedPartial ? ' [realized-partial]' : ''}`
          )
        } catch (err) {
          failed++
          console.log(
            `  #${rank} ${wallet.slice(0, 10)}… FAILED: ${err instanceof Error ? err.message : err}`
          )
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => runOne()))
    console.log(`=== ${slug} done: ${ok} ok, ${failed} failed ===`)
  }
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
