#!/usr/bin/env node
/**
 * Onchain Trader Enrichment - Complete Solution
 * 
 * 补全所有链上交易员的 win_rate 和 max_drawdown
 * 优先级: Hyperliquid > dydx > Aevo > Drift > Jupiter Perps > Gains > GMX
 * 
 * Usage:
 *   node scripts/enrich-onchain-all.mjs [--platform=hyperliquid] [--batch=100] [--dry-run]
 */

import pg from 'pg';
import fetch from 'node-fetch';

const { Pool } = pg;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 
    'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
});

const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] || '100');
const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_PLATFORM = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1];

// Rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============ Utility Functions ============
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function getMissingTraders(source) {
  const result = await pool.query(`
    SELECT DISTINCT 
      source_trader_id as trader_key,
      win_rate IS NULL as need_wr,
      max_drawdown IS NULL as need_mdd
    FROM leaderboard_ranks
    WHERE source = $1 
      AND (win_rate IS NULL OR max_drawdown IS NULL)
    ORDER BY source_trader_id
    LIMIT ${BATCH_SIZE}
  `, [source]);
  
  return result.rows;
}

async function updateTrader(source, traderKey, updates) {
  if (DRY_RUN) {
    log(`[DRY-RUN] Would update ${source}/${traderKey}: ${JSON.stringify(updates)}`);
    return 0;
  }
  
  const setClauses = [];
  const values = [];
  let paramIndex = 1;
  
  // Validate and clamp win_rate (0-100%)
  if (updates.win_rate !== undefined && updates.win_rate !== null) {
    let wr = parseFloat(updates.win_rate);
    if (isNaN(wr)) return 0;
    wr = Math.max(0, Math.min(100, wr)); // Clamp to 0-100
    setClauses.push(`win_rate = $${paramIndex++}`);
    values.push(wr);
  }
  
  // Validate and clamp max_drawdown (0-100%, typically)
  if (updates.max_drawdown !== undefined && updates.max_drawdown !== null) {
    let mdd = parseFloat(updates.max_drawdown);
    if (isNaN(mdd)) return 0;
    mdd = Math.max(0, Math.min(100, mdd)); // Clamp to 0-100%
    setClauses.push(`max_drawdown = $${paramIndex++}`);
    values.push(mdd);
  }
  
  if (setClauses.length === 0) return 0;
  
  values.push(source, traderKey);
  
  try {
    const result = await pool.query(`
      UPDATE leaderboard_ranks
      SET ${setClauses.join(', ')}
      WHERE source = $${paramIndex++} AND source_trader_id = $${paramIndex}
    `, values);
    
    return result.rowCount;
  } catch (error) {
    log(`Error updating ${source}/${traderKey}: ${error.message}`);
    return 0;
  }
}

