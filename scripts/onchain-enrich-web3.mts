/**
 * Web3 wallet on-chain enrichment runner (Phase A — item A).
 *
 * Selects the top-N web3 wallets (by best rank) per source, recomputes their
 * profile detail 100% from chain data (durable — no exchange/WAF), and writes
 * onchain_* fields into arena.trader_stats.extras (90d row) WITHOUT clobbering
 * board values. $0: shared ALCHEMY_API_KEY + keyless Dexscreener pricing.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/onchain-enrich-web3.mts [topN] [source]
 *   npx tsx --env-file=.env.local scripts/onchain-enrich-web3.mts 3 okx_web3_solana
 *
 * Cron-wire later; run manually here to prove end-to-end.
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

const topN = Number(process.argv[2]) || 5
const onlySource = process.argv[3]

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
    // Top-N wallets by best 90d PnL for this source (trader_stats has no rank col).
    const { rows } = await pool.query(
      `SELECT t.exchange_trader_id AS wallet, ts.pnl
         FROM arena.trader_stats ts
         JOIN arena.traders t ON t.id = ts.trader_id
         JOIN arena.sources s ON s.id = t.source_id
        WHERE s.slug = $1 AND ts.timeframe = 90 AND ts.pnl IS NOT NULL
        ORDER BY ts.pnl DESC
        LIMIT $2`,
      [slug, topN]
    )
    console.log(`\n=== ${slug} (${chain}) — top ${rows.length} wallets ===`)
    for (const { wallet, pnl } of rows) {
      const rank = `pnl$${Math.round(pnl)}`
      try {
        const e = await enrichWeb3Wallet(chain, wallet, { lookbackDays: 90, maxSigs: 400 })
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
        console.log(
          `  #${rank} ${wallet.slice(0, 10)}… realized=$${e.realizedPnlUsd} unreal=$${e.unrealizedPnlUsd} total=$${e.totalPnlUsd} win=${e.winRate ?? '—'} buys=${e.txsBuy} sells=${e.txsSell} tok=${e.tokensTraded} priced=${e.pricedTokens}/${e.pricedTokens + e.unpricedTokens} (rows=${upd.rowCount})${e.realizedPartial ? ' [realized-partial]' : ''}`
        )
      } catch (err) {
        console.log(`  #${rank} ${wallet.slice(0, 10)}… FAILED: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
