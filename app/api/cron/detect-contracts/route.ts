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

const WORK_BUDGET_MS = 90_000
const DATABASE_TIMEOUT_MS = 12_000
const MAX_BATCH_SIZE = 500

interface TraderSourceRow {
  id: number
  source: string
  source_trader_id: string
}

interface DetectionFailure {
  stage: 'rpc' | 'database' | 'budget' | 'validation'
  chainId?: number
  address?: string
  affected: number
  error: string
}

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || String(MAX_BATCH_SIZE), 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), MAX_BATCH_SIZE) : MAX_BATCH_SIZE
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function databaseSignal(workSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([workSignal, AbortSignal.timeout(DATABASE_TIMEOUT_MS)])
}

async function confirmUpdatedIds(
  query: {
    select(columns: string): {
      abortSignal(signal: AbortSignal): PromiseLike<{
        data: Array<{ id: number }> | null
        error: { message?: string } | null
      }>
    }
  },
  expectedIds: number[],
  workSignal: AbortSignal
): Promise<void> {
  const { data, error } = await query.select('id').abortSignal(databaseSignal(workSignal))
  if (error || !Array.isArray(data)) {
    throw new Error(error?.message || 'database update returned no acknowledgement')
  }

  const expected = new Set(expectedIds)
  const actual = new Set(data.map((row) => row.id))
  if (
    data.length !== expectedIds.length ||
    actual.size !== expected.size ||
    [...expected].some((id) => !actual.has(id))
  ) {
    throw new Error(`database updated ${actual.size}/${expected.size} expected trader sources`)
  }
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workSignal = AbortSignal.timeout(WORK_BUDGET_MS)
  const plog = await PipelineLogger.start('detect-contracts')
  const limit = parseLimit(request.nextUrl.searchParams.get('limit'))

  try {
    const supabase = getSupabaseAdmin()
    const dexPlatforms = Object.keys(DEX_CHAIN_MAP)

    // Fetch unchecked 0x addresses from DEX platforms
    const { data: uncheckedPayload, error: fetchError } = await (
      supabase
        .from('trader_sources')
        .select('id, source, source_trader_id')
        .in('source', dexPlatforms)
        .is('is_contract', null)
        .like('source_trader_id', '0x%')
        .limit(limit) as any
    ).abortSignal(databaseSignal(workSignal))

    if (fetchError) throw fetchError
    if (!Array.isArray(uncheckedPayload)) {
      throw new Error('Unchecked trader source query returned an invalid acknowledgement')
    }

    if (uncheckedPayload.length === 0) {
      log.info('No unchecked addresses remaining')
      await plog.success(0)
      return NextResponse.json({
        success: true,
        status: 'success',
        checked: 0,
        bots: 0,
        proxies: 0,
        eoas: 0,
        errors: 0,
        acknowledgement: {
          expected: 0,
          rpc_attempted: 0,
          classified: 0,
          durable_writes: 0,
          failures: [],
        },
      })
    }

    const failures: DetectionFailure[] = []
    const unchecked: TraderSourceRow[] = []
    for (const candidate of uncheckedPayload) {
      const row = candidate as Partial<TraderSourceRow> | null
      if (
        !row ||
        !Number.isInteger(row.id) ||
        typeof row.source !== 'string' ||
        typeof row.source_trader_id !== 'string' ||
        !/^0x[0-9a-f]{40}$/i.test(row.source_trader_id)
      ) {
        failures.push({
          stage: 'validation',
          affected: 1,
          error: 'Unchecked trader source query returned a malformed row',
        })
        continue
      }
      unchecked.push(row as TraderSourceRow)
    }

    log.info(`Checking ${unchecked.length}/${uncheckedPayload.length} valid addresses`)

    // Group by chain
    const byChain = new Map<number, Array<{ id: number; address: string }>>()
    for (const row of unchecked) {
      const chainId = getChainForPlatform(row.source)
      if (!chainId) {
        failures.push({
          stage: 'validation',
          address: row.source_trader_id,
          affected: 1,
          error: `No chain mapping for ${row.source}`,
        })
        continue
      }
      if (!byChain.has(chainId)) byChain.set(chainId, [])
      byChain.get(chainId)!.push({ id: row.id, address: row.source_trader_id })
    }

    let rpcAttempted = 0
    let classified = 0
    let durableBots = 0
    let durableProxies = 0
    let durableEoas = 0
    const now = new Date().toISOString()

    for (const [chainId, rows] of byChain) {
      if (workSignal.aborted) {
        failures.push({
          stage: 'budget',
          chainId,
          affected: rows.length,
          error: `job budget exhausted after ${WORK_BUDGET_MS}ms`,
        })
        continue
      }

      const addresses = rows.map((r) => r.address)
      const results = await batchCheckContracts(addresses, chainId, 20, workSignal)
      rpcAttempted += workSignal.aborted
        ? Math.min(results.size, addresses.length)
        : addresses.length

      if (workSignal.aborted) {
        failures.push({
          stage: 'budget',
          chainId,
          affected: rows.length,
          error: `job budget exhausted while checking chain ${chainId}`,
        })
        continue
      }

      // Classify and batch update
      const botUpdates: Array<{ id: number; size: number }> = []
      const proxyUpdates: Array<{ id: number; size: number }> = []
      const eoaIds: number[] = []

      for (const row of rows) {
        const result = results.get(row.address)
        if (result == null) {
          failures.push({
            stage: 'rpc',
            chainId,
            address: row.address,
            affected: 1,
            error: 'contract RPC returned no classification',
          })
          continue
        }

        classified++
        if (!result.isContract) {
          eoaIds.push(row.id)
        } else if (isBotContract(result)) {
          botUpdates.push({ id: row.id, size: result.bytecodeSize })
        } else {
          proxyUpdates.push({ id: row.id, size: result.bytecodeSize })
        }
      }

      const individualUpdates = [
        ...botUpdates.map((update) => ({ ...update, kind: 'bot' as const })),
        ...proxyUpdates.map((update) => ({ ...update, kind: 'proxy' as const })),
      ]
      for (let index = 0; index < individualUpdates.length; index++) {
        if (workSignal.aborted) {
          failures.push({
            stage: 'budget',
            chainId,
            affected: individualUpdates.length - index,
            error: 'job budget exhausted before contract updates completed',
          })
          break
        }

        const update = individualUpdates[index]
        try {
          const query = supabase
            .from('trader_sources')
            .update({
              is_contract: update.kind === 'bot',
              contract_checked_at: now,
              contract_bytecode_size: update.size,
            })
            .eq('id', update.id)
          await confirmUpdatedIds(query as any, [update.id], workSignal)
          if (update.kind === 'bot') durableBots++
          else durableProxies++
        } catch (error) {
          failures.push({
            stage: workSignal.aborted ? 'budget' : 'database',
            chainId,
            affected: 1,
            error: errorMessage(error),
          })
        }
      }

      // Update EOAs
      if (eoaIds.length > 0) {
        if (workSignal.aborted) {
          failures.push({
            stage: 'budget',
            chainId,
            affected: eoaIds.length,
            error: 'job budget exhausted before EOA update completed',
          })
        } else {
          try {
            const query = supabase
              .from('trader_sources')
              .update({
                is_contract: false,
                contract_checked_at: now,
                contract_bytecode_size: 0,
              })
              .in('id', eoaIds)
            await confirmUpdatedIds(query as any, eoaIds, workSignal)
            durableEoas += eoaIds.length
          } catch (error) {
            failures.push({
              stage: workSignal.aborted ? 'budget' : 'database',
              chainId,
              affected: eoaIds.length,
              error: errorMessage(error),
            })
          }
        }
      }

      log.info(
        `Chain ${chainId}: ${botUpdates.length} bots, ${proxyUpdates.length} proxies, ${eoaIds.length} EOAs classified`
      )
    }

    const total = durableBots + durableProxies + durableEoas
    const expected = uncheckedPayload.length
    const failureCount = expected - total
    const failureDetails = failures.slice(0, 100)
    const acknowledgement = {
      expected,
      rpc_attempted: rpcAttempted,
      classified,
      durable_writes: total,
      failure_count: failureCount,
      failures: failureDetails,
      failures_truncated: failures.length - failureDetails.length,
    }
    const noDurableWrites = total === 0
    const partial = !noDurableWrites && failureCount > 0
    const status = noDurableWrites ? 'failed' : partial ? 'partial' : 'success'
    const success = status === 'success'

    log.info(
      `Done: ${total}/${expected} persisted, ${durableBots} bots, ${durableProxies} proxies, ${durableEoas} EOAs`
    )

    if (success) {
      await plog.success(total, { status, acknowledgement })
    } else if (partial) {
      await plog.partialSuccess(
        total,
        failures.map(
          (failure) =>
            `${failure.stage}:${failure.chainId ?? 'unknown'}:${failure.address ?? failure.affected}`
        ),
        { status, acknowledgement }
      )
    } else {
      await plog.error(new Error('contract detection produced no durable writes'), {
        status,
        acknowledgement,
      })
    }

    return NextResponse.json(
      {
        success,
        status,
        checked: total,
        bots: durableBots,
        proxies: durableProxies,
        eoas: durableEoas,
        errors: failureCount,
        remaining: failureCount,
        acknowledgement,
      },
      { status: noDurableWrites ? 503 : partial ? 207 : 200 }
    )
  } catch (err) {
    log.error('Contract detection failed', err)
    await plog.error(err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: workSignal.aborted ? 504 : 500 }
    )
  }
}