// ============ HYPERLIQUID ============
async function enrichHyperliquid() {
  log('Starting Hyperliquid enrichment...');
  const traders = await getMissingTraders('hyperliquid');
  
  if (traders.length === 0) {
    log('Hyperliquid: No traders to enrich');
    return;
  }
  
  log(`Hyperliquid: Processing ${traders.length} traders`);
  let updated = 0;
  let failed = 0;
  
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    try {
      // Get user fills for win rate calculation
      const fillsResp = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'userFills',
          user: trader.trader_key
        })
      });
      
      const fills = await fillsResp.json();
      
      const updates = {};
      
      // Calculate win_rate from fills
      if (trader.need_wr && Array.isArray(fills) && fills.length >= 3) {
        const closedTrades = fills.filter(f => f.closedPnl && parseFloat(f.closedPnl) !== 0);
        if (closedTrades.length >= 3) {
          const wins = closedTrades.filter(f => parseFloat(f.closedPnl) > 0).length;
          updates.win_rate = (wins / closedTrades.length) * 100;
        }
      }
      
      // Get account value history for max_drawdown
      if (trader.need_mdd) {
        try {
          const ledgerResp = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'userNonFundingLedgerUpdates',
              user: trader.trader_key
            })
          });
          
          const ledger = await ledgerResp.json();
          
          if (Array.isArray(ledger) && ledger.length >= 5) {
            // Calculate equity curve from ledger
            let equity = 0;
            const values = [];
            
            for (const entry of ledger) {
              if (entry.delta?.type === 'deposit') {
                equity += parseFloat(entry.delta.usdc || 0);
              } else if (entry.delta?.type === 'withdraw') {
                equity -= parseFloat(entry.delta.usdc || 0);
              } else if (entry.delta?.type === 'liquidation') {
                equity += parseFloat(entry.delta.pnl || 0);
              } else if (entry.delta?.type === 'trade') {
                equity += parseFloat(entry.delta.pnl || 0);
              }
              values.push(equity);
            }
            
            // Calculate max drawdown
            if (values.length >= 5) {
              let peak = values[0];
              let maxDD = 0;
              
              for (const val of values) {
                if (val > peak) peak = val;
                const dd = ((peak - val) / peak) * 100;
                if (dd > maxDD) maxDD = dd;
              }
              
              if (maxDD > 0) {
                updates.max_drawdown = maxDD;
              }
            }
          }
        } catch (e) {
          // Ledger API might not be available for all traders
        }
      }
      
      if (Object.keys(updates).length > 0) {
        const count = await updateTrader('hyperliquid', trader.trader_key, updates);
        updated += count;
      }
      
      if ((i + 1) % 10 === 0) {
        log(`  Hyperliquid: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`);
      }
      
      await sleep(200); // Rate limit
      
    } catch (error) {
      failed++;
      if (failed <= 3) {
        log(`  Hyperliquid error for ${trader.trader_key}: ${error.message}`);
      }
    }
  }
  
  log(`Hyperliquid complete: ${updated} updated, ${failed} failed`);
}

// ============ DYDX ============
async function enrichDydx() {
  log('Starting dYdX enrichment...');
  const traders = await getMissingTraders('dydx');
  
  if (traders.length === 0) {
    log('dYdX: No traders to enrich');
    return;
  }
  
  log(`dYdX: Processing ${traders.length} traders`);
  let updated = 0;
  let failed = 0;
  
  // dYdX v4 uses Cosmos SDK, need to query the chain
  const DYDX_RPC = 'https://dydx-ops-rpc.kingnodes.com';
  
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    try {
      // Query subaccount info
      const resp = await fetch(`${DYDX_RPC}/dydxprotocol/subaccounts/subaccount/${trader.trader_key}/0`);
      const data = await resp.json();
      
      const updates = {};
      
      // dYdX v4 Indexer API - get fills for subaccount 0
      const indexerResp = await fetch(
        `https://indexer.dydx.trade/v4/fills?address=${trader.trader_key}&subaccountNumber=0&limit=1000`
      );
      const fillsData = await indexerResp.json();
      
      if (fillsData.fills && fillsData.fills.length >= 3) {
        const fills = fillsData.fills;
        
        // Calculate win rate from realized PnL
        if (trader.need_wr) {
          // Group fills by order to determine trade outcomes
          const orderPnls = new Map();
          for (const fill of fills) {
            const orderId = fill.orderId;
            if (!orderPnls.has(orderId)) {
              orderPnls.set(orderId, 0);
            }
            // Approximate PnL from fill (simplified)
            const pnl = parseFloat(fill.price) * parseFloat(fill.size) * (fill.side === 'SELL' ? 1 : -1);
            orderPnls.set(orderId, orderPnls.get(orderId) + pnl);
          }
          
          const completedTrades = Array.from(orderPnls.values()).filter(pnl => pnl !== 0);
          if (completedTrades.length >= 3) {
            const wins = completedTrades.filter(pnl => pnl > 0).length;
            updates.win_rate = (wins / completedTrades.length) * 100;
          }
        }
      }
      
      if (Object.keys(updates).length > 0) {
        const count = await updateTrader('dydx', trader.trader_key, updates);
        updated += count;
      }
      
      if ((i + 1) % 10 === 0) {
        log(`  dYdX: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`);
      }
      
      await sleep(300);
      
    } catch (error) {
      failed++;
      if (failed <= 3) {
        log(`  dYdX error for ${trader.trader_key}: ${error.message}`);
      }
    }
  }
  
  log(`dYdX complete: ${updated} updated, ${failed} failed`);
}

