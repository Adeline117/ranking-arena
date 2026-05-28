/**
 * Contract Detection Cron Job
 *
 * Batch-checks DEX 0x addresses via eth_getCode to determine if they are
 * smart contracts (bots) or EOAs. Results are cached permanently in
 * trader_sources.is_contract since an address's contract status is immutable.
 *
 * GET /api/cron/detect-contracts?limit=500
 *
 * Designed to run every 30 minutes, processing 500 unchecked addresses per run.
 * At that rate, 15,000 DEX addresses are fully classified within ~15 hours.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createLogger } from '@/lib/utils/logger'
import {
  batchCheckContracts,
  getChainForPlatform,
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
    // is_contract / contract_checked_at are new columns — cast to bypass stale generated types
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
      return NextResponse.json({ checked: 0, contracts: 0, eoas: 0, errors: 0 })
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

    let totalContracts = 0
    let totalEoas = 0
    let totalErrors = 0
    const now = new Date().toISOString()

    // Process each chain
    for (const [chainId, rows] of byChain) {
      const addresses = rows.map((r) => r.address)
      const results = await batchCheckContracts(addresses, chainId)

      // Batch update DB
      const contractIds: number[] = []
      const eoaIds: number[] = []

      for (const row of rows) {
        const result = results.get(row.address)
        if (result === true) {
          contractIds.push(row.id)
          totalContracts++
        } else if (result === false) {
          eoaIds.push(row.id)
          totalEoas++
        } else {
          totalErrors++
        }
      }

      // Update contracts
      if (contractIds.length > 0) {
        const { error } = await (supabase
          .from('trader_sources')
          .update({ is_contract: true, contract_checked_at: now } as any)
          .in('id', contractIds) as any)
        if (error) log.error('Failed to update contracts', error)
      }

      // Update EOAs
      if (eoaIds.length > 0) {
        const { error } = await (supabase
          .from('trader_sources')
          .update({ is_contract: false, contract_checked_at: now } as any)
          .in('id', eoaIds) as any)
        if (error) log.error('Failed to update EOAs', error)
      }

      log.info(`Chain ${chainId}: ${contractIds.length} contracts, ${eoaIds.length} EOAs`)
    }

    const total = totalContracts + totalEoas
    log.info(
      `Done: ${total} checked, ${totalContracts} contracts, ${totalEoas} EOAs, ${totalErrors} errors`
    )
    await plog.success(total)

    return NextResponse.json({
      checked: total,
      contracts: totalContracts,
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
