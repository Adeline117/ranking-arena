/**
 * Contract Detection Cron Job
 *
 * Batch-checks DEX 0x addresses via eth_getCode to classify them:
 *   - EOA (no bytecode) → is_contract = false
 *   - Proxy/wallet (<100b bytecode) → is_contract = true, but NOT a bot
 *   - Real contract (>=100b bytecode) → is_contract = true, IS a bot
 *
 * Only addresses with bytecodeSize >= MIN_BOT_BYTECODE_SIZE are treated
 * as bots by detectTraderType. Short proxies (Gains per-user proxies,
 * smart wallets, ERC-4337 accounts) are excluded.
 *
 * GET /api/cron/detect-contracts?limit=500
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createLogger } from '@/lib/utils/logger'
import {
  batchCheckContracts,
  getChainForPlatform,
  isBotContract,
  DEX_CHAIN_MAP,
} from '@/lib/services/contract-detector'

const log = createLogger('cron:detect-contracts')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('detect-contracts')
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') || '500'), 2000)

  try {
    const supabase = getSupabaseAdmin()
    const dexPlatforms = Object.keys(DEX_CHAIN_MAP)

    // Fetch unchecked 0x addresses from DEX platforms
    const { data: unchecked, error: fetchError } = await (supabase
      .from('trader_sources')
      .select('id, source, source_trader_id')
      .in('source', dexPlatforms)
      .is('is_contract' as any, null)
      .like('source_trader_id', '0x%')
      .limit(limit) as any)

    if (fetchError) throw fetchError
    if (!unchecked?.length) {
      log.info('No unchecked addresses remaining')
      await plog.success(0)
      return NextResponse.json({ checked: 0, bots: 0, proxies: 0, eoas: 0, errors: 0 })
    }

    log.info(`Checking ${unchecked.length} addresses`)

    // Group by chain
    const byChain = new Map<number, Array<{ id: number; address: string }>>()
    for (const row of unchecked as Array<{
      id: number
      source: string
      source_trader_id: string
    }>) {
      const chainId = getChainForPlatform(row.source)
      if (!chainId) continue
      if (!byChain.has(chainId)) byChain.set(chainId, [])
      byChain.get(chainId)!.push({ id: row.id, address: row.source_trader_id })
    }

    let totalBots = 0
    let totalProxies = 0
    let totalEoas = 0
    let totalErrors = 0
    const now = new Date().toISOString()

    for (const [chainId, rows] of byChain) {
      const addresses = rows.map((r) => r.address)
      const results = await batchCheckContracts(addresses, chainId)

      // Classify and batch update
      const botUpdates: Array<{ id: number; size: number }> = []
      const proxyUpdates: Array<{ id: number; size: number }> = []
      const eoaIds: number[] = []

      for (const row of rows) {
        const result = results.get(row.address)
        if (result == null) {
          totalErrors++
          continue
        }

        if (!result.isContract) {
          eoaIds.push(row.id)
          totalEoas++
        } else if (isBotContract(result)) {
          botUpdates.push({ id: row.id, size: result.bytecodeSize })
          totalBots++
        } else {
          proxyUpdates.push({ id: row.id, size: result.bytecodeSize })
          totalProxies++
        }
      }

      // Update bots (real contracts with logic)
      for (const u of botUpdates) {
        await (supabase
          .from('trader_sources')
          .update({
            is_contract: true,
            contract_checked_at: now,
            contract_bytecode_size: u.size,
          } as any)
          .eq('id', u.id) as any)
      }

      // Update proxies/wallets (contract but not a bot)
      for (const u of proxyUpdates) {
        await (supabase
          .from('trader_sources')
          .update({
            is_contract: false, // NOT a bot — treat same as EOA for trader_type purposes
            contract_checked_at: now,
            contract_bytecode_size: u.size,
          } as any)
          .eq('id', u.id) as any)
      }

      // Update EOAs
      if (eoaIds.length > 0) {
        await (supabase
          .from('trader_sources')
          .update({
            is_contract: false,
            contract_checked_at: now,
            contract_bytecode_size: 0,
          } as any)
          .in('id', eoaIds) as any)
      }

      log.info(
        `Chain ${chainId}: ${botUpdates.length} bots, ${proxyUpdates.length} proxies, ${eoaIds.length} EOAs`
      )
    }

    const total = totalBots + totalProxies + totalEoas
    log.info(
      `Done: ${total} checked, ${totalBots} bots, ${totalProxies} proxies, ${totalEoas} EOAs, ${totalErrors} errors`
    )
    await plog.success(total)

    return NextResponse.json({
      checked: total,
      bots: totalBots,
      proxies: totalProxies,
      eoas: totalEoas,
      errors: totalErrors,
      remaining: (unchecked as any[]).length - total,
    })
  } catch (err) {
    log.error('Contract detection failed', err)
    await plog.error(err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