// ============ AEVO ============
async function enrichAevo() {
  log('Starting Aevo enrichment...');
  const traders = await getMissingTraders('aevo');
  
  if (traders.length === 0) {
    log('Aevo: No traders to enrich');
    return;
  }
  
  log(`Aevo: Processing ${traders.length} traders`);
  let updated = 0;
  let failed = 0;
  
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    try {
      const resp = await fetch(`https://api.aevo.xyz/statistics?account=${trader.trader_key}`);
      
      if (resp.ok) {
        const data = await resp.json();
        const updates = {};
        
        if (trader.need_wr && data.win_rate !== undefined) {
          const wr = parseFloat(data.win_rate);
          updates.win_rate = wr <= 1 ? wr * 100 : wr;
        }
        
        if (trader.need_mdd && data.max_drawdown !== undefined) {
          const mdd = Math.abs(parseFloat(data.max_drawdown));
          updates.max_drawdown = mdd <= 1 ? mdd * 100 : mdd;
        }
        
        if (Object.keys(updates).length > 0) {
          const count = await updateTrader('aevo', trader.trader_key, updates);
          updated += count;
        }
      }
      
      if ((i + 1) % 10 === 0) {
        log(`  Aevo: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`);
      }
      
      await sleep(300);
      
    } catch (error) {
      failed++;
      if (failed <= 3) {
        log(`  Aevo error for ${trader.trader_key}: ${error.message}`);
      }
    }
  }
  
  log(`Aevo complete: ${updated} updated, ${failed} failed`);
}

// ============ DRIFT ============
async function enrichDrift() {
  log('Starting Drift enrichment...');
  const traders = await getMissingTraders('drift');
  
  if (traders.length === 0) {
    log('Drift: No traders to enrich');
    return;
  }
  
  log(`Drift: Processing ${traders.length} traders`);
  let updated = 0;
  let failed = 0;
  
  // Drift Data API - use the data.api.drift.trade endpoint
  const DRIFT_API = 'https://data.api.drift.trade';
  
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    try {
      // Try to get user account data
      // Note: Drift API may not have direct trader stats endpoint
      // We might need to calculate from on-chain data or use leaderboard endpoint
      const resp = await fetch(`${DRIFT_API}/user/${trader.trader_key}`);
      
      if (resp.ok) {
        const data = await resp.json();
        const updates = {};
        
        // Drift's API structure varies, attempt to extract metrics
        if (trader.need_wr && data.win_rate !== undefined) {
          updates.win_rate = parseFloat(data.win_rate) * 100;
        }
        
        if (trader.need_mdd && data.max_drawdown !== undefined) {
          updates.max_drawdown = Math.abs(parseFloat(data.max_drawdown)) * 100;
        }
        
        if (Object.keys(updates).length > 0) {
          const count = await updateTrader('drift', trader.trader_key, updates);
          updated += count;
        }
      } else {
        // API endpoint might not exist, skip for now
        if (i < 3) {
          log(`  Drift: User endpoint not available (${resp.status}), may need SDK integration`);
        }
      }
      
      if ((i + 1) % 10 === 0) {
        log(`  Drift: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`);
      }
      
      await sleep(300);
      
    } catch (error) {
      failed++;
      if (failed <= 3) {
        log(`  Drift error for ${trader.trader_key}: ${error.message}`);
      }
    }
  }
  
  log(`Drift complete: ${updated} updated, ${failed} failed`);
}

// ============ JUPITER PERPS ============
async function enrichJupiterPerps() {
  log('Starting Jupiter Perps enrichment...');
  const traders = await getMissingTraders('jupiter_perps');
  
  if (traders.length === 0) {
    log('Jupiter Perps: No traders to enrich');
    return;
  }
  
  log(`Jupiter Perps: Processing ${traders.length} traders`);
  let updated = 0;
  let failed = 0;
  
  // Jupiter Perps - try to get data from their stats endpoint
  // Note: Jupiter Perps API may not expose individual trader stats publicly
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    try {
      // Try the perps stats API (endpoint may not be publicly documented)
      const resp = await fetch(`https://perps-api.jup.ag/trader/${trader.trader_key}`);
      
      if (resp.ok) {
        const data = await resp.json();
        const updates = {};
        
        if (trader.need_wr && data.winRate !== undefined) {
          updates.win_rate = parseFloat(data.winRate) * 100;
        }
        
        if (trader.need_mdd && data.maxDrawdown !== undefined) {
          updates.max_drawdown = Math.abs(parseFloat(data.maxDrawdown)) * 100;
        }
        
        if (Object.keys(updates).length > 0) {
          const count = await updateTrader('jupiter_perps', trader.trader_key, updates);
          updated += count;
        }
      } else {
        // API might not be available, log once
        if (i < 3) {
          log(`  Jupiter Perps: Trader endpoint not available (${resp.status}), may need on-chain calculation`);
        }
      }
      
      if ((i + 1) % 10 === 0) {
        log(`  Jupiter Perps: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`);
      }
      
      await sleep(300);
      
    } catch (error) {
      failed++;
      if (failed <= 3) {
        log(`  Jupiter Perps error for ${trader.trader_key}: ${error.message}`);
      }
    }
  }
  
  log(`Jupiter Perps complete: ${updated} updated, ${failed} failed`);
}

// ============ GAINS ============
async function enrichGains() {
  log('Starting Gains Network enrichment...');
  const traders = await getMissingTraders('gains');
  
  if (traders.length === 0) {
    log('Gains: No traders to enrich');
    return;
  }
  
  log(`Gains: Processing ${traders.length} traders`);
  let updated = 0;
  let failed = 0;
  
  // Gains Network uses The Graph
  const GAINS_SUBGRAPH = 'https://api.thegraph.com/subgraphs/name/gainsnetwork/gtrade-stats';
  
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    try {
      const query = `
        query {
          trader(id: "${trader.trader_key.toLowerCase()}") {
            winRate
            maxDrawdown
            tradesCount
          }
        }
      `;
      
      const resp = await fetch(GAINS_SUBGRAPH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      
      const data = await resp.json();
      const updates = {};
      
      if (data.data?.trader) {
        if (trader.need_wr && data.data.trader.winRate !== undefined) {
          updates.win_rate = parseFloat(data.data.trader.winRate) * 100;
        }
        
        if (trader.need_mdd && data.data.trader.maxDrawdown !== undefined) {
          updates.max_drawdown = Math.abs(parseFloat(data.data.trader.maxDrawdown)) * 100;
        }
      }
      
      if (Object.keys(updates).length > 0) {
        const count = await updateTrader('gains', trader.trader_key, updates);
        updated += count;
      }
      
      if ((i + 1) % 10 === 0) {
        log(`  Gains: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`);
      }
      
      await sleep(500); // The Graph rate limit
      
    } catch (error) {
      failed++;
      if (failed <= 3) {
        log(`  Gains error for ${trader.trader_key}: ${error.message}`);
      }
    }
  }
  
  log(`Gains complete: ${updated} updated, ${failed} failed`);
}

// ============ GMX ============
async function enrichGMX() {
  log('Starting GMX enrichment (max_drawdown only)...');
  const traders = await getMissingTraders('gmx');
  
  if (traders.length === 0) {
    log('GMX: No traders to enrich');
    return;
  }
  
  log(`GMX: Processing ${traders.length} traders (win_rate already populated)`);
  let updated = 0;
  let failed = 0;
  
  // GMX uses The Graph - multiple subgraphs for v1 and v2
  const GMX_SUBGRAPH_V2 = 'https://api.thegraph.com/subgraphs/name/gmx-io/gmx-stats';
  
  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    if (!trader.need_mdd) continue; // Skip if max_drawdown already exists
    
    try {
      const query = `
        query {
          user(id: "${trader.trader_key.toLowerCase()}") {
            id
            closedPositionCount
            positionPnls: closedPositions(first: 1000, orderBy: timestamp) {
              realisedPnl
              timestamp
            }
          }
        }
      `;
      
      const resp = await fetch(GMX_SUBGRAPH_V2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      
      const data = await resp.json();
      
      if (data.data?.user?.positionPnls && data.data.user.positionPnls.length >= 5) {
        // Calculate equity curve
        let equity = 0;
        const values = [];
        
        for (const pos of data.data.user.positionPnls) {
          equity += parseFloat(pos.realisedPnl);
          values.push(equity);
        }
        
        // Calculate max drawdown
        let peak = values[0];
        let maxDD = 0;
        
        for (const val of values) {
          if (val > peak) peak = val;
          const dd = ((peak - val) / Math.abs(peak)) * 100;
          if (dd > maxDD) maxDD = dd;
        }
        
        if (maxDD > 0) {
          const count = await updateTrader('gmx', trader.trader_key, { max_drawdown: maxDD });
          updated += count;
        }
      }
      
      if ((i + 1) % 10 === 0) {
        log(`  GMX: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`);
      }
      
      await sleep(500);
      
    } catch (error) {
      failed++;
      if (failed <= 3) {
        log(`  GMX error for ${trader.trader_key}: ${error.message}`);
      }
    }
  }
  
  log(`GMX complete: ${updated} updated, ${failed} failed`);
}

// ============ Main Execution ============
async function printStatus(label = '') {
  const result = await pool.query(`
    SELECT 
      source,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null,
      COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null,
      ROUND(COUNT(*) FILTER (WHERE win_rate IS NULL)::numeric / COUNT(*) * 100, 1) as wr_pct,
      ROUND(COUNT(*) FILTER (WHERE max_drawdown IS NULL)::numeric / COUNT(*) * 100, 1) as mdd_pct
    FROM leaderboard_ranks
    WHERE source IN ('hyperliquid', 'dydx', 'aevo', 'drift', 'jupiter_perps', 'gains', 'gmx')
    GROUP BY source
    ORDER BY total DESC
  `);
  
  console.log('\n' + '='.repeat(80));
  console.log(`Status ${label}:`);
  console.log('-'.repeat(80));
  console.log('Source          | Total | WR Null | MDD Null | WR% | MDD%');
  console.log('-'.repeat(80));
  
  for (const row of result.rows) {
    console.log(
      `${row.source.padEnd(15)} | ${String(row.total).padStart(5)} | ` +
      `${String(row.wr_null).padStart(7)} | ${String(row.mdd_null).padStart(8)} | ` +
      `${String(row.wr_pct).padStart(3)}% | ${String(row.mdd_pct).padStart(4)}%`
    );
  }
  console.log('='.repeat(80) + '\n');
}

async function main() {
  log('Starting Onchain Trader Enrichment...');
  log(`Batch size: ${BATCH_SIZE}, Dry run: ${DRY_RUN}`);
  
  if (TARGET_PLATFORM) {
    log(`Target platform: ${TARGET_PLATFORM}`);
  }
  
  await printStatus('BEFORE');
  
  const platforms = [
    { name: 'hyperliquid', fn: enrichHyperliquid },
    { name: 'dydx', fn: enrichDydx },
    { name: 'aevo', fn: enrichAevo },
    { name: 'drift', fn: enrichDrift },
    { name: 'jupiter_perps', fn: enrichJupiterPerps },
    { name: 'gains', fn: enrichGains },
    { name: 'gmx', fn: enrichGMX },
  ];
  
  for (const platform of platforms) {
    if (TARGET_PLATFORM && platform.name !== TARGET_PLATFORM) {
      continue;
    }
    
    try {
      await platform.fn();
    } catch (error) {
      log(`ERROR in ${platform.name}: ${error.message}`);
      log(error.stack);
    }
    
    // Cool down between platforms
    await sleep(2000);
  }
  
  await printStatus('AFTER');
  
  log('Enrichment complete!');
  await pool.end();
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  pool.end();
  process.exit(1);
});

main().catch(error => {
  console.error('Fatal error:', error);
  pool.end();
  process.exit(1);
});
